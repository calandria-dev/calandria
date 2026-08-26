import { describe, expect, it } from "vitest";
import {
  abortWorktreeMerge,
  mergeTask,
  removeWorktree,
  worktreePruneSafety,
  worktreeSyncStatus,
} from "../lib/git";
import { commitFile, git, makeRepo, tmpDir, uid } from "./helpers";
import path from "node:path";
import fs from "node:fs";

/** A task created before the rename: worktree on an `orch/<id>` branch. */
async function legacyWorktree() {
  const repo = await makeRepo();
  const taskId = uid();
  const branch = `orch/${taskId}`;
  const wtPath = path.join(tmpDir("legacy-wt-"), taskId);
  await git(repo, "worktree", "add", "-b", branch, wtPath, "main");
  return { repo, taskId, branch, wtPath };
}

// Branches minted before the rename keep their `orch/<id>` name forever — live
// branches are never renamed, so every branch-taking path has to stay agnostic
// about the prefix. The abort case is the one place the old spelling is read
// back deliberately: a paused merge lives in the worktree, not the DB, so its
// marker ref can outlive the deploy that renamed it.
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

    // Exactly what prepareWorktreeMerge did before the rename, then a resolution
    // merge the agent committed itself.
    await git(wtPath, "update-ref", "refs/worktree/orch-merge-abort", "HEAD");
    await git(wtPath, "merge", "--no-ff", "-m", "merge base", "main");
    expect(await git(wtPath, "rev-parse", "HEAD")).not.toBe(preMerge);

    await abortWorktreeMerge(wtPath);
    expect(await git(wtPath, "rev-parse", "HEAD")).toBe(preMerge);
    // Marker cleared under the legacy name too.
    await expect(git(wtPath, "rev-parse", "--verify", "refs/worktree/orch-merge-abort")).rejects.toThrow();
    expect(branch).toMatch(/^orch\//);
  });
});
