// Adversarial fixtures for the required-review gate (WC-15 checkpoint over
// WC-12, WC-13 and WC-14). Each case drives a race or a state the ordinary
// tests assert by claim: a completion landing mid-capture, a turn starting
// mid-capture, an acceptance that must not follow a resubmission, a landing
// whose own base movement must keep an accepted artifact applicable, a pruned
// pin, a move that would waive a review, and the epoch advancing on every way
// the model gets to work again.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Claude driver is mocked so the real runner (resume turns, the lingering
// input path) runs with no SDK anywhere near it, the same seam
// tests/queueDrainWorktree.test.ts uses.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));
vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) => runTurnMock(task, project, userText, ac),
  },
}));

import { POST as repairPost } from "../app/api/tasks/[id]/repair-worktree/route";
import { POST as messagesPost } from "../app/api/tasks/[id]/messages/route";
import { blocks } from "../lib/autoStart";
import { getDb } from "../lib/db";
import { subscribe } from "../lib/events";
import { reviewRefusal, taskReviewBlocker } from "../lib/reviews/gate";
import { reviewBlockerSync } from "../lib/reviews/guard";
import { reviewRef } from "../lib/reviews/artifacts";
import { listTaskReviews, readArtifact } from "../lib/reviews/read";
import { getSubmission, insertApplicabilityReceipt, listRequestsForOwner, taskEpoch } from "../lib/reviews/store";
import { submitReview } from "../lib/reviews/submit";
import { ReviewError, type CodeManifest } from "../lib/reviews/types";
import { withdrawReview } from "../lib/reviews/withdraw";
import { sendToLingeringTurn, startResumeTurn } from "../lib/runner";
import { createProject, createTask, getTask, setTaskDeps, updateTask } from "../lib/store";
import { moveTasksToProject, previewDiscard, UNSAFE_DISCARD_REASON } from "../lib/taskMove";
import { registerTurnInput, unregisterTurnInput, type TurnInputHandle } from "../lib/turnInput";
import { commitFile, git, uid } from "./helpers";
import { codeBody, docBody, reviewTask } from "./reviewFixture";

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
  runTurnMock.mockReset();
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

const setState = (requestId: string, state: string) =>
  getDb().prepare("UPDATE review_requests SET state = ? WHERE id = ?").run(state, requestId);

