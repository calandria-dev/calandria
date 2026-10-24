// Durable state of a request-changes feedback delivery. Database only: the
// transcript insert in lib/store.ts and the runner both call into it, so it
// imports neither. Every transition is one statement or one transaction that
// re-reads the action row, which keeps two writers (the runner's first
// correlated event and a turn end, say) from settling it twice.
//
// Delivery states, per contract work-center/1:
//   queued         action persisted, no dispatch intent recorded; safe to retry
//   dispatching    intent recorded before any send; never silently resent
//   delivered      a correlated provider event proved the agent processed it
//   failed         named failure with nothing handed to the agent
//   indeterminate  handed off (or possibly handed off) without durable proof

import { getDb } from "../db";
import { canonicalJson, type AcceptanceEvidence, type FeedbackDeliveryState, type FeedbackOperation, type ReviewActionState } from "./types";
import type { ActionRow } from "./store";

function readOp(row: ActionRow | undefined): FeedbackOperation | null {
  if (!row?.operation_json) return null;
  const op = JSON.parse(row.operation_json) as { kind?: string };
  return op.kind === "feedback" ? (op as FeedbackOperation) : null;
}

function getRow(id: string): ActionRow | undefined {
  return getDb().prepare("SELECT * FROM review_actions WHERE id = ?").get(id) as ActionRow | undefined;
}

/**
 * Apply `fn` to a feedback action inside one IMMEDIATE transaction. `fn`
 * returns the next state, or null to leave the row untouched (a stale
 * transition). Returns the updated row, or undefined when nothing changed.
 */
function transition(
  actionId: string,
  fn: (op: FeedbackOperation, row: ActionRow) => { delivery: FeedbackDeliveryState; state: ReviewActionState; errorCode: string | null; op?: Partial<FeedbackOperation> } | null,
  now = Date.now(),
): ActionRow | undefined {
  const db = getDb();
  return db
    .transaction((): ActionRow | undefined => {
      const row = getRow(actionId);
      const op = readOp(row);
      if (!row || !op) return undefined;
      const next = fn(op, row);
      if (!next) return undefined;
      const merged: FeedbackOperation = { ...op, ...next.op, delivery: next.delivery };
      db.prepare("UPDATE review_actions SET state = ?, error_code = ?, operation_json = ?, updated_at = ? WHERE id = ?").run(next.state, next.errorCode, canonicalJson(merged), now, actionId);
      if (next.state !== "pending") db.prepare("UPDATE tasks SET active_review_action_id = NULL WHERE id = ? AND active_review_action_id = ?").run(op.taskId, actionId);
      return getRow(actionId);
    })
    .immediate();
}

/** Stamp the transcript insertion time. Never touches `delivery`: a transcript row proves nothing about receipt. */
export function recordFeedbackInsertion(actionId: string, now: number): void {
  const db = getDb();
  const row = getRow(actionId);
  const op = readOp(row);
  if (!row || !op || op.recordedAt !== null) return;
  db.prepare("UPDATE review_actions SET operation_json = ?, updated_at = ? WHERE id = ?").run(canonicalJson({ ...op, recordedAt: now }), now, actionId);
}

/**
 * Record dispatch intent before anything is sent, and take ownership of the
 * task's input. Only a queued action can start dispatching, and only while no
 * other action owns the task; either condition failing returns false and
 * changes nothing.
 */
export function markFeedbackDispatching(actionId: string): boolean {
  const db = getDb();
  return db
    .transaction((): boolean => {
      const row = getRow(actionId);
      const op = readOp(row);
      if (!row || !op || row.state !== "pending" || op.delivery !== "queued") return false;
      const claim = db.prepare("UPDATE tasks SET active_review_action_id = ? WHERE id = ? AND (active_review_action_id IS NULL OR active_review_action_id = ?)").run(actionId, op.taskId, actionId);
      if (claim.changes !== 1) return false;
      db.prepare("UPDATE review_actions SET operation_json = ?, updated_at = ? WHERE id = ?").run(canonicalJson({ ...op, delivery: "dispatching" }), Date.now(), actionId);
      return true;
    })
    .immediate();
}

/** The driver refused the handoff, so nothing was sent: dispatching goes back to queued. */
export function revertFeedbackDispatching(actionId: string): void {
  transition(actionId, (op, row) => (row.state === "pending" && op.delivery === "dispatching" && op.recordedAt === null ? { delivery: "queued", state: "pending", errorCode: null } : null));
}

/** A correlated provider event proved the agent processed the feedback. */
export function acceptFeedback(actionId: string, accepted: { turnId: string | null; evidence: AcceptanceEvidence; now?: number }): ActionRow | undefined {
  const now = accepted.now ?? Date.now();
  return transition(
    actionId,
    (op, row) => (row.state === "pending" && op.delivery === "dispatching" ? { delivery: "delivered", state: "succeeded", errorCode: null, op: { acceptedAt: now, acceptanceEvidence: accepted.evidence, targetTurnId: accepted.turnId } } : null),
    now,
  );
}

/** Nothing reached the agent. Only valid before any text was recorded or sent. */
export function failFeedback(actionId: string, errorCode: string): ActionRow | undefined {
  return transition(actionId, (op, row) => (row.state === "pending" && op.delivery !== "delivered" ? { delivery: "failed", state: "failed", errorCode } : null));
}

/** The text may or may not have reached the agent; only a person's explicit retry resolves it. */
export function markFeedbackIndeterminate(actionId: string, errorCode: string): ActionRow | undefined {
  return transition(actionId, (op, row) => (row.state === "pending" && op.delivery === "dispatching" ? { delivery: "indeterminate", state: "indeterminate", errorCode } : null));
}

/** Feedback actions waiting for a dispatch that was never started. */
export function listQueuedFeedback(ownerTaskId?: string): ActionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT a.* FROM review_actions a JOIN review_requests r ON r.id = a.request_id
        WHERE a.action IN ('request_changes','retry_feedback') AND a.state = 'pending'
          ${ownerTaskId ? "AND r.owner_task_id = ?" : ""}
        ORDER BY a.created_at ASC, a.rowid ASC`,
    )
    .all(...(ownerTaskId ? [ownerTaskId] : [])) as ActionRow[];
  return rows.filter((r) => readOp(r)?.delivery === "queued");
}

export { readOp as readFeedbackOperation };
