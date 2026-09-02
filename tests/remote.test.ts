import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ensureWorktree, remoteBaseStatus, advanceBaseBranch, pushBaseBranch, prRequiredMessage, baseRemote, fetchBase, mergeTask, prepareWorktreeMerge, worktreeSyncStatus } from "../lib/git";
import { git, uid, commitFile, makeRepo, makeRepoWithOrigin, pushFromColleague } from "./helpers";
import { onPosix } from "./platform";

describe("ensureWorktree — remote-aware base", () => {
  it("branches from the fetched remote tip when the local base branch is behind", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const remoteSha = await pushFromColleague(colleague, "remote.txt", "landed on origin\n");

    const wt = await ensureWorktree(repo, uid(), "main");

    expect(wt?.baseSha).toBe(remoteSha);
    expect(fs.existsSync(path.join(wt!.path, "remote.txt"))).toBe(true);
  });

  it("keeps the local base branch when it has diverged from the remote", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    const localSha = await commitFile(repo, "local.txt", "not pushed yet\n", "local only");

    const wt = await ensureWorktree(repo, uid(), "main");

    expect(wt?.baseSha).toBe(localSha);
    expect(fs.existsSync(path.join(wt!.path, "remote.txt"))).toBe(false);
  });

  it("leaves the local base branch untouched when it branches from the remote tip", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const before = await git(repo, "rev-parse", "main");
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");

    await ensureWorktree(repo, uid(), "main");

    expect(await git(repo, "rev-parse", "main")).toBe(before);
  });

  it("gives the task branch no upstream, so a stray push can't target the base branch", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");

    const wt = await ensureWorktree(repo, uid(), "main");

    const upstream = await git(repo, "config", "--get", `branch.${wt!.branch}.merge`).catch(() => "");
    expect(upstream).toBe("");
  });

  it("still cuts a worktree when the remote is unreachable", async () => {
    const { repo, origin, colleague } = await makeRepoWithOrigin();
    const localSha = await git(repo, "rev-parse", "main");
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    fs.rmSync(origin, { recursive: true, force: true });

    const wt = await ensureWorktree(repo, uid(), "main");

    expect(wt?.baseSha).toBe(localSha);
  });

  it("keeps a reattached task's historical base instead of moving it to a newer tip", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const taskId = uid();
    const wt = (await ensureWorktree(repo, taskId, "main"))!;
    await commitFile(wt.path, "task.txt", "the task's own work\n", "task work");
    // The worktree dir is reclaimed (the "prune merged worktrees" cleanup keeps
    // the branch), and meanwhile the remote moves on.
    await git(repo, "worktree", "remove", "--force", wt.path);
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");

    const again = (await ensureWorktree(repo, taskId, "main"))!;

    expect(again.baseSha).toBe(wt.baseSha);
  });

  it("reuses one fetch for tasks launched back to back", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await ensureWorktree(repo, uid(), "main");
    // Lands after the first fetch; the cooldown means the second launch does
    // not see it, which is the cost of not fetching once per task.
    const remoteSha = await pushFromColleague(colleague, "remote.txt", "landed on origin\n");

    const second = await ensureWorktree(repo, uid(), "main");

    expect(second?.baseSha).not.toBe(remoteSha);
  });
});

describe("baseRemote", () => {
  it("follows the base branch's configured upstream", async () => {
    const { repo } = await makeRepoWithOrigin();
    expect(await baseRemote(repo, "main")).toMatchObject({ remote: "origin", remoteBranch: "main", label: "origin/main" });
  });

  it("is null for a repo with no remote, so everything stays local", async () => {
    expect(await baseRemote(await makeRepo(), "main")).toBeNull();
  });

  it("rejects a base branch name that could be read as a git flag", async () => {
    const { repo } = await makeRepoWithOrigin();
    expect(await baseRemote(repo, "--upload-pack=touch /tmp/pwned")).toBeNull();
  });
});

describe("remoteBaseStatus", () => {
  it("reports how far the local base branch is behind the remote", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "a.txt", "one\n");
    await pushFromColleague(colleague, "b.txt", "two\n");
    await fetchBase(repo, "main");

    const st = await remoteBaseStatus(repo, "main");

    expect(st).toMatchObject({ hasRemote: true, behind: 2, ahead: 0, diverged: false, canFastForward: true });
  });

  it("reports a diverged base branch without offering a one-click move", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "a.txt", "one\n");
    await commitFile(repo, "local.txt", "mine\n", "local only");
    await fetchBase(repo, "main");

    const st = await remoteBaseStatus(repo, "main");

    expect(st).toMatchObject({ behind: 1, ahead: 1, diverged: true, canFastForward: false });
  });

  it("says there is no remote for a purely local repo", async () => {
    expect(await remoteBaseStatus(await makeRepo(), "main")).toMatchObject({ hasRemote: false, behind: 0 });
  });
});