/** A human acceptance as WC-16 will record it, so history has an action to not inherit. */
function recordAccept(requestId: string, submissionId: string, version: number) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO review_actions (id, request_id, submission_id, expected_version, action, actor_kind, actor_id, reason, idempotency_key, payload_sha256,
         state, decision_applied, error_code, operation_json, receipt_http_status, receipt_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'accept', 'human', 'instance-owner', NULL, ?, 'x', 'succeeded', 1, NULL, NULL, 200, '{}', ?, ?)`,
    )
    .run(uid(), requestId, submissionId, version, `accept-${uid()}`, now, now);
  getDb().prepare("UPDATE review_requests SET state = 'accepted', version = ? WHERE id = ?").run(version + 1, requestId);
}

async function codeReview(f: Awaited<ReturnType<typeof reviewTask>>) {
  await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
  const r = await submitReview(f.ctx, codeBody());
  const manifest = JSON.parse(getDb().prepare("SELECT manifest_json FROM review_artifacts WHERE id = ?").get(r.body.artifactId)!["manifest_json" as never]) as CodeManifest;
  return { ...r.body, manifest };
}

async function pins(repo: string) {
  const out = await git(repo, "for-each-ref", "--format=%(refname)", "refs/calandria/reviews/");
  return out.split("\n").filter(Boolean);
}

describe("concurrent submit and complete", () => {
  it("a completion that lands during capture wins; the commit refuses terminal_task and leaves no rows or pins", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
    await expect(
      submitReview(f.ctx, codeBody(), {
        beforeCommit: () => {
          // No review rows exist yet, so the store's gate lets the done land.
          expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
        },
      }),
    ).rejects.toMatchObject({ code: "terminal_task" });
    expect(getTask(f.taskId)!.status).toBe("done");
    expect(listRequestsForOwner(f.taskId)).toEqual([]);
    expect(await pins(f.repo)).toEqual([]);
  });

  it("a completion attempted during a resubmission's capture is refused, and the resubmission commits", async () => {
    const f = await reviewTask();
    const first = await codeReview(f);
    await commitFile(f.wt.path, "src/b.txt", "b\n", "feat: b");
    let refused: unknown;
    const second = await submitReview(
      f.ctx,
      codeBody({ requestId: first.requestId, expectedVersion: first.version, expectedSubmissionId: first.submissionId }),
      {
        beforeCommit: () => {
          try {
            updateTask(f.taskId, { status: "done" });
          } catch (e) {
            refused = e;
          }
        },
      },
    );
    expect(refused).toBeInstanceOf(ReviewError);
    expect((refused as ReviewError).code).toBe("review_required");
    expect(second.body.revision).toBe(2);
    expect(getTask(f.taskId)!.status).toBe("in_progress");
  });

  it("a turn starting during capture fails the commit with source_changed and deletes this attempt's pins", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
    const first = await submitReview(f.ctx, codeBody({ outputKey: "earlier" }));
    const before = await pins(f.repo);
    expect(before).toHaveLength(3);
    await expect(
      submitReview(f.ctx, codeBody(), {
        beforeCommit: () => {
          // What startTurn / startResumeTurn do on entry.
          getDb().prepare("UPDATE tasks SET review_content_epoch = review_content_epoch + 1 WHERE id = ?").run(f.taskId);
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    // The earlier artifact's pins survive; only the failed attempt's are gone.
    expect(await pins(f.repo)).toEqual(before);
    expect(getSubmission(first.body.submissionId)).toBeTruthy();
  });
});

describe("no stale approval transfer", () => {
  it("a resubmission after acceptance is pending, the old acceptance stays on its own revision, and the gate blocks", async () => {
    const f = await reviewTask();
    const first = await codeReview(f);
    recordAccept(first.requestId, first.submissionId, first.version);
    expect(await reviewRefusal(f.taskId)).toBeNull();

    await commitFile(f.wt.path, "src/b.txt", "b\n", "feat: b");
    const second = await submitReview(
      f.ctx,
      codeBody({ requestId: first.requestId, expectedVersion: first.version + 1, expectedSubmissionId: first.submissionId }),
    );
    expect(second.body.state).toBe("pending");
    expect(second.body.revision).toBe(2);
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);

    const view = (await listTaskReviews(f.taskId)).requests[0];
    expect(view.state).toBe("pending");
    expect(view.currentSubmission.id).toBe(second.body.submissionId);
    expect(view.latestAction?.action).toBe("accept");
    expect(view.latestAction?.submissionId).toBe(first.submissionId);
    expect(view.allowedActions).not.toContain("merge");
    const history = (await listTaskReviews(f.taskId)).history.submissions;
    expect(history.find((s) => s.id === first.submissionId)?.superseded).toBe(true);
    expect(history.find((s) => s.id === second.body.submissionId)?.superseded).toBe(false);
  });

  it("an accepted artifact that changed under the same epoch blocks the async gate, the first turn of a dependent, and keeps blocks() honest once the epoch moves", async () => {
    const f = await reviewTask();
    const first = await codeReview(f);
    recordAccept(first.requestId, first.submissionId, first.version);
    const dependent = createTask({ id: uid(), project_id: f.project.id, title: "after", description: "" });
    setTaskDeps(dependent.id, [f.taskId]);
    // Done lands while the artifact is current.
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
    expect(blocks(f.taskId)).toBe(false);
    expect(await taskReviewBlocker(f.taskId)).toBeNull();

    // A commit from outside any turn: the epoch does not move, the checkout does.
    await commitFile(f.wt.path, "src/late.txt", "late\n", "feat: after acceptance");
    expect(await taskReviewBlocker(f.taskId)).not.toBeNull();
    const res = await messagesPost(
      new Request(`http://local/api/tasks/${dependent.id}/messages`, { method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ id: dependent.id }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/required review/);
    expect(body.blockedBy).toEqual([f.taskId]);
    expect(getTask(dependent.id)!.started).toBe(0);

    // Reopening moves the epoch, and the synchronous read agrees.
    updateTask(f.taskId, { status: "in_progress" });
    expect(reviewBlockerSync(f.taskId)?.requestIds).toEqual([first.requestId]);
  });
});

