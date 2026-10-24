// The human decision service (WC-16): idempotent replay, compare-and-swap
// across competing tabs, the separation of accept from merge and completion,
// server-set actors, and request-changes feedback delivered to the right task
// once. Effects that need a restart or a lost reply live in reviewRecovery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Claude driver is mocked so the real runner (feedback launches a resume
// turn through it) runs with no SDK anywhere near it.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
  },
}));

import { POST as actionsPost } from "../app/api/tasks/[id]/reviews/[requestId]/actions/route";
import { subscribe } from "../lib/events";
import { reviewBlockerSync } from "../lib/reviews/guard";
import { performReviewAction } from "../lib/reviews/actions";
import { resolveHumanActor } from "../lib/reviews/actor";
import { reviewRef } from "../lib/reviews/artifacts";
import { listTaskReviews } from "../lib/reviews/read";
import { getAction, getRequest, listReceipts, taskEpoch } from "../lib/reviews/store";
import { submitReview } from "../lib/reviews/submit";
import { ReviewError, type ActionResponse, type FeedbackOperation } from "../lib/reviews/types";
import { listMessages, getTask, updateTask } from "../lib/store";
import { commitFile, git, uid } from "./helpers";
import { codeBody, docBody, reviewTask } from "./reviewFixture";

const OWNER = { id: "instance-owner" };

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
  runTurnMock.mockReset();
  runTurnMock.mockImplementation(async function* () {
    yield { type: "session", sessionId: "sess" };
    yield { type: "assistant", content: "On it." };
    yield { type: "done", sessionId: "sess" };
  });
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function docReview() {
  const f = await reviewTask();
  await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
  const sub = await submitReview(f.ctx, docBody());
  return { ...f, requestId: sub.body.requestId, submissionId: sub.body.submissionId, version: sub.body.version };
}

async function codeReview() {
  const f = await reviewTask();
  await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
  const sub = await submitReview(f.ctx, codeBody());
  return { ...f, requestId: sub.body.requestId, submissionId: sub.body.submissionId, version: sub.body.version, artifactId: sub.body.artifactId };
}

type Fx = { taskId: string; requestId: string; submissionId: string; version: number };

const body = (f: Fx, over: Record<string, unknown> = {}) => ({
  submissionId: f.submissionId,
  expectedVersion: f.version,
  action: "accept",
  idempotencyKey: `k-${uid()}`,
  ...over,
});

const act = (f: Fx, over: Record<string, unknown> = {}) => performReviewAction(f.taskId, f.requestId, body(f, over), OWNER);

async function rejects(p: Promise<unknown>): Promise<ReviewError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ReviewError);
    return e as ReviewError;
  }
  throw new Error("expected a ReviewError");
}

/** Resolve at the next turn_end the runner publishes for this task. */
const turnEnd = (taskId: string) =>
  new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });

describe("accept", () => {
  it("records the decision and nothing else: no done, no merge, no receipt", async () => {
    const f = await docReview();
    const before = getTask(f.taskId)!;
    const r = await act(f);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ requestId: f.requestId, submissionId: f.submissionId, version: f.version + 1, state: "accepted" });
    expect(r.body.action).toMatchObject({ state: "succeeded", decisionApplied: true, errorCode: null, operation: null });
    const after = getTask(f.taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.merged_at).toBe(before.merged_at);
    expect(listReceipts(f.submissionId)).toEqual([]);
    expect(getRequest(f.requestId)!.state).toBe("accepted");
    // The gate is satisfied for the current revision, and completion stays a separate step.
    expect(reviewBlockerSync(f.taskId)).toBeNull();
  });

  it("refuses an acceptance after the source changed", async () => {
    const f = await docReview();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan v2\n", "edit plan");
    const err = await rejects(act(f));
    expect(err.code).toBe("source_changed");
    expect(getRequest(f.requestId)!.state).toBe("pending");
  });

  it("refuses accept from changes_requested", async () => {
    const f = await docReview();
    const asked = await act(f, { action: "request_changes", reason: "tighten section 2" });
    await asked.settled;
    const err = await rejects(act({ ...f, version: asked.body.version }, { action: "accept" }));
    expect(err.code).toBe("version_conflict");
    expect(getRequest(f.requestId)!.state).toBe("changes_requested");
  });

  it("refuses a code acceptance whose pinned objects are gone", async () => {
    const f = await codeReview();
    await git(f.repo, "update-ref", "-d", reviewRef(f.artifactId, "head"));
    const err = await rejects(act(f));
    expect(err.code).toBe("artifact_unavailable");
  });

  it("validates the body and the actor boundary", async () => {
    const f = await docReview();
    expect((await rejects(act(f, { action: "waive" }))).code).toBe("bad_request");
    expect((await rejects(act(f, { action: "request_changes", reason: "   " }))).code).toBe("bad_request");
    expect((await rejects(act(f, { actor_id: "someone-else" }))).code).toBe("bad_request");
    expect((await rejects(act(f, { expectedVersion: 0 }))).code).toBe("bad_request");
  });
});

