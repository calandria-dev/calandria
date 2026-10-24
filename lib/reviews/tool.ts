// Agent-tool policy for submit_review, get_review and withdraw_review. Shared by
// the Claude driver (in process) and the stdio bridge's internal endpoints so
// the two cannot drift. SDK-free: it reaches the review service and the task
// row, never the runner. None of these tools complete a task, merge, release a
// dependent or reclaim a checkout, and none can accept or waive a requirement.

import { getTask } from "../store";
import { bumpWorkCenter } from "../workCenter/execution";
import { listTaskReviews } from "./read";
import { submitReview } from "./submit";
import { ReviewError, type SubmitterContext } from "./types";
import { withdrawReview } from "./withdraw";

export interface ReviewToolResult {
  ok: boolean;
  text: string;
}

function describeError(tool: string, e: unknown): ReviewToolResult {
  if (!(e instanceof ReviewError)) throw e;
  const cur = e.current ? ` Current: version ${e.current.version}, state ${e.current.state}, submission ${e.current.submissionId ?? "none"}.` : "";
  return {
    ok: false,
    text: `${tool} refused (${e.code}${e.retryable ? ", retryable" : ""}): ${e.message}.${cur} Nothing was changed.`,
  };
}

function contextOf(callerId: string): SubmitterContext | null {
  const t = getTask(callerId);
  if (!t) return null;
  return { taskId: t.id, sessionId: t.session_id ?? "", generation: t.generation, agent: t.agent, model: t.resolved_model ?? t.model ?? null };
}

export async function submitReviewForAgent(callerId: string, args: unknown): Promise<ReviewToolResult> {
  const ctx = contextOf(callerId);
  if (!ctx) return { ok: false, text: "Could not submit a review: this task no longer exists." };
  try {
    const r = await submitReview(ctx, args);
    bumpWorkCenter();
    const b = r.body;
    return {
      ok: true,
      text:
        `Review submitted: request ${b.requestId}, submission ${b.submissionId}, revision ${b.revision}, version ${b.version}, state ${b.state}. ` +
        `This only asks a person to decide. It does not complete the task, merge, or release anything waiting on it, and only a person can accept or waive it. ` +
        `To revise, call submit_review again with requestId ${b.requestId}, expectedVersion ${b.version} and expectedSubmissionId ${b.submissionId}.`,
    };
  } catch (e) {
    return describeError("submit_review", e);
  }
}

export async function getReviewForAgent(callerId: string, args: { requestId?: string | null; limit?: number; cursor?: string | null }): Promise<ReviewToolResult> {
  if (!getTask(callerId)) return { ok: false, text: "Could not read reviews: this task no longer exists." };
  try {
    const out = await listTaskReviews(callerId, {
      requestId: args.requestId || null,
      limit: args.limit,
      cursor: args.cursor || null,
    });
    return { ok: true, text: JSON.stringify(out) };
  } catch (e) {
    return describeError("get_review", e);
  }
}

export async function withdrawReviewForAgent(
  callerId: string,
  args: { requestId: string; expectedVersion: number; idempotencyKey: string; reason: string },
): Promise<ReviewToolResult> {
  try {
    const r = await withdrawReview(callerId, args);
    return {
      ok: true,
      text:
        `Review withdrawn: request ${r.requestId}, version ${r.version}. A required review stays unsatisfied after withdrawal: ` +
        `the task still cannot complete until a person waives it or you resubmit and it is accepted.`,
    };
  } catch (e) {
    return describeError("withdraw_review", e);
  }
}