describe("landing and receipts", () => {
  it("after a merge the gate blocks until a landed receipt exists; the receipt tolerates the base movement but not new commits", async () => {
    const f = await reviewTask();
    const first = await codeReview(f);
    recordAccept(first.requestId, first.submissionId, first.version);
    expect(await reviewRefusal(f.taskId)).toBeNull();

    await git(f.repo, "merge", "--no-ff", "-m", "land the task", f.wt.branch);
    updateTask(f.taskId, { merged_at: Date.now() });
    // The base moved: without landing evidence the acceptance is no longer current.
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);

    const result = await git(f.repo, "rev-parse", "main");
    insertApplicabilityReceipt({
      submissionId: first.submissionId,
      kind: "landed",
      evidence: {
        repositoryId: first.manifest.repositoryId,
        submittedHeadSha: first.manifest.headCommitSha,
        targetRef: "refs/heads/main",
        baseBeforeSha: first.manifest.baseTipSha,
        resultCommitSha: result,
        mode: "local",
        prNumber: null,
        observedAt: Date.now(),
      },
    });
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("landed");
    expect(await reviewRefusal(f.taskId)).toBeNull();
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");

    // Work past the landed head is not what landed.
    await commitFile(f.wt.path, "src/extra.txt", "extra\n", "feat: after landing");
    const after = (await listTaskReviews(f.taskId)).requests[0].applicability;
    expect(after.state).toBe("changed");
    expect(after.reason).toMatch(/moved past the landed head/);
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);
  });

  it("a landed receipt still fails once the epoch moves, and a retired checkout passes without observing one", async () => {
    const f = await reviewTask();
    const first = await codeReview(f);
    recordAccept(first.requestId, first.submissionId, first.version);
    insertApplicabilityReceipt({
      submissionId: first.submissionId,
      kind: "retired",
      evidence: { repositoryId: first.manifest.repositoryId, validatedManifestSha256: "m", cleanupId: "c", cleanupSucceededAt: 1, observedAt: 1 },
    });
    fs.rmSync(f.wt.path, { recursive: true, force: true });
    updateTask(f.taskId, { worktree_path: "" });
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("retired");
    expect(await reviewRefusal(f.taskId)).toBeNull();
    getDb().prepare("UPDATE tasks SET review_content_epoch = review_content_epoch + 1 WHERE id = ?").run(f.taskId);
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("changed");
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);
  });
});

describe("retained objects", () => {
  it("a pruned pin makes the artifact unreadable, and the gate blocks as soon as the checkout cannot vouch for it", async () => {
    const f = await reviewTask();
    const first = await codeReview(f);
    recordAccept(first.requestId, first.submissionId, first.version);
    await git(f.repo, "update-ref", "-d", reviewRef(first.artifactId, "head"));
    await expect(readArtifact(f.taskId, first.requestId, first.submissionId)).rejects.toMatchObject({ code: "artifact_unavailable" });
    // The checkout still sits at the accepted head, which is the one observation
    // that can still vouch for the acceptance.
    expect(await reviewRefusal(f.taskId)).toBeNull();
    fs.rmSync(f.wt.path, { recursive: true, force: true });
    expect((await listTaskReviews(f.taskId)).requests[0].applicability.state).toBe("unavailable");
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);
  });
});

describe("cancelled and disabled", () => {
  it("cancel is refused while required is open; after a waiver, a required resubmit is refused and an optional one allowed", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    const r = await submitReview(f.ctx, docBody());
    expect(() => updateTask(f.taskId, { status: "cancelled" })).toThrow(/required review/);
    setState(r.body.requestId, "waived");
    expect(updateTask(f.taskId, { status: "cancelled" })?.status).toBe("cancelled");
    await expect(submitReview(f.ctx, docBody({ outputKey: "another" }))).rejects.toMatchObject({ code: "terminal_task" });
    const optional = await submitReview(f.ctx, docBody({ outputKey: "courtesy", required: false }));
    expect(optional.body.state).toBe("pending");
    expect(reviewBlockerSync(f.taskId)).toBeNull();
  });

  it("with creation disabled an existing requirement still gates, withdraws and resubmits", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    const r = await submitReview(f.ctx, docBody());
    delete process.env.CALANDRIA_REVIEW_REQUESTS;
    expect(() => updateTask(f.taskId, { status: "done" })).toThrow(/required review/);
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);
    await expect(submitReview(f.ctx, docBody({ outputKey: "new" }))).rejects.toMatchObject({ code: "creation_disabled" });
    const w = await withdrawReview(f.taskId, { requestId: r.body.requestId, expectedVersion: 1, idempotencyKey: "w", reason: "wrong file" });
    expect(w.state).toBe("withdrawn");
    const again = await submitReview(f.ctx, docBody({ requestId: r.body.requestId, expectedVersion: w.version, expectedSubmissionId: r.body.submissionId }));
    expect(again.body.revision).toBe(2);
    expect(() => updateTask(f.taskId, { status: "done" })).toThrow(/required review/);
  });
});

