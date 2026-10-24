// The Work Center's review attention source (contract work-center/1). A pending
// review with a current submission is one `decide_review` item, and a failed or
// indeterminate decision effect is one `recover_review_action` item. Both read
// the review tables only; nothing here duplicates the existing question,
// permission, CI or settings sources. Reads stay on with
// CALANDRIA_REVIEW_REQUESTS off, so a pending review is never hidden by the flag.
// Store-only and SDK-free.

import { getRequest, getSubmission, listRecoverableActions, listRequestsInState } from "@/lib/reviews/store";
import { sourceId } from "./ids";
import type { Attention, Destination, Freshness, Ms } from "./types";

/** The task columns the adapter needs; WorkCenterTaskRow satisfies it. */
export interface ReviewTaskRow {
  id: string;
  project_id: string;
  snoozed_until: number | null;
}

const FRESH = (now: Ms): Freshness => ({ state: "fresh", observedAt: now, lastAttemptAt: now, errorCode: null });

function destination(row: ReviewTaskRow, requestId: string, submissionId: string): Destination {
  return { projectId: row.project_id, taskId: row.id, sessionId: null, messageId: null, requestId: null, reviewRequestId: requestId, submissionId, surface: "review" };
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

export function reviewAttention(rows: Map<string, ReviewTaskRow>, now: Ms): Attention[] {
  const out: Attention[] = [];
  const snooze = (row: ReviewTaskRow) => (row.snoozed_until && row.snoozed_until > now ? row.snoozed_until : null);

  for (const req of listRequestsInState("pending")) {
    const row = req.task_id ? rows.get(req.task_id) : undefined;
    const sub = req.current_submission_id ? getSubmission(req.current_submission_id) : undefined;
    if (!row || !sub) continue;
    out.push({
      id: sourceId("review", [row.id, req.id, sub.id]),
      sourceRevision: String(req.version),
      kind: "review",
      firstOccurredAt: sub.created_at,
      actionable: true,
      title: clip(sub.summary.split("\n")[0] || "Review requested"),
      action: "decide_review",
      destination: destination(row, req.id, sub.id),
      freshness: FRESH(now),
      snoozedUntil: snooze(row),
      recoveryActionId: null,
      inlineDecision: null,
    });
  }

  for (const act of listRecoverableActions()) {
    const req = getRequest(act.request_id);
    const row = req?.task_id ? rows.get(req.task_id) : undefined;
    if (!req || !row) continue;
    out.push({
      id: sourceId("review", [row.id, req.id, "action", act.id]),
      sourceRevision: act.id,
      kind: "review",
      firstOccurredAt: act.updated_at,
      actionable: true,
      title: act.state === "indeterminate" ? "A review decision may not have been delivered" : "A review decision failed",
      action: "recover_review_action",
      destination: destination(row, req.id, act.submission_id),
      freshness: FRESH(now),
      snoozedUntil: snooze(row),
      recoveryActionId: act.id,
      inlineDecision: null,
    });
  }
  return out;
}
