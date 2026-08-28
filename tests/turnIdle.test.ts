// The idle-turn mark: lib/turnActivity.ts, the backstop for a turn that stays
// `running` while waiting on something that already finished.
//
// The case it exists for was real (2026-08-27): two `while pgrep …; do sleep;
// done` watcher loops matched their own `zsh -c` command line, so they never
// exited, and the session sat live and silent for half an hour after the test
// runs they were waiting on had passed. Nothing on screen distinguished it from
// a session doing work.
//
// The mark is deliberately not a deadline — nothing here stops or kills a turn —
// so the only thing that can go wrong is what it says. Two ways it could be
// WORSE than not existing, both pinned below: marking a turn that is legitimately
// parked on a human (a question card, a permission prompt), and failing to
// unmark one that started talking again.
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { createProject, createTask, updateTask } from "@/lib/store";
import { registerTurn, unregisterTurn } from "@/lib/abort";
import { waitForAnswer, submitAnswer } from "@/lib/asks";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { TURN_IDLE_MS } from "@/lib/config";
import {
  markTurnActivity,
  resetTurnActivity,
  sweepIdleTurns,
  turnIdleSince,
} from "@/lib/turnActivity";
import { tmpDir } from "./helpers";

// A plain (non-git) working dir — nothing here launches a turn, so no worktree
// is ever cut.
const makeTask = () => {
  const project = createProject({ name: "Idle", repo_path: tmpDir("idle-") });
  return createTask({ project_id: project.id, title: "T", description: "work" });
};

// Stand in for a live turn without running one: the abort registry IS the
// liveness source of truth the sweep reads (lib/abort.ts), so registering a
// controller is exactly what makes a task "mid-turn" as far as this module is
// concerned.
const controllers: { id: string; ac: AbortController }[] = [];
function liveTurn(taskId: string): AbortController {
  const ac = new AbortController();
  registerTurn(taskId, ac);
  controllers.push({ id: taskId, ac });
  return ac;
}

let events: { taskId: string; ev: BusEvent }[] = [];
let unsub = () => {};

beforeEach(() => {
  resetTurnActivity();
  events = [];
  unsub = subscribeGlobal((taskId, ev) => events.push({ taskId, ev }), { internal: true });
});

afterEach(() => {
  unsub();
  for (const { id, ac } of controllers.splice(0)) unregisterTurn(id, ac);
  resetTurnActivity();
});

/** `now`, far enough past the last activity that the window has elapsed. */
const wellPast = () => Date.now() + TURN_IDLE_MS + 60_000;
const idleEvents = () => events.filter((e) => e.ev.type === "turn_idle");

describe("idle turn mark", () => {
  it("marks a live turn that has produced nothing for the whole window", () => {
    const task = makeTask();
    liveTurn(task.id);
    markTurnActivity(task.id);
    const at = turnIdleSince(task.id);
    expect(at).toBe(0);

    sweepIdleTurns(wellPast());

    // The stored value is the INSTANT of the last activity, not a duration:
    // every surface ages it against its own clock.
    expect(turnIdleSince(task.id)).toBeGreaterThan(0);
    expect(turnIdleSince(task.id)).toBeLessThanOrEqual(Date.now());
    // Published once, because a quiet turn puts nothing on its own transcript
    // stream and this is the only channel that can tell a card.
    expect(idleEvents().map((e) => e.taskId)).toEqual([task.id]);
  });

  it("leaves a turn that spoke inside the window alone", () => {
    const task = makeTask();
    liveTurn(task.id);
    markTurnActivity(task.id);

    sweepIdleTurns(Date.now() + TURN_IDLE_MS - 1000);

    expect(turnIdleSince(task.id)).toBe(0);
    expect(idleEvents()).toHaveLength(0);
  });

  it("does not mark a turn parked on a permission card", () => {
    // The false positive that would make this feature worse than nothing. A
    // turn waiting on the user is silent for exactly the same reason an idle
    // one is — but that wait is legitimate, open-ended by design, and already
    // surfaced as "needs you". awaiting_input is how the runner records it
    // (lib/runner.ts persists it before publishing either card).
    const task = makeTask();
    liveTurn(task.id);
    markTurnActivity(task.id);
    updateTask(task.id, { awaiting_input: 1 });

    sweepIdleTurns(wellPast());

    expect(turnIdleSince(task.id)).toBe(0);
    expect(idleEvents()).toHaveLength(0);
  });

  it("does not mark a turn parked on an ask_user question", async () => {
    // Same rule from the other end: the ask registry holds the waiter from the
    // moment the gate parks, which is a beat before the row flag lands, so the
    // sweep checks it as well as awaiting_input.
    const task = makeTask();
    const ac = liveTurn(task.id);
    markTurnActivity(task.id);
    const answered = waitForAnswer(task.id, "ask-1", [], ac.signal);

    sweepIdleTurns(wellPast());

    expect(turnIdleSince(task.id)).toBe(0);
    expect(idleEvents()).toHaveLength(0);

    // And once it IS answered the turn is an ordinary silent turn again: the
    // exemption is the parked ask, not the task.
    submitAnswer(task.id, "ask-1", []);
    await answered;
    sweepIdleTurns(wellPast());
    expect(turnIdleSince(task.id)).toBeGreaterThan(0);
  });

  it("clears the mark, and says so, the moment the turn produces anything", () => {
    const task = makeTask();
    liveTurn(task.id);
    markTurnActivity(task.id);
    sweepIdleTurns(wellPast());
    expect(idleEvents()).toHaveLength(1);

    markTurnActivity(task.id);

    expect(turnIdleSince(task.id)).toBe(0);
    // A second event, because the client cannot learn it any other way — the
    // transcript detail that proves the turn is alive never reaches the global
    // stream.
    expect(idleEvents()).toHaveLength(2);
  });

  it("marks once, not once per sweep", () => {
    const task = makeTask();
    liveTurn(task.id);
    markTurnActivity(task.id);
    sweepIdleTurns(wellPast());
    const at = turnIdleSince(task.id);
    sweepIdleTurns(wellPast() + 60_000);
    sweepIdleTurns(wellPast() + 120_000);

    expect(turnIdleSince(task.id)).toBe(at);
    expect(idleEvents()).toHaveLength(1);
  });

  it("never marks a task with no live turn, and forgets it", () => {
    // `tasks.running` can be stale after a crash mid-turn; the abort registry
    // cannot. A record whose turn ended down a path that skipped the runner's
    // cleanup must age out rather than describe a task that finished.
    const task = makeTask();
    const ac = liveTurn(task.id);
    markTurnActivity(task.id);
    unregisterTurn(task.id, ac);

    sweepIdleTurns(wellPast());

    expect(turnIdleSince(task.id)).toBe(0);
    expect(idleEvents()).toHaveLength(0);
  });
});
