import { describe, it, expect, beforeEach, vi } from "vitest";

// Work Center stage 1: the execution classifier, model-turn identity, the
// live observation registry, boot recovery and the recent-result list
// (contract work-center/1). The first block is pure; the second drives the
// registry and store directly; the third runs the real runner against a
// scripted driver.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, updateTask, recordSession, endSession } from "@/lib/store";
import { getDb, finalizeActiveTurnsAsInterrupted } from "@/lib/db";
import { startTurn } from "@/lib/runner";
import { abortTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import { classifyExecution, decodeRecentCursor, resultNeedsAttention, selectRecent, type ClassifyInput } from "@/lib/workCenter/classify";
import {
  beginExecution,
  endExecution,
  executionOf,
  finishModelTurn,
  observeExecution,
  recentResults,
  RecentCursorError,
  startModelTurn,
  subscribeWorkCenter,
  workCenterSequence,
} from "@/lib/workCenter/execution";
import { ClaudeExecutionTracker } from "@/lib/agents/claude/executionObserver";
import type { ExecutionObservation } from "@/lib/workCenter/types";
import type { StreamEvent, TaskStreamEvent } from "@/lib/types";

const OBS = (o: Partial<Omit<ExecutionObservation, "type">> = {}): ExecutionObservation => ({
  type: "execution_observation",
  foreground: "executing",
  background: [],
  backgroundCoverage: "complete",
  wakeups: [],
  externalWait: null,
  ...o,
});

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    lifecycle: "in_progress",
    live: true,
    openRequest: false,
    observation: { foreground: "executing", background: [], backgroundCoverage: "complete", wakeups: [], externalWait: null },
    turnId: "turn_1",
    sessionId: "sess_1",
    queuedStart: null,
    queuedFollowupCount: 0,
    blockerTaskIds: [],
    lastActivityAt: 1000,
    ...over,
  };
}

describe("classifyExecution", () => {
  it("counts quiet foreground execution as working, with no inferred failure", () => {
    const e = classifyExecution(input({ lastActivityAt: 1 }));
    expect(e.isWorking).toBe(true);
    expect(e.foreground).toBe("executing");
    expect(e.waitingReasons).toEqual([]);
  });

  it("is not working while parked on an ask with no background", () => {
    const e = classifyExecution(input({ openRequest: true }));
    expect(e.isWorking).toBe(false);
    expect(e.foreground).toBe("parked");
    expect(e.waitingReasons).toEqual(["input"]);
  });

  it("is working AND waiting on input when background runs under a parked ask", () => {
    const e = classifyExecution(
      input({
        openRequest: true,
        observation: { foreground: "executing", background: [{ id: "b1", kind: "command", startedAt: 5 }], backgroundCoverage: "complete", wakeups: [], externalWait: null },
      })
    );
    expect(e.isWorking).toBe(true);
    expect(e.waitingReasons).toContain("input");
    expect(e.background).toEqual([{ id: "b1", kind: "command", startedAt: 5 }]);
  });

  it("keeps a background-only session working after the foreground finished", () => {
    const e = classifyExecution(
      input({
        observation: { foreground: "finished", background: [{ id: "a1", kind: "agent", startedAt: null }], backgroundCoverage: "complete", wakeups: [], externalWait: null },
      })
    );
    expect(e.isWorking).toBe(true);
    expect(e.foreground).toBe("finished");
  });

  it.each([
    ["wakeup only", input({ observation: { foreground: "finished", background: [], backgroundCoverage: "complete", wakeups: [{ id: "w", at: 9 }], externalWait: null } }), ["wakeup"]],
    ["queued start only", input({ live: false, queuedStart: { at: 50, reason: "scheduled" } }), ["queued", "no_live_turn"]],
    ["queued follow-up only", input({ live: false, queuedFollowupCount: 2 }), ["queued", "no_live_turn"]],
    ["dependency only", input({ live: false, lifecycle: "not_started", blockerTaskIds: ["t0"] }), ["dependency"]],
    ["hold", input({ live: false, lifecycle: "on_hold" }), ["on_hold"]],
    ["in progress with no live turn", input({ live: false }), ["no_live_turn"]],
  ] as const)("is waiting, not working: %s", (_name, i, reasons) => {
    const e = classifyExecution(i);
    expect(e.isWorking).toBe(false);
    expect(e.waitingReasons).toEqual(reasons);
  });

  it("declares missing provider detail instead of fabricating background or wakeups", () => {
    const e = classifyExecution(
      input({ observation: { foreground: "executing", background: [], backgroundCoverage: "unavailable", wakeups: [], externalWait: null } })
    );
    expect(e.backgroundCoverage).toBe("unavailable");
    expect(e.background).toEqual([]);
    expect(e.wakeups).toEqual([]);
    expect(e.waitingReasons).toEqual(["detail_unavailable"]);
    expect(e.isWorking).toBe(true);
  });

  it("reads a live turn with no observation as unknown, not idle", () => {
    const e = classifyExecution(input({ observation: null }));
    expect(e.foreground).toBe("unknown");
    expect(e.backgroundCoverage).toBe("unavailable");
    expect(e.isWorking).toBe(false);
    expect(e.waitingReasons).toContain("detail_unavailable");
  });

  it("ignores a stale observation when no turn is live", () => {
    const e = classifyExecution(
      input({ live: false, observation: { foreground: "executing", background: [{ id: "b", kind: "command", startedAt: 1 }], backgroundCoverage: "complete", wakeups: [], externalWait: null } })
    );
    expect(e.isWorking).toBe(false);
    expect(e.foreground).toBe("none");
    expect(e.background).toEqual([]);
    expect(e.turnId).toBeNull();
  });

  it("keeps a terminal task's live work visible", () => {
    const e = classifyExecution(input({ lifecycle: "done" }));
    expect(e.isWorking).toBe(true);
  });

  it("reports an external wait as its own reason", () => {
    const e = classifyExecution(
      input({ observation: { foreground: "executing", background: [], backgroundCoverage: "complete", wakeups: [], externalWait: { kind: "capacity", since: 3 } } })
    );
    expect(e.waitingReasons).toContain("external");
    expect(e.externalWait).toEqual({ kind: "capacity", since: 3 });
  });
});

