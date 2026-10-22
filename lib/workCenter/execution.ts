// Live execution observations and model-turn identity (contract work-center/1).
//
// A driver session (one `run()` in lib/runner.ts) holds a server-owned LEASE.
// Observations from the driver and turn starts and ends are accepted only
// against the current lease, so a late event from an outgoing session cannot
// overwrite the one that replaced it. The registry is on globalThis like the
// other live-turn registries, survives dev HMR, and is empty after a restart:
// nothing live is ever read back from the database, whose active_turn_* group
// is settled to `interrupted` at boot (recoverFromCrash in lib/db.ts).
//
// One driver session can contain several MODEL turns: the opening prompt, a
// message injected into a lingering session, a wakeup firing. Each gets its
// own server-generated turn id and its own result, finalized when the model
// completes its response even though the driver stays open for background
// work. The id is nonsecret and unrelated to the turn's capability token.
//
// Imports are SDK-free (lib/store.ts, lib/abort.ts, lib/asks.ts), so this
// module sits in tests/importGraph.test.ts's PINNED set.

import { nanoid } from "nanoid";
import { hasTurn } from "@/lib/abort";
import { hasOpenAsk } from "@/lib/asks";
import {
  beginTurnRecord,
  finalizeTurnRecord,
  getTask,
  getTaskDeps,
  listPendingMessages,
  listRecentResultRows,
  sessionRowId,
  setActiveTurnSession,
  type TurnResultInput,
} from "@/lib/store";
import {
  classifyExecution,
  decodeRecentCursor,
  latestResultOf,
  RECENT_WINDOW_MS,
  resultNeedsAttention,
  selectRecent,
} from "./classify";
import type { Execution, ExecutionObservation, Id, LatestResult, Ms } from "./types";

export type ObservationState = Omit<ExecutionObservation, "type">;

type Entry = {
  lease: string;
  taskId: string;
  generation: number;
  turnId: string | null;
  sessionId: string | null;
  obs: ObservationState | null;
  lastActivityAt: Ms | null;
};

type Listener = () => void;

type Registry = { entries: Map<string, Entry>; sequence: number; listeners: Set<Listener>; epoch?: string };

declare global {
  // eslint-disable-next-line no-var
  var __calandriaWorkCenterExecution: Registry | undefined;
}

function registry(): Registry {
  if (!global.__calandriaWorkCenterExecution) {
    global.__calandriaWorkCenterExecution = { entries: new Map(), sequence: 0, listeners: new Set() };
  }
  return global.__calandriaWorkCenterExecution;
}

/** Counter that moves on every registry change, before listeners run, so a
 *  snapshot assembled afterward is never older than the sequence it reports. */
export function workCenterSequence(): number {
  return registry().sequence;
}

/**
 * The process's epoch: a random id minted once per process (on globalThis, so
 * dev HMR keeps it). A client that sees it change knows every sequence it
 * holds is void and refetches in full.
 */
export function workCenterEpoch(): string {
  const r = registry();
  return (r.epoch ??= nanoid());
}

/** A source outside this registry changed (request settled, edit acknowledged, PR refreshed, snooze). */
export function bumpWorkCenter(): void {
  changed();
}

/** Called after each registry change. Returns the unsubscribe. */
export function subscribeWorkCenter(fn: Listener): () => void {
  const r = registry();
  r.listeners.add(fn);
  return () => r.listeners.delete(fn);
}

function changed(): void {
  const r = registry();
  r.sequence += 1;
  for (const fn of [...r.listeners]) {
    try {
      fn();
    } catch {
      // a listener must never break the turn that caused the change
    }
  }
}

function current(taskId: string, lease: string): Entry | null {
  const e = registry().entries.get(taskId);
  return e && e.lease === lease ? e : null;
}

/**
 * Open the live session for a task and return its lease. A session that
 * replaces another (a queue handoff, a resume right after a stop) takes the
 * slot, and the outgoing lease goes stale. Until a driver reports otherwise
 * the foreground is executing and background coverage is unavailable, which
 * is what a provider that observes nothing should read as.
 */