describe("idempotency and competing decisions", () => {
  it("replays the stored receipt verbatim at a later version", async () => {
    const f = await docReview();
    const key = `k-${uid()}`;
    const first = await act(f, { action: "request_changes", reason: "Please revise.", idempotencyKey: key });
    await first.settled;
    // The request moves on (a withdrawal), then the very same POST is repeated.
    const later = await act({ ...f, version: first.body.version }, { action: "withdraw", reason: "not needed" });
    expect(later.body.version).toBe(first.body.version + 1);
    const replay = await act(f, { action: "request_changes", reason: "Please revise.", idempotencyKey: key });
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(getRequest(f.requestId)!.version).toBe(later.body.version);
  });

  it("answers a reused key with different content as idempotency_conflict", async () => {
    const f = await docReview();
    const key = `k-${uid()}`;
    await act(f, { idempotencyKey: key });
    const err = await rejects(act(f, { idempotencyKey: key, action: "waive", reason: "changed my mind" }));
    expect(err.code).toBe("idempotency_conflict");
    expect(err.status).toBe(409);
  });

  it("lets one of two competing keys win and gives the other version_conflict with current", async () => {
    const f = await docReview();
    const results = await Promise.allSettled([act(f), act(f, { action: "request_changes", reason: "no" })]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ReviewError);
    expect((lost[0].reason as ReviewError).code).toBe("version_conflict");
    expect((lost[0].reason as ReviewError).current).toMatchObject({ version: f.version + 1 });
    const settled = (won[0] as PromiseFulfilledResult<{ settled?: Promise<void> }>).value.settled;
    await settled;
  });

  it("returns 409 revision_changed for a stale submission and version_conflict for a stale version", async () => {
    const f = await docReview();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\nmore\n", "edit");
    const resub = await submitReview(f.ctx, docBody({ requestId: f.requestId, expectedVersion: f.version, expectedSubmissionId: f.submissionId }));
    expect((await rejects(act(f))).code).toBe("revision_changed");
    expect((await rejects(act({ ...f, submissionId: resub.body.submissionId }))).code).toBe("version_conflict");
  });

  it("rejects an unknown request or another task's request as not_found", async () => {
    const f = await docReview();
    const other = await docReview();
    expect((await rejects(performReviewAction(f.taskId, "nope", body(f), OWNER))).code).toBe("not_found");
    expect((await rejects(performReviewAction(other.taskId, f.requestId, body(f), OWNER))).code).toBe("not_found");
  });
});

describe("waive and withdraw", () => {
  it("waives a required review for this submission only", async () => {
    const f = await docReview();
    const r = await act(f, { action: "waive", reason: "reviewed out of band" });
    expect(r.body.state).toBe("waived");
    expect(reviewBlockerSync(f.taskId)).toBeNull();
    const row = getAction(r.body.action.id)!;
    expect(row).toMatchObject({ actor_kind: "human", actor_id: "instance-owner", reason: "reviewed out of band", decision_applied: 1 });
    // A resubmission restores the requirement.
    await commitFile(f.wt.path, "docs/plan.md", "# Plan 2\n", "edit");
    await submitReview(f.ctx, docBody({ requestId: f.requestId, expectedVersion: r.body.version, expectedSubmissionId: f.submissionId }));
    expect(reviewBlockerSync(f.taskId)).not.toBeNull();
  });

  it("withdraws a pending review with a reason and keeps the requirement open", async () => {
    const f = await docReview();
    const r = await act(f, { action: "withdraw", reason: "wrong approach" });
    expect(r.body.state).toBe("withdrawn");
    expect(reviewBlockerSync(f.taskId)).not.toBeNull();
  });
});

