// The human decision service for review requests (contract work-center/1,
// "Decisions, effects, and recovery"). One entry point, `performReviewAction`,
// behind POST /api/tasks/[id]/reviews/[requestId]/actions.
//
// Guarantees, in the order a request meets them:
//   1. Idempotency before CAS. A known (request, key) returns the stored
//      receipt verbatim at any later version, or 409 idempotency_conflict when
//      the payload differs.
//   2. Compare-and-swap on the exact submission and request version, under the
//      task lock and again inside one IMMEDIATE transaction, so two tabs with
//      different keys produce one winner and one version_conflict.
//   3. Every action row is persisted (`pending`) before any external effect,
//      with its public response serialized into the receipt in the same
//      transaction. A crash after the effect leaves a row the recovery paths
//      read, never a silent success.
//   4. Acceptance, merge, completion and dependent release stay separate.
//      Accept writes `accepted` and nothing else; merge is its own action with
//      its own outcome; nothing here writes task `done`.

import { nanoid } from "nanoid";

import { hasTurn } from "../abort";
import { resolveBaseBranch } from "../baseBranch";
import { getDb } from "../db";
import { isAncestorCommit, mergeTask, resolveCommit, taskCommitMessage } from "../git";
import { fetchPrState, mergeTaskPr } from "../github";
import { createLogger } from "../log.mjs";
import { prMergeBlocker } from "../prMerge";
import { refreshPrState, schedulePrRefresh, startPrPolling } from "../prState";
import { getProject, getTask, recordTaskMerge, updateTask } from "../store";
import { withTaskLock } from "../taskLock";
import { bumpWorkCenter } from "../workCenter/execution";
import { verifyPins } from "./artifacts";
import { deliverFeedback } from "./feedback";
import { reviewRefusal } from "./gate";
import { baseTipBefore, recordLocalLanding } from "./landing";
import { evaluateApplicability } from "./read";
import {
  getAction,
  getActionByKey,
  getArtifact,
  getRequest,
  getSubmission,
  hasUnresolvedCleanup,
  hasUnsettledAction,
  latestAction,
  listReceipts,
  listUnsettledMerges,
  updateActionOutcome,
  type ActionRow,
  type RequestRow,
  type SubmissionRow,
} from "./store";
import {
  ReviewError,
  canonicalJson,
  parseActionBody,
  sha256Hex,
  type ActionBody,
  type ActionOperation,
  type ActionResponse,
  type CodeManifest,
  type FeedbackOperation,
  type HumanActor,
  type MergeOperation,
  type ReviewActionState,
  type ReviewState,
} from "./types";

const log = createLogger("review-actions");

export interface ActionResult {
  status: number;
  body: ActionResponse;
  /** Resolves when any asynchronous effect this request started has settled. For tests; the route ignores it. */
  settled?: Promise<void>;
}

const TIMEOUT_RE = /timed? ?out|etimedout|killed|sigterm|deadline/i;

type Current = { version: number; state: ReviewState; submissionId: string | null };
const currentOf = (r: RequestRow): Current => ({ version: r.version, state: r.state, submissionId: r.current_submission_id });

interface ActionInsert {
  id: string;
  req: RequestRow;
  sub: SubmissionRow;
  body: ActionBody;
  hash: string;
  actor: HumanActor;
  state: ReviewActionState;
  decisionApplied: boolean;
  errorCode: string | null;
  operation: ActionOperation | null;
  status: number;
  response: ActionResponse;
  now: number;
}

function insertAction(a: ActionInsert) {
  getDb()
    .prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, reason, idempotency_key, payload_sha256,
         state, decision_applied, error_code, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.id, a.req.id, a.sub.id, a.body.expectedVersion, a.body.action, a.actor.id, a.body.reason, a.body.idempotencyKey, a.hash,
      a.state, a.decisionApplied ? 1 : 0, a.errorCode, a.operation ? canonicalJson(a.operation) : null, a.status, canonicalJson(a.response), a.now, a.now,
    );
}

