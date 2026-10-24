// Review persistence (contract work-center/1): raw queries and the one
// synchronous transaction that reserves a request, supersedes its pointer and
// stores the immutable submission with its replayable receipt. No git and no
// await in here; capture happens before and the caller holds the locks.

import { nanoid } from "nanoid";

import { getDb } from "../db";
import {
  ReviewError,
  canonicalJson,
  sha256Hex,
  type ActionOperation,
  type ArtifactManifest,
  type ReviewActionName,
  type ReviewActionState,
  type ReviewKind,
  type ReviewState,
  type SubmissionPayload,
  type SubmitReceipt,
  type SubmitterContext,
} from "./types";

export interface RequestRow {
  id: string;
  task_id: string | null;
  owner_task_id: string;
  owner_session_id: string;
  generation: number;
  submitter_agent: string;
  kind: ReviewKind;
  output_key: string;
  required: 0 | 1;
  current_submission_id: string | null;
  state: ReviewState;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface SubmissionRow {
  id: string;
  request_id: string;
  revision: number;
  submitter_session_id: string;
  submitter_generation: number;
  submitter_agent: string;
  submitter_model: string | null;
  summary: string;
  requested_decision: string;
  evidence_json: string;
  validation_json: string;
  artifact_id: string;
  content_epoch: number;
  idempotency_key: string;
  payload_sha256: string;
  receipt_http_status: number;
  receipt_json: string;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  kind: ReviewKind;
  manifest_json: string;
  manifest_sha256: string;
  document_bytes: Buffer | null;
  created_at: number;
}

export interface ActionRow {
  id: string;
  request_id: string;
  submission_id: string;
  expected_version: number;
  action: ReviewActionName;
  actor_kind: "human" | "agent";
  actor_id: string;
  reason: string | null;
  idempotency_key: string;
  payload_sha256: string;
  state: ReviewActionState;
  decision_applied: 0 | 1;
  error_code: string | null;
  operation_json: string | null;
  receipt_http_status: number;
  receipt_json: string;
  created_at: number;
  updated_at: number;
}

export interface ReceiptRow {
  id: string;
  submission_id: string;
  owner_task_id: string;
  content_epoch: number;
  kind: "landed" | "retired";
  evidence_json: string;
  created_at: number;
}

// ---------- reads

export function getRequest(id: string): RequestRow | undefined {
  return getDb().prepare("SELECT * FROM review_requests WHERE id = ?").get(id) as RequestRow | undefined;
}

export function getRequestByKey(ownerTaskId: string, outputKey: string): RequestRow | undefined {
  return getDb().prepare("SELECT * FROM review_requests WHERE owner_task_id = ? AND output_key = ?").get(ownerTaskId, outputKey) as RequestRow | undefined;
}

/** Every request a task owns, oldest first. Includes history that outlived a deleted task row. */
export function listRequestsForOwner(ownerTaskId: string): RequestRow[] {
  return getDb().prepare("SELECT * FROM review_requests WHERE owner_task_id = ? ORDER BY created_at ASC, id ASC").all(ownerTaskId) as RequestRow[];
}

export function getSubmission(id: string): SubmissionRow | undefined {
  return getDb().prepare("SELECT * FROM review_submissions WHERE id = ?").get(id) as SubmissionRow | undefined;
}

export function getSubmissionByKey(requestId: string, idempotencyKey: string): SubmissionRow | undefined {
  return getDb().prepare("SELECT * FROM review_submissions WHERE request_id = ? AND idempotency_key = ?").get(requestId, idempotencyKey) as SubmissionRow | undefined;
}

export function getArtifact(id: string): ArtifactRow | undefined {
  return getDb().prepare("SELECT * FROM review_artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
}

export function latestAction(requestId: string): ActionRow | undefined {
  return getDb().prepare("SELECT * FROM review_actions WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(requestId) as ActionRow | undefined;
}

export function getAction(id: string): ActionRow | undefined {
  return getDb().prepare("SELECT * FROM review_actions WHERE id = ?").get(id) as ActionRow | undefined;
}

export function getActionByKey(requestId: string, idempotencyKey: string): ActionRow | undefined {
  return getDb().prepare("SELECT * FROM review_actions WHERE request_id = ? AND idempotency_key = ?").get(requestId, idempotencyKey) as ActionRow | undefined;
}

export function listReceipts(submissionId: string): ReceiptRow[] {
  return getDb().prepare("SELECT * FROM review_applicability_receipts WHERE submission_id = ? ORDER BY created_at ASC").all(submissionId) as ReceiptRow[];
}

/** Required requests the task owns, for the completion guard and the projection. */
export function listRequiredRequests(ownerTaskId: string): RequestRow[] {
  return getDb().prepare("SELECT * FROM review_requests WHERE owner_task_id = ? AND required = 1 ORDER BY created_at ASC, id ASC").all(ownerTaskId) as RequestRow[];
}

/** Requests in a state across every task: the Work Center projection's input. */
export function listRequestsInState(state: ReviewState): RequestRow[] {
  return getDb().prepare("SELECT * FROM review_requests WHERE state = ? AND task_id IS NOT NULL ORDER BY created_at ASC, id ASC").all(state) as RequestRow[];
}

/** A decision effect that has not settled. Blocks resubmission and cleanup. */
export function hasUnsettledAction(requestId: string, opts: { ignoreIndeterminateFeedback?: boolean } = {}): boolean {
  // A pending action always blocks. An indeterminate one blocks only while it is
  // the request's latest action: a later explicit retry supersedes it, so the
  // old row can never wedge the request once a person has resolved it.
  const db = getDb();
  if (db.prepare("SELECT 1 FROM review_actions WHERE request_id = ? AND state = 'pending' LIMIT 1").get(requestId)) return true;
  const last = latestAction(requestId);
  if (!last || last.state !== "indeterminate") return false;
  // For a person withdrawing or waiving, an uncertain feedback delivery is no
  // reason to keep the request: they are abandoning the feedback.
  if (opts.ignoreIndeterminateFeedback && (last.action === "request_changes" || last.action === "retry_feedback")) return false;
  return true;
}

/** True while any request the task owns has an effect that has not settled, feedback included. */
export function taskHasPendingOperation(ownerTaskId: string): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1 FROM review_actions a JOIN review_requests r ON r.id = a.request_id
        WHERE r.owner_task_id = ? AND a.state IN ('pending','indeterminate') LIMIT 1`,
    )
    .get(ownerTaskId);
}

/** Actions that need a person to recover them: failed or indeterminate, newest per request. */
export function listRecoverableActions(): ActionRow[] {
  return getDb().prepare(
    `SELECT a.* FROM review_actions a
      WHERE a.state IN ('failed','indeterminate')
        AND a.id = (SELECT b.id FROM review_actions b WHERE b.request_id = a.request_id ORDER BY b.created_at DESC, b.id DESC LIMIT 1)
      ORDER BY a.created_at ASC, a.id ASC`,
  ).all() as ActionRow[];
}

/** An unresolved or failed cleanup journal naming the task blocks new review mutations on it. */
export function hasUnresolvedCleanup(ownerTaskId: string): boolean {
  const rows = getDb().prepare("SELECT owner_task_ids_json, phase, error_code FROM review_cleanup_jobs WHERE phase != 'succeeded' OR error_code IS NOT NULL").all() as { owner_task_ids_json: string; phase: string; error_code: string | null }[];
  return rows.some((r) => {
    if (r.phase === "succeeded" && r.error_code === null) return false;
    try {
      return (JSON.parse(r.owner_task_ids_json) as string[]).includes(ownerTaskId);
    } catch {
      return true; // an unreadable journal fails closed
    }
  });
}

export function taskEpoch(taskId: string): number | null {
  const row = getDb().prepare("SELECT review_content_epoch AS e FROM tasks WHERE id = ?").get(taskId) as { e: number } | undefined;
  return row ? row.e : null;
}

/**
 * Advance the task's content epoch. Call before any new turn or worktree cut
 * and from every source-changing operation (move/reset/retarget/sync/repair):
 * a submission captured at an older epoch stops being current even when the
 * bytes happen to match.
 */
export function bumpReviewContentEpoch(taskId: string): number | null {
  const db = getDb();
  const r = db.prepare("UPDATE tasks SET review_content_epoch = review_content_epoch + 1 WHERE id = ?").run(taskId);
  return r.changes ? taskEpoch(taskId) : null;
}

// ---------- history

export interface HistoryCursor { t: string; r: string | null; c: number; i: string }

export const encodeCursor = (c: HistoryCursor) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

export function decodeCursor(raw: string, taskId: string, requestId: string | null): HistoryCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as HistoryCursor;
    if (c && c.t === taskId && (c.r ?? null) === requestId && Number.isInteger(c.c) && typeof c.i === "string") return c;
  } catch {
    /* fall through */
  }
  throw new ReviewError("bad_request", "invalid history cursor");
}

export interface HistoryPage {
  submissions: SubmissionRow[];
  actions: ActionRow[];
  nextCursor: string | null;
}

/**
 * One descending (created_at, id) page over submissions and actions together,
 * split afterwards. The cursor names the task and request filter it was minted
 * for, so it cannot be replayed against another scope.
 */
export function listHistory(ownerTaskId: string, opts: { requestId?: string | null; limit?: number; cursor?: string | null } = {}): HistoryPage {
  const db = getDb();
  const requestId = opts.requestId ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const cur = opts.cursor ? decodeCursor(opts.cursor, ownerTaskId, requestId) : null;
  const before = cur ? "AND (x.created_at < @c OR (x.created_at = @c AND x.id < @i))" : "";
  const reqFilter = requestId ? "AND r.id = @r" : "";
  const params = { t: ownerTaskId, r: requestId, c: cur?.c ?? 0, i: cur?.i ?? "", n: limit + 1 };
  const subs = db.prepare(
    `SELECT x.*, 's' AS src FROM review_submissions x JOIN review_requests r ON r.id = x.request_id
      WHERE r.owner_task_id = @t ${reqFilter} ${before} ORDER BY x.created_at DESC, x.id DESC LIMIT @n`,
  ).all(params) as (SubmissionRow & { src: string })[];
  const acts = db.prepare(
    `SELECT x.*, 'a' AS src FROM review_actions x JOIN review_requests r ON r.id = x.request_id
      WHERE r.owner_task_id = @t ${reqFilter} ${before} ORDER BY x.created_at DESC, x.id DESC LIMIT @n`,
  ).all(params) as (ActionRow & { src: string })[];
  const merged = [...subs, ...acts].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const more = merged.length > limit;
  return {
    submissions: page.filter((p) => p.src === "s") as unknown as SubmissionRow[],
    actions: page.filter((p) => p.src === "a") as unknown as ActionRow[],
    nextCursor: more && last ? encodeCursor({ t: ownerTaskId, r: requestId, c: last.created_at, i: last.id }) : null,
  };
}

// ---------- submission

export interface StoredReceipt { status: number; body: SubmitReceipt }

export function storedReceipt(sub: SubmissionRow): StoredReceipt {
  return { status: sub.receipt_http_status, body: JSON.parse(sub.receipt_json) as SubmitReceipt };
}

export interface CommitInput {
  payload: SubmissionPayload;
  payloadHash: string;
  ctx: SubmitterContext;
  artifact: { id: string; manifest: ArtifactManifest; documentBytes: Buffer | null };
  /** Epoch read under the task lock before capture; the commit refuses if the task moved past it. */
  capturedEpoch: number;
  now?: number;
}

/**
 * Reserve-or-supersede plus insert, as one IMMEDIATE transaction. Every
 * precondition that a concurrent writer could have changed since the caller's
 * early checks is re-read here: the request pointer and version, any unsettled
 * effect or cleanup journal, the task's terminal status and its content epoch.
 * Returns the stored receipt, which a later replay of the same idempotency key
 * returns verbatim.
 */
export function commitSubmission(input: CommitInput): StoredReceipt {
  const db = getDb();
  const { payload, ctx } = input;
  const now = input.now ?? Date.now();
  const run = db.transaction((): StoredReceipt => {
    const task = db.prepare("SELECT status, review_content_epoch AS epoch FROM tasks WHERE id = ?").get(ctx.taskId) as { status: string; epoch: number } | undefined;
    if (!task) throw new ReviewError("not_found", "task not found");
    if (payload.required && (task.status === "done" || task.status === "cancelled")) {
      throw new ReviewError("terminal_task", "reopen the task before submitting a required review");
    }
    if (task.epoch !== input.capturedEpoch) throw new ReviewError("source_changed", "the task source changed during capture");
    if (hasUnresolvedCleanup(ctx.taskId)) throw new ReviewError("operation_pending", "a review cleanup is unresolved for this task");

    let requestId: string;
    let revision: number;
    let version: number;
    if (payload.requestId === null) {
      if (getRequestByKey(ctx.taskId, payload.outputKey)) {
        throw new ReviewError("source_changed", "a review for this output key already exists; resubmit it");
      }
      requestId = nanoid();
      revision = 1;
      version = 1;
    } else {
      const req = getRequest(payload.requestId);
      if (!req || req.owner_task_id !== ctx.taskId) throw new ReviewError("not_found", "review request not found");
      if (req.kind !== payload.kind || (req.required === 1) !== payload.required) {
        throw new ReviewError("bad_request", "kind and required cannot change on resubmission");
      }
      if (req.output_key !== payload.outputKey) throw new ReviewError("bad_request", "outputKey cannot change on resubmission");
      if (req.version !== payload.expectedVersion || req.current_submission_id !== payload.expectedSubmissionId) {
        throw new ReviewError("version_conflict", "the review changed since you read it", { version: req.version, state: req.state, submissionId: req.current_submission_id });
      }
      if (hasUnsettledAction(req.id)) {
        throw new ReviewError("operation_pending", "a decision on this review has not settled", { version: req.version, state: req.state, submissionId: req.current_submission_id });
      }
      const max = db.prepare("SELECT MAX(revision) AS m FROM review_submissions WHERE request_id = ?").get(req.id) as { m: number | null };
      requestId = req.id;
      revision = (max.m ?? 0) + 1;
      version = req.version + 1;
    }

    const submissionId = nanoid();
    const receipt: SubmitReceipt = { requestId, submissionId, revision, version, state: "pending", artifactId: input.artifact.id };
    const status = 201;
    const manifestJson = canonicalJson(input.artifact.manifest);
    db.prepare(
      "INSERT INTO review_artifacts (id, kind, manifest_json, manifest_sha256, document_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(input.artifact.id, payload.kind, manifestJson, sha256Hex(manifestJson), input.artifact.documentBytes, now);
    if (payload.requestId === null) {
      db.prepare(
        `INSERT INTO review_requests (id, task_id, owner_task_id, owner_session_id, generation, submitter_agent, kind, output_key, required, current_submission_id, state, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 1, ?, ?)`,
      ).run(requestId, ctx.taskId, ctx.taskId, ctx.sessionId, ctx.generation, ctx.agent, payload.kind, payload.outputKey, payload.required ? 1 : 0, now, now);
    }
    db.prepare(
      `INSERT INTO review_submissions (id, request_id, revision, submitter_session_id, submitter_generation, submitter_agent, submitter_model, summary, requested_decision,
         evidence_json, validation_json, artifact_id, content_epoch, idempotency_key, payload_sha256, receipt_http_status, receipt_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      submissionId, requestId, revision, ctx.sessionId, ctx.generation, ctx.agent, ctx.model, payload.summary, payload.requestedDecision,
      JSON.stringify(payload.evidence), JSON.stringify(payload.validation), input.artifact.id, input.capturedEpoch,
      payload.idempotencyKey, input.payloadHash, status, canonicalJson(receipt), now,
    );
    db.prepare("UPDATE review_requests SET current_submission_id = ?, state = 'pending', version = ?, updated_at = ? WHERE id = ?").run(submissionId, version, now, requestId);
    return { status, body: receipt };
  });
  return run.immediate();
}

