// The two agent verbs phase 3 adds: `set_base_branch` (retarget a task's base)
// and `update_tag` (edit the tag itself — the plan's own brief, colour and
// default base). Policy only; the same two are driven end to end over the real
// stdio bridge in tests/codexUpdateTaskPolicy.test.ts, which is the path where
// the MODEL names the target.
// Design: docs/superpowers/specs/2026-08-27-per-task-base-branch-design.md.

import { describe, expect, it } from "vitest";
import { POST as revertEp } from "../app/api/tasks/[id]/agent-edits/route";
import { setBaseBranchForAgent, updateTagForAgent } from "../lib/agentTools";
import { registerTurn, unregisterTurn } from "../lib/abort";
import { resolveBaseBranch } from "../lib/baseBranch";
import { ensureWorktree } from "../lib/git";
import { createProject, createTag, createTask, getTag, getTask, listAgentEdits, setTaskTags, updateTask } from "../lib/store";
import { commitFile, git, makeRepo, uid } from "./helpers";

/** A project with a real repo, a caller session, and a `release` branch to aim at. */
async function board(opts: { repo?: string } = {}) {
  const repo = opts.repo ?? (await makeRepo());
  await git(repo, "branch", "release");
  const project = createProject({ name: `agent-base-${uid()}`, repo_path: repo, branch: "main" });
  const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
  return { repo, project, caller };
}

/** Cut a task's worktree the way the launch paths do, pinning the base it used. */
async function cut(repo: string, taskId: string, base: string) {
  const wt = await ensureWorktree(repo, taskId, base);
  if (!wt) throw new Error("ensureWorktree returned null");
  updateTask(taskId, {
    started: 1, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha,
    ...(wt.baseBranch ? { base_branch: wt.baseBranch } : {}),
  });
  return getTask(taskId)!;
}

