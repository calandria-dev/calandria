import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  abortWorktreeMerge,
  completeWorktreeMerge,
  ensureWorktree,
  mergeTask,
  prepareWorktreeMerge,
  worktreeMergeStatus,
} from "../lib/git";
import { commitFile, git, makeRepo, makeRepoWithWorktree, uid, writeFile } from "./helpers";

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

describe("mergeTask", () => {
  it("commits pending work and lands it on the base branch", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "feature.txt", "feature\n"); // left uncommitted

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.targetBranch).toBe("main");
    expect(res.alreadyMerged).toBeUndefined();
    expect(res.mergedSha).toBe(await git(repo, "rev-parse", wt.branch));
    // main got the file via a merge commit; the repo stays on main.
    expect(read(repo, "feature.txt")).toBe("feature\n");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
  });

  it("restores the branch the repo had checked out", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await git(repo, "checkout", "-b", "scratch");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("main");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scratch");
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
  });

  it("short-circuits when there is nothing to land", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "noop",
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyMerged).toBe(true);
    expect(res.committed).toBe(false);
  });

  it("refuses when the main working tree is dirty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    writeFile(repo, "file.txt", "local edit\n"); // dirty the main tree

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/uncommitted changes/);
    // The local edit was not clobbered.
    expect(read(repo, "file.txt")).toBe("local edit\n");
  });

  it("names what is dirty in the main checkout so the refusal is actionable", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    writeFile(repo, "file.txt", "local edit\n"); // tracked, modified
    writeFile(repo, ".gitattributes", "* text=auto\n"); // the tool-dropping case

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
    });

    expect(res.ok).toBe(false);
    // git's own order: tracked changes first, untracked after.
    expect(res.dirty).toEqual([
      { code: " M", path: "file.txt", untracked: false },
      { code: "??", path: ".gitattributes", untracked: true },
    ]);
    expect(res.dirtyTruncated).toBeUndefined();
    expect(res.stashed).toBeUndefined();
  });

  // `--porcelain -z` reverses the rename pair, giving the destination path
  // first and the origin in a second NUL field. Reading it as one entry per
  // field would report the old path and offer to stash a path that no longer
  // exists.
  it("reports the destination path of a staged rename", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await git(repo, "mv", "file.txt", "renamed.txt");

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
    });

    expect(res.ok).toBe(false);
    expect(res.dirty).toEqual([{ code: "R ", path: "renamed.txt", untracked: false }]);
  });

  it("stashes acknowledged dirt, merges, and puts the dirt back", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    writeFile(repo, "file.txt", "local edit\n");
    writeFile(repo, ".gitattributes", "* text=auto\n");

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
      stashDirty: [".gitattributes", "file.txt"],
    });

    expect(res.ok).toBe(true);
    expect(res.stashed?.restored).toBe(true);
    // The merge landed.
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
    expect(read(repo, "feature.txt")).toBe("feature\n");
    // The borrowed work is back, tracked and untracked alike, and the stash
    // entry is cleaned up instead of left on the user's stack.
    expect(read(repo, "file.txt")).toBe("local edit\n");
    expect(read(repo, ".gitattributes")).toBe("* text=auto\n");
    expect(await git(repo, "stash", "list")).toBe("");
  });

  it("refuses to stash dirt the user never acknowledged", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    writeFile(repo, "file.txt", "local edit\n");
    writeFile(repo, "secret.txt", "appeared after the card rendered\n");

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
      stashDirty: ["file.txt"], // the list the user was actually shown
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/didn't agree to stash/);
    expect(res.dirty?.map((d) => d.path)).toEqual(["file.txt", "secret.txt"]);
    // Nothing was stashed, nothing was merged.
    expect(await git(repo, "stash", "list")).toBe("");
    expect(read(repo, "secret.txt")).toBe("appeared after the card rendered\n");
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("initial commit");
  });

  it("restores the stash when the merge conflicts", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    writeFile(repo, "scratch.txt", "local scratch\n");

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
      stashDirty: ["scratch.txt"],
    });

    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(["file.txt"]);
    expect(res.stashed?.restored).toBe(true);
    expect(read(repo, "scratch.txt")).toBe("local scratch\n");
    expect(await git(repo, "stash", "list")).toBe("");
  });

  it("still reports 'already merged' when the main checkout is dirty", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
    });
    writeFile(repo, "file.txt", "local edit\n"); // dirty AFTER the merge landed

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land feature",
    });
    expect(res.ok).toBe(true);
    expect(res.alreadyMerged).toBe(true);
    expect(res.dirty).toBeUndefined();
  });

  it("aborts cleanly on conflicts, listing the conflicted files", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const mainTip = await git(repo, "rev-parse", "main");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(["file.txt"]);
    expect(res.error).toMatch(/conflicts in 1 file/);
    // The merge was aborted: main untouched, tree clean, no merge in progress.
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect((await worktreeMergeStatus(repo)).mergeInProgress).toBe(false);
  });

  it("serializes two concurrent merges on the same repo", async () => {
    const repo = await makeRepo();
    const a = await ensureWorktree(repo, uid());
    const b = await ensureWorktree(repo, uid());
    if (!a || !b) throw new Error("ensureWorktree returned null");
    await commitFile(a.path, "a.txt", "a\n", "task a");
    await commitFile(b.path, "b.txt", "b\n", "task b");

    const [ra, rb] = await Promise.all([
      mergeTask({ repoPath: repo, worktreePath: a.path, workBranch: a.branch, baseBranch: "main", message: "land a" }),
      mergeTask({ repoPath: repo, worktreePath: b.path, workBranch: b.branch, baseBranch: "main", message: "land b" }),
    ]);

    // Both land cleanly (serialized), and the repo is left on the original branch
    // with both tasks' files present on main.
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(read(repo, "a.txt")).toBe("a\n");
    expect(read(repo, "b.txt")).toBe("b\n");
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("recovers a repo stranded mid-merge by a prior crash", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");

    // Strand the MAIN tree mid-merge (as a crash would): two branches edit the
    // same file, so `git merge` stops with MERGE_HEAD set and a dirty index.
    await git(repo, "checkout", "-b", "other");
    await commitFile(repo, "file.txt", "other version\n", "other edit");
    await git(repo, "checkout", "main");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    await git(repo, "merge", "other").catch(() => {}); // conflicts → stranded MERGE_HEAD
    expect((await worktreeMergeStatus(repo)).mergeInProgress).toBe(true);

    // The next merge recovers the stranded tree instead of blocking on it forever.
    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect((await worktreeMergeStatus(repo)).mergeInProgress).toBe(false);
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(read(repo, "feature.txt")).toBe("feature\n");
  });

  it("merges into a base branch that is not the main checkout without touching the working tree", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    // Put the main tree on a different branch with its own uncommitted edit.
    await git(repo, "checkout", "-b", "scratch");
    writeFile(repo, "scratch.txt", "local wip\n");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land feature",
    });

    expect(res.ok).toBe(true);
    expect(res.targetBranch).toBe("main");
    // main advanced, main tree stayed on scratch with its uncommitted edit intact.
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe("land feature");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("scratch");
    expect(read(repo, "scratch.txt")).toBe("local wip\n");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });

  // A base that exists on the remote is already a local branch by cut time,
  // so a missing branch here is genuinely absent, not a checkout to fall
  // back to.
  it("refuses when the base branch is missing, rather than landing on the checked-out one", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    const mainTip = await git(repo, "rev-parse", "main");

    const res = await mergeTask({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "develop", // does not exist
      message: "land feature",
    });
    expect(res.ok).toBe(false);
    expect(res.targetBranch).toBe("develop");
    expect(res.error).toContain("base branch develop not found");
    expect(res.error).toContain("main"); // names the branch it would have written to
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });
});

