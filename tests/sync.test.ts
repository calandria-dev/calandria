import { describe, expect, it } from "vitest";
import { abortWorktreeMerge, completeWorktreeMerge, ensureWorktree, fastForwardWorktree, prepareWorktreeMerge, worktreeSyncStatus } from "../lib/git";
import fs from "node:fs";
import path from "node:path";
import { commitFile, git, makeRepo, makeRepoWithWorktree, tmpDir, uid, writeFile } from "./helpers";

describe("worktreeSyncStatus", () => {
  it("reports an up-to-date branch with nothing to do", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s).toEqual({
      behind: 0,
      ahead: 0,
      isDirty: false,
      canFastForward: false,
      clean: true,
      conflicts: [],
      baseTip: await git(repo, "rev-parse", "main"),
      mergeInProgress: false,
      unresolved: [],
    });
  });

  // A landed task must not be reported as still needing the base. mergeTask
  // lands with --no-ff, so the base gets a merge commit the task branch itself
  // doesn't carry: `behind` is 1 forever after a successful Accept & merge. What
  // says "nothing is waiting to land" is ahead === 0 — the banner's hide rule.
  // Without it the banner reappeared over a just-merged task as "1 commit to
  // pick up / Sync" whenever the worktree was dirty (a clean one was hidden by
  // canFastForward), and that Sync just re-merged the task's own merge commit.
  it("reports a landed task as having nothing of its own left, not as needing a sync", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const args = { repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" };

    await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" });
    writeFile(wt.path, "file.txt", "merged version\n");
    const landed = await completeWorktreeMerge({ ...args, message: "land it" });
    expect(landed).toMatchObject({ ok: true });

    // Clean tree: hidden the old way too (a plain fast-forward of the merge commit).
    let s = await worktreeSyncStatus(args);
    expect(s).toMatchObject({ ahead: 0, behind: 1, canFastForward: true, mergeInProgress: false });

    // Dirty tree: canFastForward goes false and only `ahead: 0` still says the
    // task has nothing outstanding — this is the case that showed the banner.
    writeFile(wt.path, "scratch.txt", "uncommitted\n");
    s = await worktreeSyncStatus(args);
    expect(s).toMatchObject({ ahead: 0, behind: 1, isDirty: true, canFastForward: false, mergeInProgress: false, conflicts: [] });
  });

  // The "main moved on / Fix with AI" banner reads this. A resolution turn edits
  // the markers out WITHOUT committing (the prompt forbids it), so the branch
  // tips never move: `behind` stays put and merge-tree re-predicts the same
  // conflicts forever. The banner kept re-offering "Fix with AI" over a finished
  // resolution because of exactly that — while paused, the worktree is the truth.
  it("reports a paused merge by the worktree's live state, not the branch prediction", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const args = { repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" };

    const prep = await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" });
    expect(prep).toMatchObject({ ok: true, clean: false, conflicts: ["file.txt"] });

    // Markers still in place: conflicted, and named — never a fast-forward.
    let s = await worktreeSyncStatus(args);
    expect(s).toMatchObject({ behind: 1, ahead: 1, canFastForward: false, clean: false, conflicts: ["file.txt"], mergeInProgress: true, unresolved: ["file.txt"] });

    // What a resolution turn does: rewrite the file marker-free, no `git add`.
    writeFile(wt.path, "file.txt", "merged version\n");
    s = await worktreeSyncStatus(args);
    expect(s.behind).toBe(1); // nothing committed yet — still behind, still paused
    expect(s).toMatchObject({ mergeInProgress: true, unresolved: [], conflicts: [], clean: true, canFastForward: false });

    // Discarding the resolution returns to the prediction: main still moved on.
    await abortWorktreeMerge(wt.path);
    s = await worktreeSyncStatus(args);
    expect(s).toMatchObject({ behind: 1, mergeInProgress: false, unresolved: [], conflicts: ["file.txt"], clean: false });
  });

  it("offers a fast-forward when only the base moved and the tree is clean", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const baseTip = await commitFile(repo, "main.txt", "main\n", "base advance");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(0);
    expect(s.isDirty).toBe(false);
    expect(s.canFastForward).toBe(true);
    expect(s.clean).toBe(true);
    expect(s.baseTip).toBe(baseTip);
  });

  it("withholds the fast-forward when the tree is dirty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "main.txt", "main\n", "base advance");
    writeFile(wt.path, "scratch.txt", "uncommitted\n");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.isDirty).toBe(true);
    expect(s.canFastForward).toBe(false);
    expect(s.clean).toBe(true); // branches themselves merge cleanly
  });

  it("predicts a clean merge for non-overlapping divergence", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main edit");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(1);
    expect(s.canFastForward).toBe(false);
    expect(s.clean).toBe(true);
    expect(s.conflicts).toEqual([]);
  });

  it("predicts conflicts for overlapping divergence, without touching the worktree", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const wtTip = await git(wt.path, "rev-parse", "HEAD");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(1);
    expect(s.clean).toBe(false);
    expect(s.conflicts).toEqual(["file.txt"]);
    // Read-only: no merge started, no files changed, tip unmoved.
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtTip);
  });

  it("returns the inert status when the base branch was deleted", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await git(repo, "checkout", "-b", "scratch");
    await git(repo, "branch", "-D", "main");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });
    expect(s).toEqual({ behind: 0, ahead: 0, isDirty: false, canFastForward: false, clean: true, conflicts: [], baseTip: "", mergeInProgress: false, unresolved: [] });
  });

  it("returns the inert status for missing worktree/branch inputs", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const none = { behind: 0, ahead: 0, isDirty: false, canFastForward: false, clean: true, conflicts: [], baseTip: "", mergeInProgress: false, unresolved: [] };
    expect(await worktreeSyncStatus({ repoPath: repo, worktreePath: "", workBranch: wt.branch, baseBranch: "main" })).toEqual(none);
    expect(await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: "", baseBranch: "main" })).toEqual(none);
    expect(await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: "calandria/ghost", baseBranch: "main" })).toEqual(none);
  });
});

