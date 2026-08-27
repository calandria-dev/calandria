import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as previewRoute, POST as moveRoute } from "@/app/api/tasks/[id]/move/route";
import {
  addUsage,
  createProject,
  createTask,
  getTask,
  getProjectUsage,
  recordSession,
  recordTaskMerge,
  updateTask,
} from "@/lib/store";
import { ensureWorktree, mergeTask } from "@/lib/git";
import { WORKTREES_DIR } from "@/lib/config";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { getDb } from "@/lib/db";
import { commitFile, git, makeRepo, writeFile } from "./helpers";
import { canonicalPath } from "@/lib/paths";

// Moving a task that has ALREADY RUN. The plain move refuses these: the task
// holds a git worktree cut from its current project's repo, so re-parenting the
// row alone would leave it diffing against one repository and merging into
// another. The way out isn't to keep refusing — it's to throw the checkout away
// on purpose. The transcript, summaries and spend are task-keyed and survive;
// only the worktree and its branch are lost, and the next turn cuts a fresh one
// from the destination's repo.
//
// So what these pin is the cost being named before it's paid: the acknowledge-
// ment, the second acknowledgement when the worktree holds work nobody saved,
// the refusal while a turn is live, and the child rows that would otherwise keep
// billing the project the task just left.

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function move(id: string, body: Record<string, unknown>) {
  return moveRoute(new Request("http://test", { method: "POST", body: JSON.stringify(body) }), params(id));
}

/**
 * Two projects with real repos, and a task in the first that has run: a
 * worktree, a branch, a session, spend, and a merge on record — the whole shape
 * the move used to refuse.
 */
