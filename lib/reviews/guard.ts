// The required-review eligibility guard (contract work-center/1). One pure
// decision, `requiredReviewBlocker`, fed by two loaders: a synchronous one that
// every store-level write can afford (state, epoch and receipts only), and an
// async one in lib/reviews/gate.ts that also observes the checkout. A task with
// no required review rows is never blocked, so ordinary tasks are unchanged.
//
// This module imports only the database and the review types, so lib/store.ts
// can call it without a cycle and it stays out of the SDK graph.

import { nanoid } from "nanoid";

import { getDb } from "../db";
import { taskHasPendingOperation } from "./store";
import { LOCAL_OWNER_ACTOR, ReviewError, canonicalJson, sha256Hex, type ActionResponse, type ReviewApplicabilityState, type ReviewState } from "./types";

export interface GateRequest {
  id: string;
  state: ReviewState;
  /** A decision effect that has not settled: blocks even an accepted request. */
  effectPending: boolean;
}

export interface ReviewBlocker {
  code: "review_required";
  requestIds: string[];
  reason: string;
}

/**
 * Null when every required request is satisfied. Accepted plus a current,
 * landed or retired artifact passes, and so does a waived current submission.
 * Every other state, and any artifact that cannot be observed, blocks.
 */
export function requiredReviewBlocker(
  requests: readonly GateRequest[],
  applicability: ReadonlyMap<string, ReviewApplicabilityState | null>,
): ReviewBlocker | null {
  const open = requests.filter((r) => {
    if (r.effectPending) return true;
    if (r.state === "waived") return false;
    if (r.state !== "accepted") return true;
    const a = applicability.get(r.id) ?? null;
    return !(a === "current" || a === "landed" || a === "retired");
  });
  if (open.length === 0) return null;
  const states = [...new Set(open.map((r) => (r.effectPending ? "has an unsettled decision" : r.state)))].join(", ");
  return {
    code: "review_required",
    requestIds: open.map((r) => r.id),
    reason: `${open.length} required review${open.length === 1 ? "" : "s"} not satisfied (${states})`,
  };
}

interface Row {
  id: string;
  state: ReviewState;
  current_submission_id: string | null;
  content_epoch: number | null;
  task_epoch: number | null;
  pending: number;
}

/** Required requests an owner holds, with what a synchronous read can tell. */
export function loadGateRequests(ownerTaskId: string): { requests: GateRequest[]; applicability: Map<string, ReviewApplicabilityState | null> } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id, r.state, r.current_submission_id,
              s.content_epoch AS content_epoch,
              (SELECT review_content_epoch FROM tasks WHERE id = r.owner_task_id) AS task_epoch,
              EXISTS (SELECT 1 FROM review_actions a WHERE a.request_id = r.id AND a.state IN ('pending','indeterminate')) AS pending
         FROM review_requests r
         LEFT JOIN review_submissions s ON s.id = r.current_submission_id
        WHERE r.owner_task_id = ? AND r.required = 1
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(ownerTaskId) as Row[];
  const applicability = new Map<string, ReviewApplicabilityState | null>();
  const receipts = db.prepare("SELECT kind FROM review_applicability_receipts WHERE submission_id = ? AND content_epoch = ?");
  for (const r of rows) {
    if (r.state !== "accepted" || !r.current_submission_id) continue;
    if (r.task_epoch === null || r.content_epoch !== r.task_epoch) {
      applicability.set(r.id, "changed");
      continue;
    }
    const kinds = (receipts.all(r.current_submission_id, r.content_epoch) as { kind: string }[]).map((x) => x.kind);
    // Without a receipt the checkout has to be observed, which the async gate
    // does; here an unchanged epoch is the strongest synchronous evidence.
    applicability.set(r.id, kinds.includes("retired") ? "retired" : kinds.includes("landed") ? "landed" : "current");
  }
  return { requests: rows.map((r) => ({ id: r.id, state: r.state, effectPending: r.pending === 1 })), applicability };
}

/** Conservative synchronous verdict for one owner. */
export function reviewBlockerSync(ownerTaskId: string): ReviewBlocker | null {
  const { requests, applicability } = loadGateRequests(ownerTaskId);
  return requests.length === 0 ? null : requiredReviewBlocker(requests, applicability);
}

/**
 * True when the owner holds an unsatisfied required review that no pending
 * decision item already covers. A request still in `pending` is a needs-you
 * attention row, so it is excluded; a withdrawn request, a request awaiting
 * changes, and an accepted one whose content changed since are not.
 */
export function reviewRequiredWithoutItemSync(ownerTaskId: string): boolean {
  const { requests, applicability } = loadGateRequests(ownerTaskId);
  if (requests.length === 0) return false;
  const b = requiredReviewBlocker(requests, applicability);
  if (!b) return false;
  const state = new Map(requests.map((r) => [r.id, r.state]));
  return b.requestIds.some((id) => state.get(id) !== "pending");
}