describe("advanceBaseBranch", () => {
  it("fast-forwards the local base branch to the remote tip", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const remoteSha = await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    await fetchBase(repo, "main");

    const res = await advanceBaseBranch(repo, "main", remoteSha);

    expect(res.ok).toBe(true);
    expect(await git(repo, "rev-parse", "main")).toBe(remoteSha);
  });

  it("updates the checked-out working tree, not just the ref", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const remoteSha = await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    await fetchBase(repo, "main");

    await advanceBaseBranch(repo, "main", remoteSha);

    expect(fs.existsSync(path.join(repo, "remote.txt"))).toBe(true);
  });

  it("refuses to move a base branch that has local commits of its own", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const remoteSha = await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    const localSha = await commitFile(repo, "local.txt", "mine\n", "local only");
    await fetchBase(repo, "main");

    const res = await advanceBaseBranch(repo, "main", remoteSha);

    expect(res.ok).toBe(false);
    expect(await git(repo, "rev-parse", "main")).toBe(localSha);
  });
});

describe("mergeTask — landing a task cut from the remote tip", () => {
  // A task branched from origin/main carries the remote's commits as well as its
  // own. Fast-forwarding the base past those first keeps the merge honest.
  async function taskAheadOfLocalMain() {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "a\nb\nc\nd\ne\n");
    const wt = (await ensureWorktree(repo, uid(), "main"))!;
    await commitFile(wt.path, "task.txt", "just the one line\n", "task work");
    return { repo, wt };
  }

  it("brings the remote's commits into the base branch", async () => {
    const { repo, wt } = await taskAheadOfLocalMain();

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "main", message: "merge the task", baseSha: wt.baseSha,
    });

    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, "remote.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "task.txt"))).toBe(true);
  });

  it("counts only the task's own lines, not the remote commits it rode in on", async () => {
    const { repo, wt } = await taskAheadOfLocalMain();

    const res = await mergeTask({
      repoPath: repo, worktreePath: wt.path, workBranch: wt.branch,
      baseBranch: "main", message: "merge the task", baseSha: wt.baseSha,
    });

    expect(res.additions).toBe(1);
  });
});