function responseOf(req: { id: string; version: number; state: ReviewState }, subId: string, action: { id: string; state: ReviewActionState; decisionApplied: boolean; errorCode: string | null; operation: ActionOperation | null }): ActionResponse {
  return { requestId: req.id, submissionId: subId, version: req.version, state: req.state, action };
}

/** Rewrite an action's stored receipt. Only used for the request that is about to return that very response. */
function finalizeReceipt(actionId: string, status: number, response: ActionResponse) {
  getDb().prepare("UPDATE review_actions SET receipt_http_status = ?, receipt_json = ? WHERE id = ?").run(status, canonicalJson(response), actionId);
}

export async function performReviewAction(ownerTaskId: string, requestId: string, rawBody: unknown, actor: HumanActor): Promise<ActionResult> {
  const body = parseActionBody(rawBody);
  const hash = sha256Hex(canonicalJson({ requestId, submissionId: body.submissionId, expectedVersion: body.expectedVersion, action: body.action, idempotencyKey: body.idempotencyKey, reason: body.reason }));
  const out = await withTaskLock(ownerTaskId, () => run(ownerTaskId, requestId, body, hash, actor));
  bumpWorkCenter();
  return out;
}

async function run(ownerTaskId: string, requestId: string, body: ActionBody, hash: string, actor: HumanActor): Promise<ActionResult> {
  const req = getRequest(requestId);
  if (!req || req.owner_task_id !== ownerTaskId || !getTask(ownerTaskId)) throw new ReviewError("not_found", "review request not found");

  // 1. Replay before CAS: the receipt is the answer at any later version.
  const seen = getActionByKey(req.id, body.idempotencyKey);
  if (seen) {
    if (seen.payload_sha256 !== hash) throw new ReviewError("idempotency_conflict", "this idempotency key was used with different content", currentOf(req));
    return { status: seen.receipt_http_status, body: JSON.parse(seen.receipt_json) as ActionResponse };
  }

  const sub = getSubmission(body.submissionId);
  if (!sub || sub.request_id !== req.id) throw new ReviewError("not_found", "submission not found");
  if (req.current_submission_id !== sub.id) throw new ReviewError("revision_changed", "a newer revision was submitted", currentOf(req));
  if (req.version !== body.expectedVersion) throw new ReviewError("version_conflict", "the review changed since you read it", currentOf(req));
  if (hasUnresolvedCleanup(ownerTaskId)) throw new ReviewError("operation_pending", "a review cleanup is unresolved for this task", currentOf(req));

  const ctx = { ownerTaskId, req, sub, body, hash, actor };
  switch (body.action) {
    case "accept": return accept(ctx);
    case "request_changes": return requestChanges(ctx);
    case "withdraw": return withdraw(ctx);
    case "waive": return waive(ctx);
    case "merge": return merge(ctx);
    case "retry_feedback": return retryFeedback(ctx);
  }
}

interface Ctx { ownerTaskId: string; req: RequestRow; sub: SubmissionRow; body: ActionBody; hash: string; actor: HumanActor }

/** Refuse unless an earlier effect on this request has settled. */
function assertSettled(c: Ctx, opts: { ignoreIndeterminateFeedback?: boolean } = {}) {
  if (hasUnsettledAction(c.req.id, opts)) throw new ReviewError("operation_pending", "a decision on this review has not settled", currentOf(c.req));
}

/**
 * The shared decision transaction: CAS the request row, insert the action row
 * and its receipt. Re-reads the request inside the IMMEDIATE transaction, so a
 * writer that slipped in after the early checks loses with version_conflict.
 */
