// The required-review guard (WC-13): one eligibility rule, enforced at every
// completion, dependency, cleanup and deletion path. A task with no review rows
// behaves exactly as before.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blocks } from "../lib/autoStart";
import { getDb } from "../lib/db";
import { reviewRefusal } from "../lib/reviews/gate";
import { requiredReviewBlocker, reviewBlockerSync } from "../lib/reviews/guard";
import { prunableTaskIds } from "../lib/retention";
import { submitReview } from "../lib/reviews/submit";
import { withdrawReview } from "../lib/reviews/withdraw";
import { ReviewError } from "../lib/reviews/types";
import { reclaimTask } from "../lib/reclaim";
import { sweepWorktrees } from "../lib/worktreeSweep";
import { updateTaskForAgent } from "../lib/agentTools";
import { createProject, createTask, deleteProject, deleteTask, getTask, moveTasks, setTaskDeps, updateTask } from "../lib/store";
import { commitFile, uid } from "./helpers";
import { docBody, reviewTask } from "./reviewFixture";

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function withReview(required = true) {
  const f = await reviewTask();
  await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
  const receipt = await submitReview(f.ctx, docBody({ required }));
  return { ...f, requestId: receipt.body.requestId };
}

const setState = (requestId: string, state: string) =>
  getDb().prepare("UPDATE review_requests SET state = ? WHERE id = ?").run(state, requestId);

function expectReviewRequired(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ReviewError);
    expect((e as ReviewError).code).toBe("review_required");
    return;
  }
  throw new Error("expected review_required");
}

describe("requiredReviewBlocker (pure)", () => {
  const req = (id: string, state: any, effectPending = false) => ({ id, state, effectPending });
  it("passes with no requests", () => expect(requiredReviewBlocker([], new Map())).toBeNull());
  it("passes accepted+current/landed/retired and waived", () => {
    for (const a of ["current", "landed", "retired"] as const)
      expect(requiredReviewBlocker([req("a", "accepted")], new Map([["a", a]]))).toBeNull();
    expect(requiredReviewBlocker([req("w", "waived")], new Map())).toBeNull();
  });
  it("blocks every other state, changed or unavailable artifacts, and unsettled effects", () => {
    for (const s of ["pending", "changes_requested", "withdrawn"])
      expect(requiredReviewBlocker([req("a", s)], new Map())?.code).toBe("review_required");
    for (const a of ["changed", "unavailable"] as const)
      expect(requiredReviewBlocker([req("a", "accepted")], new Map([["a", a]]))?.requestIds).toEqual(["a"]);
    expect(requiredReviewBlocker([req("a", "accepted", true)], new Map([["a", "current"]]))).not.toBeNull();
  });
});

describe("completion paths", () => {
  it("leaves an ordinary task unchanged", async () => {
    const f = await reviewTask();
    expect(reviewBlockerSync(f.taskId)).toBeNull();
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
    expect(prunableTaskIds(Date.now() + 1000)).toContain(f.taskId);
  });

  it("submitting never completes the task or releases a dependent", async () => {
    const f = await withReview();
    expect(getTask(f.taskId)!.status).toBe("in_progress");
    const dependent = uid();
    createTask({ id: dependent, project_id: f.project.id, title: "after", description: "" });
    setTaskDeps(dependent, [f.taskId]);
    expect(blocks(f.taskId)).toBe(true);
  });

  it("refuses done and cancelled while the required review is unsatisfied, in the store itself", async () => {
    const f = await withReview();
    expectReviewRequired(() => updateTask(f.taskId, { status: "done" }));
    expectReviewRequired(() => updateTask(f.taskId, { status: "cancelled" }));
    expect(getTask(f.taskId)!.status).toBe("in_progress");
  });

  it("a snoozed task's required review still blocks completion", async () => {
    const f = await withReview();
    updateTask(f.taskId, { snoozed_until: Date.now() + 3_600_000 });
    expectReviewRequired(() => updateTask(f.taskId, { status: "done" }));
    expect(reviewBlockerSync(f.taskId)).not.toBeNull();
  });

  it("does not let an optional review block completion", async () => {
    const f = await withReview(false);
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
  });

  it("refuses the agent's done through update_task and names the review", async () => {
    const f = await withReview();
    const out = await updateTaskForAgent({ id: f.taskId, title: "x", agent: "claude" }, undefined, { status: "done" });
    expect(out.task).toBeNull();
    expect(out.text).toMatch(/required review/);
    expect(getTask(f.taskId)!.status).toBe("in_progress");
  });

  it("lets accepted pass, and blocks again after a reopen bumps the epoch", async () => {
    const f = await withReview();
    setState(f.requestId, "accepted");
    expect(reviewBlockerSync(f.taskId)).toBeNull();
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
    // Reopening invalidates the old acceptance: it must be resubmitted.
    updateTask(f.taskId, { status: "in_progress" });
    expect(reviewBlockerSync(f.taskId)?.requestIds).toEqual([f.requestId]);
    expectReviewRequired(() => updateTask(f.taskId, { status: "done" }));
  });

  it("fails an accepted old revision once the checkout changes (async gate)", async () => {
    const f = await withReview();
    setState(f.requestId, "accepted");
    expect(await reviewRefusal(f.taskId)).toBeNull();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan v2\n", "edit plan");
    expect(await reviewRefusal(f.taskId)).toMatch(/required review/);
  });

  it("keeps a withdrawn required review unsatisfied; a waiver is the human's alone", async () => {
    const f = await withReview();
    await withdrawReview(f.taskId, { requestId: f.requestId, expectedVersion: 1, idempotencyKey: "w1", reason: "wrong file" });
    expect(getDb().prepare("SELECT state FROM review_requests WHERE id = ?").get(f.requestId)).toMatchObject({ state: "withdrawn" });
    expectReviewRequired(() => updateTask(f.taskId, { status: "done" }));
    setState(f.requestId, "waived");
    expect(updateTask(f.taskId, { status: "done" })?.status).toBe("done");
  });

  it("rejects a required submission on a terminal task", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    updateTask(f.taskId, { status: "done" });
    await expect(submitReview(f.ctx, docBody())).rejects.toMatchObject({ code: "terminal_task" });
  });
});

