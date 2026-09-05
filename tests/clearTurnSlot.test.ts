import { describe, it, expect, beforeEach, vi } from "vitest";

// POST /clear aborts the live turn, releasing its turn slot, then awaits
// summarizeTranscript(), a real agent call that can take minutes, before
// advancing the generation. During that window hasTurn() reads false, so a
// POST /messages (or the runner's queue-drain handoff) must not claim the
// freed slot and start a turn on the generation /clear is retiring: a session
// about to be summarized away, with a summary covering a generation still
// being written to.
//
// A per-task clearing claim (lib/abort.ts) is held across the whole route,
// vetoing claimTurn/handoffTurn so a successor queues instead of starting.
// These tests park the summarize on a gate and race the launch paths against
// it. A scripted fake driver stands in for the agent, the same seam
// tests/clearMidTurn.test.ts uses.
const { runTurnMock, summarizeMock } = vi.hoisted(() => ({ runTurnMock: vi.fn(), summarizeMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
    summarizeTranscript: (transcript: string, project: unknown) => summarizeMock(transcript, project),
  },
}));

import {
  createProject,
  createTask,
  getTask,
  listMessages,
  listPendingMessages,
  listSummaries,
} from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { beginClearing, claimTurn, endClearing, handoffTurn, hasTurn, isClearing, unregisterTurn } from "@/lib/abort";
import { POST as clearRoute } from "@/app/api/tasks/[id]/clear/route";
import { POST as messagesPost } from "@/app/api/tasks/[id]/messages/route";
import { makeRepo } from "./helpers";

function clear(taskId: string) {
  return clearRoute(new Request("http://test/clear", { method: "POST" }), { params: Promise.resolve({ id: taskId }) });
}

function post(taskId: string, text: string) {
  return messagesPost(new Request("http://test/messages", { method: "POST", body: JSON.stringify({ text }) }), {
    params: Promise.resolve({ id: taskId }),
  });
}

function turnEnd(taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Run a task through one complete turn so it has a session to clear.
async function seedSession(name: string) {
  const project = createProject({ name, repo_path: await makeRepo() });
  const task = createTask({ project_id: project.id, title: "T", description: "d" });
  runTurnMock.mockImplementation(async function* () {
    yield { type: "session", sessionId: "s1" };
    yield { type: "assistant", content: "did some work" };
    yield { type: "done", sessionId: "s1" };
  });
  const ended = turnEnd(task.id);
  await startResumeTurn(task, project, "go");
  await ended;
  runTurnMock.mockReset();
  return { project, task };
}

beforeEach(() => {
  runTurnMock.mockReset();
  summarizeMock.mockReset();
  summarizeMock.mockResolvedValue("HANDOFF SUMMARY");
});

describe("/clear holds the turn slot until the generation advances", () => {
  it("queues a POST that races an in-flight summarize instead of starting a turn on the retiring generation", async () => {
    const { task } = await seedSession("ClearSlotRace");

    // Park the summarize the way a real minutes-long agent call would.
    const summarizing = deferred();
    const gate = deferred<string>();
    summarizeMock.mockImplementation(async () => {
      summarizing.resolve();
      return gate.promise;
    });

    const clearing = clear(task.id);
    await summarizing.promise; // /clear is inside summarizeTranscript

    // The live turn's slot is gone, but the generation has not advanced yet.
    expect(hasTurn(task.id)).toBe(false);
    expect(getTask(task.id)!.generation).toBe(1);

    const res = await post(task.id, "sent while clearing");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    // No turn was launched against generation 1.
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(listPendingMessages(task.id)).toHaveLength(1);

    gate.resolve("HANDOFF SUMMARY");
    const done = await clearing;
    expect(done.status).toBe(200);
    expect((await done.json()).generation).toBe(2);

    // Still nothing started, and the queue was retired with the generation.
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(listPendingMessages(task.id)).toHaveLength(0);
    expect(listSummaries(task.id)).toHaveLength(1);
    // The claim is released, so the next send runs normally.
    expect(isClearing(task.id)).toBe(false);
  });

  it("names the queued messages it discarded so nothing vanishes silently", async () => {
    const { task } = await seedSession("ClearSlotNotice");

    const summarizing = deferred();
    const gate = deferred<string>();
    summarizeMock.mockImplementation(async () => {
      summarizing.resolve();
      return gate.promise;
    });

    const clearing = clear(task.id);
    await summarizing.promise;
    await post(task.id, "please also update the README");
    gate.resolve("HANDOFF SUMMARY");
    await clearing;

    const notice = listMessages(task.id).find((m) => m.role === "system" && m.content.includes("discarded by /clear"));
    expect(notice).toBeDefined();
    expect(notice!.generation).toBe(2);
    expect(notice!.content).toContain("please also update the README");
  });

  it("releases the claim when the summary fails, so the next send still runs", async () => {
    const { task, project } = await seedSession("ClearSlotFailedSummary");

    summarizeMock.mockRejectedValue(new Error("model exploded"));
    const res = await clear(task.id);
    const body = (await res.json()) as { generation: number; summary: string };
    expect(body.generation).toBe(2);
    expect(body.summary).toContain("model exploded");
    // A claim left behind here wedges the task forever: every future message
    // would queue with nothing able to start a turn.
    expect(isClearing(task.id)).toBe(false);

    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s2" };
      yield { type: "done", sessionId: "s2" };
    });
    const ended = turnEnd(task.id);
    await startResumeTurn(getTask(task.id)!, project, "continue");
    await ended;
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a second /clear while one is in flight", async () => {
    const { task } = await seedSession("ClearSlotDouble");

    const summarizing = deferred();
    const gate = deferred<string>();
    summarizeMock.mockImplementation(async () => {
      summarizing.resolve();
      return gate.promise;
    });

    const first = clear(task.id);
    await summarizing.promise;

    const second = await clear(task.id);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already in progress/);

    gate.resolve("HANDOFF SUMMARY");
    await first;
    // One generation boundary, one summary.
    expect(getTask(task.id)!.generation).toBe(2);
    expect(listSummaries(task.id)).toHaveLength(1);
  });
});

describe("the clearing claim", () => {
  it("vetoes both launch chokepoints and lifts cleanly", () => {
    const id = "task-clearing-unit";

    // claimTurn: what POST /messages, autoStart, dispatch and deferredStart all
    // funnel through.
    expect(beginClearing(id)).toBe(true);
    expect(beginClearing(id)).toBe(false); // not re-entrant: a second /clear is refused
    expect(claimTurn(id)).toBeNull();

    // handoffTurn: the runner's queue drain, which would otherwise pop a
    // follow-up parked against the generation being retired.
    endClearing(id);
    const live = claimTurn(id)!;
    expect(live).not.toBeNull();
    expect(beginClearing(id)).toBe(true);
    expect(handoffTurn(id, live)).toBeNull();

    endClearing(id);
    expect(isClearing(id)).toBe(false);
    // A clear leaves no residue: the handoff `live` was refused earlier now
    // goes through, and the slot is claimable again once its successor
    // releases.
    const next = handoffTurn(id, live);
    expect(next).not.toBeNull();
    unregisterTurn(id, next!);
    const after = claimTurn(id);
    expect(after).not.toBeNull();
    unregisterTurn(id, after!);
  });
});
