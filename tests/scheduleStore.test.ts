import { describe, expect, it, beforeEach } from "vitest";
import { getDb, reapInFlightScheduleRuns } from "@/lib/db";
import { createProject, createTask } from "@/lib/store";
import {
  createSchedule, getSchedule, listSchedules, listEnabledSchedules, updateSchedule,
  deleteSchedule, claimRun, settleRun, startRun, activeRun, recordMissedRun, listRuns, lastRun, specOf,
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

  it("reports a claim failure that ISN'T the durable claim, instead of eating it", () => {
    // A bare `catch { return null }` read EVERY insert failure as "somebody
    // else owns this slot": SQLITE_BUSY, a full disk, a foreign key pointing at
    // a schedule that was just deleted. A lost race is silent by design — no
    // row, no log, nothing in the ledger — so this was the one place in the
    // feature where a skip left no trace at all. Only the unique index gets to
    // mean that; anything else comes out.
    expect(() => claimRun("no-such-schedule", at("2026-08-12T15:30:00Z"), "scheduled")).toThrow(/FOREIGN KEY/i);
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
    // Settled, like real history — an unsettled ("claimed") row is exactly the
    // case the next test covers, and pruning must never touch it.
    for (let i = 0; i < 55; i++) {
      const run = claimRun(s.id, base + i * 86_400_000, "scheduled")!;
      settleRun(run.id, "succeeded");
    }
    expect(listRuns(s.id, 200).length).toBeLessThanOrEqual(50);
  });

  it("never prunes a claimed/running row, however far retention pushes past it", () => {
    // Oldest row stays claimed (e.g. a wedged "Run now") while enough newer,
    // settled rows accumulate to push it out of the top-RUN_RETENTION window.
    // Before the fix, pruneRuns deleted it purely by rank — activeRun() then
    // stopped seeing anything busy and a second run could overlap it.
    const s = schedule(pid);
    const base = at("2026-08-12T15:30:00Z");
    const stuck = claimRun(s.id, base, "scheduled")!;
    for (let i = 1; i <= 55; i++) {
      const run = claimRun(s.id, base + i * 86_400_000, "scheduled")!;
      settleRun(run.id, "succeeded");
    }
    expect(activeRun(s.id)?.id).toBe(stuck.id);
    expect(listRuns(s.id, 200).some((r) => r.id === stuck.id)).toBe(true);
    // Retention still holds for everything that HAS settled.
    expect(listRuns(s.id, 200).length).toBeLessThanOrEqual(51);
  });

  it("settles a run left mid-flight by a crash, so overlap detection recovers", () => {
    // isScheduleBusy() treats a `claimed` row with no task as "mid-launch", so
    // a process that died between claimRun and startRun leaves the schedule
    // permanently busy: every later occurrence records `skipped_overlap`, and
    // the card's Stop control is gated on the blocking run having a task_id,
    // which this one never got. Nothing recovered it until retention pruned the
    // row ~50 occurrences later.
    const s = schedule(pid);
    const stuckClaim = claimRun(s.id, at("2026-08-12T15:30:00Z"), "scheduled")!;
    const stuckRunning = claimRun(s.id, at("2026-08-13T15:30:00Z"), "scheduled")!;
    startRun(stuckRunning.id, createTask({ project_id: pid, title: "in flight" }).id);
    const finished = claimRun(s.id, at("2026-08-11T15:30:00Z"), "scheduled")!;
    settleRun(finished.id, "succeeded");

    expect(activeRun(s.id)).not.toBeNull();
    // >= 2: earlier cases in this file leave claimed rows of their own behind,
    // and the reaper is deliberately instance-wide.
    expect(reapInFlightScheduleRuns(getDb())).toBeGreaterThanOrEqual(2);

    for (const id of [stuckClaim.id, stuckRunning.id]) {
      const row = listRuns(s.id, 10).find((r) => r.id === id)!;
      expect(row.status).toBe("interrupted");
      expect(row.detail).toMatch(/restarted/i);
      expect(row.finished_at).toBeGreaterThan(0);
    }
    // The whole point: the schedule is free to fire again.
    expect(activeRun(s.id)).toBeNull();
    // An already-settled row is left exactly as it was.
    expect(listRuns(s.id, 10).find((r) => r.id === finished.id)!.status).toBe("succeeded");
  });
});
