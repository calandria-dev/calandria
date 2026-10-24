// Canonical execution classifier (contract work-center/1). Pure: every input
// is passed in, so the fixtures in tests/workCenterExecution.test.ts pin each
// case without a database, a runner or a clock.
//
// "Working" means a live foreground that is executing with nothing blocking
// it, or at least one observed active background operation. It is a different
// question from the lifecycle value `in_progress`, which only says the task was
// started and not finished. Wakeups alone, queues alone, holds, dependencies
// and an in-progress task with no live turn are waiting, never working. Quiet
// execution still counts: silence is never read as a stall.

import type {
  Execution,
  ExecutionObservation,
  Id,
  LatestResult,
  Lifecycle,
  Ms,
  Outcome,
  TurnFailureCode,
  WaitingReason,
} from "./types";

export type ClassifyInput = {
  lifecycle: Lifecycle;
  /** Live ownership: `hasTurn(taskId)`, never the persisted `running` flag. */
  live: boolean;
  /** A card (question or permission) is parked on a person right now. */
  openRequest: boolean;
  /** Latest accepted observation of the live session, or null when none arrived. */
  observation: Omit<ExecutionObservation, "type"> | null;
  turnId: Id | null;
  sessionId: Id | null;
  queuedStart: Execution["queuedStart"];
  queuedFollowupCount: number;
  blockerTaskIds: Id[];
  /** A required review is unsatisfied and no pending decision item covers it (for example, withdrawn). */
  reviewRequired: boolean;
  lastActivityAt: Ms | null;
};

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export function classifyExecution(i: ClassifyInput): Execution {
  const live = i.live;
  // With no live turn nothing is executing, whatever a stale observation says.
  const obs = live ? i.observation : null;

  let foreground: Execution["foreground"];
  if (!live) foreground = "none";
  else if (!obs) foreground = "unknown";
  else foreground = obs.foreground;
  // A live ask always parks the foreground for classification, even when the
  // driver has not yet said so: the turn cannot proceed until it is answered.
  if (live && i.openRequest) foreground = "parked";

  const background = obs ? uniqueById(obs.background).map((b) => ({ id: b.id, kind: b.kind, startedAt: b.startedAt })) : [];
  const wakeups = obs ? uniqueById(obs.wakeups).map((w) => ({ id: w.id, at: w.at })) : [];
  // No observation, or a provider that cannot enumerate background work:
  // declared unavailable instead of an empty list that would read as "none".
  const backgroundCoverage: Execution["backgroundCoverage"] = obs ? obs.backgroundCoverage : "unavailable";
  const externalWait = obs ? obs.externalWait : null;

  const foregroundWorking = foreground === "executing" && !i.openRequest;
  const isWorking = foregroundWorking || background.length > 0;

  const reasons: WaitingReason[] = [];
  if (live && foreground === "parked") reasons.push("input");
  if (wakeups.length > 0) reasons.push("wakeup");
  if (externalWait) reasons.push("external");
  if (i.queuedStart || i.queuedFollowupCount > 0) reasons.push("queued");
  if (i.blockerTaskIds.length > 0) reasons.push("dependency");
  if (i.reviewRequired) reasons.push("review_required");
  if (i.lifecycle === "on_hold") reasons.push("on_hold");
  if (i.lifecycle === "in_progress" && !live) reasons.push("no_live_turn");
  if (live && (backgroundCoverage === "unavailable" || foreground === "unknown")) reasons.push("detail_unavailable");

  return {
    turnId: live ? i.turnId : null,
    sessionId: live ? i.sessionId : null,
    foreground,
    background,
    backgroundCoverage,
    wakeups,
    externalWait,
    queuedStart: i.queuedStart,
    queuedFollowupCount: i.queuedFollowupCount,
    blockerTaskIds: [...i.blockerTaskIds],
    lastActivityAt: i.lastActivityAt,
    isWorking,
    waitingReasons: reasons,
  };
}

// ---- Latest result ----------------------------------------------------

export const OUTCOMES: readonly Outcome[] = ["ok", "failed", "stopped", "interrupted", "unknown"];
export const FAILURE_CODES: readonly TurnFailureCode[] = ["context_limit", "auth", "approval", "execution"];

export function isOutcome(v: unknown): v is Outcome {
  return typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);
}

export function isFailureCode(v: unknown): v is TurnFailureCode {
  return typeof v === "string" && (FAILURE_CODES as readonly string[]).includes(v);
}

/** The source-owned columns a finalized turn leaves on its task row. */
export type LatestTurnColumns = {
  generation: number;
  completed_at: number | null;
  latest_turn_id: string | null;
  latest_turn_session_id: string | null;
  latest_turn_generation: number | null;
  latest_turn_started_at: number | null;
  latest_turn_ended_at: number | null;
  latest_turn_outcome: string | null;
  latest_turn_terminal_message_id: string | null;
  latest_turn_schedule_run_id: string | null;
  latest_turn_failure_code: string | null;
  latest_turn_failure_resolved_at: number | null;
};

