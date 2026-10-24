// Recovery of review effects (WC-16): a merge whose reply was lost, a restart
// that leaves pending rows, feedback that cannot be correlated, a generation
// that moved, and a destructive disposition that must not eat an in-flight
// record. Nothing here may resend silently or report a success it did not see.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runTurnMock, mergeTaskPrMock, fetchPrStateMock } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
  mergeTaskPrMock: vi.fn(),
  fetchPrStateMock: vi.fn(),
}));
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
  },
}));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  mergeTaskPr: mergeTaskPrMock,
  fetchPrState: fetchPrStateMock,
  fetchCheckEvidence: vi.fn(async () => ({ ok: false, error: "none" })),
}));

import { claimTurn, unregisterTurn } from "../lib/abort";
import { getDb, settleReviewEffects } from "../lib/db";
import { subscribe } from "../lib/events";
import { performReviewAction, reconcileMerges } from "../lib/reviews/actions";
import { reconcileFeedback } from "../lib/reviews/feedback";
import { bumpReviewContentEpoch, getAction, getRequest, listReceipts } from "../lib/reviews/store";
import { submitReview } from "../lib/reviews/submit";
import { ReviewError, type FeedbackOperation, type MergeOperation } from "../lib/reviews/types";
import { startResumeTurn } from "../lib/runner";
import { deleteTask, getTask, listPendingMessages, updateTask, clearPendingMessages } from "../lib/store";
import { moveTasksToProject } from "../lib/taskMove";
import { createProject } from "../lib/store";
import { commitFile, git, uid } from "./helpers";
import { codeBody, docBody, reviewTask } from "./reviewFixture";

const OWNER = { id: "instance-owner" };

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
  runTurnMock.mockReset();
  mergeTaskPrMock.mockReset();
  fetchPrStateMock.mockReset();
  runTurnMock.mockImplementation(async function* () {
    yield { type: "session", sessionId: "sess" };
    yield { type: "assistant", content: "On it." };
    yield { type: "done", sessionId: "sess" };
  });
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

type Fx = { taskId: string; requestId: string; submissionId: string; version: number };
const call = (f: Fx, over: Record<string, unknown> = {}) =>
  performReviewAction(f.taskId, f.requestId, { submissionId: f.submissionId, expectedVersion: f.version, action: "accept", idempotencyKey: `k-${uid()}`, ...over }, OWNER);

async function docReview() {
  const f = await reviewTask();
  await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
  const sub = await submitReview(f.ctx, docBody());
  return { ...f, requestId: sub.body.requestId, submissionId: sub.body.submissionId, version: sub.body.version };
}

async function acceptedCode() {
  const f = await reviewTask();
  await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
  const sub = await submitReview(f.ctx, codeBody());
  const head = (await git(f.wt.path, "rev-parse", "HEAD")).trim();
  const accepted = await performReviewAction(f.taskId, sub.body.requestId, { submissionId: sub.body.submissionId, expectedVersion: sub.body.version, action: "accept", idempotencyKey: `k-${uid()}` }, OWNER);
  return { ...f, requestId: sub.body.requestId, submissionId: sub.body.submissionId, version: accepted.body.version, head };
}

const prSnapshot = (head: string, merged: boolean, over: Record<string, unknown> = {}) => ({
  number: 7,
  state: merged ? "merged" : "open",
  checks: "passing",
  review: "",
  mergedAt: merged ? 1_700_000_000_000 : 0,
  mergeState: "CLEAN",
  draft: false,
  failing: [],
  headSha: head,
  mergeCommitSha: merged ? "c".repeat(40) : "",
  baseRef: "main",
  ...over,
});

const turnEnd = (taskId: string) =>
  new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });

describe("PR merge with a lost reply", () => {
  it("enforces the expected head in the remote call and settles from the PR, never merging twice", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    let merged = false;
    fetchPrStateMock.mockImplementation(async () => ({ ok: true, snapshot: prSnapshot(f.head, merged) }));
    mergeTaskPrMock.mockImplementation(async () => {
      merged = true; // GitHub merged it; the reply never arrived.
      return { ok: false, error: "gh pr merge timed out" };
    });
    const key = `k-${uid()}`;
    const r = await call(f, { action: "merge", idempotencyKey: key });
    expect(mergeTaskPrMock).toHaveBeenCalledTimes(1);
    expect(mergeTaskPrMock.mock.calls[0][0]).toMatchObject({ number: 7, expectedHeadSha: f.head });
    expect(r.body.action).toMatchObject({ state: "succeeded", errorCode: null });
    expect((r.body.action.operation as MergeOperation)).toMatchObject({ mode: "pr", prNumber: 7, expectedHeadSha: f.head, resultCommitSha: "c".repeat(40) });
    const receipt = listReceipts(f.submissionId).find((x) => x.kind === "landed")!;
    expect(JSON.parse(receipt.evidence_json)).toMatchObject({ mode: "pr", prNumber: 7, submittedHeadSha: f.head, resultCommitSha: "c".repeat(40) });

    // The browser timed out and repeats the request: the receipt answers, nothing runs again.
    const replay = await call(f, { action: "merge", idempotencyKey: key });
    expect(replay.body).toEqual(r.body);
    expect(mergeTaskPrMock).toHaveBeenCalledTimes(1);
  });

  it("stays indeterminate when the PR cannot be read, then resolves from the PR on the next look without merging again", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    let readable = true;
    let merged = false;
    fetchPrStateMock.mockImplementation(async () => (readable ? { ok: true, snapshot: prSnapshot(f.head, merged) } : { ok: false, error: "network down" }));
    mergeTaskPrMock.mockImplementation(async () => {
      readable = false;
      merged = true;
      return { ok: false, error: "gh pr merge timed out" };
    });
    const r = await call(f, { action: "merge" });
    expect(r.body.action).toMatchObject({ state: "indeterminate", errorCode: "merge_unverified" });
    expect(listReceipts(f.submissionId)).toEqual([]);

    // A retry first reads the world. The PR is merged with the accepted head,
    // so the retry records that and issues no second merge.
    readable = true;
    const retry = await call({ ...f, version: r.body.version }, { action: "merge" });
    expect(retry.body.action.state).toBe("succeeded");
    expect(mergeTaskPrMock).toHaveBeenCalledTimes(1);
    expect(getAction(r.body.action.id)!.state).toBe("succeeded");
    expect(listReceipts(f.submissionId)).toHaveLength(1);
  });

  it("fails cleanly when GitHub refuses the pinned head and leaves the acceptance standing", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    fetchPrStateMock.mockImplementation(async () => ({ ok: true, snapshot: prSnapshot("d".repeat(40), false) }));
    mergeTaskPrMock.mockResolvedValue({ ok: false, error: "Head branch was modified. Review and try the merge again." });
    const r = await call(f, { action: "merge" });
    expect(r.body.state).toBe("accepted");
    expect(r.body.action).toMatchObject({ state: "failed", errorCode: "merge_failed" });
    expect(listReceipts(f.submissionId)).toEqual([]);
    expect(getRequest(f.requestId)!.state).toBe("accepted");
  });

  it("returns 202 for an armed auto-merge and settles it when the poll sees the merged head", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    let merged = false;
    fetchPrStateMock.mockImplementation(async () => ({ ok: true, snapshot: prSnapshot(f.head, merged) }));
    mergeTaskPrMock.mockResolvedValue({ ok: true, queued: true });
    const r = await call(f, { action: "merge" });
    expect(r.status).toBe(202);
    expect(r.body.action.state).toBe("pending");
    // Another merge while it waits is refused, not stacked.
    expect((await call({ ...f, version: r.body.version }, { action: "merge" }).catch((e) => e)) as ReviewError).toMatchObject({ code: "operation_pending" });

    merged = true;
    const { refreshPrState } = await import("../lib/prState");
    await refreshPrState(f.taskId, { force: true });
    expect(getAction(r.body.action.id)!.state).toBe("succeeded");
    expect(listReceipts(f.submissionId).map((x) => x.kind)).toEqual(["landed"]);
  });

  it("does not mint a receipt or settle success when the merged PR head is not the accepted head", async () => {
    const f = await acceptedCode();
    updateTask(f.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    let merged = false;
    fetchPrStateMock.mockImplementation(async () => ({ ok: true, snapshot: prSnapshot(merged ? "e".repeat(40) : f.head, merged) }));
    mergeTaskPrMock.mockResolvedValue({ ok: true, queued: true });
    const r = await call(f, { action: "merge" });
    merged = true;
    const { refreshPrState } = await import("../lib/prState");
    await refreshPrState(f.taskId, { force: true });
    expect(getAction(r.body.action.id)!.state).toBe("failed");
    expect(getAction(r.body.action.id)!.error_code).toBe("merge_head_changed");
    expect(listReceipts(f.submissionId)).toEqual([]);
  });
});

