// Wire and domain types for Work Center review submissions (contract
// work-center/1). Pure and SDK-free: payload validation, the protocol limits and
// canonical JSON live here, and nothing in this file touches the database or git.

import { createHash } from "node:crypto";

import { MAX_COLLAB_BYTES } from "../worktreeFile";

export type ReviewKind = "code" | "document";
export type ReviewState = "pending" | "changes_requested" | "accepted" | "withdrawn" | "waived";
export type ReviewApplicabilityState = "current" | "landed" | "retired" | "changed" | "unavailable";
export type ReviewActionName = "accept" | "request_changes" | "withdraw" | "waive" | "merge" | "retry_feedback";
export type ReviewActionState = "pending" | "succeeded" | "failed" | "indeterminate";

/** Protocol constants. Changing one is a contract change, not a tuning knob. */
export const REVIEW_LIMITS = {
  summary: 4000,
  requestedDecision: 2000,
  evidenceEntries: 20,
  evidenceLabel: 200,
  evidenceUrl: 2048,
  validationEntries: 20,
  validationText: 4000,
  reason: 16000,
  outputKey: 200,
  idempotencyKey: 128,
  bodyBytes: 256 * 1024,
  documentBytes: MAX_COLLAB_BYTES,
  diffPreviewBytes: 2 * 1024 * 1024,
  diffPreviewPaths: 1000,
} as const;

export interface CodeManifest {
  repositoryId: string;
  taskBranch: string;
  baseBranch: string;
  baseTipSha: string;
  baseCommitSha: string;
  headCommitSha: string;
  baseTreeSha: string;
  headTreeSha: string;
  pr: { repositoryId: string; number: number; url: string; headSha: string } | null;
  capturedAt: number;
}

export interface DocumentManifest {
  repositoryId: string;
  path: string;
  realRelativePath: string;
  sha256: string;
  byteLength: number;
  sourceHeadSha: string | null;
  capturedAt: number;
  encoding: "utf-8";
}

export type ArtifactManifest = CodeManifest | DocumentManifest;

export interface EvidenceLink {
  url: string;
  label: string;
}
export interface ValidationClaim {
  command: string;
  result: string;
}
export type ArtifactRequest = { kind: "code" } | { kind: "document"; path: string };

export interface SubmissionPayload {
  requestId: string | null;
  expectedVersion: number;
  expectedSubmissionId: string | null;
  outputKey: string;
  kind: ReviewKind;
  required: boolean;
  summary: string;
  requestedDecision: string;
  evidence: EvidenceLink[];
  validation: ValidationClaim[];
  idempotencyKey: string;
  artifact: ArtifactRequest;
}

/** The stable error codes of contract section "Errors, migration, and rollback". */
export type ReviewErrorCode =
  | "bad_request" | "invalid_utf8" | "creation_disabled" | "not_found" | "artifact_not_found"
  | "request_expired" | "source_changed" | "version_conflict" | "idempotency_conflict"
  | "revision_changed" | "terminal_task" | "review_required" | "dirty_worktree"
  | "unstable_capture" | "generation_changed" | "operation_pending"
  | "payload_too_large" | "document_too_large" | "unsupported_artifact" | "artifact_unavailable"
  | "snapshot_busy";

const STATUS: Record<ReviewErrorCode, number> = {
  bad_request: 400, invalid_utf8: 400, creation_disabled: 403, not_found: 404, artifact_not_found: 404,
  request_expired: 409, source_changed: 409, version_conflict: 409, idempotency_conflict: 409,
  revision_changed: 409, terminal_task: 409, review_required: 409, dirty_worktree: 409,
  unstable_capture: 409, generation_changed: 409, operation_pending: 409, artifact_unavailable: 409,
  payload_too_large: 413, document_too_large: 413, unsupported_artifact: 422, snapshot_busy: 503,
};
const RETRYABLE = new Set<ReviewErrorCode>(["unstable_capture", "snapshot_busy", "version_conflict", "dirty_worktree"]);