async function startedTask(name: string) {
  const fromRepo = await makeRepo();
  const toRepo = await makeRepo();
  const from = createProject({ name: `${name} from`, repo_path: fromRepo, branch: "main" });
  const to = createProject({ name: `${name} to`, repo_path: toRepo, branch: "main" });
  const task = createTask({ project_id: from.id, title: "Filed under the wrong repo" });
  const wt = await ensureWorktree(fromRepo, task.id, "main");
  if (!wt) throw new Error("ensureWorktree returned null in fixture");
  updateTask(task.id, {
    started: 1,
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
    session_id: "old-session",
  });
  recordSession({ project_id: from.id, task_id: task.id, generation: 1, claude_session_id: "old-session" });
  addUsage({
    project_id: from.id,
    task_id: task.id,
    generation: 1,
    agent: "claude",
    usage: { cost_usd: 1.25, input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
  });
  return { from, to, fromRepo, toRepo, task: getTask(task.id)!, wt };
}

/** Land the task's branch in its base branch — the safe, merged case. */
async function landIt(repo: string, wt: { path: string; branch: string }) {
  await commitFile(wt.path, "feature.txt", "the work\n", "task commit");
  const res = await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
  expect(res.ok).toBe(true);
}

const childCounts = (projectId: string, taskId: string) => {
  const one = (table: string) =>
    (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ? AND project_id = ?`).get(taskId, projectId) as { n: number }).n;
  return { sessions: one("sessions"), usage: one("task_usage"), merges: one("task_merges") };
};

describe("moving a started task by discarding its worktree", () => {
  it("refuses without the acknowledgement, and touches nothing", async () => {
    const { from, to, task, wt } = await startedTask("Unacked");
    await landIt(from.repo_path, wt);

    const res = await move(task.id, { project_id: to.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/started task can't be moved/);
    expect(getTask(task.id)?.project_id).toBe(from.id);
    // The refusal is a refusal: the checkout is still there to go back to.
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(getTask(task.id)?.worktree_path).toBe(wt.path);
  });

  it("moves the row and removes the worktree + branch when acknowledged", async () => {
    const { to, fromRepo, task, wt } = await startedTask("Acked");
    await landIt(fromRepo, wt);

    const res = await move(task.id, { project_id: to.id, discard_worktree: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.project_id).toBe(to.id);
    // The point of moving instead of recreating: the row itself survives.
    expect(body.id).toBe(task.id);
    expect(body.started).toBe(1);
    // The checkout is gone from disk AND from the old repo's registry.
    expect(fs.existsSync(wt.path)).toBe(false);
    await expect(git(fromRepo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
    // …and off the row, which is what makes the next turn cut a fresh one.
    expect(getTask(task.id)).toMatchObject({ worktree_path: "", work_branch: "", base_sha: "" });
    // Reported, so the caller can say what it cost rather than leaving the user
    // to notice.
    expect(body.discarded).toMatchObject({ id: task.id, branch: wt.branch, dirty: false, ahead: 0 });
  });

  it("re-points the project-keyed child rows, so spend follows the task", async () => {
    const { from, to, fromRepo, task, wt } = await startedTask("Children");
    recordTaskMerge({ project_id: from.id, task_id: task.id, agent: "claude", additions: 9, deletions: 1 });
    await landIt(fromRepo, wt);
    expect(childCounts(from.id, task.id)).toEqual({ sessions: 1, usage: 1, merges: 1 });
    expect(getProjectUsage(from.id).cost_usd).toBeCloseTo(1.25);

    await move(task.id, { project_id: to.id, discard_worktree: true });

    // Left behind, these would keep billing a project that no longer owns the
    // task — and crediting it with insights it didn't earn.
    expect(childCounts(from.id, task.id)).toEqual({ sessions: 0, usage: 0, merges: 0 });
    expect(childCounts(to.id, task.id)).toEqual({ sessions: 1, usage: 1, merges: 1 });
    expect(getProjectUsage(from.id).cost_usd).toBe(0);
    expect(getProjectUsage(to.id).cost_usd).toBeCloseTo(1.25);
  });

  it("clears the state that described the old repo — session, merge, PR", async () => {
    const { to, fromRepo, task, wt } = await startedTask("StaleState");
    await landIt(fromRepo, wt);
    updateTask(task.id, { merged_at: Date.now(), pr_url: "https://github.com/old/repo/pull/7" });

    await move(task.id, { project_id: to.id, discard_worktree: true });

    const moved = getTask(task.id)!;
    // Resuming the old agent thread would drop it into a repo it has never
    // seen, at the very path it remembers (worktrees are keyed by task id).
    expect(moved.session_id).toBeNull();
    // Nothing of this task is in the destination's base branch, and its PR is
    // against a repo it no longer belongs to.
    expect(moved.merged_at).toBe(0);
    expect(moved.pr_url).toBe("");
    // The session row itself is history and survives — re-pointed, not erased.
    expect(childCounts(to.id, task.id).sessions).toBe(1);
  });

  it("leaves the transcript-bearing history alone", async () => {
    const { to, fromRepo, task, wt } = await startedTask("History");
    await landIt(fromRepo, wt);
    updateTask(task.id, { description: "why this task exists" });

    await move(task.id, { project_id: to.id, discard_worktree: true });

    const moved = getTask(task.id)!;
    expect(moved.description).toBe("why this task exists");
    // Still a started task: it really did run, so its next turn is a resume in
    // the new repo, not a rerun from scratch.
    expect(moved.started).toBe(1);
    expect(moved.generation).toBe(1);
  });
});

describe("discarding a worktree that still holds work", () => {
  it("refuses uncommitted changes until they're acknowledged by name", async () => {
    const { from, to, fromRepo, task, wt } = await startedTask("Dirty");
    await landIt(fromRepo, wt);
    // An edit made after the merge — force-remove would shred it silently.
    writeFile(wt.path, "feature.txt", "an afternoon of unsaved work\n");

    const res = await move(task.id, { project_id: to.id, discard_worktree: true });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/unsaved work — uncommitted changes/);
    // The flag the client uses to offer the stronger confirmation rather than
    // presenting this as a dead end.
    expect(body.needs_discard_unsafe).toBe(true);
    expect(getTask(task.id)?.project_id).toBe(from.id);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("refuses commits the base branch never took", async () => {
    const { fromRepo, to, task, wt } = await startedTask("Ahead");
    await landIt(fromRepo, wt);
    await commitFile(wt.path, "feature.txt", "round two\n", "round two commit");

    const res = await move(task.id, { project_id: to.id, discard_worktree: true });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/1 commit not yet in main/);
  });

  it("goes through once the second acknowledgement is given", async () => {
    const { to, fromRepo, task, wt } = await startedTask("DirtyAcked");
    await landIt(fromRepo, wt);
    writeFile(wt.path, "feature.txt", "unsaved\n");

    const res = await move(task.id, { project_id: to.id, discard_worktree: true, discard_unsafe: true });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.project_id).toBe(to.id);
    expect(body.discarded).toMatchObject({ dirty: true });
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("re-reads the worktree at teardown, not when the preview was taken", async () => {
    const { from, to, fromRepo, task, wt } = await startedTask("Raced");
    await landIt(fromRepo, wt);
    // The preview the modal rendered: clean and merged, nothing to lose.
    const preview = await (await previewRoute(new Request("http://test"), params(task.id))).json();
    expect(preview).toMatchObject({ has_worktree: true, safe: true, dirty: false });

    // …and then the user edits a file in their own editor before confirming.
    writeFile(wt.path, "feature.txt", "typed while the modal was open\n");
    const res = await move(task.id, { project_id: to.id, discard_worktree: true });

    // The acknowledgement was given about a state that no longer holds, so it
    // doesn't carry: nothing uncommitted is destroyed without being named.
    expect(res.status).toBe(409);
    expect(getTask(task.id)?.project_id).toBe(from.id);
    expect(fs.readFileSync(path.join(wt.path, "feature.txt"), "utf8")).toContain("typed while the modal was open");
  });
});

describe("the discard preview", () => {
  it("reports a clean merged worktree as safe", async () => {
    const { fromRepo, task, wt } = await startedTask("PreviewSafe");
    await landIt(fromRepo, wt);

    const body = await (await previewRoute(new Request("http://test"), params(task.id))).json();

    expect(body).toMatchObject({ has_worktree: true, safe: true, dirty: false, ahead: 0, reason: null, branch: wt.branch });
  });

  it("names what an unsafe worktree would cost", async () => {
    const { fromRepo, task, wt } = await startedTask("PreviewUnsafe");
    await landIt(fromRepo, wt);
    await commitFile(wt.path, "other.txt", "more\n", "unmerged commit");
    writeFile(wt.path, "feature.txt", "unsaved\n");

    const body = await (await previewRoute(new Request("http://test"), params(task.id))).json();

    expect(body).toMatchObject({ has_worktree: true, safe: false, dirty: true, ahead: 1 });
    expect(body.reason).toMatch(/uncommitted changes \+ 1 commit not yet in main/);
  });

  it("says there's nothing to discard for a task that never ran", async () => {
    const project = createProject({ name: "Preview unstarted", repo_path: await makeRepo(), branch: "main" });
    const task = createTask({ project_id: project.id, title: "Never started" });

    const body = await (await previewRoute(new Request("http://test"), params(task.id))).json();

    expect(body).toMatchObject({ has_worktree: false, safe: true, branch: "" });
  });

  it("404s an unknown task", async () => {
    expect((await previewRoute(new Request("http://test"), params("nope"))).status).toBe(404);
  });
});

describe("a live turn still refuses", () => {
  it("won't discard a worktree the row says is running", async () => {
    const { from, to, fromRepo, task, wt } = await startedTask("RunningFlag");
    await landIt(fromRepo, wt);
    updateTask(task.id, { running: 1 });

    const res = await move(task.id, { project_id: to.id, discard_worktree: true });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/running turn/);
    expect(getTask(task.id)?.project_id).toBe(from.id);
    // Nothing may delete a worktree an agent is writing into.
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("won't discard a worktree whose turn is merely in flight", async () => {
    const { from, to, fromRepo, task, wt } = await startedTask("ClaimedSlot");
    await landIt(fromRepo, wt);
    // POST /messages claims the turn slot BEFORE it takes the task lock, so the
    // row can still read running=0 while a launch is underway.
    const controller = claimTurn(task.id)!;
    try {
      const res = await move(task.id, { project_id: to.id, discard_worktree: true });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/running turn/);
      expect(getTask(task.id)?.project_id).toBe(from.id);
      expect(fs.existsSync(wt.path)).toBe(true);
    } finally {
      unregisterTurn(task.id, controller);
    }
  });
});

describe("what the next turn cuts", () => {
  it("gets a worktree in the DESTINATION repo, not the one it left", async () => {
    const { to, toRepo, fromRepo, task, wt } = await startedTask("NextTurn");
    await landIt(fromRepo, wt);

    await move(task.id, { project_id: to.id, discard_worktree: true });

    // What POST /messages does on the next turn: a cleared worktree_path reads
    // as "cut one".
    const fresh = await ensureWorktree(toRepo, task.id, "main");
    expect(fresh).toBeTruthy();
    expect(fresh!.path).toBe(wt.path); // same path — worktrees are keyed by task id
    // …but a different repo, which is the whole point.
    // canonicalPath both sides: git prints C:/Users/... on Windows where
    // realpathSync gives C:\Users\..., and NTFS case-folds (lib/paths.ts).
    expect(canonicalPath(await git(fresh!.path, "rev-parse", "--git-common-dir"))).toContain(canonicalPath(toRepo));
    expect(await git(toRepo, "rev-parse", "--verify", `refs/heads/${fresh!.branch}`)).toBeTruthy();
  });

  it("never adopts a leftover checkout belonging to another repo", async () => {
    // The crash window: teardown half-failed, or the process died between
    // removing the worktree and committing the move, and the old repo's
    // checkout is still sitting at the path this task's id maps to.
    const oldRepo = await makeRepo();
    const newRepo = await makeRepo();
    await commitFile(newRepo, "only-here.txt", "destination\n", "destination-only commit");
    const taskId = `stale-${Date.now().toString(36)}`;
    const stale = await ensureWorktree(oldRepo, taskId, "main");
    expect(fs.existsSync(path.join(WORKTREES_DIR, taskId))).toBe(true);

    const fresh = await ensureWorktree(newRepo, taskId, "main");

    expect(fresh).toBeTruthy();
    expect(fresh!.path).toBe(stale!.path);
    // Reusing it would run the agent — and its commits, and its merge — against
    // the repo the task just left.
    expect(canonicalPath(await git(fresh!.path, "rev-parse", "--git-common-dir"))).toContain(canonicalPath(newRepo));
    expect(fs.existsSync(path.join(fresh!.path, "only-here.txt"))).toBe(true);
  });
});

describe("a branch that outlived its worktree", () => {
  it("is deleted too — the pruned-but-kept shape", async () => {
    const { to, fromRepo, task, wt } = await startedTask("BranchOnly");
    await landIt(fromRepo, wt);
    // What "prune merged worktrees" leaves behind: disk reclaimed, branch kept
    // as the diff base for reopening the task.
    const { removeWorktree } = await import("@/lib/git");
    await removeWorktree(fromRepo, wt.path, wt.branch, { keepBranch: true });
    updateTask(task.id, { worktree_path: "" });
    expect(await git(fromRepo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).toBeTruthy();

    const res = await move(task.id, { project_id: to.id, discard_worktree: true });

    expect(res.status).toBe(200);
    // Left behind it would be an orphan ref in a repo nothing points at any
    // more — and would silently re-adopt the old work if the task ever moved back.
    await expect(git(fromRepo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
    expect(getTask(task.id)?.work_branch).toBe("");
  });

  it("is refused when it carries commits the base branch never took", async () => {
    const { from, to, fromRepo, task, wt } = await startedTask("BranchOnlyAhead");
    await commitFile(wt.path, "feature.txt", "never merged\n", "unmerged work");
    const { removeWorktree } = await import("@/lib/git");
    await removeWorktree(fromRepo, wt.path, wt.branch, { keepBranch: true });
    updateTask(task.id, { worktree_path: "" });

    const res = await move(task.id, { project_id: to.id, discard_worktree: true });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not yet in main/);
    expect(getTask(task.id)?.project_id).toBe(from.id);
  });
});