describe("restart with pending rows", () => {
  it("turns an in-flight merge and an unconfirmed feedback into indeterminate, never a success", async () => {
    const f = await acceptedCode();
    const db = getDb();
    const now = Date.now();
    const op: MergeOperation = { kind: "merge", mode: "local", expectedHeadSha: f.head, expectedBaseSha: "0".repeat(40), repositoryId: "r", prNumber: null, resultCommitSha: null, resultUrl: null };
    db.prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, idempotency_key, payload_sha256, state, decision_applied, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES ('m1a', ?, ?, ?, 'merge', 'human', 'instance-owner', 'kma', 'h', 'pending', 0, ?, 202, '{}', ?, ?)`,
    ).run(f.requestId, f.submissionId, f.version, JSON.stringify(op), now, now);
    const fb: FeedbackOperation = { kind: "feedback", recordedAt: now, delivery: "dispatching", acceptedAt: null, acceptanceEvidence: null, taskId: f.taskId, expectedGeneration: 1, sourceSessionId: "s", messageCorrelationId: "f1a", targetTurnId: null, priorActionId: null };
    db.prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, idempotency_key, payload_sha256, state, decision_applied, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES ('f1a', ?, ?, ?, 'request_changes', 'human', 'instance-owner', 'kfa', 'h', 'pending', 1, ?, 202, '{}', ?, ?)`,
    ).run(f.requestId, f.submissionId, f.version, JSON.stringify(fb), now, now);
    db.prepare("UPDATE tasks SET active_review_action_id = 'f1a' WHERE id = ?").run(f.taskId);

    settleReviewEffects(db);

    expect(getAction("m1a")).toMatchObject({ state: "indeterminate", error_code: "restart_during_merge" });
    expect(getAction("f1a")).toMatchObject({ state: "indeterminate", error_code: "restart_during_dispatch" });
    expect((JSON.parse(getAction("f1a")!.operation_json!) as FeedbackOperation).delivery).toBe("indeterminate");
    expect(getTask(f.taskId)!.active_review_action_id).toBeNull();
    // Nothing is resent for a dispatch that may have gone out.
    await reconcileFeedback();
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it("reads the target after a restart: a local merge that did land is recorded, one that did not is failed and retried", async () => {
    const f = await acceptedCode();
    const db = getDb();
    const now = Date.now();
    const op: MergeOperation = { kind: "merge", mode: "local", expectedHeadSha: f.head, expectedBaseSha: "0".repeat(40), repositoryId: "r", prNumber: null, resultCommitSha: null, resultUrl: null };
    db.prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, idempotency_key, payload_sha256, state, decision_applied, error_code, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES ('m1b', ?, ?, ?, 'merge', 'human', 'instance-owner', 'kmb', 'h', 'indeterminate', 0, 'restart_during_merge', ?, 202, '{}', ?, ?)`,
    ).run(f.requestId, f.submissionId, f.version, JSON.stringify(op), now, now);
    // The merge did land before the process died.
    await git(f.repo, "merge", "--no-ff", "-m", "merge task", f.head);
    expect(await reconcileMerges(f.taskId)).toBe(true);
    expect(getAction("m1b")!.state).toBe("succeeded");
    expect(listReceipts(f.submissionId).map((r) => r.kind)).toEqual(["landed"]);
    const mergesBefore = (await git(f.repo, "rev-list", "--count", "main")).trim();
    // A person retrying finds it landed and records that without merging again.
    const retry = await call({ ...f, version: f.version }, { action: "merge" });
    expect(retry.body.action.state).toBe("succeeded");
    expect((await git(f.repo, "rev-list", "--count", "main")).trim()).toBe(mergesBefore);
  });

  it("delivers a queued feedback exactly once after its parked copy was lost", async () => {
    const f = await docReview();
    // A live turn holds the task, so the feedback parks in the queue.
    const held = claimTurn(f.taskId)!;
    const r = await call(f, { action: "request_changes", reason: "Please revise." });
    await r.settled;
    expect(listPendingMessages(f.taskId).filter((m) => m.review_action_id === r.body.action.id)).toHaveLength(1);
    expect(runTurnMock).not.toHaveBeenCalled();
    // Restart or Stop drops the parked copy; the action row survives.
    clearPendingMessages(f.taskId);
    unregisterTurn(f.taskId, held);
    const ended = turnEnd(f.taskId);
    expect(await reconcileFeedback(f.taskId)).toBe(1);
    await ended;
    expect(getAction(r.body.action.id)!.state).toBe("succeeded");
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(await reconcileFeedback(f.taskId)).toBe(0);
  });

  it("drains feedback parked behind unrelated running work into the same task, once", async () => {
    const f = await docReview();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runTurnMock.mockImplementationOnce(async function* () {
      yield { type: "session", sessionId: "sess" };
      await gate;
      yield { type: "done", sessionId: "sess" };
    });
    await startResumeTurn(getTask(f.taskId)!, f.project, "unrelated work");
    const r = await call(f, { action: "request_changes", reason: "Fix the heading." });
    await r.settled;
    expect(listPendingMessages(f.taskId).some((m) => m.review_action_id === r.body.action.id)).toBe(true);
    expect((JSON.parse(getAction(r.body.action.id)!.operation_json!) as FeedbackOperation).delivery).toBe("queued");
    const ended = new Promise<void>((resolve) => {
      let n = 0;
      const unsub = subscribe(f.taskId, (ev) => {
        if (ev.type === "turn_end" && ++n === 1) {
          unsub();
          resolve();
        }
      });
    });
    release();
    await ended;
    expect(getAction(r.body.action.id)!.state).toBe("succeeded");
    expect(runTurnMock).toHaveBeenCalledTimes(2);
  });
});

describe("feedback that cannot be delivered or confirmed", () => {
  it("names a changed generation as a failure and never sends to the newest session", async () => {
    const f = await docReview();
    updateTask(f.taskId, { generation: f.ctx.generation + 1 });
    const r = await call(f, { action: "request_changes", reason: "Revise." });
    await r.settled;
    const row = getAction(r.body.action.id)!;
    expect(row).toMatchObject({ state: "failed", error_code: "generation_changed" });
    expect((JSON.parse(row.operation_json!) as FeedbackOperation).delivery).toBe("failed");
    expect(runTurnMock).not.toHaveBeenCalled();
    // The explicit resend links the prior action and fails the same named way.
    const retry = await call({ ...f, version: r.body.version }, { action: "retry_feedback", reason: "Retry acknowledged: the agent may receive this feedback twice." });
    await retry.settled;
    expect((JSON.parse(getAction(retry.body.action.id)!.operation_json!) as FeedbackOperation).priorActionId).toBe(r.body.action.id);
    expect(getAction(retry.body.action.id)!.error_code).toBe("generation_changed");
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it("leaves a handoff with no correlated model output indeterminate and never resends it", async () => {
    const f = await docReview();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess" };
      yield { type: "done", sessionId: "sess" };
    });
    const ended = turnEnd(f.taskId);
    const r = await call(f, { action: "request_changes", reason: "Revise." });
    await r.settled;
    await ended;
    const row = getAction(r.body.action.id)!;
    expect(row).toMatchObject({ state: "indeterminate", error_code: "no_correlated_event" });
    const op = JSON.parse(row.operation_json!) as FeedbackOperation;
    expect(op.delivery).toBe("indeterminate");
    expect(op.recordedAt).toBeGreaterThan(0);
    expect(op.acceptedAt).toBeNull();
    await reconcileFeedback();
    expect(runTurnMock).toHaveBeenCalledTimes(1);

    // Only an explicit, acknowledged retry sends it again, as a new action.
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess" };
      yield { type: "assistant", content: "Got it." };
      yield { type: "done", sessionId: "sess" };
    });
    const ended2 = turnEnd(f.taskId);
    const retry = await call({ ...f, version: r.body.version }, { action: "retry_feedback", reason: "Retry acknowledged: the agent may receive this feedback twice." });
    await retry.settled;
    await ended2;
    expect(getAction(retry.body.action.id)!.state).toBe("succeeded");
    expect(getAction(r.body.action.id)!.state).toBe("indeterminate");
    expect(runTurnMock).toHaveBeenCalledTimes(2);
    // The resend carries the person's original feedback, never the acknowledgement sentence.
    const resent = String(runTurnMock.mock.calls[1][2]);
    expect(resent).toContain("Revise.");
    expect(resent).not.toContain("Retry acknowledged");
  });

  it("refuses a retry when the last feedback is not failed or uncertain", async () => {
    const f = await docReview();
    const ended = turnEnd(f.taskId);
    const r = await call(f, { action: "request_changes", reason: "Revise." });
    await r.settled;
    await ended;
    await expect(call({ ...f, version: r.body.version }, { action: "retry_feedback", reason: "again" })).rejects.toMatchObject({ code: "version_conflict" });
  });
});

describe("destructive dispositions", () => {
  it("refuses waive_and_delete and a move reset while an action is pending, and records one waive action per request otherwise", async () => {
    const f = await acceptedCode();
    const other = await reviewTask();
    const target = createProject({ name: `dest-${uid()}`, repo_path: other.repo, branch: "main" });
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, idempotency_key, payload_sha256, state, decision_applied, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES ('p1c', ?, ?, ?, 'merge', 'human', 'instance-owner', 'kpc', 'h', 'pending', 0, NULL, 202, '{}', ?, ?)`,
    ).run(f.requestId, f.submissionId, f.version, now, now);
    expect(() => deleteTask(f.taskId, { reviewDisposition: "waive_and_delete" })).toThrow(ReviewError);
    try {
      deleteTask(f.taskId, { reviewDisposition: "waive_and_delete" });
    } catch (e) {
      expect((e as ReviewError).code).toBe("operation_pending");
    }
    const moved = await moveTasksToProject([f.taskId], target.id, { discardWorktree: [f.taskId], discardUnsafe: [f.taskId], reviewActor: "access:alice@example.com" });
    expect(moved!.discarded).toEqual([]);
    expect(getTask(f.taskId)!.project_id).toBe(f.project.id);
    expect(fs.existsSync(f.wt.path)).toBe(true);

    db.prepare("UPDATE review_actions SET state = 'failed' WHERE id = 'p1c'").run();
    // An accepted review that still holds is satisfied, so the source has to change for the delete to be a real waiver.
    bumpReviewContentEpoch(f.taskId);
    deleteTask(f.taskId, { reviewDisposition: "waive_and_delete", reviewActor: "access:alice@example.com" });
    const waives = db.prepare("SELECT * FROM review_actions WHERE request_id = ? AND action = 'waive'").all(f.requestId) as Array<{ actor_kind: string; actor_id: string; reason: string; state: string; decision_applied: number }>;
    expect(waives).toHaveLength(1);
    expect(waives[0]).toMatchObject({ actor_kind: "human", actor_id: "access:alice@example.com", reason: "waive_and_delete", state: "succeeded", decision_applied: 1 });
    expect(getRequest(f.requestId)!.state).toBe("waived");
  });
});