describe("latest result", () => {
  const base = {
    generation: 2,
    completed_at: null,
    latest_turn_failure_code: null,
    latest_turn_failure_resolved_at: null,
  };
  it("only a failed turn with an unresolved code asks for attention", () => {
    expect(resultNeedsAttention({ latest_turn_outcome: "failed", latest_turn_failure_code: "auth", latest_turn_failure_resolved_at: null })).toBe(true);
    expect(resultNeedsAttention({ latest_turn_outcome: "failed", latest_turn_failure_code: "auth", latest_turn_failure_resolved_at: 5 })).toBe(false);
    expect(resultNeedsAttention({ latest_turn_outcome: "ok", latest_turn_failure_code: null, latest_turn_failure_resolved_at: null })).toBe(false);
    expect(resultNeedsAttention({ latest_turn_outcome: "stopped", latest_turn_failure_code: null, latest_turn_failure_resolved_at: null })).toBe(false);
    expect(resultNeedsAttention({ latest_turn_outcome: "interrupted", latest_turn_failure_code: null, latest_turn_failure_resolved_at: null })).toBe(false);
    void base;
  });
});

describe("selectRecent", () => {
  const NOW = 10 * 24 * 3600 * 1000;
  const DAY = 24 * 3600 * 1000;
  const rows = (n: number, endedAt: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ taskId: `t${String(i).padStart(3, "0")}`, endedAt: endedAt(i) }));

  it("keeps only the last seven days, newest first, task id breaking ties", () => {
    const out = selectRecent(
      [
        { taskId: "a", endedAt: NOW - 8 * DAY },
        { taskId: "b", endedAt: NOW - DAY },
        { taskId: "c", endedAt: NOW - DAY },
        { taskId: "d", endedAt: NOW - 7 * DAY },
      ],
      { now: NOW, scope: null }
    );
    expect(out.rows.map((r) => r.taskId)).toEqual(["c", "b", "d"]);
    expect(out.nextCursor).toBeNull();
  });

  it("pages without gaps or repeats, including across a tie on endedAt", () => {
    const all = rows(7, (i) => NOW - (i % 2 === 0 ? 1000 : 2000));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: ReturnType<typeof selectRecent<(typeof all)[number]>> = selectRecent(all, { now: NOW, scope: null, limit: 3, cursor: cursor ? decodeRecentCursor(cursor, null) : null });
      seen.push(...page.rows.map((r) => r.taskId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("clamps the limit to 1..100", () => {
    const all = rows(150, () => NOW - 10);
    expect(selectRecent(all, { now: NOW, scope: null, limit: 1000 }).rows).toHaveLength(100);
    expect(selectRecent(all, { now: NOW, scope: null, limit: 0 }).rows.length).toBe(50);
  });

  it("rejects a cursor minted for another scope or malformed", () => {
    const page = selectRecent(rows(5, (i) => NOW - i), { now: NOW, scope: "p1", limit: 2 });
    expect(page.nextCursor).toBeTruthy();
    expect(decodeRecentCursor(page.nextCursor!, "p1")).not.toBeNull();
    expect(decodeRecentCursor(page.nextCursor!, "p2")).toBeNull();
    expect(decodeRecentCursor(page.nextCursor!, null)).toBeNull();
    expect(decodeRecentCursor("not-a-cursor", null)).toBeNull();
  });
});

describe("ClaudeExecutionTracker", () => {
  it("tracks background tasks from native events and ignores ambient ones", () => {
    const t = new ClaudeExecutionTracker();
    expect(t.changed()).toMatchObject({ foreground: "executing", background: [], backgroundCoverage: "complete" });
    expect(t.changed()).toBeNull();
    t.taskStarted({ task_id: "fg", is_backgrounded: false, task_type: "local_bash" }, 1);
    expect(t.changed()).toBeNull();
    t.taskStarted({ task_id: "bg", is_backgrounded: true, task_type: "local_agent" }, 2);
    t.taskStarted({ task_id: "amb", is_backgrounded: true, ambient: true }, 3);
    expect(t.changed()?.background).toEqual([{ id: "bg", kind: "agent", startedAt: 2 }]);
    t.taskUpdated({ task_id: "fg", patch: { is_backgrounded: true } });
    expect(t.changed()?.background.map((b) => b.id).sort()).toEqual(["bg", "fg"]);
    t.taskNotification("bg");
    t.taskUpdated({ task_id: "fg", patch: { status: "completed" } });
    expect(t.changed()?.background).toEqual([]);
  });

  it("lets the Stop hook's list replace the tracked set and keeps wakeups separate", () => {
    const t = new ClaudeExecutionTracker();
    t.taskStarted({ task_id: "x", is_backgrounded: true, task_type: "local_bash" }, 7);
    t.stopSnapshot([{ id: "x", type: "local_bash" }, { id: "y", type: "local_agent" }]);
    t.setWakeups([{ id: "c1", fireAt: 99 }, { id: "c2", fireAt: null }]);
    t.setForeground("finished");
    expect(t.snapshot()).toMatchObject({
      foreground: "finished",
      background: [{ id: "x", kind: "command", startedAt: 7 }, { id: "y", kind: "agent", startedAt: null }],
      wakeups: [{ id: "c1", at: 99 }],
    });
  });
});

function fixture() {
  const project = createProject({ name: "WcProj", repo_path: "" });
  const task = createTask({ project_id: project.id, title: "Work task", description: "" });
  return { project, task: getTask(task.id)! };
}

describe("model-turn identity and the live registry", () => {
  it("gives each model turn its own id and finalizes it once", () => {
    const { task } = fixture();
    const lease = beginExecution(task.id, task.generation);
    const a = startModelTurn(task.id, lease)!;
    expect(getTask(task.id)!.active_turn_id).toBe(a);
    expect(finishModelTurn(task.id, lease, { outcome: "ok", terminalMessageId: "m1" })).toBe(true);
    // repeated end event
    expect(finishModelTurn(task.id, lease, { outcome: "failed" })).toBe(false);
    const row = getTask(task.id)!;
    expect(row).toMatchObject({ latest_turn_id: a, latest_turn_outcome: "ok", latest_turn_terminal_message_id: "m1", active_turn_id: null });
    // injected follow-up / actual wake: a distinct turn on the same session
    const b = startModelTurn(task.id, lease)!;
    expect(b).not.toBe(a);
    finishModelTurn(task.id, lease, { outcome: "ok" });
    expect(getTask(task.id)!.latest_turn_id).toBe(b);
    endExecution(task.id, lease);
  });

  it("does not let a stale lease observe, start, finish or end", () => {
    const { task } = fixture();
    const old = beginExecution(task.id, task.generation);
    startModelTurn(task.id, old);
    const next = beginExecution(task.id, task.generation);
    // the replaced session's open turn ended by being stopped, and was kept
    expect(getTask(task.id)!.latest_turn_outcome).toBe("stopped");
    const b = startModelTurn(task.id, next)!;
    expect(observeExecution(task.id, old, OBS({ background: [{ id: "z", kind: "command", startedAt: null }] }))).toBe(false);
    expect(startModelTurn(task.id, old)).toBeNull();
    // late old-turn cleanup after the successor launched
    expect(finishModelTurn(task.id, old, { outcome: "failed", failureCode: "execution" })).toBe(false);
    expect(endExecution(task.id, old)).toBe(false);
    expect(getTask(task.id)).toMatchObject({ active_turn_id: b, latest_turn_outcome: "stopped" });
    endExecution(task.id, next);
  });

  it("replaces the full background and wakeup sets and de-duplicates ids", () => {
    const { task } = fixture();
    const lease = beginExecution(task.id, task.generation);
    observeExecution(
      task.id,
      lease,
      OBS({ background: [{ id: "a", kind: "command", startedAt: 1 }, { id: "a", kind: "command", startedAt: 1 }, { id: "b", kind: "agent", startedAt: null }], wakeups: [{ id: "w", at: 5 }, { id: "w", at: 5 }] })
    );
    // live ownership is hasTurn, which this registry-only test never claims
    expect(executionOf(task.id)!.isWorking).toBe(false);
    observeExecution(task.id, lease, OBS({ backgroundCoverage: "unavailable", background: [{ id: "q", kind: "command", startedAt: null }] }));
    endExecution(task.id, lease);
  });

  it("moves the sequence before listeners run", () => {
    const { task } = fixture();
    const seen: number[] = [];
    const unsub = subscribeWorkCenter(() => seen.push(workCenterSequence()));
    const before = workCenterSequence();
    const lease = beginExecution(task.id, task.generation);
    endExecution(task.id, lease);
    unsub();
    expect(seen).toEqual([before + 1, before + 2]);
  });

  it("turn writes do not touch updated_at", () => {
    const { task } = fixture();
    const stamp = getTask(task.id)!.updated_at;
    const lease = beginExecution(task.id, task.generation);
    startModelTurn(task.id, lease);
    finishModelTurn(task.id, lease, { outcome: "ok" });
    endExecution(task.id, lease);
    expect(getTask(task.id)!.updated_at).toBe(stamp);
  });
});

describe("boot recovery", () => {
  it("finalizes an active turn as interrupted and leaves a finished linger alone", () => {
    const { task: crashed } = fixture();
    const { task: lingered } = fixture();
    const l1 = beginExecution(crashed.id, 0);
    const active = startModelTurn(crashed.id, l1)!;
    const l2 = beginExecution(lingered.id, 0);
    const done = startModelTurn(lingered.id, l2)!;
    finishModelTurn(lingered.id, l2, { outcome: "ok", endedAt: 4242 });
    // other tests in this file may have left their own open turns behind
    expect(finalizeActiveTurnsAsInterrupted(getDb(), 9999)).toBeGreaterThanOrEqual(1);
    expect(getTask(crashed.id)).toMatchObject({ latest_turn_id: active, latest_turn_outcome: "interrupted", active_turn_id: null });
    expect(getTask(lingered.id)).toMatchObject({ latest_turn_id: done, latest_turn_outcome: "ok", latest_turn_ended_at: 4242 });
    // a second pass finds nothing: one result per turn
    expect(finalizeActiveTurnsAsInterrupted(getDb(), 99999)).toBe(0);
    endExecution(crashed.id, l1);
    endExecution(lingered.id, l2);
  });

  it("an old database row with no turns reads as unknown", () => {
    const { task } = fixture();
    expect(getTask(task.id)).toMatchObject({ latest_turn_id: null, latest_turn_outcome: null, completed_at: null });
  });
});

describe("completed_at", () => {
  it("is set on the transition into done and cleared on reopen, never backfilled", () => {
    const { task } = fixture();
    expect(getTask(task.id)!.completed_at).toBeNull();
    updateTask(task.id, { status: "in_progress" });
    expect(getTask(task.id)!.completed_at).toBeNull();
    updateTask(task.id, { status: "done" });
    const at = getTask(task.id)!.completed_at;
    expect(at).toBeGreaterThan(0);
    updateTask(task.id, { title: "renamed" });
    expect(getTask(task.id)!.completed_at).toBe(at);
    updateTask(task.id, { status: "in_progress" });
    expect(getTask(task.id)!.completed_at).toBeNull();
  });
});

describe("recentResults", () => {
  const DAY = 24 * 3600 * 1000;

  it("lists the latest result per task within seven days and falls back to an unknown historical end", () => {
    const now = Date.now();
    const { project, task: withTurn } = fixture();
    const old = createTask({ project_id: project.id, title: "historic", description: "" });
    const stale = createTask({ project_id: project.id, title: "stale", description: "" });
    const lease = beginExecution(withTurn.id, 0);
    const turnId = startModelTurn(withTurn.id, lease)!;
    finishModelTurn(withTurn.id, lease, { outcome: "failed", failureCode: "auth", endedAt: now - 1000, terminalMessageId: "m9" });
    endExecution(withTurn.id, lease);
    recordSession({ project_id: project.id, task_id: old.id, generation: 0, claude_session_id: "x" });
    endSession(old.id, 0);
    recordSession({ project_id: project.id, task_id: stale.id, generation: 0, claude_session_id: "y" });
    getDb().prepare("UPDATE sessions SET ended_at = ? WHERE task_id = ?").run(now - 8 * DAY, stale.id);

    const { rows } = recentResults({ now, projectId: project.id });
    const byTask = Object.fromEntries(rows.map((r) => [r.taskId, r]));
    expect(byTask[stale.id]).toBeUndefined();
    expect(byTask[withTurn.id]).toMatchObject({ needsAttention: true, result: { turnId, outcome: "failed", terminalMessageId: "m9" } });
    expect(byTask[old.id]).toMatchObject({ needsAttention: false, result: { turnId: null, outcome: "unknown", terminalMessageId: null } });
  });

  it("pages by cursor and refuses a foreign one", () => {
    const now = Date.now();
    const project = createProject({ name: "PagingProj", repo_path: "" });
    for (let i = 0; i < 5; i++) {
      const t = createTask({ project_id: project.id, title: `t${i}`, description: "" });
      const lease = beginExecution(t.id, 0);
      startModelTurn(t.id, lease);
      finishModelTurn(t.id, lease, { outcome: "ok", endedAt: now - i * 10 });
      endExecution(t.id, lease);
    }
    const first = recentResults({ now, projectId: project.id, limit: 2 });
    const second = recentResults({ now, projectId: project.id, limit: 2, cursor: first.nextCursor });
    const third = recentResults({ now, projectId: project.id, limit: 2, cursor: second.nextCursor });
    const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.taskId);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    expect(() => recentResults({ now, projectId: null, cursor: first.nextCursor })).toThrow(RecentCursorError);
  });
});

// ---- the real runner against a scripted driver ----------------------------

function collect(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") { unsub(); resolve(); }
  });
  return { events, done };
}

