import { describe, expect, it, beforeEach, vi } from "vitest";

const started: { taskId: string; text: string }[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string) => {
    started.push({ taskId: task.id, text: userText });
  },
}));

// The real validator spawns a CLI session to read the command registry; drive
// it from the test instead so the unknown-command branch is reachable offline.
let promptCheck: { ok: boolean; error?: string; suggestions?: string[] } = { ok: true };
vi.mock("@/lib/schedule/commands", () => ({
  validatePrompt: async () => promptCheck,
}));

import { createProject, getTask, listTasks } from "@/lib/store";
import { createSchedule, getSchedule, lastRun, listRuns } from "@/lib/schedule/store";
import { runScheduleNow, tickSchedules } from "@/lib/scheduler";
import { getDb } from "@/lib/db";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";

const at = (iso: string) => Date.parse(iso);

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `sched-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

describe("scheduler", () => {
  beforeEach(() => {
    started.length = 0;
    promptCheck = { ok: true };
    // The preflight checks whether THIS schedule's agent is connected, and
    // never falls back — every schedule in this file runs the default agent
    // ("claude"), so the hermetic test environment (tests/setup.ts strips
    // credentials) needs an explicit connection record or every case would
    // fall into the "agent is not connected" branch instead of exercising the
    // launch. Mirrors tests/agentFallback.test.ts's `connect()` helper.
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
  });

  it("mints a fresh task per firing, tagged with its schedule", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "Jira triage", prompt: "/jira-tasks",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
      permission_mode: "bypassPermissions",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const tasks = listTasks(p.id).filter((t) => t.schedule_id === s.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain("Jira triage");
    expect(tasks[0].permission_mode).toBe("bypassPermissions");
    expect(started[0].text).toBe("/jira-tasks");
    expect(lastRun(s.id)!.status).toBe("running");
    expect(lastRun(s.id)!.task_id).toBe(tasks[0].id);
  });

  it("a second firing mints a SECOND task rather than reusing the first", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);
    await tickSchedules(Date.now());
    // Settle the first run so overlap doesn't skip the second.
    getDb().prepare("UPDATE schedule_runs SET status = 'succeeded', finished_at = ? WHERE schedule_id = ?")
      .run(Date.now(), s.id);
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);
    await tickSchedules(Date.now());

    expect(listTasks(p.id).filter((t) => t.schedule_id === s.id)).toHaveLength(2);
  });

  it("refuses to mint a doomed task when the project has no working directory", async () => {
    const p = createProject({ name: `norepo-${Math.random().toString(36).slice(2)}` });
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/working directory/i);
    expect(listTasks(p.id).filter((t) => t.schedule_id === s.id)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("refuses to mint a doomed task when the schedule's own project no longer exists", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);
    // Orphan the schedule: delete its project without cascading the delete onto
    // the schedule row itself (schedules.project_id is ON DELETE CASCADE), so
    // fireSchedule's own `!project` guard — not the FK — is what's under test.
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    getDb().pragma("foreign_keys = ON");

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toMatch(/no longer exists/i);
    expect(listTasks(p.id)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("refuses to mint a doomed task when its agent is not connected, and never falls back", async () => {
    const p = await projectWithRepo();
    // "codex" is a real registered agent id, but only "claude" is connected in
    // beforeEach — so this exercises isAgentConnected(schedule.agent) failing
    // for THIS agent specifically, with nothing to silently fall back to.
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go", agent: "codex",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("codex");
    expect(listTasks(p.id).filter((t) => t.schedule_id === s.id)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("Run now fires immediately without moving the next scheduled occurrence", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    const before = getSchedule(s.id)!.next_fire_at;

    const run = await runScheduleNow(s.id);

    expect(run!.trigger).toBe("manual");
    expect(getSchedule(s.id)!.next_fire_at).toBe(before);
    expect(started).toHaveLength(1);
  });

  it("refuses to run an unknown slash command, which would otherwise report success", async () => {
    promptCheck = { ok: false, error: "/jira-taks is not a command", suggestions: ["jira-tasks"] };
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "/jira-taks",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    const run = lastRun(s.id)!;
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("/jira-tasks"); // the suggestion, so it's fixable
    // Proves the check runs BEFORE minting, not just that startTurn was never
    // called — a regression that moved this check to fire after createTask
    // would otherwise pass this test unnoticed.
    expect(listTasks(p.id).filter((t) => t.schedule_id === s.id)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("does not fire a paused schedule", async () => {
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "n", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET enabled = 0, next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);

    await tickSchedules(Date.now());

    expect(started).toHaveLength(0);
    expect(listRuns(s.id, 10)).toHaveLength(0);
  });
});
