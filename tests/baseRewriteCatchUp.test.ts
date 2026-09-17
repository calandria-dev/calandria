import { describe, it, expect } from "vitest";
import { ensureWorktree } from "../lib/git";
import { flagBaseRewrite, tasksOnBase, describeSweep } from "../lib/baseRewrite";
import { reportBaseRewriteForAgent } from "../lib/agentTools";
import { GET as syncGet } from "../app/api/tasks/[id]/sync/route";
import { createProject, createTask, createTag, setTaskTags, getTask, updateTask, listMessages } from "../lib/store";
import { git, commitFile, makeRepoWithOrigin } from "./helpers";

/**
 * The landing task's last step. A task that rebases an integration branch onto
 * main and force-pushes it leaves every other task cut from that branch pinned
 * to commits that no longer exist. The sync banner detects that per task, and
 * only for the task the user has open, so a sibling says nothing until
 * somebody selects it. `report_base_rewrite` is what puts the fact on the
 * board at the moment of the rewrite.
 *
 * Every case drives a real local `origin` through many git subprocesses. The
 * Windows CI runner spawns processes far more slowly than Linux and these sit
 * past vitest's 30 s default under load (issue #261), so the ceiling below is
 * headroom, not a measured bound.
 */
const GIT_HEAVY_TIMEOUT = 120_000;

/** origin/main + origin/integration, with the repo fetched and up to date. */
async function repoWithIntegration() {
  const { origin, repo, colleague } = await makeRepoWithOrigin();
  await git(colleague, "checkout", "-b", "integration");
  await commitFile(colleague, "shared.txt", "deslopped\n", "deslop shared.txt");
  await git(colleague, "push", "-u", "origin", "integration");
  await git(repo, "fetch", "origin");
  return { origin, repo, colleague };
}

/** The landing task's work, done outside Calandria: rebase onto a moved main, force-push. */
async function rebaseAndForcePush(colleague: string) {
  await git(colleague, "checkout", "main");
  await commitFile(colleague, "main.txt", "landed on main\n", "main moves on");
  await git(colleague, "push", "origin", "main");
  await git(colleague, "checkout", "integration");
  await git(colleague, "rebase", "main");
  await git(colleague, "push", "--force", "origin", "integration");
  return git(colleague, "rev-parse", "integration");
}

/** A started task with a real worktree cut from `base`, and its cut point recorded. */
async function startedTask(project: { id: string }, repo: string, title: string, base: string, opts: { base_branch?: string } = {}) {
  const row = createTask({ project_id: project.id, title });
  const wt = await ensureWorktree(repo, row.id, base);
  if (!wt) throw new Error("no worktree");
  const cut = await git(repo, "rev-parse", base);
  updateTask(row.id, {
    started: 1, status: "in_progress",
    worktree_path: wt.path, work_branch: wt.branch,
    base_sha: cut, base_branch: opts.base_branch ?? "",
  });
  return { id: row.id, wt, cut };
}

