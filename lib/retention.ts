// Scheduled retention: the sweep that keeps the unbounded tables from being
// unbounded.
//
// Before this, `schedule_runs` was the only table with automatic retention
// (pruneRuns() in lib/schedule/store.ts, a hard cap per schedule). Everything
// else grew forever and was only ever emptied by the FK cascade behind a manual
// task/project delete — so an instance six months in carries every event of
// every turn it has ever run (issue #15).
//
// DB + fs only: no runner, no SDK, no bus (pinned by tests/importGraph.test.ts),
// so the predicate below can be tested without launching anything. The sweep
// itself is driven from lib/scheduler.ts's existing ticker — one server-owned
// periodic worker, never a second process (see CLAUDE.md).
//
// WHAT "COMPLETED" MEANS, per table, is the whole design:
//
//   messages / task_comments / task_doc_comments / uploads
//       Deleted for a task that is TERMINAL (done or cancelled), idle, and
//       untouched for CALANDRIA_RETENTION_DAYS. These are the user's record of
//       a finished piece of work; they feed no aggregate, so age is the only
//       question.
//   sessions
//       Same tasks, minus the ONE row that is still live: the session
//       `tasks.session_id` names is the task's resume key, and its `usage_cum`
//       is the Codex driver's per-thread cumulative baseline. Prune that and a
//       resumed task re-bills its whole thread on the next turn, so it stays
//       until the task itself is deleted. The older generations — everything
//       a `/clear` left behind — go.
//   task_usage / task_merges
//       Same predicate but a SEPARATE, longer window
//       (CALANDRIA_USAGE_RETENTION_DAYS), because these are not the task's
//       record, they are the Insights dashboard's: /api/insights reads 180 days
//       back and the default window is deliberately wider than that, so a
//       sweep can never carve a hole in a chart the user is looking at. They
//       also back the all-time cost totals on the project and task cards, which
//       do fall when a row ages out — an old task reads $0.00 rather than
//       lying about a smaller number.
//   internal_usage
//       Has no foreign keys at all (deliberately: deleting a project must not
//       erase historical overhead spend), so there is no task lifecycle to
//       hang it on. Pruned by ROW age against the usage window, which is what
//       its idx_internal_usage_created index is for.
//
// Nothing here touches `summaries`: they are the seed a new generation starts
// from, they are one short paragraph each, and a task whose messages have aged
// out is exactly the task whose summary is the last thing left explaining it.

import { getDb } from "@/lib/db";
import {
  RETENTION_ENABLED,
  RETENTION_MS,
  RETENTION_SWEEP_MS,
  RETENTION_VACUUM,
  USAGE_RETENTION_MS,
} from "@/lib/config";
import { removeTaskUploads } from "@/lib/uploads";

/** Task statuses that mean "this is over" — the only ones a sweep may touch. */
const TERMINAL_STATUSES = "'done','cancelled'";

/** Per-table row counts a sweep removed, for the log line and the tests. */
export interface RetentionCounts {
  messages: number;
  sessions: number;
  task_comments: number;
  task_doc_comments: number;
  task_usage: number;
  task_merges: number;
  internal_usage: number;
  /** Tasks whose upload dir was removed (attachments live outside the DB). */
  uploads: number;
}

export interface RetentionResult extends RetentionCounts {
  /** Total rows deleted — 0 means nothing was reclaimed and nothing ran after. */
  rows: number;
  /** Whether the WAL was truncated afterwards. */
  checkpointed: boolean;
  /** Whether a full VACUUM ran (opt-in, CALANDRIA_RETENTION_VACUUM). */
  vacuumed: boolean;
}

const EMPTY: RetentionCounts = {
  messages: 0, sessions: 0, task_comments: 0, task_doc_comments: 0,
  task_usage: 0, task_merges: 0, internal_usage: 0, uploads: 0,
};

