// Landed receipts (WC-16): every existing route that lands an accepted head
// leaves the evidence that lets the task keep passing the required-review guard
// afterwards, so an accepted and merged task can be completed and reclaimed.
// A landing of any other head leaves none.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mergeTaskPrMock, fetchPrStateMock } = vi.hoisted(() => ({ mergeTaskPrMock: vi.fn(), fetchPrStateMock: vi.fn() }));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  mergeTaskPr: mergeTaskPrMock,
  fetchPrState: fetchPrStateMock,
  fetchCheckEvidence: vi.fn(async () => ({ ok: false, error: "none" })),
}));

import { POST as mergeRoute } from "../app/api/tasks/[id]/merge/route";
import { POST as completeRoute } from "../app/api/tasks/[id]/merge/complete/route";
import { POST as prepareRoute } from "../app/api/tasks/[id]/merge/prepare/route";
import { POST as prMergeRoute } from "../app/api/tasks/[id]/pr/merge/route";
import { performReviewAction } from "../lib/reviews/actions";
import { reviewRefusal } from "../lib/reviews/gate";
import { listTaskReviews } from "../lib/reviews/read";
import { listReceipts } from "../lib/reviews/store";
import { submitReview } from "../lib/reviews/submit";
import { refreshPrState } from "../lib/prState";
import { getTask, updateTask } from "../lib/store";
import { commitFile, git, uid } from "./helpers";
import { codeBody, reviewTask } from "./reviewFixture";

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
  mergeTaskPrMock.mockReset();
  fetchPrStateMock.mockReset();
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function acceptedCode() {
  const f = await reviewTask();
  // The merge routes want the task's own branch recorded, as ensureWorktree's callers do.
  const branch = (await git(f.wt.path, "symbolic-ref", "--short", "HEAD")).trim();
  updateTask(f.taskId, { work_branch: branch });
  await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
  const sub = await submitReview(f.ctx, codeBody());
  const head = (await git(f.wt.path, "rev-parse", "HEAD")).trim();
  await performReviewAction(f.taskId, sub.body.requestId, { submissionId: sub.body.submissionId, expectedVersion: sub.body.version, action: "accept", idempotencyKey: `k-${uid()}` }, { id: "instance-owner" });
  return { ...f, submissionId: sub.body.submissionId, head };
}

const post = (url: string, body?: unknown) => new Request(url, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("receipts from the landing routes", () => {
  it("POST /merge mints a landed receipt, after which the task is no longer blocked and can complete", async () => {
    const f = await acceptedCode();
    const res = await mergeRoute(post(`http://x/api/tasks/${f.taskId}/merge`), params(f.taskId));
    expect(res.status).toBe(200);
    const receipts = listReceipts(f.submissionId);
    expect(receipts.map((r) => r.kind)).toEqual(["landed"]);
    expect(JSON.parse(receipts[0].evidence_json)).toMatchObject({ mode: "local", submittedHeadSha: f.head, targetRef: "refs/heads/main", prNumber: null });
    expect(Object.keys(JSON.parse(receipts[0].evidence_json)).sort()).toEqual(["baseBeforeSha", "mode", "observedAt", "prNumber", "repositoryId", "resultCommitSha", "submittedHeadSha", "targetRef"]);
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("landed");
    expect(await reviewRefusal(f.taskId)).toBeNull();
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
  });

  it("POST /merge/complete mints the receipt when it lands the unchanged accepted head", async () => {
    const f = await acceptedCode();
    const res = await completeRoute(post(`http://x/api/tasks/${f.taskId}/merge/complete`, {}), params(f.taskId));
    expect(res.status).toBe(200);
    expect(listReceipts(f.submissionId).map((r) => r.kind)).toEqual(["landed"]);
  });

  it("POST /merge/prepare mints the receipt when a clean trial lands the accepted head", async () => {
    const f = await acceptedCode();
    const res = await prepareRoute(post(`http://x/api/tasks/${f.taskId}/merge/prepare`), params(f.taskId));
    expect(res.status).toBe(200);
    expect(listReceipts(f.submissionId).map((r) => r.kind)).toEqual(["landed"]);
  });

  it("a landing of some other head leaves no receipt", async () => {
    const f = await acceptedCode();
    // Past the accepted head the guard already refuses the route, so the landing never happens.
    await commitFile(f.wt.path, "src/b.txt", "b\n", "feat: b");
    const res = await mergeRoute(post(`http://x/api/tasks/${f.taskId}/merge`), params(f.taskId));
    expect(res.status).toBe(409);
    expect(listReceipts(f.submissionId)).toEqual([]);
  });
});

describe("receipts from the PR path", () => {
  const snap = (head: string, merged: boolean) => ({
    number: 9, state: merged ? "merged" : "open", checks: "passing", review: "", mergedAt: merged ? 1_700_000_000_000 : 0,
    mergeState: "CLEAN", draft: false, failing: [], headSha: head, mergeCommitSha: merged ? "b".repeat(40) : "", baseRef: "main",
  });

  it("POST /pr/merge pins the accepted head in the remote call and mints from the refreshed, merged PR", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/9", pr_number: 9 });
    let merged = false;
    fetchPrStateMock.mockImplementation(async () => ({ ok: true, snapshot: snap(f.head, merged) }));
    mergeTaskPrMock.mockImplementation(async () => {
      merged = true;
      return { ok: true, merged: true };
    });
    const res = await prMergeRoute(post(`http://x/api/tasks/${f.taskId}/pr/merge`), params(f.taskId));
    expect(res.status).toBe(200);
    expect(mergeTaskPrMock.mock.calls[0][0]).toMatchObject({ number: 9, expectedHeadSha: f.head });
    const receipt = listReceipts(f.submissionId).find((r) => r.kind === "landed")!;
    expect(JSON.parse(receipt.evidence_json)).toMatchObject({ mode: "pr", prNumber: 9, submittedHeadSha: f.head, resultCommitSha: "b".repeat(40), targetRef: "refs/heads/main" });
    expect(await reviewRefusal(f.taskId)).toBeNull();
  });

  it("the PR poll mints when a merged PR's head equals the accepted head, and not otherwise", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/9", pr_number: 9 });
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snap("f".repeat(40), true) });
    await refreshPrState(f.taskId, { force: true });
    expect(listReceipts(f.submissionId)).toEqual([]);
    expect(getTask(f.taskId)!.pr_state).toBe("merged");

    // A PR record that has since been corrected to the accepted head is recognized on the next look.
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snap(f.head, true) });
    await refreshPrState(f.taskId, { force: true });
    expect(listReceipts(f.submissionId).map((r) => r.kind)).toEqual(["landed"]);
    // Idempotent: a further poll adds nothing.
    await refreshPrState(f.taskId, { force: true });
    expect(listReceipts(f.submissionId)).toHaveLength(1);
  });
});