function commitDecision(
  c: Ctx,
  next: { state: ReviewState; actionState: ReviewActionState; decisionApplied: boolean; operation: ActionOperation | null; status: number; fromStates: ReviewState[]; epochMustMatch?: boolean },
): ActionResult {
  const db = getDb();
  const now = Date.now();
  const actionId = nanoid();
  const version = c.req.version + 1;
  const response = responseOf({ id: c.req.id, version, state: next.state }, c.sub.id, { id: actionId, state: next.actionState, decisionApplied: next.decisionApplied, errorCode: null, operation: next.operation });
  db.transaction(() => {
    if (next.epochMustMatch) {
      const t = db.prepare("SELECT review_content_epoch AS e FROM tasks WHERE id = ?").get(c.ownerTaskId) as { e: number } | undefined;
      if (!t || t.e !== c.sub.content_epoch) throw new ReviewError("source_changed", "the task's source changed after this submission", currentOf(c.req));
    }
    const marks = next.fromStates.map(() => "?").join(",");
    const r = db
      .prepare(`UPDATE review_requests SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND current_submission_id = ? AND state IN (${marks})`)
      .run(next.state, version, now, c.req.id, c.req.version, c.sub.id, ...next.fromStates);
    if (r.changes !== 1) {
      const live = getRequest(c.req.id) ?? c.req;
      throw new ReviewError("version_conflict", "the review changed since you read it", currentOf(live));
    }
    insertAction({ id: actionId, req: c.req, sub: c.sub, body: c.body, hash: c.hash, actor: c.actor, state: next.actionState, decisionApplied: next.decisionApplied, errorCode: null, operation: next.operation, status: next.status, response, now });
  }).immediate();
  return { status: next.status, body: response };
}

// ---------- accept

async function verifiedCurrent(req: RequestRow, sub: SubmissionRow) {
  const art = getArtifact(sub.artifact_id);
  if (!art) throw new ReviewError("artifact_unavailable", "the captured artifact is not available", currentOf(req));
  const ev = await evaluateApplicability(req, sub, art);
  if (ev.state === "unavailable") throw new ReviewError("artifact_unavailable", ev.reason ?? "the artifact cannot be observed", currentOf(req));
  if (ev.state !== "current") throw new ReviewError("source_changed", ev.reason ?? "the source no longer matches the submission", currentOf(req));
  if (art.kind === "code") await verifyPins(art.id, JSON.parse(art.manifest_json) as CodeManifest);
  return art;
}

async function accept(c: Ctx): Promise<ActionResult> {
  if (c.req.state !== "pending") {
    throw new ReviewError("version_conflict", c.req.state === "changes_requested" ? "changes were requested; the agent has to resubmit before this can be accepted" : `a ${c.req.state} review cannot be accepted`, currentOf(c.req));
  }
  assertSettled(c);
  await verifiedCurrent(c.req, c.sub);
  // Acceptance records the decision and nothing else: no merge, no completion,
  // no reclaim, no dependent release.
  return commitDecision(c, { state: "accepted", actionState: "succeeded", decisionApplied: true, operation: null, status: 200, fromStates: ["pending"], epochMustMatch: true });
}

// ---------- withdraw / waive

function withdraw(c: Ctx): ActionResult {
  if (c.req.state !== "pending" && c.req.state !== "changes_requested") {
    throw new ReviewError("version_conflict", `a ${c.req.state} review cannot be withdrawn`, currentOf(c.req));
  }
  assertSettled(c, { ignoreIndeterminateFeedback: true });
  return commitDecision(c, { state: "withdrawn", actionState: "succeeded", decisionApplied: true, operation: null, status: 200, fromStates: ["pending", "changes_requested"] });
}

async function waive(c: Ctx): Promise<ActionResult> {
  if (c.req.required !== 1) throw new ReviewError("bad_request", "only a required review can be waived", currentOf(c.req));
  if (c.req.state === "waived") throw new ReviewError("version_conflict", "this review is already waived", currentOf(c.req));
  assertSettled(c, { ignoreIndeterminateFeedback: true });
  if (c.req.state === "accepted") {
    // An acceptance that still holds is already satisfied; only a changed or
    // unavailable one is waivable.
    const art = getArtifact(c.sub.artifact_id);
    const ev = art ? await evaluateApplicability(c.req, c.sub, art) : { state: "unavailable" as const };
    if (ev.state === "current" || ev.state === "landed" || ev.state === "retired") {
      throw new ReviewError("version_conflict", "this review is already satisfied", currentOf(c.req));
    }
  }
  return commitDecision(c, { state: "waived", actionState: "succeeded", decisionApplied: true, operation: null, status: 200, fromStates: ["pending", "changes_requested", "accepted", "withdrawn"] });
}