describe("move disposition", () => {
  it("the preview names the review, the teardown refuses without the stronger acknowledgement, and the move waives it", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    const r = await submitReview(f.ctx, docBody());
    const dest = createProject({ name: `Dest-${uid()}`, repo_path: f.repo, branch: "main" });

    const preview = await previewDiscard(f.taskId);
    expect(preview?.safe).toBe(false);
    expect(preview?.reason).toMatch(/required review/);

    const refused = await moveTasksToProject([f.taskId], dest.id, { discardWorktree: [f.taskId] });
    expect(refused?.moved).toEqual([]);
    expect(refused?.skipped[0].reason.startsWith(UNSAFE_DISCARD_REASON)).toBe(true);
    expect(refused?.skipped[0].reason).toMatch(/required review/);
    expect(getTask(f.taskId)!.project_id).toBe(f.project.id);
    expect(fs.existsSync(f.wt.path)).toBe(true);

    const moved = await moveTasksToProject([f.taskId], dest.id, { discardWorktree: [f.taskId], discardUnsafe: [f.taskId], reviewActor: "instance-owner" });
    expect(moved?.moved.map((t) => t.id)).toEqual([f.taskId]);
    expect(getTask(f.taskId)!.project_id).toBe(dest.id);
    expect(getDb().prepare("SELECT state FROM review_requests WHERE id = ?").get(r.body.requestId)).toMatchObject({ state: "waived" });
  });
});

describe("the epoch moves on every way the model gets to work again", () => {
  function settled(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsub = subscribe(taskId, (ev) => {
        if (ev.type === "turn_end") {
          unsub();
          resolve();
        }
      });
    });
  }

  it("a resumed turn advances it; a task with no review rows is untouched", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    await submitReview(f.ctx, docBody());
    const before = taskEpoch(f.taskId)!;
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess" };
      yield { type: "done", sessionId: "sess" };
    });
    const done = settled(f.taskId);
    await startResumeTurn(getTask(f.taskId)!, f.project, "carry on");
    await done;
    expect(taskEpoch(f.taskId)).toBe(before + 1);

    const plain = await reviewTask();
    const d2 = settled(plain.taskId);
    await startResumeTurn(getTask(plain.taskId)!, plain.project, "carry on");
    await d2;
    expect(taskEpoch(plain.taskId)).toBe(0);
  });

  it("a message accepted into a lingering session advances it", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    await submitReview(f.ctx, docBody());
    const before = taskEpoch(f.taskId)!;
    const handle: TurnInputHandle = { send: () => true };
    registerTurnInput(f.taskId, handle);
    try {
      expect(sendToLingeringTurn(f.taskId, "one more thing")).toBe(true);
    } finally {
      unregisterTurnInput(f.taskId, handle);
    }
    expect(taskEpoch(f.taskId)).toBe(before + 1);
  });

  it("a worktree repair that re-cuts the checkout advances it", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    await submitReview(f.ctx, docBody());
    const before = taskEpoch(f.taskId)!;
    fs.rmSync(f.wt.path, { recursive: true, force: true });
    const res = await repairPost(new Request(`http://local/api/tasks/${f.taskId}/repair-worktree`, { method: "POST" }), { params: Promise.resolve({ id: f.taskId }) });
    expect(res.status).toBe(200);
    expect(getTask(f.taskId)!.worktree_path).not.toBe("");
    expect(taskEpoch(f.taskId)).toBeGreaterThan(before);
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);
  });
});