describe("request changes and feedback delivery", () => {
  it("returns 202 and delivers the feedback to the submitting task exactly once", async () => {
    const f = await docReview();
    const epoch = taskEpoch(f.taskId)!;
    const ended = turnEnd(f.taskId);
    const r = await act(f, { action: "request_changes", reason: "Tighten section two." });
    expect(r.status).toBe(202);
    expect(r.body.state).toBe("changes_requested");
    expect(r.body.action).toMatchObject({ state: "pending", decisionApplied: true });
    expect((r.body.action.operation as FeedbackOperation).delivery).toBe("queued");
    await r.settled;
    await ended;

    const row = getAction(r.body.action.id)!;
    const op = JSON.parse(row.operation_json!) as FeedbackOperation;
    expect(row.state).toBe("succeeded");
    expect(op).toMatchObject({ kind: "feedback", delivery: "delivered", taskId: f.taskId, expectedGeneration: f.ctx.generation, sourceSessionId: f.ctx.sessionId, acceptanceEvidence: "correlated_provider_event" });
    expect(op.recordedAt).toBeGreaterThan(0);
    expect(op.acceptedAt).toBeGreaterThanOrEqual(op.recordedAt!);

    const rows = listMessages(f.taskId).filter((m) => (m as { review_action_id?: string }).review_action_id === r.body.action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("Tighten section two.");
    expect(rows[0].content).toContain(f.requestId);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // The feedback turn is a source-changing turn: the resubmission captures a new epoch.
    expect(taskEpoch(f.taskId)).toBeGreaterThan(epoch);
  });

  it("replays the 202 receipt without a second delivery", async () => {
    const f = await docReview();
    const key = `k-${uid()}`;
    const ended = turnEnd(f.taskId);
    const first = await act(f, { action: "request_changes", reason: "More tests.", idempotencyKey: key });
    await first.settled;
    await ended;
    const replay = await act(f, { action: "request_changes", reason: "More tests.", idempotencyKey: key });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(replay.settled).toBeUndefined();
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the requirement unsatisfied and lets the agent resubmit once delivered", async () => {
    const f = await docReview();
    const ended = turnEnd(f.taskId);
    const r = await act(f, { action: "request_changes", reason: "Fix it." });
    await r.settled;
    await ended;
    expect(reviewBlockerSync(f.taskId)).not.toBeNull();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan fixed\n", "fix");
    const resub = await submitReview(f.ctx, docBody({ requestId: f.requestId, expectedVersion: r.body.version, expectedSubmissionId: f.submissionId }));
    expect(resub.body.revision).toBe(2);
  });
});

describe("human-only boundary", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api", { method: "POST", headers });

  it("sets the actor to the instance owner in local mode", async () => {
    expect(await resolveHumanActor(req())).toEqual({ id: "instance-owner" });
  });

  it.each([["x-service-token", "secret"], ["authorization", "Bearer abc"], ["x-calandria-capability", "t"], ["x-calandria-turn-capability", "t"]])("refuses a %s request as human authority", async (h, v) => {
    await expect(resolveHumanActor(req({ [h]: v }))).rejects.toMatchObject({ code: "human_required", status: 403 });
  });

  it("the route rejects a service-token caller and never accepts an actor from the body", async () => {
    const f = await docReview();
    const url = `http://localhost/api/tasks/${f.taskId}/reviews/${f.requestId}/actions`;
    const params = { params: Promise.resolve({ id: f.taskId, requestId: f.requestId }) };
    const denied = await actionsPost(new Request(url, { method: "POST", headers: { "x-service-token": "t", "content-type": "application/json" }, body: JSON.stringify(body(f)) }), params);
    expect(denied.status).toBe(403);
    const spoof = await actionsPost(new Request(url, { method: "POST", body: JSON.stringify({ ...body(f), actor_id: "root" }) }), params);
    expect(spoof.status).toBe(400);
    const ok = await actionsPost(new Request(url, { method: "POST", body: JSON.stringify(body(f)) }), params);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ActionResponse).state).toBe("accepted");
    expect(getAction(((await listTaskReviews(f.taskId)).history.actions[0]).id)!.actor_id).toBe("instance-owner");
  });
});