describe("prepareWorktreeMerge", () => {
  it("merges a non-conflicting base advance cleanly into the worktree", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main moved on");

    const res = await prepareWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      baseBranch: "main",
      message: "sync base",
    });

    expect(res).toEqual({ ok: true, clean: true, conflicts: [], binaryConflicts: [] });
    expect(read(wt.path, "main.txt")).toBe("main\n"); // base content arrived
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);
  });

  it("leaves conflict markers in place and reports text vs binary conflicts", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "blob.bin", Buffer.from([0, 1, 2, 3]), "add binary");
    // Re-branch the worktree off the binary-bearing commit so both sides can edit it.
    await git(wt.path, "reset", "--hard", "main");
    await commitFile(wt.path, "file.txt", "task version\n", "task text edit");
    await commitFile(wt.path, "blob.bin", Buffer.from([0, 9, 9, 9]), "task binary edit");
    await commitFile(repo, "file.txt", "main version\n", "main text edit");
    await commitFile(repo, "blob.bin", Buffer.from([0, 7, 7, 7]), "main binary edit");

    const res = await prepareWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      baseBranch: "main",
      message: "sync base",
    });

    expect(res.ok).toBe(true);
    expect(res.clean).toBe(false);
    expect(res.conflicts).toEqual(["file.txt"]);
    expect(res.binaryConflicts).toEqual(["blob.bin"]);
    expect(read(wt.path, "file.txt")).toContain("<<<<<<<");

    const status = await worktreeMergeStatus(wt.path);
    expect(status.mergeInProgress).toBe(true);
    expect(status.unresolved.sort()).toEqual(["blob.bin", "file.txt"]);

    // Editing the text conflict marker-free resolves it even without staging;
    // the binary (which can never carry markers) stays unresolved.
    writeFile(wt.path, "file.txt", "resolved version\n");
    expect((await worktreeMergeStatus(wt.path)).unresolved).toEqual(["blob.bin"]);
  });

  it("stops reporting a file unresolved once its markers are edited out, even unstaged", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const res = await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" });
    expect(res.conflicts).toEqual(["file.txt"]);

    // An AI resolution turn rewrites the file marker-free but never `git add`s
    // it. The index still flags it unmerged even though the content is resolved.
    writeFile(wt.path, "file.txt", "resolved version\n");

    const status = await worktreeMergeStatus(wt.path);
    expect(status.mergeInProgress).toBe(true); // the merge still awaits accept
    expect(status.unresolved).toEqual([]); // nothing is left to resolve
  });

  it("no-ops when the work branch already contains the base tip", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(repo, "main.txt", "main\n", "main moved on");
    const input = { repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "Sync main into task" };
    const first = await prepareWorktreeMerge(input);
    expect(first.clean).toBe(true);
    const head = await git(wt.path, "rev-parse", "HEAD");

    // Re-running prepare on the already-synced branch (for example after a
    // half-completed accept) must not stack another sync commit, and must not
    // sweep pending edits into a sync-titled commit either.
    writeFile(wt.path, "pending.txt", "wip\n");
    const second = await prepareWorktreeMerge(input);
    expect(second).toEqual({ ok: true, clean: true, conflicts: [], binaryConflicts: [] });
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(wt.path, "status", "--porcelain")).toContain("pending.txt");
  });

  it("reports the existing conflicts when a merge is already in progress", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(repo, "file.txt", "main version\n", "main edit");
    const input = { repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" };

    const first = await prepareWorktreeMerge(input);
    expect(first.clean).toBe(false);
    const second = await prepareWorktreeMerge(input);
    expect(second).toEqual({ ok: true, clean: false, conflicts: ["file.txt"], binaryConflicts: [] });
  });

  it("fails up front without a worktree or with a missing base branch", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    const noWt = await prepareWorktreeMerge({ repoPath: repo, worktreePath: "", baseBranch: "main", message: "m" });
    expect(noWt.ok).toBe(false);
    expect(noWt.error).toMatch(/no isolated worktree/);

    const noBase = await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "develop", message: "m" });
    expect(noBase.ok).toBe(false);
    expect(noBase.error).toMatch(/develop not found/);
  });
});

