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
});
