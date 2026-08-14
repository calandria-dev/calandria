// Typed queries for schedules and their run ledger. DB only — no runner, no
// SDK (pinned by tests/importGraph.test.ts), so the ticker's adjudication can
// be tested without launching anything.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { nextFireAt, type ScheduleSpec } from "@/lib/schedule/time";
import type { Priority, Schedule, ScheduleRun, ScheduleRunStatus, ScheduleTrigger } from "@/lib/types";

/** How many run rows to keep per schedule. Audit records, not user work. */
export const RUN_RETENTION = 50;

export const specOf = (s: Schedule): ScheduleSpec => ({
  daysMask: s.days_mask,
  timeOfDay: s.time_of_day,
  timezone: s.timezone,
});

export function getSchedule(id: string): Schedule | null {
  return (getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule) ?? null;
}

export function listSchedules(projectId: string): Schedule[] {
  return getDb()
    .prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as Schedule[];
}

export function listEnabledSchedules(): Schedule[] {
  return getDb()
    .prepare("SELECT * FROM schedules WHERE enabled = 1 ORDER BY next_fire_at ASC")
    .all() as Schedule[];
}

export function createSchedule(input: {
  project_id: string;
  name: string;
  prompt: string;
  days_mask: number;
  time_of_day: string;
  timezone: string;
  agent?: string;
  permission_mode?: string | null;
  send_context?: boolean;
  priority?: Priority;
  catch_up_ms?: number;
}): Schedule {
  const now = Date.now();
  const id = nanoid();
  // Throws on an unusable spec — better a 400 at creation than a schedule that
  // silently never fires.
  const next = nextFireAt(
    { daysMask: input.days_mask, timeOfDay: input.time_of_day, timezone: input.timezone },
    now
  ).ms;
  getDb()
    .prepare(
      `INSERT INTO schedules (id, project_id, name, prompt, days_mask, time_of_day, timezone, enabled,
                              agent, permission_mode, send_context, priority, catch_up_ms, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.name, input.prompt, input.days_mask, input.time_of_day, input.timezone,
      input.agent || "claude", input.permission_mode ?? null, input.send_context === false ? 0 : 1,
      input.priority ?? "med", input.catch_up_ms ?? -1, next, now, now
    );
  return getSchedule(id)!;
}

const SPEC_FIELDS = ["days_mask", "time_of_day", "timezone"] as const;

export function updateSchedule(
  id: string,
  fields: Partial<Pick<Schedule, "name" | "prompt" | "days_mask" | "time_of_day" | "timezone" | "enabled"
    | "agent" | "permission_mode" | "send_context" | "priority" | "catch_up_ms">>
): Schedule | null {
  const before = getSchedule(id);
  if (!before) return null;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return before;

  // Recompute when the spec moves, and whenever a paused schedule resumes: on
  // resume the next occurrence is strictly after NOW, so unpausing something
  // parked for a month doesn't greet the user with a month of missed rows.
  // Decided from the INCOMING fields against the CURRENT row, not from a
  // before/after diff — the previous shape wrote first and validated after,
  // so a bad timezone or day_mask landed in the row (with next_fire_at frozen
  // stale) even though the route reported 400. Validating the merged spec
  // before any write means a bad edit can never be partially committed.
  const specChanged = SPEC_FIELDS.some((f) => f in fields && fields[f] !== before[f]);
  const resumed = "enabled" in fields && !before.enabled && !!fields.enabled;
  const setEntries: [string, unknown][] = [...entries];
  if (specChanged || resumed) {
    const mergedSpec: ScheduleSpec = {
      daysMask: fields.days_mask ?? before.days_mask,
      timeOfDay: fields.time_of_day ?? before.time_of_day,
      timezone: fields.timezone ?? before.timezone,
    };
    // Throws on an unusable spec — this must happen BEFORE the UPDATE below.
    setEntries.push(["next_fire_at", nextFireAt(mergedSpec, Date.now()).ms]);
  }

  getDb()
    .prepare(`UPDATE schedules SET ${setEntries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...setEntries.map(([, v]) => v as string | number | null), Date.now(), id);
  return getSchedule(id)!;
}

/** Recompute and persist next_fire_at from the spec. Also the boot revalidation. */
export function refreshNextFire(schedule: Schedule, afterMs = Date.now()): Schedule {
  const next = nextFireAt(specOf(schedule), afterMs).ms;
  getDb().prepare("UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?").run(next, Date.now(), schedule.id);
  return getSchedule(schedule.id)!;
}

/** Move next_fire_at past a slot we've just adjudicated. */
export function advanceNextFire(scheduleId: string, pastMs: number): void {
  const s = getSchedule(scheduleId);
  if (!s) return;
  const next = nextFireAt(specOf(s), pastMs).ms;
  getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(next, scheduleId);
}

export function deleteSchedule(id: string): void {
  getDb().prepare("DELETE FROM schedules WHERE id = ?").run(id);
}

// ---------- the run ledger ----------

/**
 * Claim an occurrence. Returns the new run, or null when this slot was already
 * claimed — the UNIQUE(schedule_id, scheduled_for) index is the adjudicator, so
 * two concurrent ticks (or a tick racing Run now) cannot both win.
 */
export function claimRun(scheduleId: string, scheduledFor: number, trigger: ScheduleTrigger, dstAdjusted = ""): ScheduleRun | null {
  const id = nanoid();
  const now = Date.now();
  try {
    getDb()
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, scheduled_for, claimed_at, status, trigger, dst_adjusted)
         VALUES (?, ?, ?, ?, 'claimed', ?, ?)`
      )
      .run(id, scheduleId, scheduledFor, now, trigger, dstAdjusted);
  } catch {
    return null; // UNIQUE violation: somebody else owns this slot
  }
  pruneRuns(scheduleId);
  return getRun(id);
}

export function getRun(id: string): ScheduleRun | null {
  return (getDb().prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as ScheduleRun) ?? null;
}

/** The turn actually launched: link the task and mark it live. */
export function startRun(runId: string, taskId: string): void {
  getDb()
    .prepare("UPDATE schedule_runs SET status = 'running', task_id = ?, fired_at = ? WHERE id = ?")
    .run(taskId, Date.now(), runId);
}

/** Terminal outcome. Idempotent — a settled run is never re-settled. */
export function settleRun(runId: string, status: ScheduleRunStatus, detail = ""): void {
  getDb()
    .prepare("UPDATE schedule_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ? AND finished_at = 0")
    .run(status, detail, Date.now(), runId);
}

/** A slot that elapsed while the app was down or the window had passed. */
export function recordMissedRun(scheduleId: string, scheduledFor: number, detail: string): void {
  const run = claimRun(scheduleId, scheduledFor, "scheduled");
  if (run) settleRun(run.id, "missed", detail);
}

/** A slot skipped because the previous run was still going. */
export function recordSkippedRun(scheduleId: string, scheduledFor: number, detail: string): void {
  const run = claimRun(scheduleId, scheduledFor, "scheduled");
  if (run) settleRun(run.id, "skipped_overlap", detail);
}

export function listRuns(scheduleId: string, limit = 20): ScheduleRun[] {
  return getDb()
    .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?")
    .all(scheduleId, limit) as ScheduleRun[];
}

export const lastRun = (scheduleId: string): ScheduleRun | null => listRuns(scheduleId, 1)[0] ?? null;

/** The run still in flight for this schedule, if any (overlap detection). */
export function activeRun(scheduleId: string): ScheduleRun | null {
  return (
    (getDb()
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND status IN ('claimed','running') ORDER BY scheduled_for DESC LIMIT 1")
      .get(scheduleId) as ScheduleRun) ?? null
  );
}

function pruneRuns(scheduleId: string): void {
  getDb()
    .prepare(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
         SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?
       )`
    )
    .run(scheduleId, scheduleId, RUN_RETENTION);
}