describe("dependency and cleanup paths", () => {
  it("keeps a terminal blocker blocking while its required review is open", async () => {
    const f = await withReview();
    const dependent = uid();
    createTask({ id: dependent, project_id: f.project.id, title: "after", description: "" });
    setTaskDeps(dependent, [f.taskId]);
    // Forced past the store guard the way a raw write would.
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.taskId);
    expect(blocks(f.taskId)).toBe(true);
    setState(f.requestId, "waived");
    expect(blocks(f.taskId)).toBe(false);
  });

  it("excludes an unsatisfied task from retention, sweep and reclaim", async () => {
    const f = await withReview();
    getDb().prepare("UPDATE tasks SET status = 'done', updated_at = 1 WHERE id = ?").run(f.taskId);
    expect(prunableTaskIds(Date.now(), Date.now())).not.toContain(f.taskId);
    await sweepWorktrees(Date.now(), { retentionMs: 1 });
    expect(getTask(f.taskId)!.worktree_path).toBe(f.wt.path);
    const r = await reclaimTask(f.taskId);
    expect(r.ok).toBe(false);
    expect(getTask(f.taskId)!.worktree_path).toBe(f.wt.path);
    setState(f.requestId, "waived");
    expect(prunableTaskIds(Date.now(), Date.now())).toContain(f.taskId);
  });
});

describe("delete and move paths", () => {
  it("refuses deleteTask and deleteProject without the explicit disposition", async () => {
    const f = await withReview();
    expectReviewRequired(() => deleteTask(f.taskId));
    expectReviewRequired(() => deleteProject(f.project.id));
    expect(getTask(f.taskId)).toBeTruthy();
    deleteTask(f.taskId, { reviewDisposition: "waive_and_delete", reviewActor: "instance-owner" });
    expect(getTask(f.taskId)).toBeUndefined();
    // History survives the row, now waived.
    expect(getDb().prepare("SELECT state FROM review_requests WHERE id = ?").get(f.requestId)).toMatchObject({ state: "waived" });
  });

  it("refuses a move unless the task is named in the reset set, then waives and bumps the epoch", async () => {
    const f = await withReview();
    const dest = createProject({ name: `Dest-${uid()}`, repo_path: f.repo, branch: "main" });
    const out = moveTasks([f.taskId], dest.id);
    expect(out.moved).toEqual([]);
    expect(out.skipped[0].reason).toMatch(/required review/);
    const forced = moveTasks([f.taskId], dest.id, { resetCheckout: new Set([f.taskId]), reviewActor: "instance-owner" });
    expect(forced.moved).toHaveLength(1);
    expect(getDb().prepare("SELECT state FROM review_requests WHERE id = ?").get(f.requestId)).toMatchObject({ state: "waived" });
  });
});