describe("pushBaseBranch", () => {
  it("publishes local base-branch commits to the remote", async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    const localSha = await commitFile(repo, "local.txt", "mine\n", "local only");

    const res = await pushBaseBranch(repo, "main");

    expect(res.ok).toBe(true);
    expect(await git(origin, "rev-parse", "main")).toBe(localSha);
  });

  it("reports a rejected push instead of throwing", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushFromColleague(colleague, "remote.txt", "landed on origin\n");
    await commitFile(repo, "local.txt", "mine\n", "local only");

    const res = await pushBaseBranch(repo, "main");

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("says there is nowhere to push for a repo with no remote", async () => {
    const res = await pushBaseBranch(await makeRepo(), "main");
    expect(res.ok).toBe(false);
  });

  it("refuses before touching the network when the base branch only takes pull requests", async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    const originTip = await git(origin, "rev-parse", "main");
    await commitFile(repo, "local.txt", "mine\n", "local only");

    const res = await pushBaseBranch(repo, "main", { prRequired: true });

    expect(res).toMatchObject({ ok: false, prRequired: true, error: prRequiredMessage("main") });
    // The point of the preflight: the remote was never asked.
    expect(await git(origin, "rev-parse", "main")).toBe(originTip);
  });

  // The project's landing policy can be wrong or simply not set yet, so the
  // remote still gets the last word — and GH006 is not a sentence to show anyone.
  onPosix("turns a protected-branch rejection into the same sentence, keeping the forge's words as detail", async () => {
    const { repo, origin } = await makeRepoWithOrigin();
    // tests/setup.ts points core.hooksPath at the null device for the whole
    // suite; re-enable hooks for THIS bare repo only, since standing in for the
    // forge's refusal is the entire fixture.
    await git(origin, "config", "core.hooksPath", path.join(origin, "hooks"));
    const hook = path.join(origin, "hooks", "pre-receive");
    fs.writeFileSync(
      hook,
      [
        "#!/bin/sh",
        'echo "error: GH006: Protected branch update failed for refs/heads/main." 1>&2',
        'echo "error: Changes must be made through a pull request." 1>&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    fs.chmodSync(hook, 0o755);
    await commitFile(repo, "local.txt", "mine\n", "local only");

    const res = await pushBaseBranch(repo, "main");

    expect(res).toMatchObject({ ok: false, prRequired: true, error: prRequiredMessage("main") });
    expect(res.error).not.toMatch(/GH006/);
    expect(res.detail).toContain("GH006");
  });
});

// The bug: `pr-workflow` existed as refs/remotes/origin/pr-workflow and nowhere
// else, because nobody in this checkout had ever asked for it. Every base-branch
// check goes through the local-only `branchExists`, so the cut silently fell back
// to HEAD, the sync banner said "in sync", and the first honest answer came from
// Fix with AI: "base branch pr-workflow not found".
describe("ensureWorktree — a base branch that exists only on the remote", () => {
  const pushBranch = async (colleague: string, branch: string) => {
    await git(colleague, "checkout", "-b", branch);
    await commitFile(colleague, `${branch}.txt`, "on the tag branch\n", `${branch}: first`);
    await git(colleague, "push", "origin", branch);
    return git(colleague, "rev-parse", "HEAD");
  };

  it("materialises it as a tracked local branch and cuts from its tip", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    const tip = await pushBranch(colleague, "pr-workflow");
    // The premise: no local ref for it at all.
    await expect(git(repo, "rev-parse", "--verify", "refs/heads/pr-workflow")).rejects.toThrow();

    const wt = await ensureWorktree(repo, uid(), "pr-workflow");

    expect(await git(repo, "rev-parse", "refs/heads/pr-workflow")).toBe(tip);
    expect(await git(repo, "config", "--get", "branch.pr-workflow.remote")).toBe("origin");
    // ...and the cut used it, rather than falling back to the checkout's HEAD.
    expect(wt?.baseBranch).toBe("pr-workflow");
    expect(wt?.baseSha).toBe(tip);
    expect(fs.existsSync(path.join(wt!.path, "pr-workflow.txt"))).toBe(true);
  });

  it("lets prepareWorktreeMerge run — the Fix-with-AI path that used to refuse", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushBranch(colleague, "pr-workflow");
    const wt = await ensureWorktree(repo, uid(), "pr-workflow");
    await commitFile(wt!.path, "task.txt", "task work\n", "task edit");
    // The base moves on, the way it does while a task is in flight.
    await commitFile(colleague, "base.txt", "base moved\n", "pr-workflow: second");
    await git(colleague, "push", "origin", "pr-workflow");
    await git(repo, "fetch", "origin", "pr-workflow:pr-workflow");

    const res = await prepareWorktreeMerge({
      repoPath: repo,
      worktreePath: wt!.path,
      baseBranch: "pr-workflow",
      message: "sync base",
    });

    expect(res).toEqual({ ok: true, clean: true, conflicts: [], binaryConflicts: [] });
    expect(fs.existsSync(path.join(wt!.path, "base.txt"))).toBe(true);
  });

  it("reports a real sync status for it instead of a silent 'in sync'", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await pushBranch(colleague, "pr-workflow");
    const wt = await ensureWorktree(repo, uid(), "pr-workflow");
    await commitFile(wt!.path, "task.txt", "task work\n", "task edit");
    await commitFile(colleague, "base.txt", "base moved\n", "pr-workflow: second");
    await git(colleague, "push", "origin", "pr-workflow");
    await git(repo, "fetch", "origin", "pr-workflow:pr-workflow");

    const st = await worktreeSyncStatus({
      repoPath: repo,
      worktreePath: wt!.path,
      workBranch: wt!.branch,
      baseBranch: "pr-workflow",
    });

    expect(st.baseMissing).toBeUndefined();
    expect(st.behind).toBe(1);
    expect(st.ahead).toBe(1);
  });

  it("still falls back to HEAD when the branch is nowhere at all", async () => {
    const { repo } = await makeRepoWithOrigin();
    const wt = await ensureWorktree(repo, uid(), "never-existed");
    expect(wt?.baseBranch).toBe("");
    expect(wt?.baseSha).toBe(await git(repo, "rev-parse", "HEAD"));
  });
});
