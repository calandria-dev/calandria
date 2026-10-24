import { describe, expect, it } from "vitest";
import type { ActionView, ReviewView, SubmissionView } from "../lib/reviews/types";
import { diffLines, diffStats, firstDiffPath, hasReviews, historyRows, needsDecision, reviewDisplay, safeHref } from "../app/shell/reviewModel";

const sub = (over: Partial<SubmissionView> = {}): SubmissionView => ({
  id: "s2", revision: 2, contentEpoch: 0, createdAt: 1, summary: "", requestedDecision: "", evidence: [], validation: [],
  submitter: { sessionId: "x", generation: 1, agent: "claude", model: null },
  artifact: { id: "a", kind: "code", manifest: {} as never, manifestSha256: "h" }, superseded: false, ...over,
});
const act = (over: Partial<ActionView> = {}): ActionView => ({
  id: "act", submissionId: "s2", action: "accept", state: "succeeded", decisionApplied: true, errorCode: null, operation: null, createdAt: 5, updatedAt: 5, ...over,
});
const review = (over: Partial<ReviewView> = {}): ReviewView => ({
  id: "r", taskId: "t", ownerTaskId: "t", outputKey: "code", kind: "code", required: true, state: "pending", version: 2,
  currentSubmission: sub(), applicability: { state: "current", checkedAt: 1, reason: null }, allowedActions: [], latestAction: null, ...over,
});

describe("reviewDisplay", () => {
  it("maps request state and applicability to the drawn states", () => {
    const s = sub();
    expect(reviewDisplay(review(), s)).toBe("submitted");
    expect(reviewDisplay(review({ state: "accepted" }), s)).toBe("accepted");
    expect(reviewDisplay(review({ state: "accepted", applicability: { state: "changed", checkedAt: 1, reason: "moved" } }), s)).toBe("accepted_changed");
    expect(reviewDisplay(review({ state: "accepted", applicability: { state: "landed", checkedAt: 1, reason: null } }), s)).toBe("accepted");
    expect(reviewDisplay(review({ state: "changes_requested" }), s)).toBe("changes_requested");
    expect(reviewDisplay(review({ state: "withdrawn" }), s)).toBe("withdrawn");
    expect(reviewDisplay(review({ state: "waived" }), s)).toBe("waived");
  });

  it("a revision that is not the current one is superseded, whatever the request says", () => {
    expect(reviewDisplay(review({ state: "accepted" }), sub({ id: "s1", revision: 1 }))).toBe("superseded");
  });

  it("feedback delivery states come from the latest request_changes action", () => {
    const base = { state: "changes_requested" as const };
    const f = (state: ActionView["state"]) => reviewDisplay(review({ ...base, latestAction: act({ action: "request_changes", state }) }), sub());
    expect(f("pending")).toBe("feedback_pending");
    expect(f("indeterminate")).toBe("delivery_unknown");
    expect(f("failed")).toBe("feedback_failed");
    expect(f("succeeded")).toBe("changes_requested");
  });

  it("an accept or waive in flight is its own state", () => {
    expect(reviewDisplay(review({ latestAction: act({ action: "waive", state: "pending" }) }), sub())).toBe("decision_pending");
  });
});

describe("tab visibility and the pending dot", () => {
  it("the tab exists only with at least one request; the dot only while one is pending", () => {
    expect(hasReviews([])).toBe(false);
    expect(hasReviews(null)).toBe(false);
    expect(hasReviews([review()])).toBe(true);
    expect(needsDecision([review({ state: "accepted" })])).toBe(false);
    expect(needsDecision([review({ state: "accepted" }), review({ state: "pending" })])).toBe(true);
  });
});

describe("diff text", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@",
    "-old", "+new", " same", "diff --git a/b.md b/b.md", "--- a/b.md", "+++ b/b.md", "@@ -1 +1,2 @@", " x", "+y",
  ].join("\n") + "\n";
  it("counts only hunk lines, not file headers", () => {
    expect(diffStats(diff)).toEqual({ files: 2, added: 2, removed: 1 });
    expect(diffLines(diff).filter((l) => l.cls === "a").map((l) => l.text)).toEqual(["+new", "+y"]);
    expect(firstDiffPath(diff)).toBe("src/a.ts");
  });
});

describe("history", () => {
  it("orders newest first and names what was decided on each revision", () => {
    const rows = historyRows(
      [sub({ id: "s1", revision: 1 }), sub()],
      [act({ id: "a1", submissionId: "s1", action: "request_changes" }), act({ id: "a2", state: "failed", decisionApplied: false })],
    );
    expect(rows.map((r) => [r.submission.revision, r.outcome, r.tone])).toEqual([[2, null, ""], [1, "changes requested", "chg"]]);
  });
});

describe("safeHref", () => {
  it("links only http and https", () => {
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });
});