describe("a landing task catching up the tasks it orphaned", { timeout: GIT_HEAVY_TIMEOUT }, () => {
  it("flags a sibling pinned to pre-rewrite history and leaves its branch alone", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-${Date.now()}`, repo_path: repo, branch: "main" });

    const sibling = await startedTask(project, repo, "work on integration", "integration", { base_branch: "integration" });
    const lander = await startedTask(project, repo, "land integration on main", "integration", { base_branch: "integration" });
    const siblingTipBefore = await git(repo, "rev-parse", sibling.wt.branch);

    await rebaseAndForcePush(colleague);
    // The local ref still points at the pre-rewrite tip, exactly the incident's
    // shape. flagBaseRewrite's own fetch is what has to close that gap.
    expect(await git(repo, "rev-parse", "integration")).toBe(sibling.cut);
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    const sweep = await flagBaseRewrite({ project, baseBranch: "integration", caller: getTask(lander.id)! });
    console.log("[sweep]", describeSweep(sweep));

    expect(sweep.flagged.map((t) => t.id)).toEqual([sibling.id]);
    expect(getTask(sibling.id)!.base_rewritten_at).toBeGreaterThan(0);

    // The caller is never in its own sweep, so a landing task cannot flag itself.
    expect(sweep.flagged.some((t) => t.id === lander.id)).toBe(false);
    expect(getTask(lander.id)!.base_rewritten_at).toBe(0);

    // Detection only: the sibling's branch is byte-for-byte where it was.
    expect(await git(repo, "rev-parse", sibling.wt.branch)).toBe(siblingTipBefore);

    // The transcript carries the command, since the chip has no room for it.
    const notice = listMessages(sibling.id).map((m) => m.content).join("\n");
    expect(notice).toContain("was rewritten by the task");
    expect(notice).toContain(`git rebase --onto integration ${sibling.cut.slice(0, 12)} ${sibling.wt.branch}`);
  });

  it("flags the incident's own shape, where the local base ref never saw the force-push", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-stale-${Date.now()}`, repo_path: repo, branch: "main" });
    const sibling = await startedTask(project, repo, "work on integration", "integration", { base_branch: "integration" });
    const lander = await startedTask(project, repo, "lander", "integration", { base_branch: "integration" });

    await rebaseAndForcePush(colleague);

    // Nobody fetched, nobody moved the local ref. This is the incident: the
    // sync banner's own local-ref test reads "not rewritten" here, and the
    // sweep has to catch it off the tracking ref its own fetch refreshes.
    expect(await git(repo, "rev-parse", "integration")).toBe(sibling.cut);

    const sweep = await flagBaseRewrite({ project, baseBranch: "integration", caller: getTask(lander.id)! });
    expect(sweep.flagged.map((t) => t.id)).toEqual([sibling.id]);
    expect(getTask(sibling.id)!.base_rewritten_at).toBeGreaterThan(0);

    // And the flag survives a sync read taken while the local ref is still
    // stale, since that read's local-only baseRewritten says false.
    const res = await syncGet(new Request("http://x"), { params: Promise.resolve({ id: sibling.id }) });
    expect((await res.json()).baseRewritten).toBe(false);
    expect(getTask(sibling.id)!.base_rewritten_at).toBeGreaterThan(0);
  });

  it("finds a task that inherits the base from its tag, not just one that names it", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-tag-${Date.now()}`, repo_path: repo, branch: "main" });
    const tag = createTag({ project_id: project.id, name: "the-plan", base_branch: "integration" });

    // No base_branch of its own: resolveBaseBranch has to reach the tag for this.
    const member = await startedTask(project, repo, "step 1", "integration");
    setTaskTags([member.id], [tag.id]);
    const lander = await startedTask(project, repo, "land it", "integration", { base_branch: "integration" });

    expect(tasksOnBase(project, "integration", lander.id).map((t) => t.id)).toContain(member.id);

    await rebaseAndForcePush(colleague);
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    const sweep = await flagBaseRewrite({ project, baseBranch: "integration", caller: getTask(lander.id)! });
    expect(sweep.flagged.map((t) => t.id)).toEqual([member.id]);
  });

  it("flags nobody when the base only moved forward", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-ff-${Date.now()}`, repo_path: repo, branch: "main" });
    const sibling = await startedTask(project, repo, "work on integration", "integration", { base_branch: "integration" });
    const lander = await startedTask(project, repo, "lander", "integration", { base_branch: "integration" });

    // An ordinary commit on top, no rewrite. The cut point stays an ancestor.
    await git(colleague, "checkout", "integration");
    await commitFile(colleague, "more.txt", "more\n", "ordinary forward movement");
    await git(colleague, "push", "origin", "integration");
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    // The regression guard: the tool takes the branch name as the model's word,
    // and the sweep re-derives per task from git, so a wrong call flags nothing.
    const sweep = await flagBaseRewrite({ project, baseBranch: "integration", caller: getTask(lander.id)! });
    expect(sweep.flagged).toEqual([]);
    expect(sweep.skipped.map((s) => [s.task.id, s.reason])).toEqual([[sibling.id, "not-rewritten"]]);
    expect(getTask(sibling.id)!.base_rewritten_at).toBe(0);
  });

  it("passes over a task on another base, a terminal one, and one that never started", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-skip-${Date.now()}`, repo_path: repo, branch: "main" });

    const onMain = await startedTask(project, repo, "unrelated work", "main");
    const finished = await startedTask(project, repo, "already landed", "integration", { base_branch: "integration" });
    updateTask(finished.id, { status: "done" });
    const unstarted = createTask({ project_id: project.id, title: "not started yet" });
    updateTask(unstarted.id, { base_branch: "integration", status: "in_progress" });
    const affected = await startedTask(project, repo, "still open", "integration", { base_branch: "integration" });
    const lander = await startedTask(project, repo, "lander", "integration", { base_branch: "integration" });

    await rebaseAndForcePush(colleague);
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    const sweep = await flagBaseRewrite({ project, baseBranch: "integration", caller: getTask(lander.id)! });
    expect(sweep.flagged.map((t) => t.id)).toEqual([affected.id]);
    // A task on `main` is not in the sweep at all: it does not share the base.
    expect(sweep.skipped.some((s) => s.task.id === onMain.id)).toBe(false);
    expect(getTask(onMain.id)!.base_rewritten_at).toBe(0);

    const why = Object.fromEntries(sweep.skipped.map((s) => [s.task.id, s.reason]));
    expect(why[finished.id]).toBe("terminal");
    // Nothing to catch up: its first launch cuts from whatever the tip is then.
    expect(why[unstarted.id]).toBe("no-checkout");
  });

  it("clears the flag on the next sync read once the cut point is reachable again", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-clear-${Date.now()}`, repo_path: repo, branch: "main" });
    const sibling = await startedTask(project, repo, "work on integration", "integration", { base_branch: "integration" });
    const lander = await startedTask(project, repo, "lander", "integration", { base_branch: "integration" });

    await rebaseAndForcePush(colleague);
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");
    await flagBaseRewrite({ project, baseBranch: "integration", caller: getTask(lander.id)! });
    expect(getTask(sibling.id)!.base_rewritten_at).toBeGreaterThan(0);

    // A read while the task is still behind the rewrite leaves the chip up.
    const still = await syncGet(new Request("http://x"), { params: Promise.resolve({ id: sibling.id }) });
    expect((await still.json()).baseRewritten).toBe(true);
    expect(getTask(sibling.id)!.base_rewritten_at).toBeGreaterThan(0);

    // The task catches up, however it does it. Here the cut point is advanced to
    // the new tip, which is what a rebase leaves behind.
    updateTask(sibling.id, { base_sha: await git(repo, "rev-parse", "integration") });
    const after = await syncGet(new Request("http://x"), { params: Promise.resolve({ id: sibling.id }) });
    expect((await after.json()).baseRewritten).toBe(false);
    expect(getTask(sibling.id)!.base_rewritten_at).toBe(0);
  });

  it("defaults to the caller's own base branch and reports what it did", async () => {
    const { repo, colleague } = await repoWithIntegration();
    const project = createProject({ name: `catchup-tool-${Date.now()}`, repo_path: repo, branch: "main" });
    const sibling = await startedTask(project, repo, "work on integration", "integration", { base_branch: "integration" });
    const lander = await startedTask(project, repo, "land integration", "integration", { base_branch: "integration" });

    await rebaseAndForcePush(colleague);
    await git(repo, "fetch", "origin");
    await git(repo, "update-ref", "refs/heads/integration", "refs/remotes/origin/integration");

    // No branch argument: the landing task is based on the branch it rewrote.
    const res = await reportBaseRewriteForAgent(getTask(lander.id)!, undefined);
    console.log("[tool]", res.text);
    expect(res.ok).toBe(true);
    expect(res.text).toContain(sibling.id);
    expect(res.text).toContain("were NOT touched");
    expect(getTask(sibling.id)!.base_rewritten_at).toBeGreaterThan(0);
  });

  it("says so plainly when no other task shares the branch", async () => {
    const { repo } = await repoWithIntegration();
    const project = createProject({ name: `catchup-none-${Date.now()}`, repo_path: repo, branch: "main" });
    const lander = await startedTask(project, repo, "lander", "integration", { base_branch: "integration" });

    const res = await reportBaseRewriteForAgent(getTask(lander.id)!, "integration");
    expect(res.ok).toBe(true);
    expect(res.text).toContain("nothing to catch up");
  });
});