// ---------- request changes and feedback retry

function feedbackOperation(c: Ctx, actionId: string, prior: string | null): FeedbackOperation {
  return {
    kind: "feedback",
    recordedAt: null,
    delivery: "queued",
    acceptedAt: null,
    acceptanceEvidence: null,
    taskId: c.ownerTaskId,
    expectedGeneration: c.sub.submitter_generation,
    sourceSessionId: c.sub.submitter_session_id,
    messageCorrelationId: actionId,
    targetTurnId: null,
    priorActionId: prior,
  };
}

/** commitDecision for a feedback action: its operation needs the action id, so it is minted first. */
function commitFeedback(c: Ctx, state: ReviewState, fromStates: ReviewState[], decisionApplied: boolean, prior: string | null): ActionResult {
  const db = getDb();
  const now = Date.now();
  const actionId = nanoid();
  const version = c.req.version + 1;
  const op = feedbackOperation(c, actionId, prior);
  const response = responseOf({ id: c.req.id, version, state }, c.sub.id, { id: actionId, state: "pending", decisionApplied, errorCode: null, operation: op });
  db.transaction(() => {
    const marks = fromStates.map(() => "?").join(",");
    const r = db
      .prepare(`UPDATE review_requests SET state = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND current_submission_id = ? AND state IN (${marks})`)
      .run(state, version, now, c.req.id, c.req.version, c.sub.id, ...fromStates);
    if (r.changes !== 1) throw new ReviewError("version_conflict", "the review changed since you read it", currentOf(getRequest(c.req.id) ?? c.req));
    insertAction({ id: actionId, req: c.req, sub: c.sub, body: c.body, hash: c.hash, actor: c.actor, state: "pending", decisionApplied, errorCode: null, operation: op, status: 202, response, now });
  }).immediate();
  // After the lock is released: delivery takes the task lock itself.
  const settled = Promise.resolve().then(() => deliverFeedback(actionId));
  return { status: 202, body: response, settled };
}

function requestChanges(c: Ctx): ActionResult {
  if (c.req.state !== "pending") throw new ReviewError("version_conflict", `a ${c.req.state} review cannot have changes requested`, currentOf(c.req));
  assertSettled(c);
  return commitFeedback(c, "changes_requested", ["pending"], true, null);
}

function retryFeedback(c: Ctx): ActionResult {
  if (c.req.state !== "changes_requested") throw new ReviewError("version_conflict", "there is no requested change to resend", currentOf(c.req));
  if (c.body.reason === null) throw new ReviewError("bad_request", "a reason is required to resend feedback");
  const last = latestAction(c.req.id);
  if (!last || (last.action !== "request_changes" && last.action !== "retry_feedback") || (last.state !== "failed" && last.state !== "indeterminate")) {
    throw new ReviewError("version_conflict", "the last feedback was not left failed or uncertain", currentOf(c.req));
  }
  // The earlier action stays as history; the new one links to it and carries
  // the person's acknowledgement that the agent may now receive it twice.
  return commitFeedback(c, "changes_requested", ["changes_requested"], false, last.id);
}

// ---------- merge

type MergeCtx = Ctx & { manifest: CodeManifest };