/**
 * THE PREDICATE. Which tasks may a sweep touch, given a cutoff?
 *
 * Terminal, idle, and cold — every clause is a way a task can still be somebody's
 * live concern despite reading `done`:
 *
 *  - `running` / `awaiting_input`: a turn is in flight, or a permission card or
 *    ask is parked on the user. Both are reset by crash recovery at boot, so a
 *    dead predecessor's flags can't freeze a task out of retention forever.
 *  - `unread_run_at`: a scheduled run finished clean and nobody has looked yet.
 *    That mark sits OVER the status, so it is invisible to the status clause.
 *  - `snoozed_until` in the future: the user deferred this ON PURPOSE and it is
 *    coming back to the inbox.
 *  - a parked follow-up in `pending_messages`: the queue is waiting to run, so
 *    the task is about to be live again.
 *  - a `claimed`/`running` schedule run pointing at it: the ledger still thinks
 *    the launch is in flight (the same exclusion pruneRuns() makes, for the same
 *    reason — retention must never delete the state something else is reading).
 *
 * `updated_at` is the clock rather than `created_at`: a long-lived task that was
 * finished yesterday is not six months old just because it was filed then, and
 * every write path in lib/store.ts stamps it.
 */
export function prunableTaskIds(cutoff: number, now = Date.now()): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM tasks
          WHERE status IN (${TERMINAL_STATUSES})
            AND running = 0
            AND awaiting_input = 0
            AND unread_run_at = 0
            AND snoozed_until <= ?
            AND updated_at <= ?
            AND id NOT IN (SELECT task_id FROM pending_messages)
            AND id NOT IN (
              SELECT task_id FROM schedule_runs
               WHERE task_id IS NOT NULL AND status IN ('claimed','running')
            )
          ORDER BY updated_at ASC`
      )
      .all(now, cutoff) as { id: string }[]
  ).map((r) => r.id);
}

/** SQLite caps bound parameters per statement; delete in chunks well under it. */
const CHUNK = 400;

function deleteByTask(table: string, column: string, ids: string[]): number {
  const db = getDb();
  let removed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const holes = slice.map(() => "?").join(",");
    removed += db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${holes})`).run(...slice).changes;
  }
  return removed;
}

/**
 * The one row per pruned task that must survive: the session the task would
 * resume into. Expressed as a join rather than a second query so the delete
 * stays a single statement per chunk.
 */
function deleteStaleSessions(ids: string[]): number {
  const db = getDb();
  let removed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const holes = slice.map(() => "?").join(",");
    removed += db
      .prepare(
        `DELETE FROM sessions
          WHERE task_id IN (${holes})
            AND id NOT IN (
              SELECT s.id FROM sessions s JOIN tasks t ON t.id = s.task_id
               WHERE t.session_id IS NOT NULL AND s.claude_session_id = t.session_id
            )`
      )
      .run(...slice).changes;
  }
  return removed;
}

export interface SweepOptions {
  /** Age-out window for a finished task's own record. 0 = don't prune those. */
  transcriptMs?: number;
  /** Age-out window for the spend/merge rows Insights reads. 0 = don't prune. */
  usageMs?: number;
  /** Run a full VACUUM afterwards (rewrites the file; off by default). */
  vacuum?: boolean;
}

/**
 * One retention pass. Synchronous and transactional per half, because
 * better-sqlite3 is synchronous and the four deletes for one task describe a
 * single decision — a half-pruned task would leave comments anchored to a
 * transcript that no longer exists.
 *
 * The file-system half (uploads) runs OUTSIDE the transaction: `fs.rmSync` can't
 * be rolled back, and a directory that survives a failed sweep is retried next
 * time, whereas a directory deleted under a rolled-back transaction is gone with
 * its messages still pointing at it.
 */
