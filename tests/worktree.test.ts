import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchForTask,
  commitWorktree,
  ensureWorktree,
  isGitRepo,
  mergeTask,
  recentCommits,
  removeWorktree,
  repairWorktree,
  worktreePruneSafety,
} from "../lib/git";
import {
  WORKTREE_PREP_PREFIX,
  WORKTREE_REPAIR_NOTICE,
  WorktreePrepError,
  classifyWorktreePrep,
  worktreePrepNotice,
} from "../lib/worktreeFailure";
import { WORKTREES_DIR } from "../lib/config";
import { commitFile, git, makeRepo, makeRepoWithWorktree, tmpDir, uid, writeFile } from "./helpers";
import { NULL_DEVICE } from "./platform";

describe("isGitRepo", () => {
  it("is true inside a repo and false for plain or missing dirs", async () => {
    const repo = await makeRepo();
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(tmpDir())).toBe(false);
    expect(await isGitRepo(path.join(tmpDir(), "does-not-exist"))).toBe(false);
  });
});

describe("branchForTask", () => {
  it("prefixes the task id", () => {
    expect(branchForTask("abc123")).toBe("calandria/abc123");
  });
});

describe("recentCommits", () => {
  it("lists recent commits, newest first", async () => {
    const repo = await makeRepo();
    await commitFile(repo, "a.txt", "a\n", "second commit");
    const log = await recentCommits(repo);
    const lines = log.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/second commit$/);
    expect(lines[1]).toMatch(/initial commit$/);
  });

  it("respects the count limit", async () => {
    const repo = await makeRepo();
    await commitFile(repo, "a.txt", "a\n", "second commit");
    await commitFile(repo, "b.txt", "b\n", "third commit");
    expect((await recentCommits(repo, 2)).split("\n")).toHaveLength(2);
  });

  it("returns empty for non-repos and empty paths", async () => {
    expect(await recentCommits("")).toBe("");
    expect(await recentCommits(tmpDir())).toBe("");
  });
});