async function merge(c: Ctx): Promise<ActionResult> {
  if (c.req.kind !== "code") throw new ReviewError("bad_request", "only a code review can be merged", currentOf(c.req));
  if (c.req.state !== "accepted") throw new ReviewError("version_conflict", `a ${c.req.state} review cannot be merged`, currentOf(c.req));
  const art = getArtifact(c.sub.artifact_id);
  if (!art) throw new ReviewError("artifact_unavailable", "the captured artifact is not available", currentOf(c.req));
  const manifest = JSON.parse(art.manifest_json) as CodeManifest;
  const task = getTask(c.ownerTaskId)!;
  const project = getProject(task.project_id);
  if (!project) throw new ReviewError("not_found", "the task's project no longer exists");

  // An earlier merge that never reported back: read the world before anything
  // is attempted again. A landing it already made is recorded, never repeated.
  const landed = await reconcileMerges(c.ownerTaskId);
  if (landed || listReceipts(c.sub.id).some((r) => r.kind === "landed" && r.content_epoch === c.sub.content_epoch)) {
    return recordNoop(c, manifest, "the accepted head has already landed");
  }
  if (listUnsettledMerges(c.ownerTaskId).some((m) => m.state === "pending")) {
    throw new ReviewError("operation_pending", "a merge on this review is still in progress", currentOf(c.req));
  }

  await verifiedCurrent(c.req, c.sub);
  if (task.running || hasTurn(task.id)) throw new ReviewError("source_changed", "the task is running; wait for the session to finish before merging", currentOf(c.req));
  const refusal = await reviewRefusal(c.ownerTaskId);
  if (refusal) throw new ReviewError("review_required", refusal, currentOf(c.req));

  const mode: "local" | "pr" = task.pr_number && task.pr_url ? "pr" : "local";
  let prNumber: number | null = null;
  if (mode === "pr") {
    prNumber = task.pr_number;
    const cwd = project.repo_path || task.worktree_path;
    if (!cwd) throw new ReviewError("bad_request", "this project has no working directory", currentOf(c.req));
    await refreshPrState(task.id, { force: true });
    const fresh = getTask(task.id) ?? task;
    const blocked = prMergeBlocker(fresh);
    if (blocked) throw new ReviewError("source_changed", blocked, currentOf(c.req));
  }

  const op: MergeOperation = {
    kind: "merge",
    mode,
    expectedHeadSha: manifest.headCommitSha,
    expectedBaseSha: manifest.baseTipSha,
    repositoryId: manifest.repositoryId,
    prNumber,
    resultCommitSha: null,
    resultUrl: null,
  };

  // Persist the operation before the effect: version reserved, row pending.
  const reserved = commitDecision(c, { state: "accepted", actionState: "pending", decisionApplied: false, operation: op, status: 202, fromStates: ["accepted"] });
  const mc: MergeCtx = { ...c, manifest };
  const actionId = reserved.body.action.id;

  const outcome = mode === "local" ? await landLocal(mc, op, task.id, project.repo_path) : await landPr(mc, op, task.id, project.repo_path || task.worktree_path || "");
  updateActionOutcome(actionId, { state: outcome.state, errorCode: outcome.errorCode, operation: outcome.operation });
  const finalResponse = responseOf(
    { id: c.req.id, version: reserved.body.version, state: "accepted" },
    c.sub.id,
    { id: actionId, state: outcome.state, decisionApplied: false, errorCode: outcome.errorCode, operation: outcome.operation },
  );
  const status = outcome.state === "pending" ? 202 : 200;
  finalizeReceipt(actionId, status, finalResponse);
  return { status, body: finalResponse };
}

interface MergeOutcome { state: ReviewActionState; errorCode: string | null; operation: MergeOperation }