describe("conflict resolution: complete / abort", () => {
  // Shared fixture: prepare() has paused mid-merge with a conflict in file.txt.
  async function conflictedWorktree() {
    const fx = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(fx.wt.path, "file.txt", "task version\n", "task edit");
    await commitFile(fx.repo, "file.txt", "main version\n", "main edit");
    const res = await prepareWorktreeMerge({
      repoPath: fx.repo,
      worktreePath: fx.wt.path,
      baseBranch: "main",
      message: "sync base",
    });
    expect(res.clean).toBe(false);
    return fx;
  }

  it("completeWorktreeMerge refuses while conflict markers remain", async () => {
    const { repo, wt } = await conflictedWorktree();
    const res = await completeWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/conflict markers/);
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(true); // still resumable
  });

  it("completeWorktreeMerge lands a resolved conflict into the base branch", async () => {
    const { repo, wt } = await conflictedWorktree();
    writeFile(wt.path, "file.txt", "resolved version\n");

    const res = await completeWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land resolved",
    });

    expect(res.ok).toBe(true);
    expect(res.mergedSha).toBe(await git(repo, "rev-parse", wt.branch));
    expect(read(repo, "file.txt")).toBe("resolved version\n");
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);
  });

  it("completeWorktreeMerge after a clean prepare is a plain landing", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main moved on");
    const prep = await prepareWorktreeMerge({ repoPath: repo, worktreePath: wt.path, baseBranch: "main", message: "sync" });
    expect(prep.clean).toBe(true);

    const res = await completeWorktreeMerge({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "main",
      message: "land",
    });
    expect(res.ok).toBe(true);
    expect(read(repo, "task.txt")).toBe("task\n");
  });

  it("abortWorktreeMerge cancels an in-progress merge", async () => {
    const { wt } = await conflictedWorktree();
    const preMergeTip = await git(wt.path, "rev-parse", "HEAD");

    await abortWorktreeMerge(wt.path);

    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(preMergeTip);
    expect(read(wt.path, "file.txt")).toBe("task version\n"); // markers gone
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
  });

  it("abortWorktreeMerge unwinds a merge Claude already committed", async () => {
    const { wt } = await conflictedWorktree();
    const preMergeTip = await git(wt.path, "rev-parse", "HEAD");
    // Resolve and commit the merge by hand; MERGE_HEAD is consumed.
    writeFile(wt.path, "file.txt", "resolved\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--no-edit", "--no-verify");
    expect((await worktreeMergeStatus(wt.path)).mergeInProgress).toBe(false);

    await abortWorktreeMerge(wt.path);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(preMergeTip);
  });

  it("abortWorktreeMerge never discards ordinary, non-merge commits", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    const tip = await commitFile(wt.path, "work.txt", "work\n", "ordinary commit");

    await abortWorktreeMerge(wt.path);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("abortWorktreeMerge spares a prior sync merge commit + uncommitted work", async () => {
    // HEAD may be an earlier merge commit the app did not create for conflict
    // resolution (for example a sync of main), with uncommitted edits made
    // since. Discard merge must be a no-op in that case.
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "task.txt", "task\n", "task edit");
    await commitFile(repo, "main.txt", "main\n", "main moved on");
    // Sync main into the work branch; HEAD becomes a non-resolution merge commit.
    await git(wt.path, "merge", "--no-ff", "-m", "sync main", "main");
    const syncMerge = await git(wt.path, "rev-parse", "HEAD");
    // Agent edits a file but does not commit.
    writeFile(wt.path, "task.txt", "task WIP edit\n");

    await abortWorktreeMerge(wt.path);

    // Neither the sync merge commit nor the uncommitted edit was destroyed.
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(syncMerge);
    expect(read(wt.path, "task.txt")).toBe("task WIP edit\n");
  });

  it("abortWorktreeMerge unwinds a resolution merge but keeps unrelated later work", async () => {
    // A genuine app-started resolution merge is committed, then more commits
    // land on top. Abort must not discard that later work; it only owns the
    // merge it made.
    const { repo, wt } = await conflictedWorktree();
    const preMergeTip = await git(wt.path, "rev-parse", "HEAD");
    writeFile(wt.path, "file.txt", "resolved\n");
    await git(wt.path, "add", "-A");
    await git(wt.path, "commit", "--no-edit", "--no-verify"); // the resolution merge
    const later = await commitFile(wt.path, "more.txt", "more\n", "follow-up work");

    await abortWorktreeMerge(wt.path);

    // HEAD unchanged: the merge is buried under `later`, no longer safe to discard.
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(later);
    expect(later).not.toBe(preMergeTip);
    expect(await git(repo, "rev-parse", "HEAD")).toBeTruthy();
  });

  it("worktreeMergeStatus and abortWorktreeMerge tolerate an empty path", async () => {
    expect(await worktreeMergeStatus("")).toEqual({ mergeInProgress: false, unresolved: [] });
    await expect(abortWorktreeMerge("")).resolves.toBeUndefined();
  });
});

