// Pure display model for the Review tab (design release work-center-design-release/1,
// section 5; contract work-center/1 read DTOs). Nothing here touches the DOM or
// the network, so the state mapping is unit-testable.

import type { ActionView, ReviewView, SubmissionView } from "@/lib/reviews/types";

/** The display states of the return's Review page, plus the two the release adds in section 5. */
export type ReviewDisplay =
  | "submitted"
  | "accepted"
  | "accepted_changed"
  | "changes_requested"
  | "feedback_pending"
  | "delivery_unknown"
  | "feedback_failed"
  | "waived"
  | "withdrawn"
  | "superseded"
  | "decision_pending";

/** The state the tab draws for one revision of a request. `viewing` is the revision on screen. */
export function reviewDisplay(view: ReviewView, viewing: SubmissionView): ReviewDisplay {
  if (viewing.id !== view.currentSubmission.id) return "superseded";
  const last = view.latestAction;
  if (view.state === "withdrawn") return "withdrawn";
  if (last && last.state === "pending" && (last.action === "accept" || last.action === "waive")) return "decision_pending";
  if (view.state === "accepted") {
    return view.applicability.state === "changed" || view.applicability.state === "unavailable" ? "accepted_changed" : "accepted";
  }
  if (view.state === "waived") return "waived";
  if (view.state === "changes_requested") {
    if (last && (last.action === "request_changes" || last.action === "retry_feedback")) {
      if (last.state === "pending") return "feedback_pending";
      if (last.state === "indeterminate") return "delivery_unknown";
      if (last.state === "failed") return "feedback_failed";
    }
    return "changes_requested";
  }
  return "submitted";
}

/** A pending request is the only one that asks the person for something; it carries the tab dot. */
export const needsDecision = (reviews: ReviewView[]) => reviews.some((r) => r.state === "pending");

/** The tab and the phone segment exist only for a task that has at least one review request. */
export const hasReviews = (reviews: ReviewView[] | null | undefined) => (reviews?.length ?? 0) > 0;

export const REQUEST_STATE_LABEL: Record<ReviewView["state"], string> = {
  pending: "Awaiting decision",
  changes_requested: "Changes requested",
  accepted: "Accepted",
  withdrawn: "Withdrawn",
  waived: "Waived",
};

export const shortSha = (sha: string) => sha.slice(0, 7);
export const shortDigest = (sha: string) => `${sha.slice(0, 12)}…`;

// ---------- diff text ----------

export type DiffLineClass = "a" | "d" | "h" | "";
export type DiffLine = { cls: DiffLineClass; text: string };

/** Classifies a unified diff for colouring. Header lines (`diff`, `index`, `---`, `+++`, hunks) are dim. */
export function diffLines(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) { inHunk = false; out.push({ cls: "h", text: line }); continue; }
    if (line.startsWith("@@")) { inHunk = true; out.push({ cls: "h", text: line }); continue; }
    if (!inHunk) { out.push({ cls: "h", text: line }); continue; }
    out.push({ cls: line.startsWith("+") ? "a" : line.startsWith("-") ? "d" : "", text: line });
  }
  return out;
}

/** File and line counts of the text shown. For a truncated preview these describe the preview only. */
export function diffStats(text: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const l of diffLines(text)) {
    if (l.cls === "h" && l.text.startsWith("diff --git ")) files++;
    else if (l.cls === "a") added++;
    else if (l.cls === "d") removed++;
  }
  return { files, added, removed };
}

/** The first path named in a diff, for the artifact bar. */
export function firstDiffPath(text: string): string | null {
  const m = text.match(/^diff --git a\/(.+?) b\/.+$/m);
  return m ? m[1] : null;
}

export const PREVIEW_REASON: Record<string, string> = {
  size_limit: "the diff is larger than the 2 MiB preview limit",
  path_limit: "more than 1,000 files changed, so no preview is shown",
};

// ---------- history ----------

export type HistoryRow = { submission: SubmissionView; outcome: string | null; tone: "" | "acc" | "chg" };

const OUTCOME: Partial<Record<ActionView["action"], [string, "acc" | "chg"]>> = {
  accept: ["accepted", "acc"],
  request_changes: ["changes requested", "chg"],
  retry_feedback: ["changes requested", "chg"],
  waive: ["waived", "acc"],
  withdraw: ["withdrawn by agent", "chg"],
};

/** Newest revision first. A revision's outcome is the last action that took effect on it. */
export function historyRows(submissions: SubmissionView[], actions: ActionView[]): HistoryRow[] {
  return [...submissions]
    .sort((a, b) => b.revision - a.revision)
    .map((submission) => {
      const taken = actions
        .filter((a) => a.submissionId === submission.id && (a.state === "succeeded" || a.decisionApplied))
        .sort((x, y) => y.createdAt - x.createdAt)[0];
      const o = taken ? OUTCOME[taken.action] : undefined;
      return { submission, outcome: o?.[0] ?? null, tone: o?.[1] ?? "" };
    });
}

/** Only http and https evidence links are drawn as links; the server validates, this is the second check. */
export const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? url : null);
