// Review read models (contract work-center/1): ReviewView, SubmissionView,
// ActionView, history pages, and the exact artifact reads. Every read of a
// captured artifact goes through the stored manifest and the review-owned refs,
// never the task branch or an editor draft.

import { getTask } from "../store";
import { checkManifestCurrent, headMovedSince, readCodePreview, type CodePreview } from "./artifacts";
import {
  getArtifact,
  getRequest,
  getSubmission,
  latestAction,
  listHistory,
  listReceipts,
  listRequestsForOwner,
  type ActionRow,
  type ArtifactRow,
  type RequestRow,
  type SubmissionRow,
} from "./store";
import {
  ReviewError,
  type ActionView,
  type ArtifactManifest,
  type CodeManifest,
  type ReviewActionName,
  type ReviewApplicabilityState,
  type ReviewView,
  type SubmissionView,
} from "./types";

export async function evaluateApplicability(
  req: RequestRow,
  sub: SubmissionRow,
  artifact: ArtifactRow,
  now = Date.now(),
): Promise<{ state: ReviewApplicabilityState; checkedAt: number; reason: string | null }> {
  const out = (state: ReviewApplicabilityState, reason: string | null) => ({ state, checkedAt: now, reason });
  const task = req.task_id ? getTask(req.task_id) : undefined;
  if (!task) return out("unavailable", "the owner task no longer exists");
  if (task.review_content_epoch !== sub.content_epoch) {
    return out("changed", "the task's source changed after this submission");
  }
  const manifest = JSON.parse(artifact.manifest_json) as ArtifactManifest;
  const receipts = listReceipts(sub.id).filter((r) => r.content_epoch === sub.content_epoch);
  if (receipts.some((r) => r.kind === "retired")) return out("retired", null);
  if (receipts.some((r) => r.kind === "landed")) {
    // The landing moved the base by definition, so a landed code artifact is
    // compared on the task branch alone: a commit past the accepted head is
    // work the landing never covered. A document keeps the full comparison.
    if (task.worktree_path) {
      if (artifact.kind === "code") {
        if (await headMovedSince(task.worktree_path, task.id, manifest as CodeManifest)) {
          return out("changed", "the task branch moved past the landed head");
        }
      } else {
        const v = await checkManifestCurrent({ taskId: task.id, worktree: task.worktree_path, manifest, kind: artifact.kind });
        if (v.state === "changed") return out("changed", v.reason);
      }
    }
    return out("landed", null);
  }
  const v = await checkManifestCurrent({ taskId: task.id, worktree: task.worktree_path, manifest, kind: artifact.kind });
  return out(v.state, v.reason);
}

export function submissionView(sub: SubmissionRow, artifact: ArtifactRow, superseded: boolean): SubmissionView {
  const attribution = { sessionId: sub.submitter_session_id, generation: sub.submitter_generation, agent: sub.submitter_agent };
  const claims = JSON.parse(sub.validation_json) as Array<{ command: string; result: string }>;
  return {
    id: sub.id,
    revision: sub.revision,
    contentEpoch: sub.content_epoch,
    createdAt: sub.created_at,
    summary: sub.summary,
    requestedDecision: sub.requested_decision,
    evidence: JSON.parse(sub.evidence_json),
    // A validation entry is the submitter's claim, never a server-verified result.
    validation: claims.map((c) => ({ ...c, attributedTo: attribution, submittedAt: sub.created_at })),
    submitter: { ...attribution, model: sub.submitter_model },
    artifact: { id: artifact.id, kind: artifact.kind, manifest: JSON.parse(artifact.manifest_json), manifestSha256: artifact.manifest_sha256 },
    superseded,
  };
}

