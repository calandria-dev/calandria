import { describe, expect, it, beforeEach, vi } from "vitest";

// Mirror tests/agentDriver.test.ts: mock the driver registry so the runner
// drives a scripted agent instead of a real CLI.
const events: Record<string, unknown>[] = [];
vi.mock("@/lib/agents/registry", () => ({
  getDriver: () => ({
    id: "mock",
    label: "Mock",
    async *runTurn() {
      yield { type: "session", sessionId: "s1" };
      for (const e of events) yield e;
      yield { type: "done", sessionId: "s1" };
    },
  }),
}));

// Mirror tests/runnerEarlyThrow.test.ts: track() calls inside run()'s own
// finally (turn_completed / turn_failed) are unguarded, so making one throw
// forces a crash that escapes run() entirely — before its OWN settle-the-
// schedule-run block ever runs. That is the only way to reach the
// last-resort `.catch` on the detached run() promise in startTurn(), which is
// what this file's "crash" test is really exercising.
const analyticsState = vi.hoisted(() => ({ failEvents: [] as string[] }));
vi.mock("@/lib/analytics", () => ({
  track: (event: string) => {
    if (analyticsState.failEvents.includes(event)) throw new Error(`simulated finally failure (${event})`);
  },
}));

import { createProject, createTask, getProject, getTask } from "@/lib/store";
import { claimRun, createSchedule, getRun, startRun } from "@/lib/schedule/store";
import { startTurn } from "@/lib/runner";
import { SCHEDULED_RUN_CONTEXT, getRunContext } from "@/lib/runContext";
import { hasTurn } from "@/lib/abort";

const settled = async () => {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (!hasTurn(taskId)) return;
  }
  throw new Error("turn never settled");
};

let taskId = "";

describe("scheduled turns in the runner", () => {
  let projectId = "";
  let runId = "";

  beforeEach(() => {
    events.length = 0;
    analyticsState.failEvents = [];
    const p = createProject({ name: `runner-${Math.random().toString(36).slice(2)}` });
    projectId = p.id;
    const s = createSchedule({
      project_id: projectId, name: "n", prompt: "/x",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    runId = claimRun(s.id, Date.now(), "scheduled")!.id;
    taskId = createTask({ project_id: projectId, title: "scheduled run" }).id;
    startRun(runId, taskId);
  });

  const scheduled = () => ({ ...SCHEDULED_RUN_CONTEXT, scheduleRunId: runId });

  it("settles the run as succeeded and leaves 'needs you' alone", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getRun(runId)!.status).toBe("succeeded");
    // Success is quiet: a scheduled run must not park itself in the "N need
    // you" pill forever.
    expect(getTask(taskId)!.awaiting_input).toBe(0);
  });

  it("settles a failed run and DOES surface it", async () => {
    events.push({ type: "error", content: "boom" });
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const run = getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("boom");
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("clears the run context when the turn ends", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    expect(getRunContext(taskId)).toBeUndefined();
  });

  it("leaves an ordinary turn's awaiting_input behaviour untouched", async () => {
    startTurn(getTask(taskId)!, getProject(projectId)!, "hello", "");
    await settled();
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("still settles the schedule run and clears the run context when run()'s own finally crashes", async () => {
    // turn_completed fires inside run()'s finally, unguarded, BEFORE the
    // schedule-run settle block below it — so throwing there simulates a
    // crash that escapes run() with its own settle block never reached
    // (the FOREIGN-KEY-on-a-deleted-row hazard tests/runnerEarlyThrow.test.ts
    // documents is one real-world way this happens; this is the same shape of
    // failure, provoked directly at the point that matters for this test).
    // The ONLY thing left that can settle the run and clear the context is
    // the last-resort `.catch` on startTurn's detached run() promise.
    analyticsState.failEvents = ["turn_completed", "turn_failed"];
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();
    const run = getRun(runId)!;
    // Terminal, not stuck at "claimed"/"running" forever.
    expect(run.status).not.toBe("claimed");
    expect(run.status).not.toBe("running");
    expect(run.finished_at).toBeGreaterThan(0);
    // The stale RunContext must not survive — otherwise a later, ORDINARY
    // turn on this same task would silently inherit interactionPolicy: "deny"
    // and have its own permission prompts auto-deny with no explanation.
    expect(getRunContext(taskId)).toBeUndefined();
  });
});
