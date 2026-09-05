import { describe, expect, it } from "vitest";
import {
  abortWorktreeMerge,
  ensureWorktree,
  mergeTask,
  removeWorktree,
  worktreePruneSafety,
  worktreeSyncStatus,
} from "../lib/git";
import { commitFile, git, makeRepo, tmpDir, uid } from "./helpers";
import path from "node:path";
import fs from "node:fs";

/** A task worktree on a legacy `orch/<id>` branch. */
async function legacyWorktree() {
  const repo = await makeRepo();
  const taskId = uid();
  const branch = `orch/${taskId}`;
  const wtPath = path.join(tmpDir("legacy-wt-"), taskId);
  await git(repo, "worktree", "add", "-b", branch, wtPath, "main");
  return { repo, taskId, branch, wtPath };
}

// Branches minted under the old `orch/<id>` prefix keep that name
// permanently, since live branches are never renamed, so every branch-taking
// path must stay agnostic to the prefix. The abort case reads the old ref
// name because a paused merge marker lives in the worktree, not the DB, and
// can outlive a deploy that changed the prefix.
describe("legacy orch/ branches keep working after the calandria/ cutover", () => {
  it("syncs, merges and prunes an orch/ task", async () => {
    const { repo, branch, wtPath } = await legacyWorktree();
    await commitFile(wtPath, "task.txt", "task work\n", "task edit");
    await commitFile(repo, "main.txt", "main work\n", "main edit");
    const args = { repoPath: repo, worktreePath: wtPath, workBranch: branch, baseBranch: "main" };

    const status = await worktreeSyncStatus(args);
    expect(status).toMatchObject({ behind: 1, ahead: 1, canFastForward: false });

    const unsafe = await worktreePruneSafety(args);
    expect(unsafe).toMatchObject({ safe: false });

    const merged = await mergeTask({ ...args, message: `Legacy task (calandria task legacy)` });
    expect(merged).toMatchObject({ ok: true });
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toContain("calandria task legacy");

    expect(await worktreePruneSafety(args)).toMatchObject({ safe: true });
    await removeWorktree(repo, wtPath, branch);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(await git(repo, "branch", "--list", branch)).toBe("");
  });

  it("aborts a merge whose marker was recorded under the old ref name", async () => {
    const { repo, branch, wtPath } = await legacyWorktree();
    const preMerge = await commitFile(wtPath, "task.txt", "task work\n", "task edit");
    await commitFile(repo, "main.txt", "main work\n", "main edit");

    // What prepareWorktreeMerge writes under the legacy ref name, followed by
    // a resolution merge the agent commits itself.
    await git(wtPath, "update-ref", "refs/worktree/orch-merge-abort", "HEAD");
    await git(wtPath, "merge", "--no-ff", "-m", "merge base", "main");
    expect(await git(wtPath, "rev-parse", "HEAD")).not.toBe(preMerge);

    await abortWorktreeMerge(wtPath);
    expect(await git(wtPath, "rev-parse", "HEAD")).toBe(preMerge);
    // Marker cleared under the legacy name too.
    await expect(git(wtPath, "rev-parse", "--verify", "refs/worktree/orch-merge-abort")).rejects.toThrow();
    expect(branch).toMatch(/^orch\//);
  });

  // The self-heal path derives a branch name when a worktree is gone,
  // whether from a merged worktree pruned to reclaim disk or a lost
  // checkout. It must derive the branch matching the task's real work
  // (orch/<id> for a legacy task), so a caller doesn't mint a fresh, empty
  // calandria/<id> branch and write that to the row.
  it("ensureWorktree reattaches a pruned orch/ task to its own branch, not a fresh calandria/ one", async () => {
    const { repo, taskId, branch, wtPath } = await legacyWorktree();
    await commitFile(wtPath, "task.txt", "task work\n", "task edit");
    const work = (await git(wtPath, "rev-parse", "HEAD")).trim();
    // The prune: worktree directory gone, branch kept (keepBranch: true).
    await removeWorktree(repo, wtPath, branch, { keepBranch: true });
    expect(fs.existsSync(wtPath)).toBe(false);

    const wt = await ensureWorktree(repo, taskId, "main");
    expect(wt).not.toBeNull();
    expect(wt!.branch).toBe(branch);
    expect((await git(wt!.path, "rev-parse", "HEAD")).trim()).toBe(work);
    // The base is the fork point where the task branched, which may differ
    // from the base branch's current tip.
    expect(wt!.baseSha).toBe((await git(repo, "rev-parse", "main")).trim());
    // And no shadow branch was minted.
    await expect(git(repo, "rev-parse", "--verify", `calandria/${taskId}`)).rejects.toThrow();
  });
});