/**
 * Task ids that hold an unsatisfied required review with no pending item.
 * One grouped read finds the unfinished owners that have a required request
 * neither pending nor waived, and only those owners pay for the per-task verdict.
 */
export function reviewRequiredTaskIds(): Set<string> {
  const ids = getDb()
    .prepare(
      "SELECT DISTINCT r.owner_task_id AS id FROM review_requests r JOIN tasks t ON t.id = r.owner_task_id " +
        "WHERE r.required = 1 AND r.state NOT IN ('pending', 'waived') AND t.status NOT IN ('done', 'cancelled')",
    )
    .all() as { id: string }[];
  const out = new Set<string>();
  for (const { id } of ids) if (reviewRequiredWithoutItemSync(id)) out.add(id);
  return out;
}

export function reviewRequiredError(b: ReviewBlocker): ReviewError {
  return new ReviewError("review_required", `${b.reason}. A person has to accept or waive it first.`);
}

export const isTerminalStatus = (s: string) => s === "done" || s === "cancelled";

/** Throws review_required when the owner has an unsatisfied required review. */
export function assertReviewsSatisfiedSync(ownerTaskId: string): void {
  const b = reviewBlockerSync(ownerTaskId);
  if (b) throw reviewRequiredError(b);
}

/** Every task in a project that holds an unsatisfied required review. */
export function projectReviewBlockers(projectId: string): { taskId: string; blocker: ReviewBlocker }[] {
  const ids = getDb()
    .prepare("SELECT DISTINCT owner_task_id AS id FROM review_requests WHERE required = 1 AND owner_task_id IN (SELECT id FROM tasks WHERE project_id = ?)")
    .all(projectId) as { id: string }[];
  const out: { taskId: string; blocker: ReviewBlocker }[] = [];
  for (const { id } of ids) {
    const blocker = reviewBlockerSync(id);
    if (blocker) out.push({ taskId: id, blocker });
  }
  return out;
}

/** Why a person waived requests outside the decision endpoint. */
export type WaiveReason = "waive_and_delete" | "move_reset";

/**
 * Explicit human disposition for a delete or a source-changing move: waives
 * each unsatisfied required request in place, and records one succeeded
 * `waive` action per request so the history names who released the work and
 * why. Refused with `operation_pending` while any action on the task's
 * requests is still pending or indeterminate, since that effect (a merge in
 * flight, an undelivered feedback) would otherwise lose its record.
 */
export function waiveRequired(ownerTaskId: string, reason: WaiveReason, actorId: string = LOCAL_OWNER_ACTOR): void {
  if (taskHasPendingOperation(ownerTaskId)) {
    throw new ReviewError("operation_pending", "a review decision on this task has not settled; resolve it before waiving");
  }
  const b = reviewBlockerSync(ownerTaskId);
  if (!b) return;
  const db = getDb();
  const now = Date.now();
  const run = db.transaction(() => {
    for (const id of b.requestIds) {
      const req = db.prepare("SELECT id, version, current_submission_id FROM review_requests WHERE id = ?").get(id) as
        | { id: string; version: number; current_submission_id: string | null }
        | undefined;
      if (!req?.current_submission_id) continue;
      const version = req.version + 1;
      db.prepare("UPDATE review_requests SET state = 'waived', version = ?, updated_at = ? WHERE id = ?").run(version, now, id);
      const actionId = nanoid();
      const response: ActionResponse = {
        requestId: id,
        submissionId: req.current_submission_id,
        version,
        state: "waived",
        action: { id: actionId, state: "succeeded", decisionApplied: true, errorCode: null, operation: null },
      };
      const key = `disposition:${reason}:${id}:${req.version}`;
      db.prepare(
        `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, reason, idempotency_key, payload_sha256,
           state, decision_applied, error_code, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'waive', 'human', ?, ?, ?, ?, 'succeeded', 1, NULL, NULL, 200, ?, ?, ?)`,
      ).run(actionId, id, req.current_submission_id, req.version, actorId, reason, key, sha256Hex(canonicalJson({ action: "waive", reason, requestId: id, version: req.version })), canonicalJson(response), now, now);
    }
  });
  run.immediate();
}

/**
 * Advance the content epoch of a task that owns review rows. Tasks without any
 * stay untouched, so ordinary tasks never see the write.
 */
export function bumpEpochIfReviewed(taskId: string): void {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM review_requests WHERE owner_task_id = ? LIMIT 1").get(taskId)) return;
  db.prepare("UPDATE tasks SET review_content_epoch = review_content_epoch + 1 WHERE id = ?").run(taskId);
}
