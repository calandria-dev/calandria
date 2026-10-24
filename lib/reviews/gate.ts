// The async half of the required-review guard: the same pure decision as
// lib/reviews/guard.ts, but accepted requests are checked against the live
// checkout, so an acceptance of an old revision fails after a change. Used by
// merge, reclaim, sweep and launch paths that already await git.

import { loadGateRequests, requiredReviewBlocker, type ReviewBlocker } from "./guard";
import { evaluateApplicability } from "./read";
import { getArtifact, getRequest, getSubmission } from "./store";
import type { ReviewApplicabilityState } from "./types";

export async function taskReviewBlocker(ownerTaskId: string): Promise<ReviewBlocker | null> {
  const { requests, applicability } = loadGateRequests(ownerTaskId);
  if (requests.length === 0) return null;
  for (const r of requests) {
    if (r.state !== "accepted") continue;
    const req = getRequest(r.id);
    const sub = req?.current_submission_id ? getSubmission(req.current_submission_id) : undefined;
    const artifact = sub ? getArtifact(sub.artifact_id) : undefined;
    let verdict: ReviewApplicabilityState = "unavailable";
    if (req && sub && artifact) verdict = (await evaluateApplicability(req, sub, artifact)).state;
    applicability.set(r.id, verdict);
  }
  return requiredReviewBlocker(requests, applicability);
}

/** Message for a route or tool refusal, or null to proceed. */
export async function reviewRefusal(ownerTaskId: string): Promise<string | null> {
  const b = await taskReviewBlocker(ownerTaskId);
  return b ? `${b.reason}. A person has to accept or waive it first.` : null;
}