/** A refusal with the contract's code, HTTP status and a message free of host paths and secrets. */
export class ReviewError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(readonly code: ReviewErrorCode, message: string, readonly current?: { version: number; state: ReviewState; submissionId: string | null }) {
    super(message);
    this.name = "ReviewError";
    this.status = STATUS[code];
    this.retryable = RETRYABLE.has(code);
  }
  body() {
    return {
      error: { code: this.code, message: this.message, retryable: this.retryable },
      ...(this.current ? { current: this.current } : {}),
    };
  }
}

/**
 * RFC 8785 canonical JSON for the value shapes the review protocol carries
 * (objects, arrays, strings, finite numbers, booleans, null). Keys sort by
 * UTF-16 code unit and numbers use the ECMAScript form JSON.stringify already
 * produces, which is what the RFC specifies. Nonfinite numbers and undefined
 * are rejected before they can reach a hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new ReviewError("bad_request", "nonfinite number in payload");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new ReviewError("bad_request", "unsupported value in payload");
  }
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const payloadSha256 = (payload: unknown) => sha256Hex(canonicalJson(payload));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, max: number, opts: { min?: number } = {}): string {
  if (typeof v !== "string") throw new ReviewError("bad_request", `${field} must be a string`);
  const len = [...v].length;
  if (len > max) throw new ReviewError("bad_request", `${field} is longer than ${max} characters`);
  if (len < (opts.min ?? 0)) throw new ReviewError("bad_request", `${field} must not be empty`);
  return v;
}

function exactKeys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ReviewError("bad_request", `${where}: unknown field ${k}`);
}

/**
 * Validate and normalize a submission body. Throws ReviewError (400) for a
 * malformed body; the size limit on the whole request is the transport's job
 * (REVIEW_LIMITS.bodyBytes) and enforced again here on the canonical form.
 */
