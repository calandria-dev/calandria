// Agent withdrawal of its own review submission. Withdrawing retires the
// agent's ask, never the requirement: a required request that reaches
// `withdrawn` stays unsatisfied (lib/reviews/guard.ts), so the task cannot
// complete, merge or be cleaned up until a person waives it or the agent
// resubmits and the person accepts.

import { nanoid } from "nanoid";

import { getDb } from "../db";
import { getTask } from "../store";
import { withTaskLock } from "../taskLock";
import { bumpWorkCenter } from "../workCenter/execution";
import { getRequest, getSubmission, hasUnsettledAction } from "./store";
import { canonicalJson, REVIEW_LIMITS, ReviewError, sha256Hex } from "./types";

export interface WithdrawInput {
  requestId: string;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
}

export interface WithdrawReceipt {
  requestId: string;
  submissionId: string;
  version: number;
  state: "withdrawn";
}

export async function withdrawReview(ownerTaskId: string, input: WithdrawInput): Promise<WithdrawReceipt> {
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new ReviewError("bad_request", "a reason is required to withdraw a review");
  if (reason.length > REVIEW_LIMITS.reason) throw new ReviewError("bad_request", "reason is too long");
  if (!/^[\x20-\x7e]{1,128}$/.test(input.idempotencyKey ?? "")) throw new ReviewError("bad_request", "idempotencyKey must be 1..128 printable ASCII characters");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new ReviewError("bad_request", "expectedVersion must be a positive integer");

  const hash = sha256Hex(canonicalJson({ requestId: input.requestId, expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey, reason, action: "withdraw" }));
  const out = await withTaskLock(ownerTaskId, async () => {
    const req = getRequest(input.requestId);
    if (!req || req.owner_task_id !== ownerTaskId || !getTask(ownerTaskId)) throw new ReviewError("not_found", "review request not found");
    const current = { version: req.version, state: req.state, submissionId: req.current_submission_id };
    const db = getDb();
    const seen = db
      .prepare("SELECT payload_sha256, receipt_json FROM review_actions WHERE request_id = ? AND idempotency_key = ?")
      .get(req.id, input.idempotencyKey) as { payload_sha256: string; receipt_json: string } | undefined;
    if (seen) {
      if (seen.payload_sha256 !== hash) throw new ReviewError("idempotency_conflict", "this idempotency key was used with different content", current);
      return JSON.parse(seen.receipt_json) as WithdrawReceipt;
    }
    if (req.version !== input.expectedVersion) throw new ReviewError("version_conflict", "the review changed since you read it", current);
    if (req.state !== "pending" && req.state !== "changes_requested") {
      throw new ReviewError("version_conflict", `a ${req.state} review cannot be withdrawn`, current);
    }
    if (hasUnsettledAction(req.id)) throw new ReviewError("operation_pending", "a decision on this review has not settled", current);
    const sub = req.current_submission_id ? getSubmission(req.current_submission_id) : undefined;
    if (!sub) throw new ReviewError("not_found", "review has no submission");
    const now = Date.now();
    const version = req.version + 1;
    const receipt: WithdrawReceipt = { requestId: req.id, submissionId: sub.id, version, state: "withdrawn" };
    db.transaction(() => {
      const r = db
        .prepare("UPDATE review_requests SET state = 'withdrawn', version = ?, updated_at = ? WHERE id = ? AND version = ? AND state IN ('pending','changes_requested')")
        .run(version, now, req.id, req.version);
      if (r.changes !== 1) throw new ReviewError("version_conflict", "the review changed since you read it", current);
      db.prepare(
        `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, reason, idempotency_key, payload_sha256,
           state, decision_applied, error_code, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'withdraw', 'agent', ?, ?, ?, ?, 'succeeded', 0, NULL, NULL, 200, ?, ?, ?)`,
      ).run(nanoid(), req.id, sub.id, input.expectedVersion, ownerTaskId, reason, input.idempotencyKey, hash, canonicalJson(receipt), now, now);
    }).immediate();
    return receipt;
  });
  bumpWorkCenter();
  return out;
}
