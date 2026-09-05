import { describe, expect, it, beforeEach, vi } from "vitest";

const started: { taskId: string; text: string }[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string) => {
    started.push({ taskId: task.id, text: userText });
  },
}));
vi.mock("@/lib/schedule/commands", () => ({ validatePrompt: async () => ({ ok: true }) }));

import { createProject, listTasks } from "@/lib/store";
import { getDb } from "@/lib/db";
import { createSchedule, getSchedule, lastRun } from "@/lib/schedule/store";
import { createRunbook, deleteRunbook } from "@/lib/runbooks/store";
import { tickSchedules } from "@/lib/scheduler";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `link-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}
const due = (id: string) => getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, id);
const link = (scheduleId: string, runbookId: string) =>
  getDb().prepare("UPDATE schedules SET runbook_id = ? WHERE id = ?").run(runbookId, scheduleId);

describe("a schedule that fires a runbook", () => {
  beforeEach(() => {
    started.length = 0;
    getDb().prepare("DELETE FROM schedules").run();
    getDb().prepare("DELETE FROM runbooks").run();
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
  });

  it("fires the RUNBOOK's prompt and config, not the schedule's own columns", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/from-runbook", priority: "hi", permission_mode: "plan" });
    const s = createSchedule({
      project_id: p.id, name: "Morning", prompt: "/stale-fallback", priority: "lo",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    link(s.id, rb.id);
    due(s.id);

    await tickSchedules(Date.now());

    expect(started[0].text).toBe("/from-runbook");
    const task = listTasks(p.id).find((t) => t.schedule_id === s.id)!;
    expect(task.priority).toBe("hi");
    expect(task.permission_mode).toBe("plan");
    expect(task.runbook_id).toBe(rb.id);
    // The title still comes from the schedule: that's what the user named the
    // occurrence, and it's what the run ledger reads by.
    expect(task.title).toContain("Morning");
  });

  it("falls back to its own columns after the runbook is deleted, with the recipe carried over", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/from-runbook" });
    const s = createSchedule({
      project_id: p.id, name: "Morning", prompt: "/stale-fallback",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    link(s.id, rb.id);

    deleteRunbook(rb.id);
    due(s.id);
    await tickSchedules(Date.now());

    // deleteRunbook copies the live recipe back, so the schedule keeps firing
    // what it fired yesterday instead of something stale from before the link
    // was made.
    expect(started[0].text).toBe("/from-runbook");
    expect(getSchedule(s.id)!.runbook_id).toBeNull();
  });

  it("a link to a runbook in another project fails the run rather than firing the wrong repo's recipe", async () => {
    const p = await projectWithRepo();
    const other = await projectWithRepo();
    const rb = createRunbook({ project_id: other.id, name: "Foreign", prompt: "/foreign" });
    const s = createSchedule({
      project_id: p.id, name: "Morning", prompt: "/own",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    link(s.id, rb.id);
    due(s.id);

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/different project/i);
    expect(started).toHaveLength(0);
  });

  it("an unlinked schedule is completely unaffected", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "Morning", prompt: "/own",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    due(s.id);

    await tickSchedules(Date.now());

    expect(started[0].text).toBe("/own");
    expect(listTasks(p.id).find((t) => t.schedule_id === s.id)!.runbook_id).toBeNull();
  });
});