describe("fastForwardWorktree", () => {
  it("advances the work branch to the base tip", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const baseTip = await commitFile(repo, "main.txt", "main\n", "base advance");

    expect(await fastForwardWorktree(wt.path, "main")).toBe(true);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(baseTip);
    expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch); // still on the work branch
  });

  it("refuses when the branches diverged", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main edit");
    const wtTip = await git(wt.path, "rev-parse", "HEAD");

    expect(await fastForwardWorktree(wt.path, "main")).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtTip);
  });

  it("refuses when dirty files would be overwritten", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "file.txt", "main version\n", "base advance");
    writeFile(wt.path, "file.txt", "uncommitted local edit\n");
    const wtTip = await git(wt.path, "rev-parse", "HEAD");

    expect(await fastForwardWorktree(wt.path, "main")).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(wtTip);
  });

  it("returns false for a directory that is not a git repo", async () => {
    expect(await fastForwardWorktree(tmpDir(), "main")).toBe(false);
  });
});

// A task with a base of its own (lib/baseBranch.ts) follows THAT branch, not the
// project's default. The git layer already takes the base as a parameter, so
// what these pin is that a non-default base behaves identically — and, more to
// the point, that main moving is not something such a task ever picks up.
describe("sync against a non-default base branch", () => {
  it("catches up to the task's own base and ignores the project default", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-b", "feature/x");
    await git(repo, "checkout", "main");
    const wt = await ensureWorktree(repo, uid(), "feature/x");
    if (!wt) throw new Error("ensureWorktree returned null");
    expect(wt.baseBranch).toBe("feature/x");

    // Both branches move on, each with a file of its own.
    await git(repo, "checkout", "feature/x");
    const featureTip = await commitFile(repo, "feature.txt", "feature\n", "feature edit");
    await git(repo, "checkout", "main");
    await commitFile(repo, "main.txt", "main\n", "main edit");

    const s = await worktreeSyncStatus({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "feature/x" });
    expect(s).toMatchObject({ behind: 1, ahead: 0, canFastForward: true, baseTip: featureTip });

    expect(await fastForwardWorktree(wt.path, "feature/x")).toBe(true);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(featureTip);
    // main's commit is nowhere near this worktree — that is the whole point.
    expect(fs.existsSync(path.join(wt.path, "feature.txt"))).toBe(true);
    expect(fs.existsSync(path.join(wt.path, "main.txt"))).toBe(false);
  });
});

// A project whose base branch only takes pull requests can still hit conflicts,
// and resolving them is the same work: merge the base INTO the task branch so
// the PR becomes mergeable. What it must not do is the second half — landing
// that branch on the local base, which is the merge that can never be pushed.
describe("completeWorktreeMerge — resolveOnly (PR landing policy)", () => {
  it("commits the resolution to the work branch and leaves the base branch where it was", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const baseBefore = await git(repo, "rev-parse", "main");
    const args = { repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" };

    await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" });
    writeFile(wt.path, "file.txt", "merged version\n");
    const res = await completeWorktreeMerge({ ...args, message: "land it", resolveOnly: true });

    expect(res).toMatchObject({ ok: true, resolveOnly: true, targetBranch: wt.branch });
    expect(await git(repo, "rev-parse", "main")).toBe(baseBefore);

    // The branch now contains the base — which is the whole point — and the
    // paused merge is gone, so the banner has nothing left to ask about.
    const s = await worktreeSyncStatus(args);
    expect(s).toMatchObject({ behind: 0, mergeInProgress: false, conflicts: [] });
  });
});
