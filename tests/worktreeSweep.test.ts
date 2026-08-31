import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { ensureWorktree } from "@/lib/git";
import { registerTurn, unregisterTurn } from "@/lib/abort";
import { sweepWorktrees } from "@/lib/worktreeSweep";
import { taskUploadsDir } from "@/lib/uploads";
import { commitFile, git, makeRepo, writeFile } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

// updateTask() stamps updated_at = Date.now(), which is the column the
// predicate reads — so "cold" has to be written underneath it.
const age = (id: string, ms: number) =>
  getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(Date.now() - ms, id);

/**
 * A finished task with a real worktree, cold by `days`. Returns everything a
 * case needs to dirty the checkout or read the branch back.
 */
async function coldTask(opts: { status?: "done" | "cancelled" | "in_progress"; days?: number } = {}) {
  const repo = await makeRepo();
  const project = createProject({ name: `wtsweep-${Math.random()}`, repo_path: repo, branch: "main" });
  const task = createTask({ project_id: project.id, title: "finished work" });
  const wt = await ensureWorktree(repo, task.id, "main");
  if (!wt) throw new Error("worktree fixture failed");
  updateTask(task.id, {
    status: opts.status ?? "done",
    started: 1,
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
  });
  age(task.id, (opts.days ?? 30) * DAY);
  return { repo, projectId: project.id, taskId: task.id, wt };
}

/**
 * Run a pass and narrow it to one task. The sweep's candidate list is every
 * prunable task in the database, and a case that deliberately leaves an unsafe
 * checkout behind (there are two below) is reported again by every later pass —
 * correctly, since it is still there. Narrowing keeps each case asserting about
 * its own fixture instead of about test order.
 */
async function sweep(taskId: string, retentionDays = 14) {
  const r = await sweepWorktrees(Date.now(), { retentionMs: retentionDays * DAY });
  return {
    reclaimed: r.reclaimed.filter((x) => x.taskId === taskId),
    skipped: r.skipped.filter((x) => x.taskId === taskId),
  };
}

/** Stage a chat attachment for a task, the way POST /uploads does. */
function attach(taskId: string, name = "q3-report.pdf") {
  const dir = taskUploadsDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "x".repeat(4096));
  return dir;
}

describe("scheduled worktree sweep", () => {
  it("reclaims the task's staged attachments along with its checkout", async () => {
    // Any file type can be attached now, so an instance can be sitting on
    // gigabytes of PDFs and log bundles outliving the worktrees they were
    // staged for. This sweep is the one teardown licensed to take them: the
    // task has been terminal and untouched for weeks.
    const { taskId } = await coldTask();
    const dir = attach(taskId);

    const result = await sweep(taskId);

    expect(result.reclaimed.map((r) => r.taskId)).toEqual([taskId]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("keeps the attachments of a checkout it refused to reclaim", async () => {
    const { taskId, wt } = await coldTask();
    writeFile(wt.path, "scratch.txt", "unsaved work");
    const dir = attach(taskId);

    const result = await sweep(taskId);

    expect(result.reclaimed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("reclaims a cold finished task's checkout and keeps its branch", async () => {
    const { repo, taskId, wt } = await coldTask();

    const result = await sweep(taskId);

    expect(result.reclaimed.map((r) => r.taskId)).toEqual([taskId]);
    expect(result.reclaimed[0].bytes).toBeGreaterThan(0);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(getTask(taskId)?.worktree_path).toBe("");
    // The branch is the diff base a reopened task is read against — never the
    // sweep's to delete, only the user's.
    expect(getTask(taskId)?.work_branch).toBe(wt.branch);
    await expect(git(repo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).resolves.toBeTruthy();
  });

  it("clearing the worktree does not restamp updated_at", async () => {
    // The board sorts on updated_at and the table prune ages against it, so a
    // reclaim nobody asked for must not float a six-month-old task to the top
    // of Done or push its transcript prune out by the worktree window.
    const { taskId } = await coldTask();
    const before = getTask(taskId)!.updated_at;

    await sweep(taskId);

    expect(getTask(taskId)!.updated_at).toBe(before);
  });

  it("skips a checkout with uncommitted edits, naming what it found", async () => {
    const { taskId, wt } = await coldTask();
    writeFile(wt.path, "wip.txt", "not saved\n");

    const result = await sweep(taskId);

    expect(result.reclaimed).toEqual([]);
    expect(result.skipped).toEqual([
      { taskId, reason: "the worktree has unsaved work: uncommitted changes not saved to any branch" },
    ]);
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(getTask(taskId)?.worktree_path).toBe(wt.path);
  });

  it("skips a branch carrying commits the base has not absorbed", async () => {
    const { taskId, wt } = await coldTask();
    await commitFile(wt.path, "landed-nowhere.txt", "work\n", "unmerged task work");

    const result = await sweep(taskId);

    expect(result.reclaimed).toEqual([]);
    expect(result.skipped[0].taskId).toBe(taskId);
    expect(result.skipped[0].reason).toContain("1 commit not yet in main");
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("leaves a task that is not terminal alone, however cold", async () => {
    const { taskId, wt } = await coldTask({ status: "in_progress", days: 400 });

    const result = await sweep(taskId);

    expect(result.reclaimed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(getTask(taskId)?.worktree_path).toBe(wt.path);
  });

  it("leaves a finished task that is still inside the window", async () => {
    const { taskId, wt } = await coldTask({ days: 3 });

    const result = await sweep(taskId, 14);

    expect(result.reclaimed).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("refuses while a turn is live, even though the row says otherwise", async () => {
    // The row's flags are the resting state after a turn; the abort registry is
    // liveness. A worktree must never disappear under an agent.
    const { taskId, wt } = await coldTask();
    const controller = new AbortController();
    registerTurn(taskId, controller);
    try {
      const result = await sweep(taskId);
      expect(result.reclaimed).toEqual([]);
      expect(result.skipped).toEqual([{ taskId, reason: "a turn is currently running" }]);
      expect(fs.existsSync(wt.path)).toBe(true);
    } finally {
      unregisterTurn(taskId, controller);
    }
  });

  it("reclaims a cancelled task too, and a zero window disables the pass", async () => {
    const { taskId, wt } = await coldTask({ status: "cancelled" });

    expect(await sweepWorktrees(Date.now(), { retentionMs: 0 })).toMatchObject({ reclaimed: [], skipped: [] });
    expect(fs.existsSync(wt.path)).toBe(true);

    const result = await sweep(taskId);
    expect(result.reclaimed.map((r) => r.taskId)).toEqual([taskId]);
    expect(fs.existsSync(wt.path)).toBe(false);
  });
});
