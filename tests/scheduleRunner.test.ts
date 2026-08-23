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

import { createProject, createTask, getProject, getTask } from "@/lib/store";
import { claimRun, createSchedule, getRun, startRun } from "@/lib/schedule/store";
import { startTurn } from "@/lib/runner";
import { SCHEDULED_RUN_CONTEXT, getRunContext, recordUnattendedDenial } from "@/lib/runContext";
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

  it("settles a run whose tool calls were auto-denied as FAILED, not as a green 'ran'", async () => {
    // The silent-success case, and the one this whole feature exists to make
    // impossible. Under any mode but Auto-run a scheduled turn's permission
    // prompts are declined automatically (nobody is there to answer), so the
    // agent stops partway with the job half done — and the run recorded
    // `succeeded`, because the status was computed from stopped/error/opened
    // only. The runner already tracked this to park the pending queue; it just
    // never told the schedule card.
    events.push({
      type: "permission",
      request: { id: "perm:tu_1", tool: "Bash", title: "npm run deploy", detail: "npm run deploy", expiresAt: 0 },
    });
    events.push({
      type: "permission_decided",
      id: "perm:tu_1",
      outcome: { decision: "deny", auto: true, reason: "unattended", note: "Nobody was watching." },
    });
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, scheduled());
    await settled();

    const run = getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/needed approval and nobody was watching/i);
    // And it raises its hand, like every other scheduled failure.
    expect(getTask(taskId)!.awaiting_input).toBe(1);
  });

  it("a run denied through the ask_user bridge settles the same way", async () => {
    // The Codex path has no permission event stream of its own — the bridge
    // records the denial on the RunContext instead (lib/agentTools.ts). Both
    // roads have to reach the same verdict, or "the turn stopped short because
    // nobody was there" would mean different things per agent.
    const ctx = scheduled();
    startTurn(getTask(taskId)!, getProject(projectId)!, "/x", "", undefined, ctx);
    recordUnattendedDenial(taskId);
    await settled();

    expect(getRun(runId)!.status).toBe("failed");
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

  it("still settles the schedule run and clears the run context on a clean finish", async () => {
    // A crash that escapes run()'s own finally (see tests/runnerEarlyThrow.test.ts
    // for how that's provoked) would leave settling the run and clearing the
    // context to the last-resort `.catch` on startTurn's detached run() promise.
    // This confirms the ordinary, non-crashing path reaches the same terminal
    // state via run()'s own finally.
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