export function actionView(a: ActionRow): ActionView {
  return {
    id: a.id,
    submissionId: a.submission_id,
    action: a.action,
    state: a.state,
    decisionApplied: a.decision_applied === 1,
    errorCode: a.error_code,
    operation: a.operation_json ? JSON.parse(a.operation_json) : null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

/** Advisory only: the action endpoint revalidates against the live request. */
function allowedActions(req: RequestRow, applicability: ReviewApplicabilityState, last: ActionRow | undefined): ReviewActionName[] {
  const out: ReviewActionName[] = [];
  const open = req.state === "pending" || req.state === "changes_requested";
  if (req.state === "pending") {
    if (applicability === "current") out.push("accept");
    out.push("request_changes");
  }
  if (open) out.push("withdraw");
  if (req.required === 1 && req.state !== "waived") out.push("waive");
  if (req.state === "accepted" && req.kind === "code" && applicability === "current") out.push("merge");
  if (req.state === "changes_requested" && last && last.action === "request_changes" && (last.state === "failed" || last.state === "indeterminate")) out.push("retry_feedback");
  return out;
}

export async function reviewView(req: RequestRow, now = Date.now()): Promise<ReviewView | null> {
  if (!req.current_submission_id) return null;
  const sub = getSubmission(req.current_submission_id);
  const artifact = sub && getArtifact(sub.artifact_id);
  if (!sub || !artifact) return null;
  const applicability = await evaluateApplicability(req, sub, artifact, now);
  const last = latestAction(req.id);
  return {
    id: req.id,
    taskId: req.task_id,
    ownerTaskId: req.owner_task_id,
    outputKey: req.output_key,
    kind: req.kind,
    required: req.required === 1,
    state: req.state,
    version: req.version,
    currentSubmission: submissionView(sub, artifact, false),
    applicability,
    allowedActions: allowedActions(req, applicability.state, last),
    latestAction: last ? actionView(last) : null,
  };
}

export interface ReviewCollection {
  version: 1;
  requests: ReviewView[];
  history: { submissions: SubmissionView[]; actions: ActionView[]; nextCursor: string | null };
}

export async function listTaskReviews(taskId: string, opts: { requestId?: string | null; limit?: number; cursor?: string | null } = {}): Promise<ReviewCollection> {
  if (opts.requestId) {
    const req = getRequest(opts.requestId);
    if (!req || req.owner_task_id !== taskId) throw new ReviewError("not_found", "review request not found");
  }
  const reqs = listRequestsForOwner(taskId).filter((r) => !opts.requestId || r.id === opts.requestId);
  const views = (await Promise.all(reqs.map((r) => reviewView(r)))).filter((v): v is ReviewView => v !== null);
  const page = listHistory(taskId, opts);
  const pointer = new Map(reqs.map((r) => [r.id, r.current_submission_id]));
  const subs = page.submissions.flatMap((s) => {
    const art = getArtifact(s.artifact_id);
    if (!art) return [];
    const rq = pointer.get(s.request_id) ?? getRequest(s.request_id)?.current_submission_id ?? null;
    return [submissionView(s, art, rq !== s.id)];
  });
  return { version: 1, requests: views, history: { submissions: subs, actions: page.actions.map(actionView), nextCursor: page.nextCursor } };
}

export interface ArtifactRead {
  artifactId: string;
  kind: "code" | "document";
  manifest: ArtifactManifest;
  manifestSha256: string;
  preview: CodePreview | { text: string | null; byteLength: number; pathCount: null; truncated: false; reason: null };
}

/** Parent-checked lookup shared by the JSON and raw reads. A mismatch at any level is a 404. */
function locate(taskId: string, requestId: string, submissionId: string) {
  const req = getRequest(requestId);
  if (!req || req.owner_task_id !== taskId) throw new ReviewError("not_found", "review request not found");
  const sub = getSubmission(submissionId);
  if (!sub || sub.request_id !== req.id) throw new ReviewError("not_found", "submission not found");
  const art = getArtifact(sub.artifact_id);
  if (!art) throw new ReviewError("not_found", "artifact not found");
  return { req, sub, art };
}

export async function readArtifact(taskId: string, requestId: string, submissionId: string): Promise<ArtifactRead> {
  const { art } = locate(taskId, requestId, submissionId);
  const manifest = JSON.parse(art.manifest_json) as ArtifactManifest;
  if (art.kind === "code") {
    return { artifactId: art.id, kind: "code", manifest, manifestSha256: art.manifest_sha256, preview: await readCodePreview(art.id, manifest as CodeManifest) };
  }
  const bytes = art.document_bytes ?? Buffer.alloc(0);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { artifactId: art.id, kind: "document", manifest, manifestSha256: art.manifest_sha256, preview: { text, byteLength: bytes.length, pathCount: null, truncated: false, reason: null } };
}

/** Exact stored bytes of a document artifact, for the /raw endpoint. */
export function readRawDocument(taskId: string, requestId: string, submissionId: string): { bytes: Buffer; sha256: string } {
  const { art } = locate(taskId, requestId, submissionId);
  if (art.kind !== "document" || !art.document_bytes) throw new ReviewError("unsupported_artifact", "raw bytes exist only for document artifacts");
  const manifest = JSON.parse(art.manifest_json) as { sha256: string };
  return { bytes: Buffer.from(art.document_bytes), sha256: manifest.sha256 };
}