// Covers a base branch other than the one the main checkout has open, the
// shape a task with its own base has (lib/baseBranch.ts). mergeTask routes
// `target !== current` through the object-level path; these tests pin that
// the user's checkout stays untouched.
describe("merging into a non-default base branch", () => {
  it("lands on the task's own base while the main checkout stays on main", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "feature/x");
    const wt = await ensureWorktree(repo, uid(), "feature/x");
    if (!wt) throw new Error("ensureWorktree returned null");
    const mainTip = await git(repo, "rev-parse", "main");
    await commitFile(wt.path, "feature.txt", "feature\n", "task work");

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "feature/x", message: "land on feature/x",
    });

    expect(res).toMatchObject({ ok: true, targetBranch: "feature/x" });
    // mergedSha is the work branch's tip (the new diff base), and feature/x now
    // carries the merge commit that absorbed it.
    expect(res.mergedSha).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(await git(repo, "log", "-1", "--format=%s", "feature/x")).toBe("land on feature/x");
    // The user's checkout never moved and the file never appeared there: no
    // branch switch, no working tree materialized, main exactly where it was.
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
  });

  it("serializes two tasks landing on the same non-default base", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "feature/x");
    const mainTip = await git(repo, "rev-parse", "main");
    const a = await ensureWorktree(repo, uid(), "feature/x");
    const b = await ensureWorktree(repo, uid(), "feature/x");
    if (!a || !b) throw new Error("ensureWorktree returned null");
    await commitFile(a.path, "a.txt", "a\n", "task a");
    await commitFile(b.path, "b.txt", "b\n", "task b");

    const [ra, rb] = await Promise.all([
      mergeTask({ repoPath: repo, worktreePath: a.path, workBranch: a.branch, baseBranch: "feature/x", message: "land a" }),
      mergeTask({ repoPath: repo, worktreePath: b.path, workBranch: b.branch, baseBranch: "feature/x", message: "land b" }),
    ]);

    // withRepoLock serializes them and update-ref carries the old tip, so the
    // second merge builds on the first instead of overwriting it.
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    const landed = await git(repo, "log", "--format=%s", "feature/x");
    expect(landed).toContain("land a");
    expect(landed).toContain("land b");
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(repo, "rev-parse", "main")).toBe(mainTip);
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(false);
  });

  // The object-level fast path advances the base with a bare `update-ref`,
  // which does not check whether a checkout is standing on it. A linked
  // worktree on the base is the case `mergeTask`'s target !== current check
  // doesn't cover: without the holder check the merge succeeds and leaves
  // that worktree reporting the whole merge as uncommitted local changes.
  it("refuses rather than moving a base branch a linked worktree has checked out", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "feature/x");
    const featureTip = await git(repo, "rev-parse", "feature/x");
    // The user's own worktree, sitting on the base branch.
    const held = path.join(path.dirname(repo), `held-${uid()}`);
    await git(repo, "worktree", "add", held, "feature/x");

    const wt = await ensureWorktree(repo, uid(), "feature/x");
    if (!wt) throw new Error("ensureWorktree returned null");
    await commitFile(wt.path, "feature.txt", "feature\n", "task work");

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "feature/x", message: "land on feature/x",
    });

    expect(res.ok).toBe(false);
    expect(res.targetBranch).toBe("feature/x");
    // The refusal names the worktree standing on the branch, identifying
    // which checkout to let go of. Git prints that path with forward slashes
    // on every platform while path.join gives backslashes on Windows, so the
    // assertion matches on the unique leaf name instead of the whole path.
    expect(res.error).toContain("feature/x");
    expect(res.error).toContain(path.basename(held));
    // The branch did not move, and the held worktree reports nothing out of place.
    expect(await git(repo, "rev-parse", "feature/x")).toBe(featureTip);
    expect(await git(held, "rev-parse", "HEAD")).toBe(featureTip);
    expect(await git(held, "status", "--porcelain")).toBe("");
  });
});
