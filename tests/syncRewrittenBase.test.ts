import { describe, it, expect } from "vitest";
import {
  ensureWorktree,
  worktreeSyncStatus,
  fastForwardWorktree,
  fetchBase,
  remoteBaseStatus,
  rebaseWorktreeOntoBase,
  continueWorktreeRebase,
  abortWorktreeRebase,
  worktreeRebaseStatus,
} from "../lib/git";
import { POST as syncRoute } from "../app/api/tasks/[id]/sync/route";
import { createProject, createTask, getTask, updateTask } from "../lib/store";
import { git, commitFile, makeRepoWithOrigin, uid, writeFile } from "./helpers";

/**
 * The incident this reproduces: a task is cut from an integration branch, a
 * LANDING task rebases that branch onto main in a scratch checkout and
 * force-pushes it, and the first task's worktree is left pinned to the
 * pre-rewrite tip. Nothing in Calandria notices, and the eventual hand-run
 * `git merge` reconciles two histories that hold the same content under
 * different SHAs.
 */

/** Builds origin/main + origin/integration, a task worktree cut from integration. */
async function cutTaskFromIntegration(taskId = "task1") {
  const { origin, repo, colleague } = await makeRepoWithOrigin();

  // The integration branch, with one commit of real work in it.
  await git(colleague, "checkout", "-b", "integration");
  await commitFile(colleague, "shared.txt", "deslopped\n", "deslop shared.txt");
  await git(colleague, "push", "-u", "origin", "integration");

  // A task is cut from it. This is the pre-rewrite tip (the incident's 09bec28).
  await git(repo, "fetch", "origin");
  const wt = await ensureWorktree(repo, taskId, "integration");
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
    // cooldown warm, which is itself a way the rewrite stays unseen.
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

  it("still reports baseRewritten: false while the local base ref hasn't moved, so the remote comparison is what catches this variant", async () => {
    const { repo, colleague, wt, preRewriteTip } = await cutTaskFromIntegration();
    await rebaseAndForcePush(colleague);

    // No `git fetch` and no local ref update, so the same starting point as the first
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

  it("reports baseRewritten: false for an ordinary forward-moving base, the regression guard against firing on normal movement", async () => {
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

/**
 * The remedy for the state above: replay the task's own commits onto the
 * rewritten base instead of merging the two copies together. Everything
 * interesting is around the one `git rebase --onto`, so these cover what it
 * does to uncommitted work, to a branch with an open PR, to a replay that
 * stops on a conflict, and how to get back.
 */

/** The fixture above, plus one commit of the task's own work and a DB row for it. */
async function cutTaskWithWork(opts: { touches?: string } = {}) {
  const id = uid();
  const fx = await cutTaskFromIntegration(id);
  const file = opts.touches ?? "task.txt";
  await commitFile(fx.wt.path, file, "the task's own work\n", "task work");
  const project = createProject({ name: `rewrite-${id}`, repo_path: fx.repo, branch: "main" });
  const row = createTask({ project_id: project.id, title: "based on integration" });
  updateTask(row.id, {
    started: 1, worktree_path: fx.wt.path, work_branch: fx.wt.branch,
    base_sha: fx.preRewriteTip, base_branch: "integration",
  });
  return { ...fx, project, taskId: row.id, task: () => getTask(row.id)! };
}

/** Bring the local `integration` ref across to the force-pushed tip, as a fetch + reset would. */
async function catchLocalRefUp(repo: string) {
  await git(repo, "fetch", "origin");
  await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");
}

const syncPost = (id: string, body?: Record<string, unknown>) =>
  syncRoute(
    new Request(`http://localhost/api/tasks/${id}/sync`, {
      method: "POST",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ id }) }
  );

describe("rebasing a task onto a base branch that was rewritten under it", () => {
  it("replays the task's own commits cleanly where a merge would have conflicted", async () => {
    const fx = await cutTaskWithWork(); // its work is in task.txt, the rewrite's is in shared.txt
    await rebaseAndForcePush(fx.colleague);
    await catchLocalRefUp(fx.repo);

    const before = await worktreeSyncStatus({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    // The state this whole feature is for: a rewrite, and a merge that would
    // conflict over a file the task never touched, because both sides carry
    // their own copy of the same change.
    expect(before.baseRewritten).toBe(true);
    expect(before.conflicts).toContain("shared.txt");

    const res = await rebaseWorktreeOntoBase({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    console.log("[rebase] ok:", res.ok, "clean:", res.clean, "conflicts:", res.conflicts);
    expect(res.ok).toBe(true);
    expect(res.clean).toBe(true);
    expect(res.newTip).not.toBe(res.previousTip);
    expect(res.onto).toBe(await git(fx.repo, "rev-parse", "integration"));

    // The task's work survived, and the rewritten base is now underneath it.
    expect(await git(fx.wt.path, "log", "-1", "--format=%s")).toBe("task work");
    await expect(git(fx.repo, "merge-base", "--is-ancestor", "integration", fx.wt.branch)).resolves.toBeDefined();
    // And it carries the POST-rewrite content, not the pre-rewrite copy the
    // merge would have had to reconcile.
    expect(await git(fx.wt.path, "show", "HEAD:shared.txt")).toContain("landed on main");

    // With base_sha advanced to what it replayed onto, the banner goes quiet.
    updateTask(fx.taskId, { base_sha: res.onto });
    const after = await worktreeSyncStatus({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: res.onto,
    });
    console.log("[after rebase] status:", JSON.stringify(after));
    expect(after.baseRewritten).toBe(false);
    expect(after.behind).toBe(0);
  });

  it("refuses over uncommitted work instead of sweeping it into the replay", async () => {
    const fx = await cutTaskWithWork();
    await rebaseAndForcePush(fx.colleague);
    await catchLocalRefUp(fx.repo);

    writeFile(fx.wt.path, "task.txt", "half-finished, never reviewed\n");
    const tipBefore = await git(fx.repo, "rev-parse", fx.wt.branch);

    const res = await rebaseWorktreeOntoBase({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    console.log("[dirty] ok:", res.ok, "dirty:", res.dirty, "error:", res.error);
    expect(res.ok).toBe(false);
    expect(res.dirty).toBe(true);

    // Nothing moved and nothing was committed on the user's behalf: the whole
    // point of refusing rather than doing what prepareWorktreeMerge does.
    expect(await git(fx.repo, "rev-parse", fx.wt.branch)).toBe(tipBefore);
    expect(await git(fx.wt.path, "status", "--porcelain")).toContain("task.txt");
    expect(await worktreeRebaseStatus(fx.wt.path)).toMatchObject({ rebaseInProgress: false });
  });

  it("refuses once on an open pull request, then rebases locally when the caller acknowledges it", async () => {
    const fx = await cutTaskWithWork();
    await rebaseAndForcePush(fx.colleague);
    await catchLocalRefUp(fx.repo);
    updateTask(fx.taskId, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7, pr_state: "open" });
    const tipBefore = await git(fx.repo, "rev-parse", fx.wt.branch);

    const refused = await syncPost(fx.taskId, { action: "rebase" });
    const refusedBody = await refused.json();
    console.log("[open PR] status:", refused.status, "body:", JSON.stringify(refusedBody));
    expect(refused.status).toBe(409);
    expect(refusedBody.prOpen).toBe(true);
    expect(refusedBody.prNumber).toBe(7);
    // Refused means refused: the branch is untouched, so the PR still describes it.
    expect(await git(fx.repo, "rev-parse", fx.wt.branch)).toBe(tipBefore);
    expect(await worktreeRebaseStatus(fx.wt.path)).toMatchObject({ rebaseInProgress: false });

    const ok = await syncPost(fx.taskId, { action: "rebase", acknowledgePr: true });
    const body = await ok.json();
    console.log("[open PR, acknowledged] status:", ok.status, "rebased:", body.rebased, "forcePush:", body.forcePushCommand);
    expect(ok.status).toBe(200);
    expect(body.rebased).toBe(true);
    expect(body.forcePushNeeded).toBe(true);
    expect(body.forcePushCommand).toContain("--force-with-lease");

    // The rewrite is local only. Nothing here pushes, forced or otherwise, so
    // the remote still has no copy of this branch at all.
    expect(await git(fx.repo, "ls-remote", "origin", fx.wt.branch)).toBe("");
    // And the diff base moved to what it replayed onto, so the banner stops firing.
    expect(fx.task().base_sha).toBe(await git(fx.repo, "rev-parse", "integration"));
  });

  it("leaves a stopped replay in the worktree for a resolution turn, and finishing it lands the rebase", async () => {
    // This task's own work is in the very file the rewrite rewrote, so the
    // replay cannot avoid a conflict the way the clean case above does.
    const fx = await cutTaskWithWork({ touches: "shared.txt" });
    await rebaseAndForcePush(fx.colleague);
    await catchLocalRefUp(fx.repo);

    const res = await rebaseWorktreeOntoBase({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    console.log("[conflict] ok:", res.ok, "clean:", res.clean, "conflicts:", res.conflicts);
    expect(res.ok).toBe(true);
    expect(res.clean).toBe(false);
    expect(res.conflicts).toContain("shared.txt");
    expect(res.previousTip).toBeTruthy();

    // The same shape a paused merge leaves behind: markers on disk, and a
    // status that reports the live worktree rather than the branch counts.
    const paused = await worktreeSyncStatus({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    console.log("[conflict] status:", JSON.stringify(paused));
    expect(paused.rebaseInProgress).toBe(true);
    expect(paused.mergeInProgress).toBe(false);
    expect(paused.unresolved).toContain("shared.txt");
    expect(paused.clean).toBe(false);

    // An ordinary Sync is refused while it sits there: merging on top would
    // commit a half-replayed tree full of markers.
    const refused = await syncPost(fx.taskId);
    console.log("[conflict] plain sync ->", refused.status);
    expect(refused.status).toBe(409);
    expect((await refused.json()).rebaseInProgress).toBe(true);

    // Continuing with markers still in the files is refused too.
    const early = await continueWorktreeRebase(fx.wt.path);
    console.log("[conflict] continue with markers ->", early.error);
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/conflict markers/);

    // Resolve it the way a resolution turn would: edit the file, don't commit.
    writeFile(fx.wt.path, "shared.txt", "landed on main + deslopped + the task's own work\n");
    const resolvedStatus = await worktreeSyncStatus({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    expect(resolvedStatus.rebaseInProgress).toBe(true);
    expect(resolvedStatus.clean).toBe(true); // nothing left to resolve; awaiting accept

    const done = await continueWorktreeRebase(fx.wt.path);
    console.log("[conflict] continue ->", JSON.stringify(done));
    expect(done.ok).toBe(true);
    expect(done.done).toBe(true);
    expect(await worktreeRebaseStatus(fx.wt.path)).toMatchObject({ rebaseInProgress: false });
    expect(await git(fx.wt.path, "show", "HEAD:shared.txt")).toContain("the task's own work");
    await expect(git(fx.repo, "merge-base", "--is-ancestor", "integration", fx.wt.branch)).resolves.toBeDefined();
  });

  it("aborts a stopped replay back to the pre-rebase tip", async () => {
    const fx = await cutTaskWithWork({ touches: "shared.txt" });
    await rebaseAndForcePush(fx.colleague);
    await catchLocalRefUp(fx.repo);
    const tipBefore = await git(fx.repo, "rev-parse", fx.wt.branch);

    const res = await rebaseWorktreeOntoBase({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    expect(res.clean).toBe(false);
    expect(res.previousTip).toBe(tipBefore);

    const aborted = await abortWorktreeRebase(fx.wt.path);
    console.log("[abort] ->", JSON.stringify(aborted));
    expect(aborted.ok).toBe(true);
    expect(aborted.restoredTo).toBe(tipBefore);

    // The branch, the checkout and the sync status are all back where they were.
    expect(await git(fx.repo, "rev-parse", fx.wt.branch)).toBe(tipBefore);
    expect(await git(fx.wt.path, "status", "--porcelain")).toBe("");
    expect(await git(fx.wt.path, "show", "HEAD:shared.txt")).toBe("the task's own work");
    const after = await worktreeSyncStatus({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: fx.preRewriteTip,
    });
    console.log("[abort] status:", JSON.stringify(after));
    expect(after.rebaseInProgress).toBeUndefined();
    expect(after.baseRewritten).toBe(true); // still rewritten: aborting fixes nothing, it just undoes

    // And with nothing paused, aborting again is a no-op rather than a reset
    // to a tip that no longer describes anything.
    expect(await abortWorktreeRebase(fx.wt.path)).toEqual({ ok: true, restoredTo: "" });
  });

  it("refuses when the commit the task was cut from is no longer in the repository", async () => {
    const fx = await cutTaskWithWork();
    await rebaseAndForcePush(fx.colleague);
    await catchLocalRefUp(fx.repo);

    const res = await rebaseWorktreeOntoBase({
      repoPath: fx.repo, worktreePath: fx.wt.path, workBranch: fx.wt.branch,
      baseBranch: "integration", baseSha: "",
    });
    console.log("[no cut point] ->", res.cutPointMissing, res.error);
    expect(res.ok).toBe(false);
    expect(res.cutPointMissing).toBe(true);
    // Without it there is no way to tell the task's own commits from the
    // pre-rewrite copies of the base's, so replaying would move both.
    expect(await worktreeRebaseStatus(fx.wt.path)).toMatchObject({ rebaseInProgress: false });
  });
});