// ---------- applicability receipts

/** Evidence shapes, exact per contract. Minting is a landing/cleanup concern; this validates and stores. */
export function insertApplicabilityReceipt(input: {
  submissionId: string;
  kind: "landed" | "retired";
  evidence: Record<string, unknown>;
  now?: number;
}): ReceiptRow {
  const db = getDb();
  const sub = getSubmission(input.submissionId);
  if (!sub) throw new ReviewError("not_found", "submission not found");
  const req = getRequest(sub.request_id)!;
  const keys = input.kind === "landed"
    ? ["repositoryId", "submittedHeadSha", "targetRef", "baseBeforeSha", "resultCommitSha", "mode", "prNumber", "observedAt"]
    : ["repositoryId", "validatedManifestSha256", "cleanupId", "cleanupSucceededAt", "observedAt"];
  const got = Object.keys(input.evidence).sort();
  if (got.join() !== [...keys].sort().join()) throw new ReviewError("bad_request", `${input.kind} evidence has the wrong fields`);
  const epoch = taskEpoch(req.owner_task_id);
  if (epoch === null || epoch !== sub.content_epoch) throw new ReviewError("source_changed", "the submission is not at the task's current content epoch");
  const id = nanoid();
  const now = input.now ?? Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO review_applicability_receipts (id, submission_id, owner_task_id, content_epoch, kind, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, sub.id, req.owner_task_id, sub.content_epoch, input.kind, canonicalJson(input.evidence), now);
  return db.prepare("SELECT * FROM review_applicability_receipts WHERE submission_id = ? AND content_epoch = ? AND kind = ?").get(sub.id, sub.content_epoch, input.kind) as ReceiptRow;
}

// ---------- action outcomes

/** Merge actions a task owns that no one has settled yet (pending or indeterminate), oldest first. */
export function listUnsettledMerges(ownerTaskId: string): ActionRow[] {
  return getDb()
    .prepare(
      `SELECT a.* FROM review_actions a JOIN review_requests r ON r.id = a.request_id
        WHERE r.owner_task_id = ? AND a.action = 'merge' AND a.state IN ('pending','indeterminate')
        ORDER BY a.created_at ASC, a.rowid ASC`,
    )
    .all(ownerTaskId) as ActionRow[];
}

/**
 * Settle an action's durable outcome. The stored receipt is never touched:
 * it is what the original POST returned, and a replay returns it verbatim.
 * `GET` reads these columns for the current state.
 */
export function updateActionOutcome(
  actionId: string,
  patch: { state: ReviewActionState; errorCode: string | null; operation: ActionOperation | null; now?: number },
): void {
  getDb()
    .prepare("UPDATE review_actions SET state = ?, error_code = ?, operation_json = ?, updated_at = ? WHERE id = ?")
    .run(patch.state, patch.errorCode, patch.operation ? canonicalJson(patch.operation) : null, patch.now ?? Date.now(), actionId);
}