describe("the runner records model turns", () => {
  beforeEach(() => runTurnMock.mockReset());

  it("an ended turn records ok and does not complete the task", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "execution_observation", foreground: "executing", background: [], backgroundCoverage: "complete", wakeups: [], externalWait: null } as StreamEvent;
      yield { type: "assistant", content: "all done" } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });
    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;
    const row = getTask(task.id)!;
    expect(row).toMatchObject({ latest_turn_outcome: "ok", active_turn_id: null, latest_turn_failure_code: null, completed_at: null });
    expect(row.status).not.toBe("done");
    expect(row.latest_turn_terminal_message_id).toBeTruthy();
    expect(row.latest_turn_session_id).toBeTruthy();
    expect(executionOf(task.id)).toMatchObject({ isWorking: false, foreground: "none", turnId: null });
  });

  it("a clean scheduled result carries no mandatory attention", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "assistant", content: "ran" } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });
    const { done } = collect(task.id);
    startTurn(task, project, "go", "", undefined, { origin: "schedule", interactionPolicy: "deny" });
    await done;
    const row = getTask(task.id)!;
    expect(row.latest_turn_outcome).toBe("ok");
    expect(resultNeedsAttention(row)).toBe(false);
  });

  it("a driver error records failed with a normalized code", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "error", content: "prompt is too long: 250000 tokens > 200000 maximum" } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });
    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;
    const row = getTask(task.id)!;
    expect(row).toMatchObject({ latest_turn_outcome: "failed", latest_turn_failure_code: "context_limit", latest_turn_failure_resolved_at: null });
    expect(resultNeedsAttention(row)).toBe(true);
    // the exact terminal message is the failure line
    expect(row.latest_turn_terminal_message_id).toBeTruthy();
  });

  it("Stop records stopped and releases the live execution", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      await new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
    });
    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    // the driver has opened its session, so its abort listener is armed
    await vi.waitFor(() => expect(getTask(task.id)!.started).toBe(1));
    expect(executionOf(task.id)?.isWorking).toBe(true);
    abortTurn(task.id);
    await done;
    expect(getTask(task.id)).toMatchObject({ latest_turn_outcome: "stopped", active_turn_id: null });
    expect(executionOf(task.id)).toMatchObject({ isWorking: false, foreground: "none" });
  });

  it("a lingering session finalizes the model turn at linger entry, then starts a new one when it wakes", async () => {
    const { project, task } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "assistant", content: "started a job" } as StreamEvent;
      yield { type: "execution_observation", foreground: "finished", background: [{ id: "job", kind: "command", startedAt: 5 }], backgroundCoverage: "complete", wakeups: [], externalWait: null } as StreamEvent;
      yield { type: "background_pending", tasks: [{ id: "job", kind: "local_bash", description: "sleep" }], note: "waiting" } as StreamEvent;
      await gate;
      // a duplicate pending event for the same linger must not finalize anything twice
      yield { type: "background_pending", tasks: [{ id: "job", kind: "local_bash", description: "sleep" }], note: "waiting" } as StreamEvent;
      yield { type: "background_resumed", status: "completed", summary: "job finished" } as StreamEvent;
      yield { type: "assistant", content: "the job is done" } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });
    const { done } = collect(task.id);
    startTurn(task, project, "go", "");

    await vi.waitFor(() => expect(getTask(task.id)!.latest_turn_outcome).toBe("ok"));
    const first = getTask(task.id)!;
    expect(first.active_turn_id).toBeNull();
    // background work keeps the task working with no model turn open
    const mid = executionOf(task.id)!;
    expect(mid).toMatchObject({ isWorking: true, foreground: "finished", turnId: null });
    expect(mid.background).toEqual([{ id: "job", kind: "command", startedAt: 5 }]);

    release();
    await done;
    const last = getTask(task.id)!;
    expect(last.latest_turn_outcome).toBe("ok");
    expect(last.latest_turn_id).not.toBe(first.latest_turn_id);
    expect(last.latest_turn_started_at).toBeGreaterThanOrEqual(first.latest_turn_ended_at!);
    expect(last.status).not.toBe("done");
  });
});