async function landLocal(c: MergeCtx, op: MergeOperation, taskId: string, repoPath: string): Promise<MergeOutcome> {
  const task = getTask(taskId)!;
  const project = getProject(task.project_id)!;
  if (!task.worktree_path) return { state: "failed", errorCode: "merge_failed", operation: op };
  const baseBranch = resolveBaseBranch(task, project);
  const baseBeforeSha = await baseTipBefore(repoPath, baseBranch);
  let result;
  try {
    result = await mergeTask({
      repoPath,
      worktreePath: task.worktree_path,
      // The branch the accepted manifest names, which acceptance just verified HEAD is on.
      workBranch: c.manifest.taskBranch,
      baseBranch,
      message: taskCommitMessage(task),
      expectedHeadSha: c.manifest.headCommitSha,
      expectedBaseSha: c.manifest.baseTipSha,
    });
  } catch (e) {
    log.error("local review merge threw", { task: taskId, err: e });
    // The merge may have completed before the throw: read the target.
    return (await localLanded(c, repoPath, baseBranch)) ? succeedLocal(c, op, taskId, repoPath, baseBranch, baseBeforeSha, c.manifest.headCommitSha) : { state: "indeterminate", errorCode: "merge_unverified", operation: op };
  }
  if (result.ok) return succeedLocal(c, op, taskId, repoPath, baseBranch, baseBeforeSha, result.mergedSha ?? c.manifest.headCommitSha, result);
  const code = result.conflicts?.length
    ? "merge_conflict"
    : result.dirty?.length
      ? "merge_dirty_checkout"
      : /branch moved/.test(result.error ?? "")
        ? "merge_head_moved"
        : /base branch moved/.test(result.error ?? "")
          ? "merge_base_moved"
          : "merge_failed";
  return { state: "failed", errorCode: code, operation: op };
}

async function localLanded(c: { manifest: CodeManifest }, repoPath: string, baseBranch: string): Promise<boolean> {
  return isAncestorCommit(repoPath, c.manifest.headCommitSha, `refs/heads/${baseBranch}`);
}

async function succeedLocal(
  c: MergeCtx,
  op: MergeOperation,
  taskId: string,
  repoPath: string,
  baseBranch: string,
  baseBeforeSha: string,
  mergedSha: string,
  result?: { additions?: number; deletions?: number; alreadyMerged?: boolean },
): Promise<MergeOutcome> {
  const task = getTask(taskId)!;
  const resultCommitSha = await resolveCommit(repoPath, `refs/heads/${baseBranch}`);
  const minted = await recordLocalLanding({ taskId, repoPath, baseBranch, baseBeforeSha, mergedSha });
  // Same bookkeeping the plain merge route does: the merge is recorded and the
  // diff base advances. Status is untouched; reclaim is a separate guarded step.
  updateTask(taskId, { merged_at: Date.now(), base_sha: mergedSha });
  if (!result?.alreadyMerged) recordTaskMerge({ project_id: task.project_id, task_id: taskId, agent: task.agent, additions: result?.additions ?? 0, deletions: result?.deletions ?? 0 });
  void import("../reclaim").then((m) => m.maybeAutoReclaim(taskId)).catch((e) => log.warn("auto-reclaim after review merge failed", { task: taskId, err: e }));
  const next: MergeOperation = { ...op, resultCommitSha: resultCommitSha || null };
  // A landing the receipt could not verify (the accepted head is not what
  // merged) is reported as such rather than as a clean success.
  return minted.length ? { state: "succeeded", errorCode: null, operation: next } : { state: "indeterminate", errorCode: "landing_unverified", operation: next };
}

async function landPr(c: MergeCtx, op: MergeOperation, taskId: string, cwd: string): Promise<MergeOutcome> {
  const task = getTask(taskId)!;
  if (!task.pr_number) return { state: "failed", errorCode: "merge_failed", operation: op };
  // GitHub enforces the expected head in the merge call itself; a local read
  // is never the only guard against a push that lands after it.
  const result = await mergeTaskPr({ repoPath: cwd, number: task.pr_number, expectedHeadSha: c.manifest.headCommitSha });
  if (result.ok && result.queued) {
    schedulePrRefresh(taskId, { force: true });
    startPrPolling();
    return { state: "pending", errorCode: null, operation: op };
  }
  const timedOut = !result.ok && TIMEOUT_RE.test(result.error ?? "");
  // Whatever gh said, the PR is the authority: read it before concluding.
  await refreshPrState(taskId, { force: true });
  const after = getTask(taskId) ?? task;
  const observed = await observedPrLanding(c, cwd, after.pr_number ?? task.pr_number);
  if (observed === "landed") {
    const receipt = listReceipts(c.sub.id).find((r) => r.kind === "landed" && r.content_epoch === c.sub.content_epoch);
    const evidence = receipt ? (JSON.parse(receipt.evidence_json) as { resultCommitSha?: string }) : null;
    return { state: "succeeded", errorCode: null, operation: { ...op, resultCommitSha: evidence?.resultCommitSha ?? null, resultUrl: after.pr_url ?? null } };
  }
  if (result.ok) return { state: "indeterminate", errorCode: "merge_unverified", operation: op };
  if (timedOut || observed === "unknown") return { state: "indeterminate", errorCode: "merge_unverified", operation: op };
  return { state: "failed", errorCode: "merge_failed", operation: op };
}