export function beginExecution(taskId: string, generation: number, now: Ms = Date.now()): string {
  const lease = nanoid();
  // A session is only replaced while its predecessor is still unwinding from a
  // Stop or /clear (a queue handoff finalizes its own turn first), so a model
  // turn still open on the outgoing entry ended by being stopped. Closing it
  // here keeps that result, because the outgoing lease is stale from now on
  // and its own cleanup can no longer write one.
  const prior = registry().entries.get(taskId);
  if (prior?.turnId) finalizeTurnRecord(taskId, prior.turnId, { outcome: "stopped", endedAt: now });
  registry().entries.set(taskId, {
    lease,
    taskId,
    generation,
    turnId: null,
    sessionId: null,
    obs: { foreground: "executing", background: [], backgroundCoverage: "unavailable", wakeups: [], externalWait: null },
    lastActivityAt: now,
  });
  changed();
  return lease;
}

/** Drop the session if `lease` still owns it. A stale lease is a no-op. */
export function endExecution(taskId: string, lease: string): boolean {
  if (!current(taskId, lease)) return false;
  registry().entries.delete(taskId);
  changed();
  return true;
}

function cleanObservation(o: ExecutionObservation): ObservationState {
  const seenBg = new Set<string>();
  const background = o.background.filter((b) => {
    if (typeof b.id !== "string" || !b.id || seenBg.has(b.id)) return false;
    seenBg.add(b.id);
    return true;
  });
  const seenWake = new Set<string>();
  const wakeups = o.wakeups.filter((w) => {
    if (typeof w.id !== "string" || !w.id || seenWake.has(w.id) || !Number.isFinite(w.at)) return false;
    seenWake.add(w.id);
    return true;
  });
  return {
    foreground: o.foreground,
    background: background.map((b) => ({ id: b.id, kind: b.kind, startedAt: b.startedAt ?? null })),
    backgroundCoverage: o.backgroundCoverage,
    wakeups: wakeups.map((w) => ({ id: w.id, at: w.at })),
    externalWait: o.externalWait ?? null,
  };
}

/** Replace the live observation. Returns false for a stale lease. */
export function observeExecution(taskId: string, lease: string, o: ExecutionObservation, now: Ms = Date.now()): boolean {
  const e = current(taskId, lease);
  if (!e) return false;
  const next = cleanObservation(o);
  // A provider that reports operations while declaring coverage unavailable
  // contradicts itself: the list is dropped, never half-believed.
  if (next.backgroundCoverage === "unavailable") next.background = [];
  e.obs = next;
  e.lastActivityAt = now;
  changed();
  return true;
}

/** Quiet age: record that the session did something. Does not move the sequence. */
export function touchExecution(taskId: string, lease: string, now: Ms = Date.now()): void {
  const e = current(taskId, lease);
  if (e) e.lastActivityAt = now;
}

/** Foreground phase from a structured driver event (lingering, wake, injected message). */
export function setForeground(taskId: string, lease: string, foreground: ObservationState["foreground"]): boolean {
  const e = current(taskId, lease);
  if (!e || !e.obs || e.obs.foreground === foreground) return !!e;
  e.obs = { ...e.obs, foreground };
  changed();
  return true;
}

/**
 * Begin a model turn under `lease`: mint its id, persist the active turn,
 * and set the foreground executing. Persisted before listeners run. A stale
 * lease starts nothing and returns null.
 */
export function startModelTurn(taskId: string, lease: string, now: Ms = Date.now()): string | null {
  const e = current(taskId, lease);
  if (!e) return null;
  const turnId = nanoid();
  e.turnId = turnId;
  e.sessionId = sessionRowId(taskId, e.generation);
  beginTurnRecord(taskId, { turnId, sessionId: e.sessionId, generation: e.generation, startedAt: now });
  if (e.obs) e.obs = { ...e.obs, foreground: "executing" };
  e.lastActivityAt = now;
  changed();
  return turnId;
}

/** The session row exists once the driver announces its session. */
export function noteSession(taskId: string, lease: string): void {
  const e = current(taskId, lease);
  if (!e || !e.turnId || e.sessionId) return;
  e.sessionId = sessionRowId(taskId, e.generation);
  if (e.sessionId) setActiveTurnSession(taskId, e.turnId, e.sessionId);
}

/** The lease of the live session for a task, for callers that hold only its id. */
export function leaseOf(taskId: string): string | null {
  return registry().entries.get(taskId)?.lease ?? null;
}

