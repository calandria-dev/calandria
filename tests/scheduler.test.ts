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
import { activeRun, claimRun, createSchedule, getSchedule, lastRun, listRuns } from "@/lib/schedule/store";
import { fireSchedule, runScheduleNow, schedulerHealth, tickSchedules } from "@/lib/scheduler";
import { reapInFlightScheduleRuns } from "@/lib/db";
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

  it("titles the minted task on the SCHEDULE's clock, not UTC", async () => {
    // The single most visible artifact of the whole feature. toISOString() gave
    // an 08:30 America/Los_Angeles job a task called "… — 2026-08-14 15:30",
    // which is the feature contradicting, in its own output, the one thing it
    // is fastidious about. Tests run on a UTC host, exactly like the container.
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "Morning triage", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    // Claim the 08:30 Pacific slot explicitly so the title is deterministic.
    const run = claimRun(s.id, at("2026-08-14T15:30:00Z"), "scheduled")!;
    await fireSchedule(getSchedule(s.id)!, run);

    const task = listTasks(p.id).find((t) => t.schedule_id === s.id)!;
    expect(task.title).toBe("Morning triage: 2026-08-14 08:30");
  });

  it("clears lastError on a clean sweep instead of crying wolf forever", async () => {
    // The banner said "the last scheduler tick failed" for the rest of the
    // process's life after ONE transient failure, while every schedule kept
    // firing correctly. An alarm that never goes off is one the user learns to
    // scroll past — the same disease as a schedule that cries wolf every
    // morning, which this feature explicitly refuses to have.
    const p = await projectWithRepo();
    const bad = createSchedule({
      project_id: p.id, name: "Broken zone", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    // A timezone that no longer resolves — adjudication throws on this row and
    // the sweep must survive it, named.
    getDb().prepare("UPDATE schedules SET timezone = 'Mars/Olympus', next_fire_at = ? WHERE id = ?")
      .run(Date.now() - 1_000, bad.id);

    await tickSchedules(Date.now());
    expect(schedulerHealth().lastError).toContain("Broken zone"); // WHICH schedule, not "the tick"
    expect(schedulerHealth().lastTickAt).toBeGreaterThan(0);

    // Fix it; the very next clean sweep takes the banner down.
    getDb().prepare("UPDATE schedules SET timezone = 'America/Los_Angeles' WHERE id = ?").run(bad.id);
    await tickSchedules(Date.now());
    expect(schedulerHealth().lastError).toBe("");
  });

  it("recovers a schedule wedged by a run row orphaned mid-launch", async () => {
    // A crash between claimRun and startRun leaves a `claimed` row with no
    // task_id, which isScheduleBusy() reads as "mid-launch" forever: every
    // later occurrence is skipped_overlap, and the card's Stop button never
    // renders because it is gated on blocking.task_id.
    const p = await projectWithRepo();
    const s = createSchedule({
      project_id: p.id, name: "wedged", prompt: "go",
      days_mask: 127, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    claimRun(s.id, Date.now() - 86_400_000, "scheduled");
    // Two DISTINCT due slots: both ticks below adjudicate the slot they find in
    // next_fire_at, and the unique claim is (schedule, scheduled_for) — reusing
    // one instant would make the second tick collide with the skip row the
    // first one wrote, and pass this test for the wrong reason.
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 120_000, s.id);

    await tickSchedules(Date.now());
    expect(lastRun(s.id)!.status).toBe("skipped_overlap");
    expect(started).toHaveLength(0);

    // The boot reaper (lib/db.ts init) is what breaks the deadlock.
    reapInFlightScheduleRuns(getDb());
    expect(activeRun(s.id)).toBeNull();
    getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(Date.now() - 1_000, s.id);
    await tickSchedules(Date.now());
    expect(started).toHaveLength(1);
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