async function observedPrLanding(c: MergeCtx, cwd: string, number: number): Promise<"landed" | "open" | "unknown"> {
  const res = await fetchPrState(cwd, number);
  if (!res.ok) return "unknown";
  if (res.snapshot.state === "merged") return res.snapshot.headSha === c.manifest.headCommitSha ? "landed" : "open";
  return "open";
}

/** A merge request that finds the work already landed records that and runs nothing. */
function recordNoop(c: Ctx, manifest: CodeManifest, _why: string): ActionResult {
  const op: MergeOperation = { kind: "merge", mode: "local", expectedHeadSha: manifest.headCommitSha, expectedBaseSha: manifest.baseTipSha, repositoryId: manifest.repositoryId, prNumber: null, resultCommitSha: null, resultUrl: null };
  const receipt = listReceipts(c.sub.id).find((r) => r.kind === "landed" && r.content_epoch === c.sub.content_epoch);
  if (receipt) {
    const ev = JSON.parse(receipt.evidence_json) as { mode?: "local" | "pr"; resultCommitSha?: string; prNumber?: number | null };
    op.mode = ev.mode ?? "local";
    op.prNumber = ev.prNumber ?? null;
    op.resultCommitSha = ev.resultCommitSha ?? null;
  }
  return commitDecision(c, { state: "accepted", actionState: "succeeded", decisionApplied: false, operation: op, status: 200, fromStates: ["accepted"] });
}

/**
 * Settle merge actions an earlier request left pending or indeterminate by
 * reading the actual target or PR state. Returns true when one proved the
 * accepted head landed (and minted the receipt). Never attempts a merge.
 */
export async function reconcileMerges(ownerTaskId: string): Promise<boolean> {
  let landed = false;
  for (const row of listUnsettledMerges(ownerTaskId)) {
    const op = JSON.parse(row.operation_json ?? "null") as MergeOperation | null;
    const sub = getSubmission(row.submission_id);
    const task = getTask(ownerTaskId);
    const project = task && getProject(task.project_id);
    if (!op || !sub || !task || !project) continue;
    const manifest = JSON.parse(getArtifact(sub.artifact_id)!.manifest_json) as CodeManifest;
    const mc = { manifest };
    if (op.mode === "local") {
      const baseBranch = resolveBaseBranch(task, project);
      if (await localLanded(mc, project.repo_path, baseBranch)) {
        const resultCommitSha = await resolveCommit(project.repo_path, `refs/heads/${baseBranch}`);
        await recordLocalLanding({ taskId: ownerTaskId, repoPath: project.repo_path, baseBranch, baseBeforeSha: manifest.baseTipSha, mergedSha: manifest.headCommitSha });
        updateActionOutcome(row.id, { state: "succeeded", errorCode: null, operation: { ...op, resultCommitSha: resultCommitSha || null } });
        landed = true;
      } else if (row.state === "indeterminate") {
        // A local merge is atomic against the ref: not in the target means it did not land.
        updateActionOutcome(row.id, { state: "failed", errorCode: "merge_failed", operation: op });
      }
    } else if (task.pr_number) {
      await refreshPrState(ownerTaskId, { force: true });
      const settled = listUnsettledMerges(ownerTaskId).find((m) => m.id === row.id);
      if (!settled) {
        landed = (getAction(row.id) as ActionRow).state === "succeeded" || landed;
      }
    }
  }
  return landed;
}