/** Id of the model turn the lease is currently running, if any. */
export function activeModelTurn(taskId: string, lease: string): string | null {
  return current(taskId, lease)?.turnId ?? null;
}

/**
 * Finalize the lease's model turn. Persisted before listeners run. A stale
 * lease, a turn already finalized and a repeated end event all return false
 * and change nothing, so a late cleanup can never overwrite a newer turn.
 * The session stays open: `foreground` becomes `finished`, and the driver's
 * own events decide when another turn starts or the session ends.
 */
export function finishModelTurn(taskId: string, lease: string, result: Omit<TurnResultInput, "endedAt"> & { endedAt?: Ms }): boolean {
  const e = current(taskId, lease);
  if (!e || !e.turnId) return false;
  const turnId = e.turnId;
  e.turnId = null;
  const ended = finalizeTurnRecord(taskId, turnId, { ...result, endedAt: result.endedAt ?? Date.now() });
  if (e.obs) e.obs = { ...e.obs, foreground: "finished" };
  changed();
  return ended;
}

// ---- Reading --------------------------------------------------------------

/** The registry's view of one task, without the database or the lifecycle. */
export function liveExecution(taskId: string): { turnId: string | null; sessionId: string | null; obs: ObservationState | null; lastActivityAt: Ms | null } | null {
  const e = registry().entries.get(taskId);
  return e ? { turnId: e.turnId, sessionId: e.sessionId, obs: e.obs, lastActivityAt: e.lastActivityAt } : null;
}

/**
 * The classified execution of one task. Live ownership is `hasTurn`: the
 * persisted `running` flag can be stale after a restart and is never read.
 * The queued start is the row's `start_at`; the store keeps no record of why
 * it was queued, so its reason is always `scheduled` rather than a guess.
 * Blockers are the task's unfinished dependencies.
 */
export function executionOf(taskId: string): Execution | null {
  const task = getTask(taskId);
  if (!task) return null;
  const live = hasTurn(taskId);
  const entry = live ? liveExecution(taskId) : null;
  const blockerTaskIds = getTaskDeps(taskId).filter((dep) => {
    const d = getTask(dep);
    return !!d && d.status !== "done" && d.status !== "cancelled";
  });
  return classifyExecution({
    lifecycle: task.status,
    live,
    openRequest: live && hasOpenAsk(taskId),
    observation: entry?.obs ?? null,
    turnId: entry?.turnId ?? null,
    sessionId: entry?.sessionId ?? null,
    queuedStart: task.start_at ? { at: task.start_at, reason: "scheduled" } : null,
    queuedFollowupCount: listPendingMessages(taskId).length,
    blockerTaskIds,
    lastActivityAt: entry?.lastActivityAt ?? null,
  });
}

export class RecentCursorError extends Error {
  constructor() {
    super("invalid recent cursor");
  }
}

export type RecentResult = {
  taskId: Id;
  projectId: Id;
  endedAt: Ms;
  result: LatestResult;
  /** A failed turn whose recovery is unresolved, the one mandatory attention a result carries. */
  needsAttention: boolean;
};

/**
 * One page of the seven-day recent-result list: the latest finished turn per
 * task, newest first, task id breaking ties. Pages by an opaque cursor bound
 * to its scope; one that is malformed or minted for another scope throws
 * RecentCursorError. An outcome is never inferred: a row with no recorded
 * turn reads as `unknown` from its historical session end.
 */
export function recentResults(opts: { now?: Ms; projectId?: Id | null; cursor?: string | null; limit?: number } = {}): { rows: RecentResult[]; nextCursor: string | null } {
  const now = opts.now ?? Date.now();
  const scope = opts.projectId ?? null;
  const cursor = opts.cursor ? decodeRecentCursor(opts.cursor, scope) : null;
  if (opts.cursor && !cursor) throw new RecentCursorError();
  const candidates: RecentResult[] = [];
  for (const row of listRecentResultRows(now - RECENT_WINDOW_MS, scope)) {
    const result = latestResultOf(row, row.historical_ended_at);
    if (!result) continue;
    candidates.push({ taskId: row.id, projectId: row.project_id, endedAt: result.endedAt, result, needsAttention: resultNeedsAttention(row) });
  }
  return selectRecent(candidates, { now, scope, limit: opts.limit, cursor });
}
