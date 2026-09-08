// Typed queries for schedules and their run ledger. DB only, no runner and no
// SDK (pinned by tests/importGraph.test.ts), so the ticker's adjudication can
// be tested without launching anything.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { emitScheduleFailed } from "@/lib/notifications/notify";
import { nextFireAt, type ScheduleSpec } from "@/lib/schedule/time";
import type { Priority, Schedule, ScheduleRun, ScheduleRunStatus, ScheduleTrigger } from "@/lib/types";

/** How many run rows to keep per schedule (audit records, pruned on a cap). */
export const RUN_RETENTION = 50;

export const specOf = (s: Schedule): ScheduleSpec => ({
  daysMask: s.days_mask,
  timeOfDay: s.time_of_day,
  timezone: s.timezone,
  onceDate: s.once_date,
});

/**
 * Marks a one-time schedule as fired: disabled, pointed at nothing.
 *
 * The row is not deleted. The run ledger hangs off it via ON DELETE CASCADE,
 * and its outcome is read after the fact, so deleting is left to the user.
 */
export function spendSchedule(id: string): void {
  getDb().prepare("UPDATE schedules SET next_fire_at = 0, enabled = 0 WHERE id = ?").run(id);
}

/** What a caller is told when a one-time date is behind the clock. */
const PAST_ONCE = "that one-time date and time has already passed";

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
  /** Fire this runbook's recipe instead of `prompt` and the config above. */
  runbook_id?: string | null;
  /** 'YYYY-MM-DD' for a one-time schedule; '' (the default) for a weekly one. */
  once_date?: string;
}): Schedule {
  const now = Date.now();
  const id = nanoid();
  const onceDate = input.once_date ?? "";
  // A one-time schedule's mask is never read, but the column is NOT NULL and
  // the row must stay convertible back to weekly. An absent mask lands as
  // "every day" so it won't make nextFireAt throw later.
  const daysMask = Number.isInteger(input.days_mask) && input.days_mask > 0 && input.days_mask <= 127
    ? input.days_mask
    : (onceDate ? 127 : input.days_mask);
  // Throws on an unusable spec, so creation fails with a 400 instead of
  // producing a schedule that never fires. Null means a one-time date already
  // behind us, treated the same way.
  const next = nextFireAt({ daysMask, timeOfDay: input.time_of_day, timezone: input.timezone, onceDate }, now);
  if (!next) throw new Error(PAST_ONCE);
  getDb()
    .prepare(
      `INSERT INTO schedules (id, project_id, name, prompt, days_mask, time_of_day, timezone, enabled,
                              agent, permission_mode, send_context, priority, catch_up_ms, runbook_id, once_date, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.name, input.prompt, daysMask, input.time_of_day, input.timezone,
      input.agent || "claude", input.permission_mode ?? null, input.send_context === false ? 0 : 1,
      input.priority ?? "med", input.catch_up_ms ?? -1, input.runbook_id ?? null, onceDate, next.ms, now, now
    );
  return getSchedule(id)!;
}

const SPEC_FIELDS = ["days_mask", "time_of_day", "timezone", "once_date"] as const;

export function updateSchedule(
  id: string,
  fields: Partial<Pick<Schedule, "name" | "prompt" | "days_mask" | "time_of_day" | "timezone" | "enabled"
    | "agent" | "permission_mode" | "send_context" | "priority" | "catch_up_ms" | "runbook_id" | "once_date">>
): Schedule | null {
  const before = getSchedule(id);
  if (!before) return null;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return before;

  // Recompute when the spec moves, and whenever a paused schedule resumes: on
  // resume the next occurrence must be strictly after now, so unpausing
  // something parked for a month doesn't produce a month of missed rows.
  // Decided from the incoming fields against the current row so validating
  // the merged spec happens before any write, and a bad edit can't be
  // partially committed.
  const specChanged = SPEC_FIELDS.some((f) => f in fields && fields[f] !== before[f]);
  const resumed = "enabled" in fields && !before.enabled && !!fields.enabled;
  const setEntries: [string, unknown][] = [...entries];
  if (specChanged || resumed) {
    const mergedSpec: ScheduleSpec = {
      daysMask: fields.days_mask ?? before.days_mask,
      timeOfDay: fields.time_of_day ?? before.time_of_day,
      timezone: fields.timezone ?? before.timezone,
      onceDate: fields.once_date ?? before.once_date,
    };
    // Throws on an unusable spec; this must happen before the UPDATE below.
    const next = nextFireAt(mergedSpec, Date.now());
    // A one-time date in the past is refused. Both ways of reaching here ask
    // for something impossible: moving a job to a moment that has passed, or
    // unpausing one that already fired. Spending it again would report
    // success and do nothing.
    if (!next) throw new Error(PAST_ONCE);
    setEntries.push(["next_fire_at", next.ms]);
    // Re-arm a spent one-time whose date has just been moved forward.
    // Without this, editing "check on it at 04:00" (already fired) to
    // tomorrow would report success and show the new time but never run,
    // since spendSchedule left enabled at 0 and an ordinary date edit
    // doesn't restore it. A paused-but-unfired one-time is a different row
    // (next_fire_at > 0) and stays paused; an explicit `enabled` in the same
    // call always wins.
    const spent = !!before.once_date && !before.enabled && before.next_fire_at === 0;
    if (spent && !("enabled" in fields)) setEntries.push(["enabled", 1]);
  }

  getDb()
    .prepare(`UPDATE schedules SET ${setEntries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...setEntries.map(([, v]) => v as string | number | null), Date.now(), id);
  return getSchedule(id)!;
}

/** Recompute and persist next_fire_at from the spec. Also the boot revalidation. */
export function refreshNextFire(schedule: Schedule, afterMs = Date.now()): Schedule {
  const next = nextFireAt(specOf(schedule), afterMs);
  if (!next) {
    spendSchedule(schedule.id);
    return getSchedule(schedule.id)!;
  }
  getDb().prepare("UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?").run(next.ms, Date.now(), schedule.id);
  return getSchedule(schedule.id)!;
}

/** Move next_fire_at past a slot we've just adjudicated. */
export function advanceNextFire(scheduleId: string, pastMs: number): void {
  const s = getSchedule(scheduleId);
  if (!s) return;
  const next = nextFireAt(specOf(s), pastMs);
  // No next occurrence means a one-time schedule whose slot was just
  // adjudicated. This is where a one-time is spent on the happy path, in the
  // same step the recurring case advances, before the launch, so a crash
  // between here and the turn can't leave it re-firing every tick forever.
  if (!next) return spendSchedule(scheduleId);
  getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(next.ms, scheduleId);
}

export function deleteSchedule(id: string): void {
  getDb().prepare("DELETE FROM schedules WHERE id = ?").run(id);
}

// ---------- the run ledger ----------

/**
 * Claim an occurrence. Returns the new run, or null when this slot was already
 * claimed: the UNIQUE(schedule_id, scheduled_for) index adjudicates, so two
 * concurrent ticks (or a tick racing Run now) cannot both win.
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
  } catch (err) {
    // Only the unique index means "somebody else owns this slot". A bare
    // catch { return null } would also read SQLITE_BUSY, a full disk, or a
    // foreign key pointing at a schedule that was just deleted as a lost
    // race, leaving no row, no log, no trace behind. So this narrows the
    // catch and lets anything else propagate: every caller runs inside a
    // guard that records and reports it (the sweep's per-schedule catch, the
    // route's 500).
    if (!isUniqueViolation(err)) {
      console.error(`[schedule] could not claim ${scheduleId} @ ${scheduledFor}:`, err);
      throw err;
    }
    return null;
  }
  pruneRuns(scheduleId);
  return getRun(id);
}

/** The UNIQUE(schedule_id, scheduled_for) index rejecting a duplicate claim. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY")) return true;
  // better-sqlite3 always sets `code`, but the message check keeps an older
  // build (or a driver swap) from turning a real duplicate into a thrown error.
  return /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err));
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

/** Terminal outcome. Idempotent: a settled run is never re-settled. */
export function settleRun(runId: string, status: ScheduleRunStatus, detail = ""): void {
  const res = getDb()
    .prepare("UPDATE schedule_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ? AND finished_at = 0")
    .run(status, detail, Date.now(), runId);
  // A failed run is a failure nobody may be watching for: a run that fell
  // over in preflight never minted a task to notice, and nothing else on
  // the bus covers it. This hooks the single function all four `failed`
  // settle sites go through, instead of each one separately.
  //
  // Gated on `changes` so the idempotent re-settle above can't notify twice.
  // Wrapped because this runs inside the runner's `finally`: a notification
  // failure must never leave a run unsettled.
  if (status !== "failed" || res.changes === 0) return;
  try {
    const run = getRun(runId);
    if (!run) return;
    const schedule = getSchedule(run.schedule_id);
    emitScheduleFailed({
      scheduleName: schedule?.name || "Scheduled run",
      projectId: schedule?.project_id ?? "",
      taskId: run.task_id ?? "",
      detail,
    });
  } catch (err) {
    console.error("[schedule] failed-run notification failed:", err);
  }
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

/**
 * Every status a run row can hold, as data. The /metrics exposition
 * zero-fills from this so a status nothing has hit yet still appears as a
 * series (an absent one reports no alert). The line below fails to compile
 * if a new member is added to ScheduleRunStatus without being listed here.
 */
export const SCHEDULE_RUN_STATUSES = [
  "claimed", "running", "succeeded", "failed", "stopped", "interrupted", "missed", "skipped_overlap",
] as const satisfies readonly ScheduleRunStatus[];
const _statusesAreExhaustive: never[] = [] as Exclude<ScheduleRunStatus, (typeof SCHEDULE_RUN_STATUSES)[number]>[];
void _statusesAreExhaustive;

/**
 * How many run rows sit at each status right now, across every schedule.
 *
 * A snapshot of the ledger: pruneRuns() caps each schedule at RUN_RETENTION
 * rows, so these numbers fall as history ages out. /metrics exports them as
 * a gauge for that reason; read as a counter, a prune would look like a
 * negative rate.
 */
export function runCountsByStatus(): Record<ScheduleRunStatus, number> {
  const counts = Object.fromEntries(SCHEDULE_RUN_STATUSES.map((s) => [s, 0])) as Record<ScheduleRunStatus, number>;
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM schedule_runs GROUP BY status")
    .all() as { status: ScheduleRunStatus; n: number }[];
  for (const row of rows) {
    // A status the app no longer mints (an older build's row surviving an
    // upgrade) is dropped: the exposition's label set is fixed by the array
    // above, and inventing a series from database content would let a stale
    // row define a metric's shape.
    if (row.status in counts) counts[row.status] = row.n;
  }
  return counts;
}

/** Statuses that mean somebody is still watching this row: never prunable. */
const ACTIVE_STATUSES = "'claimed','running'";

/** The run still in flight for this schedule, if any (overlap detection). */
export function activeRun(scheduleId: string): ScheduleRun | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? AND status IN (${ACTIVE_STATUSES}) ORDER BY scheduled_for DESC LIMIT 1`)
      .get(scheduleId) as ScheduleRun) ?? null
  );
}

// Retention is a hard cap by scheduled_for DESC and doesn't track what's
// still live. A burst of manual "Run now" firings while one run is wedged
// could push that claimed/running row out of the top RUN_RETENTION and
// delete it out from under activeRun(), so the overlap check would see
// nothing busy and let a second run start on top of it. Active rows are
// excluded from the candidate set entirely, so they survive no matter how
// far retention pushes past them; they only go once they've settled into a
// terminal status.
function pruneRuns(scheduleId: string): void {
  getDb()
    .prepare(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND status NOT IN (${ACTIVE_STATUSES}) AND id NOT IN (
         SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?
       )`
    )
    .run(scheduleId, scheduleId, RUN_RETENTION);
}