export function sweepRetention(now = Date.now(), opts: SweepOptions = {}): RetentionResult {
  const transcriptMs = opts.transcriptMs ?? RETENTION_MS;
  const usageMs = opts.usageMs ?? USAGE_RETENTION_MS;
  const db = getDb();
  const counts: RetentionCounts = { ...EMPTY };

  const transcriptIds = transcriptMs > 0 ? prunableTaskIds(now - transcriptMs, now) : [];
  if (transcriptIds.length) {
    db.transaction(() => {
      counts.messages = deleteByTask("messages", "task_id", transcriptIds);
      counts.task_comments = deleteByTask("task_comments", "task_id", transcriptIds);
      counts.task_doc_comments = deleteByTask("task_doc_comments", "task_id", transcriptIds);
      counts.sessions = deleteStaleSessions(transcriptIds);
    })();
    // Item 3 of the issue: removeTaskUploads() used to fire only on hard delete,
    // so an abandoned task kept its attachment dir forever. Same window, same
    // sweep — the marker lines that pointed at these files were in the messages
    // just deleted.
    for (const id of transcriptIds) {
      counts.uploads += removeTaskUploads(id) ? 1 : 0;
    }
  }

  const usageIds = usageMs > 0 ? prunableTaskIds(now - usageMs, now) : [];
  if (usageMs > 0) {
    db.transaction(() => {
      if (usageIds.length) {
        counts.task_usage = deleteByTask("task_usage", "task_id", usageIds);
        counts.task_merges = deleteByTask("task_merges", "task_id", usageIds);
      }
      counts.internal_usage = db
        .prepare("DELETE FROM internal_usage WHERE created_at <= ?")
        .run(now - usageMs).changes;
    })();
  }

  const rows =
    counts.messages + counts.sessions + counts.task_comments + counts.task_doc_comments +
    counts.task_usage + counts.task_merges + counts.internal_usage;

  // Logically freeing rows is not reclaiming disk. In WAL mode the deletes land
  // in calandria.db-wal, which grows to hold them and is only reset at a
  // checkpoint — so a big sweep can make the on-disk footprint go UP until one
  // happens. TRUNCATE checkpoints everything back into the main file and then
  // truncates the WAL to zero, which is the reclaim the issue asks for.
  //
  // It cannot reclaim pages inside calandria.db itself: freed pages go on the
  // freelist and are reused by later writes rather than returned to the
  // filesystem. Only VACUUM shrinks the file, and VACUUM rewrites the whole
  // database while holding a write lock — fine on a 50 MB DB, a stall on a
  // large one — so it is opt-in rather than the default, and never runs when
  // nothing was deleted.
  let checkpointed = false;
  let vacuumed = false;
  if (rows > 0) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      checkpointed = true;
    } catch (err) {
      // A reader holding the DB open can block a truncating checkpoint. Not a
      // failure of the sweep — the rows are gone and the next pass retries.
      console.warn("[retention] wal_checkpoint(TRUNCATE) failed:", err);
    }
    if (opts.vacuum ?? RETENTION_VACUUM) {
      try {
        // Outside any transaction, by SQLite's rules.
        db.exec("VACUUM");
        vacuumed = true;
      } catch (err) {
        console.warn("[retention] VACUUM failed:", err);
      }
    }
  }

  return { ...counts, rows, checkpointed, vacuumed };
}

interface RetentionState {
  /** When the last sweep finished, so the ticker's interval isn't the cadence. */
  lastSweepAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaRetention: RetentionState | undefined;
}

const state = (): RetentionState => (global.__calandriaRetention ??= { lastSweepAt: 0 });

/** What the ticker's health payload reports about retention. */
export const retentionHealth = () => ({
  enabled: RETENTION_ENABLED,
  lastSweepAt: state().lastSweepAt,
  sweepMs: RETENTION_SWEEP_MS,
  retentionMs: RETENTION_MS,
  usageRetentionMs: USAGE_RETENTION_MS,
});

/**
 * The ticker's entry point. The schedule sweep runs every 30s; retention has no
 * business running that often, so it keeps its own clock and returns null when
 * it isn't due.
 *
 * `lastSweepAt` starts at 0, so the first tick after boot sweeps — which is the
 * behavior an instance that is only ever up for an hour a day needs, and the
 * reason this is not a `setInterval` of its own.
 */
export function maybeSweepRetention(now = Date.now()): RetentionResult | null {
  if (!RETENTION_ENABLED) return null;
  const s = state();
  if (now - s.lastSweepAt < RETENTION_SWEEP_MS) return null;
  s.lastSweepAt = now;
  const result = sweepRetention(now);
  if (result.rows > 0) {
    // Deleting a user's data silently is how retention becomes a support
    // ticket. One line, only when something actually went.
    const detail = (Object.entries(result) as [string, number | boolean][])
      .filter(([k, v]) => typeof v === "number" && v > 0 && k !== "rows")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`[retention] pruned ${result.rows} rows (${detail})${result.vacuumed ? " + vacuum" : ""}`);
  }
  return result;
}