describe("merge", () => {
  it("lands the accepted head locally as its own action and mints a landed receipt", async () => {
    const f = await codeReview();
    const accepted = await act(f);
    const m = await act({ ...f, version: accepted.body.version }, { action: "merge" });
    expect(m.status).toBe(200);
    expect(m.body.state).toBe("accepted");
    expect(m.body.action).toMatchObject({ state: "succeeded", decisionApplied: false, errorCode: null });
    expect(m.body.action.operation).toMatchObject({ kind: "merge", mode: "local", prNumber: null });
    const head = (await git(f.wt.path, "rev-parse", "HEAD")).trim();
    expect(await git(f.repo, "branch", "--contains", head, "--list", "main")).toContain("main");
    const receipts = listReceipts(f.submissionId);
    expect(receipts.map((r) => r.kind)).toEqual(["landed"]);
    expect(JSON.parse(receipts[0].evidence_json)).toMatchObject({ mode: "local", submittedHeadSha: head, prNumber: null });
    // Neither accept nor merge completes the task.
    expect(getTask(f.taskId)!.status).not.toBe("done");
    const view = (await listTaskReviews(f.taskId)).requests[0];
    expect(view.applicability.state).toBe("landed");
    expect(reviewBlockerSync(f.taskId)).toBeNull();
  });

  it("leaves the acceptance in place when the merge fails, as a separate failed operation", async () => {
    const f = await codeReview();
    const accepted = await act(f);
    // An uncommitted file in the main checkout makes the in-place merge refuse.
    const fs = await import("node:fs");
    fs.writeFileSync(`${f.repo}/stray.txt`, "uncommitted\n");
    const m = await act({ ...f, version: accepted.body.version }, { action: "merge" });
    expect(m.body.state).toBe("accepted");
    expect(m.body.action.state).toBe("failed");
    expect(m.body.action.errorCode).toBe("merge_dirty_checkout");
    expect(getRequest(f.requestId)!.state).toBe("accepted");
    expect(listReceipts(f.submissionId)).toEqual([]);

    fs.rmSync(`${f.repo}/stray.txt`);
    const retry = await act({ ...f, version: m.body.version }, { action: "merge" });
    expect(retry.body.action.state).toBe("succeeded");
    expect(listReceipts(f.submissionId)).toHaveLength(1);
  });

  it("refuses to merge while the branch moved after acceptance", async () => {
    const f = await codeReview();
    const accepted = await act(f);
    await commitFile(f.wt.path, "src/b.txt", "b\n", "feat: b");
    const err = await rejects(act({ ...f, version: accepted.body.version }, { action: "merge" }));
    expect(err.code).toBe("source_changed");
    expect(listReceipts(f.submissionId)).toEqual([]);
  });

  it("refuses to merge a document review and a review that was never accepted", async () => {
    const d = await docReview();
    expect((await rejects(act(d, { action: "merge" }))).code).toBe("bad_request");
    const c = await codeReview();
    expect((await rejects(act(c, { action: "merge" }))).code).toBe("version_conflict");
  });

  it("updates the task row without marking it done", async () => {
    const f = await codeReview();
    const accepted = await act(f);
    await act({ ...f, version: accepted.body.version }, { action: "merge" });
    const t = getTask(f.taskId)!;
    expect(t.merged_at).toBeGreaterThan(0);
    expect(t.status).toBe("in_progress");
    // Completion is a separate lifecycle step; the guard no longer blocks it.
    updateTask(f.taskId, { status: "done" });
    expect(getTask(f.taskId)!.status).toBe("done");
  });
});
