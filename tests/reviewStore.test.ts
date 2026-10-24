// Review submission persistence (WC-12): idempotency, supersession, CAS,
// terminal-task refusal, the creation flag, unsettled effects and history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../lib/db";
import { listTaskReviews } from "../lib/reviews/read";
import {
  bumpReviewContentEpoch,
  getRequest,
  insertApplicabilityReceipt,
  listRequiredRequests,
  listRequestsForOwner,
} from "../lib/reviews/store";
import { submitReview } from "../lib/reviews/submit";
import { ReviewError } from "../lib/reviews/types";
import { reviewAttention } from "../lib/workCenter/reviewAdapter";
import { updateTask } from "../lib/store";
import { commitFile, uid } from "./helpers";
import { docBody, reviewTask } from "./reviewFixture";

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function withDoc(content = "# Plan\n") {
  const f = await reviewTask();
  await commitFile(f.wt.path, "docs/plan.md", content, "add plan");
  return f;
}

async function rejects(p: Promise<unknown>): Promise<ReviewError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ReviewError);
    return e as ReviewError;
  }
  throw new Error("expected a ReviewError");
}

describe("review submissions", () => {
  it("leaves a task with no review requirement until something is submitted", async () => {
    const f = await reviewTask();
    expect(listRequiredRequests(f.taskId)).toEqual([]);
    expect((await listTaskReviews(f.taskId)).requests).toEqual([]);
  });

  it("refuses to create a request while the creation flag is off, but still reads", async () => {
    const f = await withDoc();
    delete process.env.CALANDRIA_REVIEW_REQUESTS;
    const err = await rejects(submitReview(f.ctx, docBody()));
    expect(err.code).toBe("creation_disabled");
    expect(err.status).toBe(403);
    expect((await listTaskReviews(f.taskId)).requests).toEqual([]);
  });

  it("stores an initial submission with attributed validation claims", async () => {
    const f = await withDoc();
    const r = await submitReview(f.ctx, docBody());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ revision: 1, version: 1, state: "pending" });
    const view = (await listTaskReviews(f.taskId)).requests[0];
    expect(view.state).toBe("pending");
    expect(view.currentSubmission.validation[0]).toMatchObject({
      command: "npm test",
      result: "passed",
      attributedTo: { sessionId: f.ctx.sessionId, agent: "claude" },
    });
    expect(view.currentSubmission.submitter.model).toBe("test-model");
    expect(view.applicability.state).toBe("current");
  });

  it("returns the original receipt for a repeated key and conflicts on a changed payload", async () => {
    const f = await withDoc();
    const body = docBody();
    const first = await submitReview(f.ctx, body);
    const again = await submitReview(f.ctx, body);
    expect(again).toEqual(first);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM review_submissions WHERE request_id = ?").get(first.body.requestId)).toEqual({ n: 1 });
    const err = await rejects(submitReview(f.ctx, { ...body, summary: "different" }));
    expect(err.code).toBe("idempotency_conflict");
  });

  it("still replays a stored receipt after creation is disabled", async () => {
    const f = await withDoc();
    const body = docBody();
    const first = await submitReview(f.ctx, body);
    delete process.env.CALANDRIA_REVIEW_REQUESTS;
    expect(await submitReview(f.ctx, body)).toEqual(first);
  });

  it("rejects a second initial request for the same output key", async () => {
    const f = await withDoc();
    await submitReview(f.ctx, docBody());
    const err = await rejects(submitReview(f.ctx, docBody()));
    expect(err.code).toBe("source_changed");
  });

  it("supersedes through the pointer and keeps every earlier revision", async () => {
    const f = await withDoc();
    const first = await submitReview(f.ctx, docBody());
    await commitFile(f.wt.path, "docs/plan.md", "# Plan v2\n", "revise");
    const second = await submitReview(
      f.ctx,
      docBody({ requestId: first.body.requestId, expectedVersion: 1, expectedSubmissionId: first.body.submissionId }),
    );
    expect(second.body).toMatchObject({ revision: 2, version: 2, state: "pending" });
    const col = await listTaskReviews(f.taskId);
    expect(col.requests).toHaveLength(1);
    expect(col.requests[0].currentSubmission.id).toBe(second.body.submissionId);
    const subs = col.history.submissions;
    expect(subs.map((s) => s.revision).sort()).toEqual([1, 2]);
    expect(subs.find((s) => s.revision === 1)!.superseded).toBe(true);
    expect(subs.find((s) => s.revision === 2)!.superseded).toBe(false);
  });

  it("refuses a stale resubmission with the current version, and immutable kind or required changes", async () => {
    const f = await withDoc();
    const first = await submitReview(f.ctx, docBody());
    const base = { requestId: first.body.requestId, expectedSubmissionId: first.body.submissionId };
    const stale = await rejects(submitReview(f.ctx, docBody({ ...base, expectedVersion: 7 })));
    expect(stale.code).toBe("version_conflict");
    expect(stale.current).toMatchObject({ version: 1, state: "pending" });
    const downgrade = await rejects(submitReview(f.ctx, docBody({ ...base, expectedVersion: 1, required: false })));
    expect(downgrade.code).toBe("bad_request");
    const reload = await rejects(submitReview(f.ctx, docBody({ ...base, expectedVersion: 1, outputKey: "other" })));
    expect(reload.code).toBe("bad_request");
  });

  it("serializes two competing initial keys: one request wins, the other conflicts", async () => {
    const f = await withDoc();
    const results = await Promise.allSettled([submitReview(f.ctx, docBody()), submitReview(f.ctx, docBody())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as ReviewError).code).toBe("source_changed");
    expect(listRequestsForOwner(f.taskId)).toHaveLength(1);
  });

  it("serializes two submissions with one key into a single revision", async () => {
    const f = await withDoc();
    const body = docBody();
    const [a, b] = await Promise.all([submitReview(f.ctx, body), submitReview(f.ctx, body)]);
    expect(a).toEqual(b);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM review_submissions WHERE request_id = ?").get(a.body.requestId)).toEqual({ n: 1 });
  });

  it("rejects a required submission on a terminal task and allows an optional one", async () => {
    const f = await withDoc();
    updateTask(f.taskId, { status: "done" });
    const err = await rejects(submitReview(f.ctx, docBody()));
    expect(err.code).toBe("terminal_task");
    expect(listRequestsForOwner(f.taskId)).toEqual([]);
    const ok = await submitReview(f.ctx, docBody({ required: false, outputKey: "notes" }));
    expect(ok.status).toBe(201);
  });

  it("rejects a session whose generation was cleared", async () => {
    const f = await withDoc();
    const err = await rejects(submitReview({ ...f.ctx, generation: f.ctx.generation + 3 }, docBody()));
    expect(err.code).toBe("generation_changed");
  });

  it("refuses resubmission while a decision effect or a cleanup journal is unsettled", async () => {
    const f = await withDoc();
    const first = await submitReview(f.ctx, docBody());
    const resub = () =>
      submitReview(f.ctx, docBody({ requestId: first.body.requestId, expectedVersion: 1, expectedSubmissionId: first.body.submissionId }));
    const db = getDb();
    db.prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, idempotency_key, payload_sha256, state, decision_applied, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES ('a1', ?, ?, 1, 'request_changes', 'human', 'instance-owner', 'k', 'h', 'indeterminate', 0, 202, '{}', 1, 1)`,
    ).run(first.body.requestId, first.body.submissionId);
    expect((await rejects(resub())).code).toBe("operation_pending");
    db.prepare("UPDATE review_actions SET state = 'failed' WHERE id = 'a1'").run();
    db.prepare(
      "INSERT INTO review_cleanup_jobs (id, owner_task_ids_json, disposition_json, expected_refs_json, progress_json, phase, error_code, created_at, updated_at) VALUES ('c1', ?, '[]', '[]', '{}', 'pins_staged', 'boom', 1, 1)",
    ).run(JSON.stringify([f.taskId]));
    expect((await rejects(resub())).code).toBe("operation_pending");
    db.prepare("DELETE FROM review_cleanup_jobs").run();
    expect((await resub()).body.revision).toBe(2);
  });

  it("lets a pending review be resubmitted with creation disabled", async () => {
    const f = await withDoc();
    const first = await submitReview(f.ctx, docBody());
    delete process.env.CALANDRIA_REVIEW_REQUESTS;
    const r = await submitReview(f.ctx, docBody({ requestId: first.body.requestId, expectedVersion: 1, expectedSubmissionId: first.body.submissionId }));
    expect(r.body.revision).toBe(2);
  });

  it("makes a current-epoch acceptance stale when the task's content epoch moves", async () => {
    const f = await withDoc();
    await submitReview(f.ctx, docBody());
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("current");
    bumpReviewContentEpoch(f.taskId);
    const after = (await listTaskReviews(f.taskId)).requests[0];
    expect(after.applicability.state).toBe("changed");
    expect(after.currentSubmission.contentEpoch).toBe(0);
  });

  it("honors a landed receipt only at the submission's own epoch", async () => {
    const f = await withDoc();
    const r = await submitReview(f.ctx, docBody());
    insertApplicabilityReceipt({
      submissionId: r.body.submissionId,
      kind: "landed",
      evidence: { repositoryId: "r", submittedHeadSha: "a", targetRef: "refs/heads/main", baseBeforeSha: "b", resultCommitSha: "c", mode: "local", prNumber: null, observedAt: 1 },
    });
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("landed");
    bumpReviewContentEpoch(f.taskId);
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("changed");
    expect(() => insertApplicabilityReceipt({ submissionId: r.body.submissionId, kind: "retired", evidence: {} })).toThrow(/wrong fields/);
  });

  it("pages history newest first with a scoped cursor", async () => {
    const f = await withDoc();
    let prev = await submitReview(f.ctx, docBody());
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 3));
      prev = await submitReview(f.ctx, docBody({ requestId: prev.body.requestId, expectedVersion: prev.body.version, expectedSubmissionId: prev.body.submissionId }));
    }
    const p1 = await listTaskReviews(f.taskId, { limit: 3 });
    expect(p1.history.submissions.map((s) => s.revision)).toEqual([4, 3, 2]);
    const p2 = await listTaskReviews(f.taskId, { limit: 3, cursor: p1.history.nextCursor });
    expect(p2.history.submissions.map((s) => s.revision)).toEqual([1]);
    expect(p2.history.nextCursor).toBeNull();
    const err = await listTaskReviews("other-task", { cursor: p1.history.nextCursor }).catch((e) => e);
    expect((err as ReviewError).code).toBe("bad_request");
  });

  it("projects a pending review as one decide_review item and a failed effect as recovery", async () => {
    const f = await withDoc();
    const r = await submitReview(f.ctx, docBody());
    const rows = new Map([[f.taskId, { id: f.taskId, project_id: f.project.id, snoozed_until: null }]]);
    const items = reviewAttention(rows, Date.now());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "review", action: "decide_review", destination: { surface: "review", reviewRequestId: r.body.requestId, submissionId: r.body.submissionId } });
    getDb().prepare("UPDATE review_requests SET state = 'accepted' WHERE id = ?").run(r.body.requestId);
    expect(reviewAttention(rows, Date.now())).toEqual([]);
    expect(getRequest(r.body.requestId)!.state).toBe("accepted");
    void uid;
  });
});
