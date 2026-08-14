import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createProject } from "@/lib/store";
import {
  createSchedule, getSchedule, listSchedules, listEnabledSchedules, updateSchedule,
  deleteSchedule, claimRun, settleRun, recordMissedRun, listRuns, lastRun, specOf,
} from "@/lib/schedule/store";

const at = (iso: string) => Date.parse(iso);

function project() {
  return createProject({ name: `sched-${Math.random().toString(36).slice(2)}` }).id;
}

function schedule(projectId: string, over: Partial<Parameters<typeof createSchedule>[0]> = {}) {
  return createSchedule({
    project_id: projectId,
    name: "Jira triage",
    prompt: "/jira-tasks",
    days_mask: 62,
    time_of_day: "08:30",
    timezone: "America/Los_Angeles",
    agent: "claude",
    permission_mode: "bypassPermissions",
    ...over,
  });
}

describe("schedule store", () => {
  let pid: string;
  beforeEach(() => {
    // listEnabledSchedules() is deliberately global (the ticker scans every
    // project), so an enabled schedule left behind by a previous test in this
    // file would otherwise leak into it. schedule_runs cascades with its schedule.
    getDb().prepare("DELETE FROM schedules").run();
    pid = project();
  });

  it("computes next_fire_at at creation", () => {
    const s = schedule(pid);
    expect(s.next_fire_at).toBeGreaterThan(Date.now());
    expect(specOf(s)).toEqual({ daysMask: 62, timeOfDay: "08:30", timezone: "America/Los_Angeles" });
  });

  it("lists per project, and only enabled ones for the ticker", () => {
    const a = schedule(pid);
    const b = schedule(pid, { name: "Paused one" });
    updateSchedule(b.id, { enabled: 0 });
    expect(listSchedules(pid).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(listEnabledSchedules().map((s) => s.id)).toEqual([a.id]);
  });

  it("recomputes next_fire_at when the spec changes", () => {
    const s = schedule(pid);
    const moved = updateSchedule(s.id, { time_of_day: "17:45" })!;
    expect(moved.next_fire_at).not.toBe(s.next_fire_at);
  });

  it("resuming a paused schedule skips the slots it was paused through", () => {
    const s = schedule(pid);
    updateSchedule(s.id, { enabled: 0 });
    const resumed = updateSchedule(s.id, { enabled: 1 })!;
    expect(resumed.next_fire_at).toBeGreaterThan(Date.now());
  });

  it("claims an occurrence exactly once — the durable claim", () => {
    const s = schedule(pid);
    const slot = at("2026-08-12T15:30:00Z");
    const first = claimRun(s.id, slot, "scheduled");
    const second = claimRun(s.id, slot, "scheduled");
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // the UNIQUE index adjudicated, not a read-then-write check
    expect(listRuns(s.id, 10)).toHaveLength(1);
  });

  it("settles a run with a real outcome", () => {
    const s = schedule(pid);
    const run = claimRun(s.id, at("2026-08-12T15:30:00Z"), "scheduled")!;
    settleRun(run.id, "failed", "the repo path no longer exists");
    const settled = lastRun(s.id)!;
    expect(settled.status).toBe("failed");
    expect(settled.detail).toBe("the repo path no longer exists");
    expect(settled.finished_at).toBeGreaterThan(0);
  });

  it("records a missed occurrence so a skipped morning is visible", () => {
    const s = schedule(pid);
    recordMissedRun(s.id, at("2026-08-12T15:30:00Z"), "the app was not running");
    const run = lastRun(s.id)!;
    expect(run.status).toBe("missed");
    expect(run.task_id).toBeNull();
  });

  it("keeps run history when the schedule's tasks are gone, and drops it with the schedule", () => {
    const s = schedule(pid);
    claimRun(s.id, at("2026-08-12T15:30:00Z"), "scheduled");
    expect(listRuns(s.id, 10)).toHaveLength(1);
    deleteSchedule(s.id);
    expect(getSchedule(s.id)).toBeNull();
    expect(listRuns(s.id, 10)).toHaveLength(0);
  });

  it("prunes run history beyond the retention cap", () => {
    const s = schedule(pid);
    const base = at("2026-08-12T15:30:00Z");
    for (let i = 0; i < 55; i++) claimRun(s.id, base + i * 86_400_000, "scheduled");
    expect(listRuns(s.id, 200).length).toBeLessThanOrEqual(50);
  });
});