export function parseSubmissionPayload(body: unknown): SubmissionPayload {
  if (!isObj(body)) throw new ReviewError("bad_request", "body must be a JSON object");
  exactKeys(body, ["requestId", "expectedVersion", "expectedSubmissionId", "outputKey", "kind", "required", "summary", "requestedDecision", "evidence", "validation", "idempotencyKey", "artifact"], "submission");
  if (Buffer.byteLength(canonicalJson(body), "utf8") > REVIEW_LIMITS.bodyBytes) {
    throw new ReviewError("payload_too_large", "submission body is larger than 256 KiB");
  }
  const requestId = body.requestId ?? null;
  if (requestId !== null && (typeof requestId !== "string" || !requestId)) throw new ReviewError("bad_request", "requestId must be null or a non-empty string");
  const expectedVersion = body.expectedVersion;
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 0) throw new ReviewError("bad_request", "expectedVersion must be a nonnegative integer");
  const expectedSubmissionId = body.expectedSubmissionId ?? null;
  if (expectedSubmissionId !== null && typeof expectedSubmissionId !== "string") throw new ReviewError("bad_request", "expectedSubmissionId must be null or a string");
  if (requestId === null) {
    if (expectedVersion !== 0 || expectedSubmissionId !== null) throw new ReviewError("bad_request", "an initial submission has expectedVersion 0 and no expectedSubmissionId");
  } else if ((expectedVersion as number) < 1 || !expectedSubmissionId) {
    throw new ReviewError("bad_request", "a resubmission needs expectedVersion >= 1 and expectedSubmissionId");
  }
  const outputKey = str(body.outputKey, "outputKey", REVIEW_LIMITS.outputKey, { min: 1 });
  if (body.kind !== "code" && body.kind !== "document") throw new ReviewError("bad_request", "kind must be code or document");
  if (typeof body.required !== "boolean") throw new ReviewError("bad_request", "required must be a boolean");
  const summary = str(body.summary, "summary", REVIEW_LIMITS.summary, { min: 1 });
  const requestedDecision = str(body.requestedDecision, "requestedDecision", REVIEW_LIMITS.requestedDecision);
  const idempotencyKey = str(body.idempotencyKey, "idempotencyKey", REVIEW_LIMITS.idempotencyKey, { min: 1 });
  if (!/^[\x20-\x7e]+$/.test(idempotencyKey)) throw new ReviewError("bad_request", "idempotencyKey must be printable ASCII");

  if (!Array.isArray(body.evidence) || body.evidence.length > REVIEW_LIMITS.evidenceEntries) throw new ReviewError("bad_request", `evidence must be a list of at most ${REVIEW_LIMITS.evidenceEntries}`);
  const evidence = body.evidence.map((e, i): EvidenceLink => {
    if (!isObj(e)) throw new ReviewError("bad_request", `evidence[${i}] must be an object`);
    exactKeys(e, ["url", "label"], `evidence[${i}]`);
    const url = str(e.url, `evidence[${i}].url`, REVIEW_LIMITS.evidenceUrl, { min: 1 });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ReviewError("bad_request", `evidence[${i}].url is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ReviewError("bad_request", `evidence[${i}].url must be http or https`);
    return { url, label: str(e.label, `evidence[${i}].label`, REVIEW_LIMITS.evidenceLabel) };
  });

  if (!Array.isArray(body.validation) || body.validation.length > REVIEW_LIMITS.validationEntries) throw new ReviewError("bad_request", `validation must be a list of at most ${REVIEW_LIMITS.validationEntries}`);
  const validation = body.validation.map((v, i): ValidationClaim => {
    if (!isObj(v)) throw new ReviewError("bad_request", `validation[${i}] must be an object`);
    exactKeys(v, ["command", "result"], `validation[${i}]`);
    return {
      command: str(v.command, `validation[${i}].command`, REVIEW_LIMITS.validationText, { min: 1 }),
      result: str(v.result, `validation[${i}].result`, REVIEW_LIMITS.validationText),
    };
  });

  const art = body.artifact;
  if (!isObj(art)) throw new ReviewError("bad_request", "artifact must be an object");
  let artifact: ArtifactRequest;
  if (art.kind === "code") {
    exactKeys(art, ["kind"], "artifact");
    artifact = { kind: "code" };
  } else if (art.kind === "document") {
    exactKeys(art, ["kind", "path"], "artifact");
    artifact = { kind: "document", path: str(art.path, "artifact.path", 4096, { min: 1 }) };
  } else {
    throw new ReviewError("unsupported_artifact", "artifact kind must be code or document");
  }
  if (artifact.kind !== body.kind) throw new ReviewError("bad_request", "artifact.kind must match kind");

  return {
    requestId: requestId as string | null,
    expectedVersion: expectedVersion as number,
    expectedSubmissionId,
    outputKey, kind: body.kind, required: body.required, summary, requestedDecision,
    evidence, validation, idempotencyKey, artifact,
  };
}

/** The server-supplied identity of the calling task and session. Never read from the body. */
export interface SubmitterContext {
  taskId: string;
  sessionId: string;
  generation: number;
  agent: string;
  model: string | null;
}

// ---- read DTOs (contract: ReviewView, SubmissionView, ActionView)

export interface SubmissionView {
  id: string;
  revision: number;
  contentEpoch: number;
  createdAt: number;
  summary: string;
  requestedDecision: string;
  evidence: EvidenceLink[];
  validation: Array<ValidationClaim & { attributedTo: { sessionId: string; generation: number; agent: string }; submittedAt: number }>;
  submitter: { sessionId: string; generation: number; agent: string; model: string | null };
  artifact: { id: string; kind: ReviewKind; manifest: ArtifactManifest; manifestSha256: string };
  superseded: boolean;
}

export interface ActionView {
  id: string;
  submissionId: string;
  action: ReviewActionName;
  state: ReviewActionState;
  decisionApplied: boolean;
  errorCode: string | null;
  operation: unknown | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewView {
  id: string;
  taskId: string | null;
  ownerTaskId: string;
  outputKey: string;
  kind: ReviewKind;
  required: boolean;
  state: ReviewState;
  version: number;
  currentSubmission: SubmissionView;
  applicability: { state: ReviewApplicabilityState; checkedAt: number; reason: string | null };
  allowedActions: ReviewActionName[];
  latestAction: ActionView | null;
}

export interface SubmitReceipt {
  requestId: string;
  submissionId: string;
  revision: number;
  version: number;
  state: "pending";
  artifactId: string;
}