describe("set_base_branch", () => {
  it("retargets the caller's OWN row mid-turn — the case the tool exists for", async () => {
    const { repo, project, caller } = await board();
    await cut(repo, caller.id, "main");
    // A live turn in the caller's own session: `running` is set AND the turn is
    // registered, so both halves of the liveness check see it. Retargeting
    // yourself while you work is the tool's main use, so neither may refuse it.
    updateTask(caller.id, { running: 1 });
    const ctl = new AbortController();
    registerTurn(caller.id, ctl);
    try {
      const res = await setBaseBranchForAgent(caller, undefined, "release");
      expect(res.task, res.text).toBeTruthy();
      expect(res.text).toContain("Now based on release");
      expect(getTask(caller.id)!.base_branch).toBe("release");
      // Its own row, so nothing is recorded — there is no user to surprise.
      expect(listAgentEdits(caller.id)).toEqual([]);
      expect(getTask(caller.id)!.agent_edited_at).toBe(0);
    } finally {
      unregisterTurn(caller.id, ctl);
    }
  });

  it("refuses ANOTHER task whose turn is running, and writes nothing", async () => {
    const { repo, project, caller } = await board();
    const other = createTask({ project_id: project.id, title: "Busy", description: "" });
    await cut(repo, other.id, "main");
    updateTask(other.id, { running: 1 });

    const before = getTask(other.id)!;
    const res = await setBaseBranchForAgent(caller, other.id, "release");
    expect(res.task).toBeNull();
    expect(res.text).toContain("has a turn running");
    expect(getTask(other.id)).toEqual(before);
    expect(listAgentEdits(other.id)).toEqual([]);
  });

  it("refuses a task in another project — a branch name means nothing there", async () => {
    const { project, caller } = await board();
    const elsewhere = createProject({ name: `elsewhere-${uid()}`, repo_path: await makeRepo(), branch: "main" });
    const foreign = createTask({ project_id: elsewhere.id, title: "Foreign", description: "" });

    const res = await setBaseBranchForAgent(caller, foreign.id, "release");
    expect(res.task).toBeNull();
    expect(res.text).toContain("different project");
    expect(getTask(foreign.id)!.base_branch).toBe("");
    expect(project.id).not.toBe(elsewhere.id);
  });

  it("passes every refusal in retargetTaskBase back to the model, unwritten", async () => {
    const { repo, project, caller } = await board();
    const task = await cut(repo, caller.id, "main");

    // An unusable name, refused before any git runs.
    const unsafe = await setBaseBranchForAgent(caller, undefined, "--upload-pack=evil");
    expect(unsafe.task).toBeNull();
    expect(unsafe.text).toContain("isn't a usable git branch name");

    // A branch that is nowhere — the refusal names where it looked.
    const missing = await setBaseBranchForAgent(caller, undefined, "does-not-exist");
    expect(missing.task).toBeNull();
    expect(missing.text).toContain("does-not-exist");

    // The task's own work branch: the diff and the merge would be against itself.
    const self = await setBaseBranchForAgent(caller, undefined, task.work_branch);
    expect(self.task).toBeNull();
    expect(self.text).toContain("own work branch");

    // A branch another task's worktree has checked out. Merging moves that ref,
    // which would strand the session working in there — this is what stops one
    // task basing on another's calandria/… branch, and it says so.
    const neighbour = createTask({ project_id: project.id, title: "Neighbour", description: "" });
    const n = await cut(repo, neighbour.id, "main");
    const occupied = await setBaseBranchForAgent(caller, undefined, n.work_branch);
    expect(occupied.task).toBeNull();
    expect(occupied.text).toContain("is checked out in");

    // Nothing above moved the pin off what the cut recorded.
    expect(getTask(caller.id)!.base_branch).toBe("main");
    expect(listAgentEdits(caller.id)).toEqual([]);
  });

  it("refuses a task that no longer exists rather than falling back to the caller", async () => {
    const { caller } = await board();
    const res = await setBaseBranchForAgent(caller, "ghost", "release");
    expect(res.task).toBeNull();
    expect(res.text).toContain('No task with id "ghost"');
    expect(getTask(caller.id)!.base_branch).toBe("");
  });

  it('takes "" as "go back to inheriting", tag default included', async () => {
    const { repo, project, caller } = await board();
    const tag = createTag({ project_id: project.id, name: `plan-${uid()}`, base_branch: "release" });
    const member = createTask({ project_id: project.id, title: "Member", description: "" });
    setTaskTags([member.id], [tag.id]);
    await git(repo, "branch", "hotfix");

    // Pinned away from the tag's default...
    expect((await setBaseBranchForAgent(caller, member.id, "hotfix")).task).toBeTruthy();
    expect(getTask(member.id)!.base_branch).toBe("hotfix");

    // ...and back. The column is cleared to "" rather than written with the
    // inherited name, so a later edit to the tag still reaches this uncut task.
    const back = await setBaseBranchForAgent(caller, member.id, "");
    expect(back.task, back.text).toBeTruthy();
    expect(getTask(member.id)!.base_branch).toBe("");
    expect(resolveBaseBranch(getTask(member.id)!, project)).toBe("release");
  });

  it("records an edit on somebody else's row, and Revert re-runs the retarget", async () => {
    const { repo, project, caller } = await board();
    const other = createTask({ project_id: project.id, title: "Theirs", description: "" });
    await cut(repo, other.id, "main");
    // A commit of its own, so the retarget takes the reconcile path rather than
    // the re-cut one — the case where a revert has real git work to undo.
    await commitFile(getTask(other.id)!.worktree_path, "task.txt", "task\n", "task work");

    const res = await setBaseBranchForAgent(caller, other.id, "release");
    expect(res.task, res.text).toBeTruthy();
    expect(res.text).toContain("one-click revert");
    expect(getTask(other.id)!.base_branch).toBe("release");

    const edits = listAgentEdits(other.id);
    expect(edits).toHaveLength(1);
    expect(edits[0].actor_task_id).toBe(caller.id);
    expect(edits[0].changes).toHaveLength(1);
    // The readable halves are the RESOLVED names; the values are the raw column,
    // which is what a revert has to put back.
    expect(edits[0].changes[0]).toMatchObject({ field: "base_branch", before: "main", after: "release", before_value: "main", after_value: "release" });
    expect(getTask(other.id)!.agent_edited_at).toBeGreaterThan(0);

    const res2 = await revertEp(
      new Request(`http://test/api/tasks/${other.id}/agent-edits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revert", edit_id: edits[0].id }),
      }),
      { params: Promise.resolve({ id: other.id }) }
    );
    expect(res2.status).toBe(200);
    // Back on main, and through the retarget rather than a column write: the
    // diff snapshot follows the branch instead of being left on the other one.
    const after = getTask(other.id)!;
    expect(after.base_branch).toBe("main");
    expect(after.base_sha).toBe(await git(repo, "merge-base", "main", after.work_branch));
    expect(listAgentEdits(other.id)[0].reverted_at).toBeGreaterThan(0);
    expect(project.branch).toBe("main");
  });

  it("refuses the revert instead of half-applying it when the branch is gone", async () => {
    const { repo, project, caller } = await board();
    const other = createTask({ project_id: project.id, title: "Theirs", description: "" });
    await git(repo, "branch", "temp");
    await cut(repo, other.id, "temp");
    expect(getTask(other.id)!.base_branch).toBe("temp");

    expect((await setBaseBranchForAgent(caller, other.id, "release")).task).toBeTruthy();
    // The branch the revert would go back to is deleted out from under it.
    await git(repo, "branch", "-D", "temp");

    const edit = listAgentEdits(other.id)[0];
    const res = await revertEp(
      new Request(`http://test/api/tasks/${other.id}/agent-edits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revert", edit_id: edit.id }),
      }),
      { params: Promise.resolve({ id: other.id }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("could not put the base branch back");
    // Nothing moved, and the edit is still outstanding rather than marked done.
    expect(getTask(other.id)!.base_branch).toBe("release");
    expect(listAgentEdits(other.id)[0].reverted_at).toBe(0);
    expect(project.branch).toBe("main");
  });
});

describe("update_tag", () => {
  it("renames, rewrites, recolours and sets the base branch of the tag itself", () => {
    const project = createProject({ name: `tag-edit-${uid()}` });
    const tag = createTag({ project_id: project.id, name: "Auth migraton", description: "old" });

    const res = updateTagForAgent(project, "Auth migraton", {
      name: "Auth migration",
      description: "Port every route to the new session store.",
      color: "#3E7CA8",
      base_branch: "feature/auth",
    });
    expect(res.tag, res.text).toBeTruthy();
    expect(res.text).toContain('renamed to "Auth migration"');
    expect(res.text).toContain("set_base_branch");
    const after = getTag(tag.id)!;
    expect(after).toMatchObject({
      name: "Auth migration",
      description: "Port every route to the new session store.",
      color: "#3E7CA8",
      base_branch: "feature/auth",
    });

    // Resolvable by the NEW name afterwards, and `""` clears the default back
    // to "members follow the project".
    const cleared = updateTagForAgent(project, "Auth migration", { base_branch: "" });
    expect(cleared.tag).toBeTruthy();
    expect(cleared.text).toContain("follow the project's default branch again");
    expect(getTag(tag.id)!.base_branch).toBe("");
  });

  it("refuses a rename onto a name another tag already holds, BY NAME", () => {
    const project = createProject({ name: `tag-conflict-${uid()}` });
    const a = createTag({ project_id: project.id, name: "Auth migration", description: "keep me" });
    createTag({ project_id: project.id, name: "Mobile PWA" });

    const res = updateTagForAgent(project, a.id, { name: "Mobile PWA", description: "rewritten" });
    expect(res.tag).toBeNull();
    expect(res.text).toContain('A tag named "Mobile PWA" already exists');
    expect(res.text).toContain("Nothing was changed");
    // The description that shared the call didn't land under that refusal.
    expect(getTag(a.id)).toMatchObject({ name: "Auth migration", description: "keep me" });
  });

  it("resolves strictly — a near-miss is a refusal, never a new tag", () => {
    const project = createProject({ name: `tag-strict-${uid()}` });
    createTag({ project_id: project.id, name: "Auth migration" });

    const res = updateTagForAgent(project, "auth migration", { description: "nope" });
    expect(res.tag).toBeNull();
    expect(res.text).toContain("Nothing was changed");
    expect(res.text).toContain('"Auth migration"');
  });

  it("refuses a tag from another project, and an unusable branch name", () => {
    const here = createProject({ name: `tag-here-${uid()}` });
    const there = createProject({ name: `tag-there-${uid()}` });
    const foreign = createTag({ project_id: there.id, name: "Elsewhere", base_branch: "" });

    const cross = updateTagForAgent(here, foreign.id, { description: "mine now" });
    expect(cross.tag).toBeNull();
    expect(getTag(foreign.id)!.description).toBe("");

    const mine = createTag({ project_id: here.id, name: "Mine" });
    const unsafe = updateTagForAgent(here, mine.id, { base_branch: "--upload-pack=evil" });
    expect(unsafe.tag).toBeNull();
    expect(unsafe.text).toContain("isn't a usable git branch name");
    expect(getTag(mine.id)!.base_branch).toBe("");

    // A colour outside the palette is refused with the palette, since there is
    // no list_tags field to read the accepted values off.
    const badColor = updateTagForAgent(here, mine.id, { color: "puce" });
    expect(badColor.tag).toBeNull();
    expect(badColor.text).toContain("color must be one of");
  });

  it("accepts a branch that does not exist yet — it is a default for cuts not yet made", () => {
    const project = createProject({ name: `tag-future-${uid()}`, repo_path: "", branch: "main" });
    const tag = createTag({ project_id: project.id, name: "Release 3.2" });
    // The integration branch a plan is ABOUT to create must be settable now;
    // unlike set_base_branch this touches no git, because a tag has no worktree.
    const res = updateTagForAgent(project, "Release 3.2", { base_branch: "release/3.2" });
    expect(res.tag, res.text).toBeTruthy();
    expect(getTag(tag.id)!.base_branch).toBe("release/3.2");
  });

  it("reports a no-op instead of a spurious write", () => {
    const project = createProject({ name: `tag-noop-${uid()}` });
    const tag = createTag({ project_id: project.id, name: "Steady", base_branch: "release" });
    const before = getTag(tag.id)!.updated_at;
    const res = updateTagForAgent(project, "Steady", { name: "Steady", base_branch: "release" });
    expect(res.tag).toBeTruthy();
    expect(res.text).toContain("No change");
    expect(getTag(tag.id)!.updated_at).toBe(before);
  });
});