/**
 * Exact result label for a task, from its source-owned latest-turn columns.
 * A row with no recorded turn falls back to the newest historical
 * `sessions.ended_at`, a neutral `unknown` outcome with a null turn id: an
 * outcome is never inferred from usage or transcript prose. `taskCompletedAt`
 * is the row's `completed_at` as stored, never backfilled from `updated_at`.
 */
export function latestResultOf(row: LatestTurnColumns, historicalEndedAt: Ms | null): LatestResult | null {
  if (row.latest_turn_ended_at) {
    return {
      turnId: row.latest_turn_id,
      sessionId: row.latest_turn_session_id,
      generation: row.latest_turn_generation ?? row.generation,
      scheduleRunId: row.latest_turn_schedule_run_id,
      startedAt: row.latest_turn_started_at,
      endedAt: row.latest_turn_ended_at,
      outcome: isOutcome(row.latest_turn_outcome) ? row.latest_turn_outcome : "unknown",
      terminalMessageId: row.latest_turn_terminal_message_id,
      taskCompletedAt: row.completed_at,
    };
  }
  if (historicalEndedAt) {
    return {
      turnId: null,
      sessionId: null,
      generation: row.generation,
      scheduleRunId: null,
      startedAt: null,
      endedAt: historicalEndedAt,
      outcome: "unknown",
      terminalMessageId: null,
      taskCompletedAt: row.completed_at,
    };
  }
  return null;
}

/**
 * Whether the latest result carries a mandatory attention item of its own: a
 * failed turn whose recovery has not been resolved. A clean result, including
 * a clean scheduled run, never does, and neither does a stopped or interrupted
 * one (those are recent results unless a separate actionable source exists).
 */
export function resultNeedsAttention(row: Pick<LatestTurnColumns, "latest_turn_outcome" | "latest_turn_failure_code" | "latest_turn_failure_resolved_at">): boolean {
  return row.latest_turn_outcome === "failed" && isFailureCode(row.latest_turn_failure_code) && !row.latest_turn_failure_resolved_at;
}

// ---- Recent-result paging ----------------------------------------------

export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENT_LIMIT_DEFAULT = 50;
export const RECENT_LIMIT_MAX = 100;

export type RecentCursor = { scope: Id | null; endedAt: Ms; taskId: Id };

export function encodeRecentCursor(c: RecentCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, s: c.scope, e: c.endedAt, t: c.taskId }), "utf8").toString("base64url");
}

/** Null for anything that is not a cursor this module wrote for `scope`. */
export function decodeRecentCursor(raw: string, scope: Id | null): RecentCursor | null {
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { v?: unknown; s?: unknown; e?: unknown; t?: unknown };
    if (j.v !== 1 || typeof j.e !== "number" || !Number.isFinite(j.e) || typeof j.t !== "string") return null;
    const s = j.s === null || typeof j.s === "string" ? j.s : undefined;
    if (s === undefined || s !== scope) return null;
    return { scope: s, endedAt: j.e, taskId: j.t };
  } catch {
    return null;
  }
}

/** Descending by end time, task id breaking ties so a page boundary is deterministic. */
export function compareRecent(a: { endedAt: Ms; taskId: Id }, b: { endedAt: Ms; taskId: Id }): number {
  if (a.endedAt !== b.endedAt) return b.endedAt - a.endedAt;
  return a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : 0;
}

/**
 * Select one page of recent results: each task at most once, `endedAt` within
 * seven days of `now`, newest first, strictly after `cursor` in that order.
 * `nextCursor` is set only when more rows remain.
 */
export function selectRecent<T extends { endedAt: Ms; taskId: Id }>(
  candidates: T[],
  opts: { now: Ms; scope: Id | null; limit?: number; cursor?: RecentCursor | null }
): { rows: T[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? RECENT_LIMIT_DEFAULT) || RECENT_LIMIT_DEFAULT, 1), RECENT_LIMIT_MAX);
  const floor = opts.now - RECENT_WINDOW_MS;
  const seen = new Set<string>();
  const eligible = candidates
    .filter((c) => c.endedAt >= floor && !seen.has(c.taskId) && (seen.add(c.taskId), true))
    .sort(compareRecent);
  const after = opts.cursor ? eligible.filter((c) => compareRecent(c, opts.cursor!) > 0) : eligible;
  const rows = after.slice(0, limit);
  const last = rows[rows.length - 1];
  const nextCursor = after.length > rows.length && last ? encodeRecentCursor({ scope: opts.scope, endedAt: last.endedAt, taskId: last.taskId }) : null;
  return { rows, nextCursor };
}
