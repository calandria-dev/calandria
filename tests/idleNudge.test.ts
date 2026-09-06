// Telling the model its turn went quiet: lib/idleNudge.ts, the opt-in other
// half of the idle mark (tests/turnIdle.test.ts pins the mark itself).
//
// This is the one thing in the idle feature that spends something: a real turn
// on a session that may be waiting for a perfectly good reason. The cases
// worth pinning are all about restraint: it lands at most once, never on a run
// nobody is reading, never ahead of a message the user already queued, and
// never at all on a session the driver will not take one from.
//
// The flag is forced on here instead of in tests/setup.ts, because the suite's
// default has to stay the shipped default (off): turnIdle.test.ts asserts that
// an ordinary instance's idle turn is marked and told nothing.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", async () => ({
  ...(await vi.importActual<typeof import("@/lib/config")>("@/lib/config")),
  TURN_IDLE_NUDGE_ENABLED: true,
}));

import { registerTurn, unregisterTurn } from "@/lib/abort";
import { TURN_IDLE_MS } from "@/lib/config";
import { SCHEDULED_RUN_CONTEXT, clearRunContext, setRunContext } from "@/lib/runContext";
import {
  addPendingMessage,
  createProject,
  createTask,
  getTask,
  listMessages,
  updateTask,
} from "@/lib/store";
import { markTurnActivity, resetTurnActivity, sweepIdleTurns, turnIdleSince } from "@/lib/turnActivity";
import { registerTurnInput, unregisterTurnInput, type TurnInputHandle } from "@/lib/turnInput";
import { tmpDir } from "./helpers";

const makeTask = () => {
  const project = createProject({ name: "Nudge", repo_path: tmpDir("nudge-") });
  return createTask({ project_id: project.id, title: "T", description: "work" });
};

const controllers: { id: string; ac: AbortController }[] = [];
function liveTurn(taskId: string): void {
  const ac = new AbortController();
  registerTurn(taskId, ac);
  controllers.push({ id: taskId, ac });
}

// Stand in for the Claude driver's input channel. `accepting` is the whole of
// what the driver decides for us: true is a LINGERING session (the model's
// output is done, nothing in flight), false is every other state (mid-thought,
// closing, closed), which the real sendMidTurn refuses outright.
const handles: { id: string; handle: TurnInputHandle }[] = [];
function lingeringSession(taskId: string, accepting = true): string[] {
  const received: string[] = [];
  const handle: TurnInputHandle = {
    send: (text) => {
      if (!accepting) return false;
      received.push(text);
      return true;
    },
  };
  registerTurnInput(taskId, handle);
  handles.push({ id: taskId, handle });
  // A lingering turn is flagged as such on the row; the nudge has to clear that
  // when it lands, since a real model turn starts the moment it does.
  updateTask(taskId, { background_pending: 1, background_note: "waiting on tests" });
  return received;
}

/** A turn that has just spoken, then a sweep well past the idle window. */
function goIdle(taskId: string): void {
  markTurnActivity(taskId);
  sweepIdleTurns(Date.now() + TURN_IDLE_MS + 60_000);
}

const tasks: string[] = [];

beforeEach(() => {
  resetTurnActivity();
});

afterEach(() => {
  for (const { id, ac } of controllers.splice(0)) unregisterTurn(id, ac);
  for (const { id, handle } of handles.splice(0)) unregisterTurnInput(id, handle);
  for (const id of tasks.splice(0)) clearRunContext(id);
  resetTurnActivity();
});

