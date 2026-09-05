// Per-task base branches: the resolver, its SQL twin, the pin at the cut, the
// refusals, and what a retarget does to a worktree that already exists.
// See docs/FEATURES.md.

import { describe, expect, it } from "vitest";
import { POST as baseBranchRoute } from "../app/api/tasks/[id]/base-branch/route";
import { hasOwnBase, resolveBaseBranch, retargetTaskBase } from "../lib/baseBranch";
import { ensureWorktree, prepareWorktreeMerge, worktreeMergeStatus } from "../lib/git";
import { createProject, createTag, createTask, getTask, listReclaimableWorktrees, setTaskTags, updateTask } from "../lib/store";
import { commitFile, git, makeRepo, makeRepoWithOrigin, uid, writeFile } from "./helpers";

/** A project + task with a real repo behind it, optionally already cut. */
async function fixture(opts: { branch?: string; cut?: boolean; repo?: string } = {}) {
  const repo = opts.repo ?? (await makeRepo());
  const project = createProject({ name: `base-${uid()}`, repo_path: repo, branch: opts.branch ?? "main" });
  const task = createTask({ project_id: project.id, title: "a task" });
  if (opts.cut) {
    const wt = await ensureWorktree(repo, task.id, resolveBaseBranch(task, project));
    if (!wt) throw new Error("ensureWorktree returned null in fixture");
    updateTask(task.id, {
      started: 1, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
      ...(wt.baseBranch ? { base_branch: wt.baseBranch } : {}),
    });
  }
  return { repo, project, task: getTask(task.id)!, reload: () => getTask(task.id)! };
}

const retarget = async (fx: Awaited<ReturnType<typeof fixture>>, branch: string) =>
  retargetTaskBase(fx.reload(), fx.project, branch);

describe("resolveBaseBranch", () => {
  it("prefers the task's own base and falls back to the project's default", () => {
    const project = { branch: "main" };
    // id "" carries no tags, so these exercise the first and last legs alone.
    expect(resolveBaseBranch({ id: "", base_branch: "" }, project)).toBe("main");
    expect(resolveBaseBranch({ id: "", base_branch: "feature/auth" }, project)).toBe("feature/auth");
  });

  it("reports a base of its own only when it actually differs from the default", () => {
    const project = { branch: "main" };
    expect(hasOwnBase({ id: "", base_branch: "" }, project)).toBe(false);
    // Pinned at the cut, so a task following the default still carries the
    // name; the badge that reads "own base" must not fire on that.
    expect(hasOwnBase({ id: "", base_branch: "main" }, project)).toBe(false);
    expect(hasOwnBase({ id: "", base_branch: "release" }, project)).toBe(true);
  });

  // The resolution order is expressed twice: once in TS above, once as SQL in
  // listReclaimableWorktrees, which has no Task in hand. The two must agree,
  // or the Settings → Storage sweep would judge whether a worktree is safe to
  // delete against a branch the task was never on.
  //
  // All three legs matter: the tag leg is a lookup through task_tags ordered
  // by position, unlike the other two plain COALESCE columns, so it can drift
  // from the TS version in both the value it picks and the order it considers.
  it("agrees with the COALESCE in listReclaimableWorktrees", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "release");
    await git(repo, "branch", "feature/auth");
    const inherits = await fixture({ repo, cut: true });
    const own = await fixture({ repo, cut: true });
    await retarget(own, "release");

    // A worktree carrying no base of its own takes the middle leg. Of the
    // three tags, two name a branch; the first in tag order wins, and the
    // SQL has to express that tie-break too.
    const tagged = await fixture({ repo, cut: true });
    const untargeted = createTag({ project_id: tagged.project.id, name: `plain-${uid()}` });
    const auth = createTag({ project_id: tagged.project.id, name: `auth-${uid()}`, base_branch: "feature/auth" });
    const rel = createTag({ project_id: tagged.project.id, name: `rel-${uid()}`, base_branch: "release" });
    setTaskTags([tagged.task.id], [untargeted.id, auth.id, rel.id]);
    updateTask(tagged.task.id, { base_branch: "" });

    for (const fx of [inherits, own, tagged]) updateTask(fx.task.id, { status: "done" });

    const rows = listReclaimableWorktrees();
    const sqlBase = (id: string) => rows.find((r) => r.id === id)!.base_branch;
    expect(sqlBase(inherits.task.id)).toBe(resolveBaseBranch(inherits.reload(), inherits.project));
    expect(sqlBase(inherits.task.id)).toBe("main");
    expect(sqlBase(own.task.id)).toBe(resolveBaseBranch(own.reload(), own.project));
    expect(sqlBase(own.task.id)).toBe("release");
    expect(sqlBase(tagged.task.id)).toBe(resolveBaseBranch(tagged.reload(), tagged.project));
    expect(sqlBase(tagged.task.id)).toBe("feature/auth");

    // Re-ordering the tags must move both: the assertion is that the two
    // implementations share one ordering, not two that happen to agree on
    // this particular fixture.
    setTaskTags([tagged.task.id], [rel.id, auth.id]);
    const reordered = listReclaimableWorktrees().find((r) => r.id === tagged.task.id)!.base_branch;
    expect(reordered).toBe(resolveBaseBranch(tagged.reload(), tagged.project));
    expect(reordered).toBe("release");
  });
});

