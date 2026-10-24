// The required-review eligibility guard (contract work-center/1). One pure
// decision, `requiredReviewBlocker`, fed by two loaders: a synchronous one that
// every store-level write can afford (state, epoch and receipts only), and an
// async one in lib/reviews/gate.ts that also observes the checkout. A task with
// no required review rows is never blocked, so ordinary tasks are unchanged.
//
// This module imports only the database and the review types, so lib/store.ts
// can call it without a cycle and it stays out of the SDK graph.

import { getDb } from "../db";
import { ReviewError, type ReviewApplicabilityState, type ReviewState } from "./types";

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

/**
 * Explicit human disposition for a delete: waives each unsatisfied required
 * request in place so the history records why the work was released.
 */
export function waiveRequired(ownerTaskId: string): void {
  const b = reviewBlockerSync(ownerTaskId);
  if (!b) return;
  const db = getDb();
  const now = Date.now();
  for (const id of b.requestIds) {
    db.prepare("UPDATE review_requests SET state = 'waived', version = version + 1, updated_at = ? WHERE id = ?").run(now, id);
  }
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
