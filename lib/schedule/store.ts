// Typed queries for schedules and their run ledger. DB only — no runner, no
// SDK (pinned by tests/importGraph.test.ts), so the ticker's adjudication can
// be tested without launching anything.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { emitScheduleFailed } from "@/lib/notifications/notify";
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
  /** Fire this runbook's recipe instead of `prompt` and the config above. */
  runbook_id?: string | null;
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
                              agent, permission_mode, send_context, priority, catch_up_ms, runbook_id, next_fire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.name, input.prompt, input.days_mask, input.time_of_day, input.timezone,
      input.agent || "claude", input.permission_mode ?? null, input.send_context === false ? 0 : 1,
      input.priority ?? "med", input.catch_up_ms ?? -1, input.runbook_id ?? null, next, now, now
    );
  return getSchedule(id)!;
}

const SPEC_FIELDS = ["days_mask", "time_of_day", "timezone"] as const;

export function updateSchedule(
  id: string,
  fields: Partial<Pick<Schedule, "name" | "prompt" | "days_mask" | "time_of_day" | "timezone" | "enabled"
    | "agent" | "permission_mode" | "send_context" | "priority" | "catch_up_ms" | "runbook_id">>
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
  } catch (err) {
    // ONLY the unique index means "somebody else owns this slot". A bare
    // `catch { return null }` read every other failure — SQLITE_BUSY, a full
    // disk, a foreign key pointing at a schedule that was just deleted — as a
    // lost race too, and a lost race is silent by design: no row, no log, no
    // trace. That is the one place in this feature where a skip leaves nothing
    // behind at all, which is precisely what the whole design forbids. So
    // narrow it, and let anything else out: every caller runs inside a guard
    // that records and reports (the sweep's per-schedule catch, the route's
    // 500) rather than swallowing.
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

/** Terminal outcome. Idempotent — a settled run is never re-settled. */
export function settleRun(runId: string, status: ScheduleRunStatus, detail = ""): void {
  const res = getDb()
    .prepare("UPDATE schedule_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ? AND finished_at = 0")
    .run(status, detail, Date.now(), runId);
  // A failed run is the one failure in this app with no witness: nobody is
  // watching at 08:30, and a run that fell over in preflight never minted a
  // task to notice. This is the only notification source that isn't on the bus,
  // so it is hooked at the single function all four `failed` settle sites go
  // through rather than at each of them.
  //
  // Gated on `changes` so the idempotent re-settle above can't notify twice,
  // and wrapped because this runs inside the runner's `finally`: a notification
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
 * Every status a run row can hold, as data — the /metrics exposition zero-fills
 * from this so a status nothing has hit yet is still a series (an absent one
 * silently answers no alert). The line below fails to compile if a new member
 * is added to ScheduleRunStatus without being listed here.
 */
export const SCHEDULE_RUN_STATUSES = [
  "claimed", "running", "succeeded", "failed", "stopped", "interrupted", "missed", "skipped_overlap",
] as const satisfies readonly ScheduleRunStatus[];
const _statusesAreExhaustive: never[] = [] as Exclude<ScheduleRunStatus, (typeof SCHEDULE_RUN_STATUSES)[number]>[];
void _statusesAreExhaustive;

/**
 * How many run rows sit at each status right now, across every schedule.
 *
 * A SNAPSHOT of the ledger, not a tally of everything that ever ran: pruneRuns()
 * caps each schedule at RUN_RETENTION rows, so these numbers fall as history
 * ages out. That's why /metrics exports them as a gauge — read as a counter,
 * a prune would look like a negative rate.
 */
export function runCountsByStatus(): Record<ScheduleRunStatus, number> {
  const counts = Object.fromEntries(SCHEDULE_RUN_STATUSES.map((s) => [s, 0])) as Record<ScheduleRunStatus, number>;
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM schedule_runs GROUP BY status")
    .all() as { status: ScheduleRunStatus; n: number }[];
  for (const row of rows) {
    // A status the app no longer mints (an older build's row surviving an
    // upgrade) is dropped rather than added: the exposition's label set is
    // fixed by the array above, and inventing a series from database content
    // would let a stale row define a metric's shape.
    if (row.status in counts) counts[row.status] = row.n;
  }
  return counts;
}

/** Statuses that mean "somebody is still watching this row" — never prunable. */
const ACTIVE_STATUSES = "'claimed','running'";

/** The run still in flight for this schedule, if any (overlap detection). */
export function activeRun(scheduleId: string): ScheduleRun | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? AND status IN (${ACTIVE_STATUSES}) ORDER BY scheduled_for DESC LIMIT 1`)
      .get(scheduleId) as ScheduleRun) ?? null
  );
}

// Retention is a hard cap by scheduled_for DESC, with no idea what's still
// live. A burst of manual "Run now" firings while one run is wedged pushes
// that claimed/running row out of the top RUN_RETENTION and it gets deleted
// out from under activeRun() — the overlap check then sees nothing busy and
// lets a second run start on top of it. Active rows are excluded from the
// candidate set entirely, so they survive no matter how far retention pushes
// past them; they only go once they've settled into a terminal status.
function pruneRuns(scheduleId: string): void {
  getDb()
    .prepare(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND status NOT IN (${ACTIVE_STATUSES}) AND id NOT IN (
         SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC LIMIT ?
       )`
    )
    .run(scheduleId, scheduleId, RUN_RETENTION);
}