describe("pin at the cut", () => {
  it("records the branch the worktree was actually cut from", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "release");
    const project = createProject({ name: `pin-${uid()}`, repo_path: repo, branch: "release" });
    const task = createTask({ project_id: project.id, title: "inherits release" });
    expect(task.base_branch).toBe("");

    const wt = await ensureWorktree(repo, task.id, resolveBaseBranch(task, project));
    expect(wt?.baseBranch).toBe("release");
    expect(wt?.baseSha).toBe(await git(repo, "rev-parse", "release"));
  });

  // The fallback exists so a misconfigured project can still isolate a task. It
  // must NOT be pinned: recording a branch the cut didn't use would point the
  // merge at a branch that doesn't exist.
  it("reports no base when the configured branch is missing and the cut fell back to HEAD", async () => {
    const repo = await makeRepo();
    const wt = await ensureWorktree(repo, uid(), "no-such-branch");
    expect(wt?.baseBranch).toBe("");
  });
});

describe("retargetTaskBase — refusals", () => {
  it("refuses a name git could never use", async () => {
    const fx = await fixture({ cut: true });
    const r = await retarget(fx, "--upload-pack=evil");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("isn't a usable git branch name");
    expect(fx.reload().base_branch).toBe("main");
  });

  it("refuses a branch that is nowhere — naming both places it looked", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    void colleague;
    const fx = await fixture({ repo, cut: true });
    const r = await retarget(fx, "feature/nope");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("feature/nope");
    expect(r.error).toContain("origin/feature/nope");
  });

  it("refuses a branch another worktree has checked out, and says which", async () => {
    const repo = await makeRepo();
    const mine = await fixture({ repo, cut: true });
    const theirs = await fixture({ repo, cut: true });
    const r = await retarget(mine, theirs.reload().work_branch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(theirs.reload().worktree_path);
    expect(mine.reload().base_branch).toBe("main");
  });

  it("refuses the task's own work branch", async () => {
    const fx = await fixture({ cut: true });
    const r = await retarget(fx, fx.reload().work_branch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("own work branch");
  });

  it("refuses while a merge is paused in the worktree", async () => {
    const fx = await fixture({ cut: true });
    await git(fx.repo, "branch", "release");
    await commitFile(fx.reload().worktree_path, "file.txt", "task version\n", "task edit");
    await commitFile(fx.repo, "file.txt", "main version\n", "main edit");
    // Leaves conflict markers and MERGE_HEAD in the worktree.
    const prep = await prepareWorktreeMerge({
      repoPath: fx.repo, worktreePath: fx.reload().worktree_path, baseBranch: "main", message: "sync",
    });
    expect(prep.clean).toBe(false);
    expect((await worktreeMergeStatus(fx.reload().worktree_path)).mergeInProgress).toBe(true);

    const r = await retarget(fx, "release");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("paused");
    expect(fx.reload().base_branch).toBe("main");
  });

  it("refuses a task whose turn is running", async () => {
    const fx = await fixture({ cut: true });
    await git(fx.repo, "branch", "release");
    updateTask(fx.task.id, { running: 1 });
    const r = await retarget(fx, "release");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("turn running");
    // ...unless it is the caller's own row: a session can retarget itself
    // mid-turn.
    const own = await retargetTaskBase(fx.reload(), fx.project, "release", { callerTaskId: fx.task.id });
    expect(own.ok).toBe(true);
  });
});

describe("retargetTaskBase — reconciliation", () => {
  it("writes the row and nothing else when there is no worktree yet", async () => {
    const fx = await fixture();
    await git(fx.repo, "branch", "release");
    const r = await retarget(fx, "release");
    expect(r).toMatchObject({ ok: true, baseBranch: "release", behind: 0 });
    expect(fx.reload()).toMatchObject({ base_branch: "release", worktree_path: "", base_sha: "" });
  });

  // Nothing of the task's own exists, so a re-cut loses nothing and leaves it
  // up to date with the new base, not merely pointed at it.
  it("re-cuts a clean worktree with no commits of its own", async () => {
    const fx = await fixture({ cut: true });
    await git(fx.repo, "checkout", "-b", "release");
    const releaseTip = await commitFile(fx.repo, "release.txt", "release\n", "release work");
    await git(fx.repo, "checkout", "main");

    const r = await retarget(fx, "release");
    expect(r).toMatchObject({ ok: true, baseBranch: "release", recut: true, behind: 0 });
    const after = fx.reload();
    expect(after.base_branch).toBe("release");
    expect(after.base_sha).toBe(releaseTip);
    expect(await git(after.worktree_path, "rev-parse", "HEAD")).toBe(releaseTip);
  });

  it("leaves an uncommitted edit alone rather than re-cutting over it", async () => {
    const fx = await fixture({ cut: true });
    await git(fx.repo, "checkout", "-b", "release");
    await commitFile(fx.repo, "release.txt", "release\n", "release work");
    await git(fx.repo, "checkout", "main");
    writeFile(fx.reload().worktree_path, "scratch.txt", "unsaved\n");

    const r = await retarget(fx, "release");
    expect(r).toMatchObject({ ok: true, baseBranch: "release", recut: false });
    expect(r.behind).toBeGreaterThan(0);
    // The reset never ran, so the unsaved file is still there.
    expect(await git(fx.reload().worktree_path, "status", "--porcelain")).toContain("scratch.txt");
  });

  // The Changes tab is a merge preview ("what would arrive in the base if I
  // merged now"), so base_sha becomes the merge-base and the behind-count is
  // reported, not swallowed. Nothing is rewritten.
  it("keeps a committed task's work, re-bases the diff snapshot, and reports the behind-count", async () => {
    const fx = await fixture({ cut: true });
    const cutFrom = fx.reload().base_sha;
    const taskCommit = await commitFile(fx.reload().worktree_path, "task.txt", "task\n", "task work");
    await git(fx.repo, "checkout", "-b", "release");
    await commitFile(fx.repo, "release.txt", "release\n", "release work");
    await commitFile(fx.repo, "release2.txt", "more\n", "more release work");
    await git(fx.repo, "checkout", "main");

    const r = await retarget(fx, "release");
    expect(r).toMatchObject({ ok: true, baseBranch: "release", recut: false, behind: 2 });
    expect(r.message).toContain("2 commits behind");
    const after = fx.reload();
    // The task's own commit survives untouched...
    expect(await git(after.worktree_path, "rev-parse", "HEAD")).toBe(taskCommit);
    // ...and the diff base is now the fork point the two branches share.
    expect(after.base_sha).toBe(await git(fx.repo, "merge-base", "release", after.work_branch));
    expect(after.base_sha).toBe(cutFrom);
  });

  it("creates a local branch for one that exists only on the remote, tracking it", async () => {
    const { repo, colleague } = await makeRepoWithOrigin();
    await git(colleague, "checkout", "-b", "feature/auth");
    await commitFile(colleague, "auth.ts", "export const auth = 1\n", "auth");
    await git(colleague, "push", "origin", "feature/auth");
    const fx = await fixture({ repo, cut: true });

    const r = await retarget(fx, "feature/auth");
    expect(r).toMatchObject({ ok: true, baseBranch: "feature/auth", createdFrom: "origin/feature/auth" });
    expect(r.message).toContain("Created the local branch from origin/feature/auth");
    expect(await git(repo, "rev-parse", "feature/auth")).toBe(await git(repo, "rev-parse", "origin/feature/auth"));
    expect(await git(repo, "config", "--get", "branch.feature/auth.remote")).toBe("origin");
    expect(fx.reload().base_branch).toBe("feature/auth");
  });
});

describe("POST /api/tasks/[id]/base-branch", () => {
  const post = (id: string, branch: string) =>
    baseBranchRoute(
      new Request(`http://test/api/tasks/${id}/base-branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch }),
      }),
      { params: Promise.resolve({ id }) }
    );

  it("retargets, and reports a refusal as a 409", async () => {
    const fx = await fixture({ cut: true });
    await git(fx.repo, "branch", "release");

    const ok = await post(fx.task.id, "release");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, baseBranch: "release" });
    expect(fx.reload().base_branch).toBe("release");

    const bad = await post(fx.task.id, "does-not-exist");
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toContain("does-not-exist");
    expect(fx.reload().base_branch).toBe("release");
  });

  // Clearing the field means "follow the project again", stored as "" so a
  // later change to the project's default still reaches an uncut task.
  it("clears the pin back to inherit on an empty branch", async () => {
    const fx = await fixture({ cut: true });
    await git(fx.repo, "branch", "release");
    await post(fx.task.id, "release");

    const res = await post(fx.task.id, "");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, inherited: true, baseBranch: "main" });
    expect(fx.reload().base_branch).toBe("");
    expect(resolveBaseBranch(fx.reload(), fx.project)).toBe("main");
  });
});
