import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/review-actions.json";
import type { ActionView, ReviewView, SubmissionView } from "../lib/reviews/types";
import type { Attention } from "../lib/workCenter/types";
import { RETRY_FEEDBACK_REASON, classifyReviewReply, decisionFailText, newIdempotencyKey } from "../app/shell/reviewActions";
import { reviewDisplay } from "../app/shell/reviewModel";
import { inlineActionsFor, sheetActionsFor, type ReviewFacts } from "../app/shell/workCenterModel";

// The decision UI's classification of every recorded WC-16 reply, and the
// review rules of the Work Center row (design release work-center-design-release/1,
// sections 4 and 5).

type Entry = { name: string; status: number; body: unknown };
const entry = (name: string): Entry => {
  const e = (fixtures as { entries: Entry[] }).entries.find((x) => x.name === name);
  if (!e) throw new Error(`no fixture ${name}`);
  return e;
};

describe("classifyReviewReply over the recorded fixtures", () => {
  it("settled and accepted replies are ok", () => {
    for (const n of ["accept.ok", "accept.replay_same_key", "waive.ok", "request_changes.accepted_202", "retry_feedback.accepted_202"]) {
      const e = entry(n);
      expect(classifyReviewReply(e.status, e.body).kind, n).toBe("ok");
    }
  });

  it("a review that moved is a conflict carrying the server's message; Dismiss refetches", () => {
    for (const n of ["error.version_conflict", "error.revision_changed", "error.source_changed", "error.idempotency_conflict", "error.artifact_unavailable", "error.not_found_submission"]) {
      const e = entry(n);
      const r = classifyReviewReply(e.status, e.body);
      expect(r.kind, n).toBe("conflict");
      if (r.kind === "conflict") expect(r.message, n).toBe((e.body as { error: { message: string } }).error.message);
    }
  });

  it("an unsettled earlier action and every other refusal fail with the real status, retryable under the same key", () => {
    for (const n of ["error.operation_pending", "error.bad_request_reason_required", "error.human_required"]) {
      const e = entry(n);
      const r = classifyReviewReply(e.status, e.body);
      expect(r.kind, n).toBe("fail");
      if (r.kind === "fail") expect(r.status).toBe(e.status);
    }
    expect(classifyReviewReply(503, null)).toMatchObject({ kind: "fail", status: 503 });
  });

  it("a 2xx without a usable body is indeterminate, never success", () => {
    expect(classifyReviewReply(200, null).kind).toBe("ind");
    expect(classifyReviewReply(202, { nope: 1 }).kind).toBe("ind");
  });

  it("FAIL text names the HTTP status", () => {
    expect(decisionFailText("accept", 409)).toBe("Acceptance not recorded (409).");
    expect(decisionFailText("waive", 503)).toBe("Waiver not recorded (503).");
  });

  it("idempotency keys are unique and fit the contract's 1 to 128 printable ASCII", () => {
    const a = newIdempotencyKey();
    expect(a).not.toBe(newIdempotencyKey());
    expect(a).toMatch(/^[\x21-\x7e]{1,128}$/);
  });

  it("the retry reason is amendment 1's fixed sentence", () => {
    expect(RETRY_FEEDBACK_REASON).toBe("Retry acknowledged: the agent may receive this feedback twice.");
  });
});

const sub = (): SubmissionView => ({
  id: "s2", revision: 2, contentEpoch: 0, createdAt: 1, summary: "", requestedDecision: "", evidence: [], validation: [],
  submitter: { sessionId: "x", generation: 1, agent: "claude", model: null },
  artifact: { id: "a", kind: "code", manifest: {} as never, manifestSha256: "h" }, superseded: false,
});
const review = (latest: ActionView): ReviewView => ({
  id: "r", taskId: "t", ownerTaskId: "t", outputKey: "code", kind: "code", required: true, state: "changes_requested", version: 3,
  currentSubmission: sub(), applicability: { state: "current", checkedAt: 1, reason: null }, allowedActions: [], latestAction: latest,
});

describe("feedback delivery states from the recorded actions", () => {
  it("maps request_changes and retry_feedback actions alike", () => {
    const at = (n: string, over: Partial<ActionView> = {}) => reviewDisplay(review({ ...(entry(n).body as ActionView), ...over }), sub());
    expect(at("feedback.dispatching")).toBe("feedback_pending");
    expect(at("feedback.queued_behind_running_turn")).toBe("feedback_pending");
    expect(at("feedback.failed_generation_changed")).toBe("feedback_failed");
    expect(at("feedback.indeterminate")).toBe("delivery_unknown");
    expect(at("feedback.delivered")).toBe("changes_requested");
    expect(at("feedback.delivered_after_retry")).toBe("changes_requested");
    expect(at("feedback.indeterminate", { action: "retry_feedback" })).toBe("delivery_unknown");
    expect(at("feedback.failed_generation_changed", { action: "retry_feedback" })).toBe("feedback_failed");
  });
});

const reviewItem = (action: Attention["action"] = "decide_review"): Attention => ({
  id: "i", sourceRevision: "4", kind: "review", firstOccurredAt: 1, actionable: true, title: "t", action,
  destination: { projectId: "p", taskId: "t", sessionId: null, messageId: null, requestId: null, reviewRequestId: "r", submissionId: "s", surface: "review" },
  freshness: { state: "fresh", observedAt: 1, lastAttemptAt: 1, errorCode: null }, snoozedUntil: null, recoveryActionId: null, inlineDecision: null,
});
const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({ revision: 2, required: true, canAccept: true, canWaive: true, matches: true, ...over });

describe("Work Center review row", () => {
  it("offers Accept and Waive once the request is read and still matches the item", () => {
    expect(inlineActionsFor(reviewItem(), facts())).toEqual(["accept", "waive"]);
    expect(inlineActionsFor(reviewItem(), facts({ required: false }))).toEqual(["accept"]);
    expect(inlineActionsFor(reviewItem(), facts({ canAccept: false }))).toEqual(["waive"]);
  });

  it("navigates only, until the facts arrive, when they no longer match, or for a failed effect", () => {
    expect(inlineActionsFor(reviewItem())).toEqual(["open"]);
    expect(inlineActionsFor(reviewItem(), facts({ matches: false }))).toEqual(["open"]);
    expect(inlineActionsFor(reviewItem(), facts({ canAccept: false, canWaive: false }))).toEqual(["open"]);
    expect(inlineActionsFor(reviewItem("recover_review_action"), facts())).toEqual(["open"]);
  });

  it("the phone sheet offers Accept, never Waive", () => {
    expect(sheetActionsFor(reviewItem(), facts())).toEqual(["open", "accept"]);
    expect(sheetActionsFor(reviewItem(), facts({ canAccept: false }))).toEqual(["open"]);
    expect(sheetActionsFor(reviewItem())).toEqual(["open"]);
  });
});
