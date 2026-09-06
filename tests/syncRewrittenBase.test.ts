import { describe, it, expect } from "vitest";
import {
  ensureWorktree,
  worktreeSyncStatus,
  fastForwardWorktree,
  fetchBase,
  remoteBaseStatus,
} from "../lib/git";
import { git, commitFile, makeRepoWithOrigin } from "./helpers";

/**
 * The incident this reproduces: a task is cut from an integration branch, a
 * LANDING task rebases that branch onto main in a scratch checkout and
 * force-pushes it, and the first task's worktree is left pinned to the
 * pre-rewrite tip. Nothing in Calandria notices, and the eventual hand-run
 * `git merge` reconciles two histories that hold the same content under
 * different SHAs.
 */

/** Builds origin/main + origin/integration, a task worktree cut from integration. */
async function cutTaskFromIntegration() {
  const { origin, repo, colleague } = await makeRepoWithOrigin();

  // The integration branch, with one commit of real work in it.
  await git(colleague, "checkout", "-b", "integration");
  await commitFile(colleague, "shared.txt", "deslopped\n", "deslop shared.txt");
  await git(colleague, "push", "-u", "origin", "integration");

  // A task is cut from it. This is the pre-rewrite tip (the incident's 09bec28).
  await git(repo, "fetch", "origin");
  const wt = await ensureWorktree(repo, "task1", "integration");
  if (!wt) throw new Error("no worktree");
  const preRewriteTip = await git(repo, "rev-parse", "integration");

  return { origin, repo, colleague, wt, preRewriteTip };
}

/** The landing task's work: rebase integration onto a moved main, force-push. */
async function rebaseAndForcePush(colleague: string) {
  // main moved on while the integration branch sat there.
  await git(colleague, "checkout", "main");
  await commitFile(colleague, "shared.txt", "landed on main\n", "main touches shared.txt");
  await git(colleague, "push", "origin", "main");

  // Rebase integration onto the new main, resolving the overlap in main's
  // favour plus the branch's own change. Same intent, brand new SHA.
  await git(colleague, "checkout", "integration");
  const rebase = await git(colleague, "rebase", "main").catch((e) => String(e));
  if (String(rebase).includes("CONFLICT") || String(rebase).includes("Error")) {
    await git(colleague, "checkout", "--theirs", "shared.txt").catch(() => {});
  }
  await commitFile(colleague, "shared.txt", "landed on main + deslopped\n", "rebased deslop");
  await git(colleague, "rebase", "--continue").catch(() => {});
  await git(colleague, "push", "--force", "origin", "integration");
  return await git(colleague, "rev-parse", "integration");
}

describe("a task whose base branch is rewritten upstream", () => {
  it("reports a flat 'in sync' when the local base ref never saw the force-push", async () => {
    const { repo, colleague, wt, preRewriteTip } = await cutTaskFromIntegration();
    const postRewriteTip = await rebaseAndForcePush(colleague);
    expect(postRewriteTip).not.toBe(preRewriteTip);

    // What the Sync button reads: GET /api/tasks/[id]/sync -> worktreeSyncStatus.
    const st = await worktreeSyncStatus({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "integration",
    });
    console.log("[no-fetch] status:", JSON.stringify(st));

    // The whole finding: every number is zero, so the banner renders nothing.
    expect(st.behind).toBe(0);
    expect(st.ahead).toBe(0);
    expect(st.baseMissing).toBeUndefined();

    // And a fetch does not change it: fetchBase only writes the tracking ref.
    // Forced, because ensureWorktree's own fetch a moment ago left the per-repo
    // cooldown warm — which is itself a way the rewrite stays unseen.
    await fetchBase(repo, "integration", { force: true });
    const after = await worktreeSyncStatus({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "integration",
    });
    console.log("[post-fetch] status:", JSON.stringify(after));
    expect(after.behind).toBe(0);
    expect(after.ahead).toBe(0);

    // Meanwhile the remote-vs-local comparison KNOWS. Nothing asks it for a
    // non-default base branch.
    const remote = await remoteBaseStatus(repo, "integration");
    console.log("[remoteBaseStatus] :", JSON.stringify(remote));
    expect(remote.diverged).toBe(true);
  });

  it("still reports baseRewritten: false while the local base ref hasn't moved — the remote comparison is what catches this variant", async () => {
    const { repo, colleague, wt, preRewriteTip } = await cutTaskFromIntegration();
    await rebaseAndForcePush(colleague);

    // No `git fetch` / no local ref update — same starting point as the first
    // test. baseSha is still an ancestor of the (unmoved) local integration,
    // so the ancestry test alone has nothing to flag.
    const st = await worktreeSyncStatus({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "integration",
      baseSha: preRewriteTip,
    });
    console.log("[no-fetch, baseSha set] baseRewritten:", st.baseRewritten);
    expect(st.baseRewritten).toBe(false);
  });

  it("offers an ordinary merge, not a rebase, once the local base ref does catch up", async () => {
    const { repo, colleague, wt, preRewriteTip } = await cutTaskFromIntegration();
    await rebaseAndForcePush(colleague);

    // The user (or a later `git fetch` + reset) brings the local ref across.
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    const st = await worktreeSyncStatus({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "integration",
      baseSha: preRewriteTip,
    });
    console.log("[caught-up] status:", JSON.stringify(st));

    // Both sides now carry the same work under different SHAs, so the task
    // reads as simultaneously behind AND ahead. That is a rewrite, and the
    // status has no way to say so.
    console.log(
      "[caught-up] behind:", st.behind,
      "ahead:", st.ahead,
      "clean:", st.clean,
      "conflicts:", st.conflicts.length
    );
    expect(st.behind).toBeGreaterThan(0);
    expect(st.ahead).toBeGreaterThan(0);
    expect(st.baseRewritten).toBe(true);

    const ff = await fastForwardWorktree(wt.path, "integration");
    console.log("[caught-up] fastForwardWorktree ->", ff);
    expect(ff).toBe(false);
  });

  it("reports baseRewritten: false for an ordinary forward-moving base — the regression guard against firing on normal movement", async () => {
    const { repo, colleague, wt, preRewriteTip } = await cutTaskFromIntegration();

    // A colleague pushes a new commit onto integration with no rewrite at all.
    await git(colleague, "checkout", "integration");
    await commitFile(colleague, "shared.txt", "deslopped further\n", "another ordinary commit");
    await git(colleague, "push", "origin", "integration");

    // The local ref fast-forwards to it.
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    const st = await worktreeSyncStatus({
      repoPath: repo,
      worktreePath: wt.path,
      workBranch: wt.branch,
      baseBranch: "integration",
      baseSha: preRewriteTip,
    });
    console.log("[forward-moved] behind:", st.behind, "baseRewritten:", st.baseRewritten);
    expect(st.behind).toBeGreaterThan(0);
    expect(st.baseRewritten).toBe(false);
  });
});