describe("ensureWorktree", () => {
  it("creates a worktree + branch from HEAD and reports the base sha", async () => {
    const repo = await makeRepo();
    const head = await git(repo, "rev-parse", "HEAD");
    const taskId = uid();

    const wt = await ensureWorktree(repo, taskId);
    expect(wt).not.toBeNull();
    expect(wt!.path).toBe(path.join(WORKTREES_DIR, taskId));
    expect(wt!.branch).toBe(`calandria/${taskId}`);
    expect(wt!.baseSha).toBe(head);

    expect(await isGitRepo(wt!.path)).toBe(true);
    expect(await git(wt!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`calandria/${taskId}`);
    expect(fs.existsSync(path.join(wt!.path, "file.txt"))).toBe(true);
    // The main repo stays on its original branch.
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("bases off the configured branch even when another branch is checked out", async () => {
    const repo = await makeRepo();
    const mainSha = await git(repo, "rev-parse", "main");
    // Park the main checkout on a diverged side branch — the trap that used to
    // make tasks base off one branch and merge into another.
    await git(repo, "checkout", "-b", "side");
    const sideSha = await commitFile(repo, "side.txt", "side\n");
    const taskId = uid();

    const wt = await ensureWorktree(repo, taskId, "main");
    expect(wt!.baseSha).toBe(mainSha);
    expect(await git(wt!.path, "rev-parse", "HEAD")).toBe(mainSha);
    expect(await git(wt!.path, "rev-parse", "HEAD")).not.toBe(sideSha);
    // The main repo stays parked on its side branch.
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("side");
  });

  it("falls back to HEAD when the configured branch does not exist", async () => {
    const repo = await makeRepo();
    await git(repo, "checkout", "-b", "side");
    const sideSha = await commitFile(repo, "side.txt", "side\n");

    // Misconfigured project (or a fresh repo whose default branch is named
    // differently): current HEAD is the only sane base.
    const wt = await ensureWorktree(repo, uid(), "no-such-branch");
    expect(wt!.baseSha).toBe(sideSha);
    expect(await git(wt!.path, "rev-parse", "HEAD")).toBe(sideSha);
  });

  it("is idempotent — a second call reuses the existing worktree", async () => {
    const { repo, taskId, wt } = await makeRepoWithWorktree(ensureWorktree);
    const again = await ensureWorktree(repo, taskId);
    expect(again).toEqual(wt);
  });

  it("re-attaches to a surviving branch when the worktree dir was lost", async () => {
    const { repo, taskId, wt } = await makeRepoWithWorktree(ensureWorktree);
    const tip = await commitFile(wt.path, "work.txt", "work\n");
    // Simulate the dir vanishing (machine cleanup) while the branch survives.
    await git(repo, "worktree", "remove", "--force", wt.path);
    expect(await git(repo, "rev-parse", `refs/heads/${wt.branch}`)).toBe(tip);

    const again = await ensureWorktree(repo, taskId);
    expect(again!.path).toBe(wt.path);
    expect(await git(again!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
    expect(await git(again!.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("initializes a non-git directory (greenfield project) before isolating", async () => {
    const dir = tmpDir("greenfield-");
    writeFile(dir, "app.js", "console.log('hi')\n");

    const wt = await ensureWorktree(dir, uid());
    expect(wt).not.toBeNull();
    expect(await isGitRepo(dir)).toBe(true);
    // Baseline commit captured the existing file and a default .gitignore.
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(wt!.path, "app.js"))).toBe(true);
    expect(await git(dir, "log", "--format=%s")).toBe("Initial project state (calandria)");
  });

  it("makes a baseline commit in a repo with no commits", async () => {
    const dir = tmpDir("empty-repo-");
    await git(dir, "init", "-b", "main");
    writeFile(dir, "notes.md", "hello\n");

    const wt = await ensureWorktree(dir, uid());
    expect(wt).not.toBeNull();
    expect(wt!.baseSha).toBe(await git(dir, "rev-parse", "HEAD"));
    expect(fs.existsSync(path.join(wt!.path, "notes.md"))).toBe(true);
  });
});

// Issue #44: ensureWorktree fails CLOSED, which is right — but a bare "Could
// not prepare an isolated worktree: fatal: …" with nothing to click is a dead
// end, and a scheduled run in that state settles `failed` every morning. Each
// case below pins one classification and, where a repair can act, that it
// actually recovers the task rather than just claiming to.
describe("worktree prep failures — classification", () => {
  it("reads a crashed git's leftover lock as recoverable", () => {
    const d = classifyWorktreePrep(
      "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\n" +
        "Another git process seems to be running in this repository, e.g. an editor opened by 'git commit'."
    );
    expect(d.kind).toBe("stale_lock");
    expect(d.recoverable).toBe(true);
    expect(d.hint).not.toBe("");
  });

  it("reads a worktree registered at a directory that's gone as recoverable", () => {
    const d = classifyWorktreePrep(
      "fatal: '/w/abc' is a missing but already registered worktree;\nuse 'add -f' to override, or 'prune' or 'remove' to clear"
    );
    expect(d.kind).toBe("stale_registration");
    expect(d.recoverable).toBe(true);
  });

  it("reads a full disk as a full disk even when it surfaces as a failed lock write", () => {
    // Ordering matters: ENOSPC kills the very lock-file write git was making,
    // so a "stale lock" read here would offer a repair that deletes a lock
    // nothing left behind and then fails identically.
    const raw = "fatal: Unable to create '/repo/.git/index.lock': No space left on device";
    const d = classifyWorktreePrep(raw);
    expect(d.kind).toBe("disk_full");
    expect(d.recoverable).toBe(false);
    // Explained on the transcript, but with no button: the disk is the fix.
    const notice = worktreePrepNotice(`${WORKTREE_PREP_PREFIX}: ${raw}`);
    expect(notice).toBe(d.hint);
    expect(notice).not.toContain(WORKTREE_REPAIR_NOTICE);
  });

  it("reads a detached HEAD as unrecoverable — repairing bookkeeping wouldn't touch it", () => {
    const d = classifyWorktreePrep("fatal: You are in a detached HEAD state");
    expect(d.kind).toBe("detached_head");
    expect(d.recoverable).toBe(false);
  });

  it("leaves anything unrecognised with its own error text and no hint", () => {
    const d = classifyWorktreePrep("fatal: could not read Username for 'https://example.com': terminal prompts disabled");
    expect(d.kind).toBe("unknown");
    expect(d.recoverable).toBe(false);
    expect(d.hint).toBe("");
    expect(worktreePrepNotice("fatal: something nobody has seen before")).toBeNull();
  });

  it("offers the repair only on a PREP failure, not on the agent's own git output", () => {
    // A turn dies with git output in it all the time — a Bash call inside the
    // worktree hitting the same lock. That failure has nothing to do with
    // preparing the checkout, and re-cutting it is the wrong advice.
    const fromTheAgent = "Another git process seems to be running in this repository";
    expect(worktreePrepNotice(fromTheAgent)).toBeNull();
    expect(worktreePrepNotice(`${WORKTREE_PREP_PREFIX}: ${fromTheAgent}`)).toContain(WORKTREE_REPAIR_NOTICE);
  });
});

describe("repairWorktree", () => {
  it("classifies, then recovers, a worktree whose directory is gone but whose registration isn't", async () => {
    const { repo, taskId, wt } = await makeRepoWithWorktree(ensureWorktree);
    const tip = await commitFile(wt.path, "work.txt", "work\n");
    // The dir deleted out from under git (external cleanup, a full disk being
    // reclaimed) WITHOUT `git worktree remove`: the registration survives, and
    // git then refuses both the path and the branch.
    fs.rmSync(wt.path, { recursive: true, force: true });

    const err = await ensureWorktree(repo, taskId).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreePrepError);
    const prep = err as WorktreePrepError;
    expect(prep.kind).toBe("stale_registration");
    expect(prep.recoverable).toBe(true);
    expect(prep.message).toContain(WORKTREE_PREP_PREFIX);
    // The line the user actually reads carries the button.
    expect(worktreePrepNotice(prep.message)).toContain(WORKTREE_REPAIR_NOTICE);

    const repaired = await repairWorktree(repo, taskId);
    expect(repaired.worktree!.path).toBe(wt.path);
    expect(repaired.worktree!.branch).toBe(wt.branch);
    // Recovery, not amnesia: the branch and its commits are what came back.
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  });

  it("clears a leftover lock in the task's own admin dir without waiting", async () => {
    // Nothing but this task owns that directory, and no turn is running (the
    // route refuses), so a lock there is stale by definition.
    const { repo, taskId, wt } = await makeRepoWithWorktree(ensureWorktree);
    const lock = path.join(repo, ".git", "worktrees", taskId, "index.lock");
    fs.writeFileSync(lock, "");

    const repaired = await repairWorktree(repo, taskId);
    expect(fs.existsSync(lock)).toBe(false);
    expect(repaired.actions.join(" ")).toContain("index.lock");
    expect(repaired.worktree!.path).toBe(wt.path);
  });

  it("classifies a crashed git's index.lock, and clears it only once it's certainly abandoned", async () => {
    const dir = tmpDir("locked-repo-");
    await git(dir, "init", "-b", "main");
    writeFile(dir, "notes.md", "hello\n");
    const lock = path.join(dir, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    const taskId = uid();

    const err = await ensureWorktree(dir, taskId).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreePrepError);
    expect((err as WorktreePrepError).kind).toBe("stale_lock");
    expect((err as WorktreePrepError).recoverable).toBe(true);

    // Seconds old: it may belong to a `git add` running in the user's own
    // checkout this instant, so the repair leaves it — and fails the same way,
    // which is the honest answer.
    await expect(repairWorktree(dir, taskId)).rejects.toBeInstanceOf(WorktreePrepError);
    expect(fs.existsSync(lock)).toBe(true);

    // Older than any index write could be: whatever held it is dead.
    const abandoned = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lock, abandoned, abandoned);
    const repaired = await repairWorktree(dir, taskId);
    expect(fs.existsSync(lock)).toBe(false);
    expect(repaired.worktree).not.toBeNull();
    expect(fs.existsSync(path.join(repaired.worktree!.path, "notes.md"))).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory, registration and branch", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await removeWorktree(repo, wt.path, wt.branch);

    expect(fs.existsSync(wt.path)).toBe(false);
    expect(await git(repo, "worktree", "list")).not.toContain(wt.path);
    await expect(git(repo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
  });

  it("falls back to prune + branch delete when the worktree dir is already gone", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    // Simulate the dir being deleted out from under git (external cleanup): the
    // registration goes stale, so `git worktree remove` errors and the catch
    // branch (rmSync + prune) is what actually cleans up.
    fs.rmSync(wt.path, { recursive: true, force: true });

    await removeWorktree(repo, wt.path, wt.branch);
    expect(await git(repo, "worktree", "list")).not.toContain(wt.path);
    await expect(git(repo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
  });

  it("never throws, even with bogus inputs", async () => {
    const repo = await makeRepo();
    await expect(removeWorktree(repo, "/nonexistent/worktree", "no-such-branch")).resolves.toBeUndefined();
    await expect(removeWorktree(repo, "", "")).resolves.toBeUndefined();
    await expect(removeWorktree("/not/a/repo", "/nonexistent/worktree", "x")).resolves.toBeUndefined();
  });
});

describe("worktreePruneSafety", () => {
  const safetyOf = (repo: string, wt: { path: string; branch: string }) =>
    worktreePruneSafety({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main" });

  it("a clean, fully-merged worktree is safe to prune", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    const res = await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
    expect(res.ok).toBe(true);

    const safety = await safetyOf(repo, wt);
    expect(safety).toMatchObject({ safe: true, isDirty: false, ahead: 0 });
  });

  it("flags uncommitted changes made after a merge as unsafe", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
    // Round-2 edit left uncommitted — force-remove would silently discard it.
    writeFile(wt.path, "feature.txt", "round two edit\n");

    const safety = await safetyOf(repo, wt);
    expect(safety.safe).toBe(false);
    expect(safety.isDirty).toBe(true);
    expect(safety.reason).toBeTruthy();
  });

  it("flags committed-but-unmerged commits made after a merge as unsafe", async () => {
    const { repo, wt } = await makeRepoWithWorktree(ensureWorktree);
    await commitFile(wt.path, "feature.txt", "feature\n", "task commit");
    await mergeTask({ repoPath: repo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: "land" });
    // Round-2 commit never merged — branch -D would orphan it.
    await commitFile(wt.path, "feature.txt", "round two\n", "round two commit");

    const safety = await safetyOf(repo, wt);
    expect(safety.safe).toBe(false);
    expect(safety.ahead).toBe(1);
    expect(safety.reason).toContain("main");
  });

  it("treats a missing worktree path as safe (nothing to lose)", async () => {
    const repo = await makeRepo();
    const safety = await worktreePruneSafety({ repoPath: repo, worktreePath: "", workBranch: "", baseBranch: "main" });
    expect(safety).toMatchObject({ safe: true, isDirty: false, ahead: 0 });
  });
});

describe("commitWorktree", () => {
  it("returns false when there is nothing to commit", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    expect(await commitWorktree(wt.path, "noop")).toBe(false);
  });

  it("stages and commits all changes (modified + untracked)", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "file.txt", "changed\n");
    writeFile(wt.path, "new-dir/new.txt", "new\n");

    expect(await commitWorktree(wt.path, "task work")).toBe(true);
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(wt.path, "log", "-1", "--format=%s")).toBe("task work");
  });

  it("commits with a fallback identity when none is configured", async () => {
    const { wt } = await makeRepoWithWorktree(ensureWorktree);
    writeFile(wt.path, "file.txt", "no identity\n");

    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = NULL_DEVICE; // strip the test identity
    try {
      expect(await commitWorktree(wt.path, "identity-less commit")).toBe(true);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
    expect(await git(wt.path, "log", "-1", "--format=%s")).toBe("identity-less commit");
  });
});
