// The submission service (contract work-center/1): the one entry the tool
// transports (WC-13) and tests call to open or supersede a review.
//
// Order: validate, replay the idempotency key, apply the creation flag, then
// task lock -> repo lock -> capture -> one short synchronous transaction.
// Every early check is repeated inside the lock or the transaction because the
// awaits between them let another writer in. A failed commit deletes only the
// pins this attempt created.

import { resolveBaseBranch } from "../baseBranch";
import { resolveFeatures } from "../features";
import { getProject, getTask } from "../store";
import { withRepoLock } from "../repoLock";
import { withTaskLock } from "../taskLock";
import { bumpWorkCenter } from "../workCenter/execution";
import { captureCode, captureDocument, commonDirOf, deletePins, type CodeCapture, type DocumentCapture, type PrEvidence } from "./artifacts";
import {
  commitSubmission,
  getRequest,
  getRequestByKey,
  getSubmissionByKey,
  hasUnresolvedCleanup,
  hasUnsettledAction,
  storedReceipt,
  taskEpoch,
  type RequestRow,
  type StoredReceipt,
} from "./store";
import { ReviewError, parseSubmissionPayload, payloadSha256, type SubmissionPayload, type SubmitterContext } from "./types";

export interface SubmitOptions {
  /** Test seam: runs after capture and before the commit. */
  beforeCommit?: () => void | Promise<void>;
  /** Test seam forwarded to the document capture. */
  beforeVerify?: () => void;
}

function currentOf(req: RequestRow) {
  return { version: req.version, state: req.state, submissionId: req.current_submission_id };
}

/** The stored receipt for an already-seen idempotency key, a conflict, or null when the key is new. */
function replay(ctx: SubmitterContext, payload: SubmissionPayload, hash: string): StoredReceipt | null {
  const req = payload.requestId ? getRequest(payload.requestId) : getRequestByKey(ctx.taskId, payload.outputKey);
  if (!req) return null;
  if (req.owner_task_id !== ctx.taskId) throw new ReviewError("not_found", "review request not found");
  const sub = getSubmissionByKey(req.id, payload.idempotencyKey);
  if (!sub) return null;
  if (sub.payload_sha256 !== hash) throw new ReviewError("idempotency_conflict", "this idempotency key was used with different content", currentOf(req));
  return storedReceipt(sub);
}

function guard(ctx: SubmitterContext, payload: SubmissionPayload) {
  const task = getTask(ctx.taskId);
  if (!task) throw new ReviewError("not_found", "task not found");
  if (task.generation !== ctx.generation) throw new ReviewError("generation_changed", "the session was cleared; reread the task");
  if (payload.required && (task.status === "done" || task.status === "cancelled")) {
    throw new ReviewError("terminal_task", "reopen the task before submitting a required review");
  }
  if (payload.requestId === null) {
    const existing = getRequestByKey(ctx.taskId, payload.outputKey);
    if (existing) throw new ReviewError("source_changed", "a review for this output key already exists; resubmit it", currentOf(existing));
  } else {
    const req = getRequest(payload.requestId);
    if (!req || req.owner_task_id !== ctx.taskId) throw new ReviewError("not_found", "review request not found");
    if (req.kind !== payload.kind || (req.required === 1) !== payload.required) throw new ReviewError("bad_request", "kind and required cannot change on resubmission");
    if (req.output_key !== payload.outputKey) throw new ReviewError("bad_request", "outputKey cannot change on resubmission");
    if (req.version !== payload.expectedVersion || req.current_submission_id !== payload.expectedSubmissionId) {
      throw new ReviewError("version_conflict", "the review changed since you read it", currentOf(req));
    }
    if (hasUnsettledAction(req.id)) throw new ReviewError("operation_pending", "a decision on this review has not settled", currentOf(req));
  }
  if (hasUnresolvedCleanup(ctx.taskId)) throw new ReviewError("operation_pending", "a review cleanup is unresolved for this task");
  return task;
}

export async function submitReview(ctx: SubmitterContext, body: unknown, opts: SubmitOptions = {}): Promise<StoredReceipt> {
  const payload = parseSubmissionPayload(body);
  const hash = payloadSha256(payload);

  const seen = replay(ctx, payload, hash);
  if (seen) return seen;
  // The flag gates a NEW request only. Resubmitting an existing one is how a
  // pending or changes_requested review gets resolved, which must keep working
  // while creation is off.
  if (payload.requestId === null && !resolveFeatures().reviewRequests) {
    throw new ReviewError("creation_disabled", "review requests are not enabled on this instance");
  }
  guard(ctx, payload);

  const early = getTask(ctx.taskId)!;
  const project = getProject(early.project_id);
  if (!project) throw new ReviewError("not_found", "project not found");

  const result = await withTaskLock(ctx.taskId, () =>
    withRepoLock(project.repo_path, async (): Promise<StoredReceipt> => {
      // Re-read everything the awaits above could have changed.
      const again = replay(ctx, payload, hash);
      if (again) return again;
      const task = guard(ctx, payload);
      const epoch = taskEpoch(task.id);
      if (epoch === null) throw new ReviewError("not_found", "task not found");

      let capture: CodeCapture | DocumentCapture;
      if (payload.artifact.kind === "code") {
        const pr: PrEvidence | null =
          task.pr_number > 0 && task.pr_head_sha
            ? { number: task.pr_number, url: task.pr_url, headSha: task.pr_head_sha, repositoryId: task.pr_repository_id ?? "" }
            : null;
        capture = await captureCode({ worktree: task.worktree_path, taskId: task.id, baseBranch: resolveBaseBranch(task, project), pr });
      } else {
        capture = await captureDocument({ worktree: task.worktree_path, path: payload.artifact.path, beforeVerify: opts.beforeVerify });
      }
      try {
        await opts.beforeCommit?.();
        return commitSubmission({
          payload,
          payloadHash: hash,
          ctx,
          capturedEpoch: epoch,
          artifact: {
            id: capture.artifactId,
            manifest: capture.manifest,
            documentBytes: "bytes" in capture ? capture.bytes : null,
          },
        });
      } catch (e) {
        if ("pins" in capture) {
          const dir = await commonDirOf(task.worktree_path).catch(() => "");
          if (dir) await deletePins(dir, capture.pins);
        }
        throw e;
      }
    }),
  );
  bumpWorkCenter();
  return result;
}