describe("idle nudge", () => {
  it("tells a lingering session that it has gone quiet, and says how long", () => {
    const task = makeTask();
    liveTurn(task.id);
    const received = lingeringSession(task.id);

    goIdle(task.id);

    expect(received).toHaveLength(1);
    // Written for the model, and marked so it can't be read as the user typing.
    expect(received[0]).toContain("[Calandria]");
    expect(received[0]).toMatch(/produced nothing for 2\d minutes/);

    // The mark still stands: the nudge is US talking, not the session, so it
    // must not reset a clock that measures the session.
    expect(turnIdleSince(task.id)).toBeGreaterThan(0);

    // A real model turn is starting, so "working in background" stops being
    // true on every surface that reads the row.
    const row = getTask(task.id);
    expect(row?.background_pending).toBe(0);
    expect(row?.background_note).toBe("");

    // Recorded as the system note it is, NOT as a user message: the user did
    // not type this, and a transcript saying they did is a lie the next
    // /clear summary would carry forward.
    const msgs = listMessages(task.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("re-check what it is waiting on");
  });

  it("lands at most once for the life of a turn", () => {
    const task = makeTask();
    liveTurn(task.id);
    const received = lingeringSession(task.id);

    goIdle(task.id);
    expect(received).toHaveLength(1);

    // The model answered and went back to waiting, which clears the mark, and
    // then went quiet again. It already answered the question once; asking
    // again is a loop that bills the user for itself.
    markTurnActivity(task.id);
    expect(turnIdleSince(task.id)).toBe(0);
    sweepIdleTurns(Date.now() + TURN_IDLE_MS + 60_000);

    expect(turnIdleSince(task.id)).toBeGreaterThan(0);
    expect(received).toHaveLength(1);
    expect(listMessages(task.id)).toHaveLength(1);
  });

  it("is refused by a session that is not lingering, and leaves no trace", () => {
    const task = makeTask();
    liveTurn(task.id);
    // Mid-thought: a long build, a slow tool call, a model still reasoning.
    // The driver refuses, which makes the dangerous case structurally
    // unreachable instead of guarded by a heuristic here.
    const received = lingeringSession(task.id, false);

    goIdle(task.id);

    expect(received).toHaveLength(0);
    expect(listMessages(task.id)).toHaveLength(0);
    // The mark itself is unaffected; it never depended on this.
    expect(turnIdleSince(task.id)).toBeGreaterThan(0);
    // And the linger flags are untouched, since no turn started.
    expect(getTask(task.id)?.background_pending).toBe(1);
  });

  it("retries on a later idle onset after a refusal", () => {
    const task = makeTask();
    liveTurn(task.id);
    let accepting = false;
    const received: string[] = [];
    const handle: TurnInputHandle = {
      send: (text) => {
        if (!accepting) return false;
        received.push(text);
        return true;
      },
    };
    registerTurnInput(task.id, handle);
    handles.push({ id: task.id, handle });

    goIdle(task.id);
    expect(received).toHaveLength(0);

    // A refusal is not remembered, because every reason to refuse is temporary:
    // the turn that was mid-thought reaches its linger, and the next silence is
    // the one worth speaking into.
    accepting = true;
    markTurnActivity(task.id);
    sweepIdleTurns(Date.now() + TURN_IDLE_MS + 60_000);

    expect(received).toHaveLength(1);
  });

  it("never fires on a scheduled run", () => {
    const task = makeTask();
    tasks.push(task.id);
    liveTurn(task.id);
    const received = lingeringSession(task.id);
    // Nobody is reading this one (lib/runContext.ts), so a nudge would bill an
    // unattended turn and extend a run whose whole contract is to be quiet.
    setRunContext(task.id, { ...SCHEDULED_RUN_CONTEXT });

    goIdle(task.id);

    expect(received).toHaveLength(0);
    expect(listMessages(task.id)).toHaveLength(0);
    // Marked all the same: the human still gets told, which is the half of the
    // feature that costs nothing.
    expect(turnIdleSince(task.id)).toBeGreaterThan(0);
  });

  it("waits behind a message the user already queued", () => {
    const task = makeTask();
    liveTurn(task.id);
    const received = lingeringSession(task.id);
    // That message was typed first and renders above this as a queued bubble;
    // it also drains into the session on its own at linger entry, and is a far
    // better wake-up than anything this file could write.
    addPendingMessage(task.id, task.generation, "and then run the suite");

    goIdle(task.id);

    expect(received).toHaveLength(0);
    expect(listMessages(task.id)).toHaveLength(0);
  });
});
