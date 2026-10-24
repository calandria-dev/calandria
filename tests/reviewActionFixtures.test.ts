// Action response, error and retry fixtures for the decision UI (WC-17), and
// the contract that they stay true. The scenarios drive the real service and
// compare what it returns with tests/fixtures/review-actions.json after ids,
// timestamps and commit ids are replaced by placeholders. Regenerate with
// `UPDATE_REVIEW_FIXTURES=1 npx vitest run tests/reviewActionFixtures.test.ts`
// after an intentional wire change, and read the diff.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runTurnMock, mergeTaskPrMock, fetchPrStateMock } = vi.hoisted(() => ({ runTurnMock: vi.fn(), mergeTaskPrMock: vi.fn(), fetchPrStateMock: vi.fn() }));
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
import { subscribe } from "../lib/events";
import { performReviewAction } from "../lib/reviews/actions";
import { resolveHumanActor } from "../lib/reviews/actor";
import { listTaskReviews } from "../lib/reviews/read";
import { reconcileFeedback } from "../lib/reviews/feedback";
import { submitReview } from "../lib/reviews/submit";
import { ReviewError } from "../lib/reviews/types";
import { getDb } from "../lib/db";
import { updateTask } from "../lib/store";
import { commitFile, git, uid } from "./helpers";
import { codeBody, docBody, reviewTask } from "./reviewFixture";

const FIXTURE = path.join(__dirname, "fixtures", "review-actions.json");
const OWNER = { id: "instance-owner" };
const REASON_RETRY = "Retry acknowledged: the agent may receive this feedback twice.";

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

type Entry = { name: string; request?: unknown; status: number; body: unknown };
const entries: Entry[] = [];

/** Replace everything that varies between runs with a stable placeholder. */
function normalize(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        if (/(^|[a-z])(At|Ts)$/.test(k) && typeof v === "number") return [k, "<ms>"];
        if (k === "targetTurnId" && typeof v === "string") return [k, "<turnId>"];
        if ((k === "idempotencyKey" || k === "repositoryId") && typeof v === "string") return [k, `<${k}>`];
        return [k, normalize(v, ids)];
      }),
    );
  }
  if (typeof value === "string") {
    if (ids.has(value)) return ids.get(value);
    if (/^[0-9a-f]{40}$/.test(value)) return "<sha>";
    if (/^sess-/.test(value)) return "<sessionId>";
  }
  return value;
}

function record(name: string, ids: Map<string, string>, status: number, body: unknown, request?: unknown) {
  entries.push({ name, ...(request ? { request: normalize(request, ids) } : {}), status, body: normalize(body, ids) });
}

const refused = async (name: string, ids: Map<string, string>, p: Promise<unknown>, request?: unknown) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ReviewError);
    const err = e as ReviewError;
    record(name, ids, err.status, err.body(), request);
    return err;
  }
  throw new Error(`${name}: expected a refusal`);
};

async function fixtureTask(kind: "doc" | "code") {
  const f = await reviewTask();
  if (kind === "doc") await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
  else await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
  const sub = await submitReview(f.ctx, kind === "doc" ? docBody() : codeBody());
  const ids = new Map<string, string>([
    [f.taskId, "<taskId>"],
    [sub.body.requestId, "<requestId>"],
    [sub.body.submissionId, "<submissionId>"],
  ]);
  const head = kind === "code" ? (await git(f.wt.path, "rev-parse", "HEAD")).trim() : "";
  return { ...f, ids, requestId: sub.body.requestId, submissionId: sub.body.submissionId, version: sub.body.version, head };
}

const send = (f: { taskId: string; requestId: string; submissionId: string; version: number }, over: Record<string, unknown> = {}) => {
  const body = { submissionId: f.submissionId, expectedVersion: f.version, action: "accept", idempotencyKey: `k-${uid()}`, ...over };
  return { body, call: () => performReviewAction(f.taskId, f.requestId, body, OWNER) };
};

const latest = async (taskId: string) => (await listTaskReviews(taskId)).requests[0].latestAction;
const turnEnd = (taskId: string) =>
  new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });

describe("review action fixtures", () => {
  it("accept, replay and the non-retryable 409 codes", async () => {
    const f = await fixtureTask("doc");
    const a = send(f, { idempotencyKey: "key-accept" });
    const first = await a.call();
    f.ids.set(first.body.action.id, "<actionId>");
    record("accept.ok", f.ids, first.status, first.body, a.body);
    const replay = await a.call();
    expect(replay).toEqual({ status: first.status, body: first.body });
    record("accept.replay_same_key", f.ids, replay.status, replay.body, a.body);

    const conflict = send(f, { idempotencyKey: "key-accept", action: "waive", reason: "different content" });
    await refused("error.idempotency_conflict", f.ids, conflict.call(), conflict.body);
    const stale = send(f, { expectedVersion: f.version });
    await refused("error.version_conflict", f.ids, stale.call(), stale.body);
    const wrongRevision = send({ ...f, submissionId: "other-submission" });
    await refused("error.not_found_submission", f.ids, wrongRevision.call(), wrongRevision.body);
    const noReason = send({ ...f, version: first.body.version }, { action: "waive" });
    await refused("error.bad_request_reason_required", f.ids, noReason.call(), noReason.body);
    await refused("error.human_required", f.ids, resolveHumanActor(new Request("http://x", { method: "POST", headers: { "x-service-token": "t" } })));
  });

  it("revision_changed, source_changed and artifact_unavailable", async () => {
    const f = await fixtureTask("doc");
    await commitFile(f.wt.path, "docs/plan.md", "# Plan v2\n", "edit");
    const changed = send(f);
    await refused("error.source_changed", f.ids, changed.call(), changed.body);

    const g = await fixtureTask("doc");
    const resub = await submitReview(g.ctx, docBody({ requestId: g.requestId, expectedVersion: g.version, expectedSubmissionId: g.submissionId }));
    g.ids.set(resub.body.submissionId, "<newSubmissionId>");
    const old = send(g);
    await refused("error.revision_changed", g.ids, old.call(), old.body);

    const c = await fixtureTask("code");
    await git(c.repo, "update-ref", "-d", `refs/calandria/reviews/${(await listTaskReviews(c.taskId)).requests[0].currentSubmission.artifact.id}/head`);
    const missing = send(c);
    await refused("error.artifact_unavailable", c.ids, missing.call(), missing.body);
  });

  it("request changes: 202 queued, dispatching, delivered, failed, indeterminate, retry", async () => {
    // queued, then dispatching, then delivered.
    const f = await fixtureTask("doc");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    runTurnMock.mockImplementationOnce(async function* () {
      yield { type: "session", sessionId: "sess" };
      await gate;
      yield { type: "assistant", content: "On it." };
      yield { type: "done", sessionId: "sess" };
    });
    const rc = send(f, { action: "request_changes", reason: "Tighten section two." });
    const queued = await rc.call();
    f.ids.set(queued.body.action.id, "<actionId>");
    record("request_changes.accepted_202", f.ids, queued.status, queued.body, rc.body);
    await queued.settled;
    record("feedback.dispatching", f.ids, 200, await latest(f.taskId));
    // A second decision while the feedback is unsettled is refused.
    const wd = send({ ...f, version: queued.body.version }, { action: "withdraw", reason: "no longer needed" });
    await refused("error.operation_pending", f.ids, wd.call(), wd.body);
    const ended = turnEnd(f.taskId);
    release();
    await ended;
    record("feedback.delivered", f.ids, 200, await latest(f.taskId));

    // failed: the session was cleared before the delivery.
    const g = await fixtureTask("doc");
    updateTask(g.taskId, { generation: g.ctx.generation + 1 });
    const failedReq = send(g, { action: "request_changes", reason: "Revise." });
    const failed = await failedReq.call();
    g.ids.set(failed.body.action.id, "<actionId>");
    await failed.settled;
    record("feedback.failed_generation_changed", g.ids, 200, await latest(g.taskId));

    // indeterminate: handed off, no correlated output; retry is a new action that links the old one.
    const h = await fixtureTask("doc");
    runTurnMock.mockImplementationOnce(async function* () {
      yield { type: "session", sessionId: "sess" };
      yield { type: "done", sessionId: "sess" };
    });
    const ended2 = turnEnd(h.taskId);
    const indReq = send(h, { action: "request_changes", reason: "Revise." });
    const ind = await indReq.call();
    h.ids.set(ind.body.action.id, "<priorActionId>");
    await ind.settled;
    await ended2;
    record("feedback.indeterminate", h.ids, 200, await latest(h.taskId));
    const callsBefore = runTurnMock.mock.calls.length;
    await reconcileFeedback(h.taskId);
    expect(runTurnMock).toHaveBeenCalledTimes(callsBefore);
    const ended3 = turnEnd(h.taskId);
    const retryReq = send({ ...h, version: ind.body.version }, { action: "retry_feedback", reason: REASON_RETRY });
    const retry = await retryReq.call();
    h.ids.set(retry.body.action.id, "<actionId>");
    record("retry_feedback.accepted_202", h.ids, retry.status, retry.body, retryReq.body);
    await retry.settled;
    await ended3;
    record("feedback.delivered_after_retry", h.ids, 200, await latest(h.taskId));

    // queued behind unrelated running work.
    const k = await fixtureTask("doc");
    const held = claimTurn(k.taskId)!;
    const parkedReq = send(k, { action: "request_changes", reason: "Fix the heading." });
    const parked = await parkedReq.call();
    k.ids.set(parked.body.action.id, "<actionId>");
    await parked.settled;
    record("feedback.queued_behind_running_turn", k.ids, 200, await latest(k.taskId));
    unregisterTurn(k.taskId, held);
    getDb().prepare("DELETE FROM pending_messages WHERE task_id = ?").run(k.taskId);
  });

  it("waive and withdraw", async () => {
    const f = await fixtureTask("doc");
    const w = send(f, { action: "waive", reason: "Reviewed out of band." });
    const waived = await w.call();
    f.ids.set(waived.body.action.id, "<actionId>");
    record("waive.ok", f.ids, waived.status, waived.body, w.body);
    const g = await fixtureTask("doc");
    const wd = send(g, { action: "withdraw", reason: "Wrong approach." });
    const withdrawn = await wd.call();
    g.ids.set(withdrawn.body.action.id, "<actionId>");
    record("withdraw.ok", g.ids, withdrawn.status, withdrawn.body, wd.body);
  });

  it("merge: success, failure, pending and indeterminate", async () => {
    // success
    const f = await fixtureTask("code");
    const acc = send(f);
    const accepted = await acc.call();
    const m = send({ ...f, version: accepted.body.version }, { action: "merge" });
    const merged = await m.call();
    f.ids.set(merged.body.action.id, "<actionId>");
    record("merge.succeeded_local", f.ids, merged.status, merged.body, m.body);

    // failure leaves the acceptance in place
    const g = await fixtureTask("code");
    const gAcc = await send(g).call();
    fs.writeFileSync(path.join(g.repo, "stray.txt"), "uncommitted\n");
    const gm = send({ ...g, version: gAcc.body.version }, { action: "merge" });
    const failed = await gm.call();
    g.ids.set(failed.body.action.id, "<actionId>");
    record("merge.failed_dirty_checkout", g.ids, failed.status, failed.body, gm.body);
    fs.rmSync(path.join(g.repo, "stray.txt"));

    // pending (auto-merge armed) and indeterminate (lost reply, PR unreadable)
    const snap = (head: string, merged: boolean) => ({ number: 7, state: merged ? "merged" : "open", checks: "passing", review: "", mergedAt: merged ? 1 : 0, mergeState: "CLEAN", draft: false, failing: [], headSha: head, mergeCommitSha: merged ? "c".repeat(40) : "", baseRef: "main" });
    const h = await fixtureTask("code");
    updateTask(h.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7 });
    const hAcc = await send(h).call();
    fetchPrStateMock.mockImplementation(async () => ({ ok: true, snapshot: snap(h.head, false) }));
    mergeTaskPrMock.mockResolvedValue({ ok: true, queued: true });
    const hm = send({ ...h, version: hAcc.body.version }, { action: "merge" });
    const pending = await hm.call();
    h.ids.set(pending.body.action.id, "<actionId>");
    record("merge.pending_auto_merge_202", h.ids, pending.status, pending.body, hm.body);

    const i = await fixtureTask("code");
    updateTask(i.taskId, { pr_url: "https://github.com/o/r/pull/8", pr_number: 8 });
    const iAcc = await send(i).call();
    let readable = true;
    fetchPrStateMock.mockImplementation(async () => (readable ? { ok: true, snapshot: snap(i.head, false) } : { ok: false, error: "network down" }));
    mergeTaskPrMock.mockImplementation(async () => {
      readable = false;
      return { ok: false, error: "gh pr merge timed out" };
    });
    const im = send({ ...i, version: iAcc.body.version }, { action: "merge" });
    const ind = await im.call();
    i.ids.set(ind.body.action.id, "<actionId>");
    record("merge.indeterminate_lost_reply", i.ids, ind.status, ind.body, im.body);
  });

  it("matches the checked-in fixtures", () => {
    const out = JSON.stringify({ version: 1, entries }, null, 2) + "\n";
    if (process.env.UPDATE_REVIEW_FIXTURES === "1") fs.writeFileSync(FIXTURE, out);
    expect(fs.readFileSync(FIXTURE, "utf8")).toBe(out);
  });
});
