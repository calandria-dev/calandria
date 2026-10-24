// Client for the review decision route (contract work-center/1 with amendment 1):
// POST /api/tasks/[id]/reviews/[requestId]/actions. One idempotency key per
// person's intent, reused by every retry of that intent, so a retry after a lost
// reply replays the stored receipt and never applies twice. Every result is
// classified into the outcome strips of design release work-center-design-release/1,
// section 5. Pure apart from `fetch`, so the classification unit-tests directly.

import type { ActionResponse, ReviewActionName, ReviewState } from "@/lib/reviews/types";

/** The browser-side decisions. `withdraw` is the agent's and `merge` is the landing controls'. */
export type ReviewDecision = Extract<ReviewActionName, "accept" | "request_changes" | "waive" | "retry_feedback">;

/** The fixed reason amendment 1 sends with `retry_feedback`, after "The agent may receive this twice" is ticked. */
export const RETRY_FEEDBACK_REASON = "Retry acknowledged: the agent may receive this feedback twice.";

export type ReviewIntent = {
  decision: ReviewDecision;
  requestId: string;
  submissionId: string;
  expectedVersion: number;
  reason: string | null;
  idempotencyKey: string;
};

export type ReviewActionResult =
  /** 200 settled or 202 accepted with an effect in flight. */
  | { kind: "ok"; status: number; body: ActionResponse }
  /** Refused and not worth repeating: the review moved. Dismiss refetches. */
  | { kind: "conflict"; status: number; code: string; message: string; current: { version: number; state: ReviewState; submissionId: string | null } | null }
  /** Not recorded. Retry with the same key. */
  | { kind: "fail"; status: number; code: string | null; message: string | null }
  /** The request left and no answer came back: it may or may not have applied. */
  | { kind: "ind" };

/** Statuses that mean the review is no longer what the person saw; refetching shows what it is now. */
const CONFLICT_STATUS = new Set([404, 409]);

export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `wc-${c.randomUUID()}`;
  return `wc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Turns a settled HTTP reply into a strip. A reply with no parseable body is still a reply, so it fails by status. */
export function classifyReviewReply(status: number, body: unknown): ReviewActionResult {
  const b = body as { error?: { code?: unknown; message?: unknown }; current?: unknown } | null;
  if (status >= 200 && status < 300) {
    const ok = body as ActionResponse | null;
    if (ok && typeof ok.requestId === "string" && ok.action && typeof ok.action.id === "string") return { kind: "ok", status, body: ok };
    return { kind: "ind" };
  }
  const code = typeof b?.error?.code === "string" ? b.error.code : null;
  const message = typeof b?.error?.message === "string" ? b.error.message : null;
  if (CONFLICT_STATUS.has(status) && code !== "operation_pending") {
    const cur = b?.current as { version?: unknown; state?: unknown; submissionId?: unknown } | undefined;
    const current = cur && typeof cur.version === "number"
      ? { version: cur.version, state: cur.state as ReviewState, submissionId: typeof cur.submissionId === "string" ? cur.submissionId : null }
      : null;
    return { kind: "conflict", status, code: code ?? "conflict", message: message ?? `The review changed (${status}).`, current };
  }
  return { kind: "fail", status, code, message };
}

/** Sends one decision. A timeout or a dropped connection after sending is indeterminate. */
export async function postReviewAction(taskId: string, intent: ReviewIntent, timeoutMs = 20_000): Promise<ReviewActionResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/reviews/${encodeURIComponent(intent.requestId)}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        submissionId: intent.submissionId,
        expectedVersion: intent.expectedVersion,
        action: intent.decision,
        idempotencyKey: intent.idempotencyKey,
        reason: intent.reason,
      }),
      signal: ac.signal,
    });
  } catch {
    clearTimeout(timer);
    return { kind: "ind" };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* no body */ }
  clearTimeout(timer);
  return classifyReviewReply(res.status, body);
}

// ---------- outcome text (design MSG, FAIL and IND maps, ui/Work Center.html:88-90) ----------

export const DECISION_PENDING: Record<"accept" | "waive", string> = {
  accept: "Recording acceptance…",
  waive: "Recording waiver…",
};
export const DECISION_OK: Record<"accept" | "waive", [string, string]> = {
  accept: ["Revision accepted.", "Nothing merged. Merge is a separate landing action."],
  waive: ["Requirement waived for this submission.", "A resubmission restores it."],
};
const DECISION_FAIL: Record<"accept" | "waive", string> = {
  accept: "Acceptance not recorded",
  waive: "Waiver not recorded",
};
export const DECISION_IND: Record<"accept" | "waive" | "request_changes", string> = {
  accept: "Acceptance may have been recorded. Retrying is safe: acceptance of the same revision is idempotent.",
  waive: "The waiver may have been recorded.",
  request_changes: "The feedback may have been recorded.",
};

/** A FAIL message always carries the real HTTP status in parentheses. */
export const decisionFailText = (d: "accept" | "waive", status: number) => `${DECISION_FAIL[d]} (${status}).`;

// ---------- the person's feedback text, kept in this browser ----------

// The read DTO does not carry a feedback action's reason, so the text the
// person wrote is kept per action id in this browser. The failed and unknown
// delivery strips show it when this browser sent it.
const FEEDBACK_KEY = (actionId: string) => `calandria.wc.feedback.${actionId}`;

export function rememberFeedback(actionId: string, text: string): void {
  try { localStorage.setItem(FEEDBACK_KEY(actionId), text); } catch { /* storage unavailable */ }
}

export function recallFeedback(actionId: string | null | undefined): string | null {
  if (!actionId) return null;
  try { return localStorage.getItem(FEEDBACK_KEY(actionId)); } catch { return null; }
}
