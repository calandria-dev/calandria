// update_task's done gate: an agent may not mark a task done while its
// checkout is the only place that task's work exists (lib/strandedWork.ts).
// Every case here runs against a real repo and a real worktree, since the
// verdict is a git reading, not a column.

import { describe, expect, it } from "vitest";
import { updateTaskForAgent } from "../lib/agentTools";
import { ensureWorktree } from "../lib/git";
import { createProject, createTask, getTask, updateTask } from "../lib/store";
import { commitFile, git, makeRepo, makeRepoWithOrigin, writeFile } from "./helpers";
import type { Task } from "../lib/types";

const actor = (t: Task) => ({ id: t.id, title: t.title, agent: t.agent });

/** A task on its own worktree in a repo with no remote. */
async function taskOnAWorktree(repo: string) {
  const project = createProject({ name: `done-gate-${Math.random()}`, repo_path: repo, branch: "main" });
  const row = createTask({ project_id: project.id, title: "some work" });
  const wt = await ensureWorktree(repo, row.id, "main");
  if (!wt) throw new Error("worktree fixture failed");
  updateTask(row.id, {
    status: "in_progress",
    started: 1,
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
  });
  return { project, task: getTask(row.id)!, wt };
}

describe("update_task done gate", () => {
  it("allows done on a task that never got a checkout", async () => {
    const project = createProject({ name: `no-wt-${Math.random()}`, repo_path: await makeRepo(), branch: "main" });
    const task = createTask({ project_id: project.id, title: "planning only" });
    const { task: updated } = await updateTaskForAgent(actor(task), undefined, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("allows done on a clean checkout with nothing of its own", async () => {
    const { task } = await taskOnAWorktree(await makeRepo());
    const { task: updated } = await updateTaskForAgent(actor(task), undefined, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("refuses done while the worktree has uncommitted changes", async () => {
    const { task, wt } = await taskOnAWorktree(await makeRepo());
    writeFile(wt.path, "scratch.txt", "half a feature\n");

    const { task: updated, text } = await updateTaskForAgent(actor(task), undefined, { status: "done" });
    expect(updated).toBeNull();
    expect(text).toContain("uncommitted changes");
    expect(text).toContain("create_pr");
    expect(getTask(task.id)!.status).toBe("in_progress");
  });

  it("refuses done when the branch carries commits no pull request covers", async () => {
    const { task, wt } = await taskOnAWorktree(await makeRepo());
    await commitFile(wt.path, "feature.txt", "the work\n", "feat: the work");

    const { task: updated, text } = await updateTaskForAgent(actor(task), undefined, { status: "done" });
    expect(updated).toBeNull();
    expect(text).toContain("1 commit");
    expect(text).toContain("no pull request covers it");
    expect(getTask(task.id)!.status).toBe("in_progress");
  });

  it("allows done once those commits are in the base branch", async () => {
    const repo = await makeRepo();
    const { task, wt } = await taskOnAWorktree(repo);
    await commitFile(wt.path, "feature.txt", "the work\n", "feat: the work");
    await git(repo, "merge", "--no-ff", "-m", "merge the work", wt.branch);

    const { task: updated } = await updateTaskForAgent(actor(task), undefined, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("allows done on a pushed branch with a pull request open on it", async () => {
    const { repo } = await makeRepoWithOrigin();
    const { task, wt } = await taskOnAWorktree(repo);
    await commitFile(wt.path, "feature.txt", "the work\n", "feat: the work");
    await git(wt.path, "push", "-u", "origin", wt.branch);
    updateTask(task.id, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7, pr_state: "open" });

    const { task: updated } = await updateTaskForAgent(actor(getTask(task.id)!), undefined, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("refuses done when a commit never reached the pull request", async () => {
    const { repo } = await makeRepoWithOrigin();
    const { task, wt } = await taskOnAWorktree(repo);
    await commitFile(wt.path, "feature.txt", "the work\n", "feat: the work");
    await git(wt.path, "push", "-u", "origin", wt.branch);
    await commitFile(wt.path, "feature.txt", "the work, finished\n", "feat: finish the work");
    updateTask(task.id, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7, pr_state: "open" });

    const { task: updated, text } = await updateTaskForAgent(actor(getTask(task.id)!), undefined, { status: "done" });
    expect(updated).toBeNull();
    expect(text).toContain("never pushed");
    expect(text).toContain("#7");
    expect(getTask(task.id)!.status).toBe("in_progress");
  });

  it("does not let a closed pull request cover the branch", async () => {
    const { repo } = await makeRepoWithOrigin();
    const { task, wt } = await taskOnAWorktree(repo);
    await commitFile(wt.path, "feature.txt", "the work\n", "feat: the work");
    await git(wt.path, "push", "-u", "origin", wt.branch);
    updateTask(task.id, { pr_url: "https://github.com/o/r/pull/7", pr_number: 7, pr_state: "closed" });

    const { task: updated, text } = await updateTaskForAgent(actor(getTask(task.id)!), undefined, { status: "done" });
    expect(updated).toBeNull();
    expect(text).toContain("no pull request covers it");
  });

  it("writes nothing else in the same refused call", async () => {
    const { task, wt } = await taskOnAWorktree(await makeRepo());
    writeFile(wt.path, "scratch.txt", "half a feature\n");

    const { task: updated } = await updateTaskForAgent(actor(task), undefined, { title: "Renamed", status: "done", priority: "hi" });
    expect(updated).toBeNull();
    const after = getTask(task.id)!;
    expect(after.title).toBe("some work");
    expect(after.priority).toBe(task.priority);
  });

  it("gates another session's task on ITS checkout, not the caller's", async () => {
    const repo = await makeRepo();
    const { task: caller } = await taskOnAWorktree(repo);
    const { task: target, wt } = await taskOnAWorktree(repo);
    await commitFile(wt.path, "feature.txt", "their work\n", "feat: their work");

    const { task: updated, text } = await updateTaskForAgent(actor(caller), target.id, { status: "done" });
    expect(updated).toBeNull();
    expect(text).toContain(wt.branch);
    expect(getTask(target.id)!.status).toBe("in_progress");
    expect(getTask(caller.id)!.status).toBe("in_progress");
  });

  it("leaves every other status write alone", async () => {
    const { task, wt } = await taskOnAWorktree(await makeRepo());
    writeFile(wt.path, "scratch.txt", "half a feature\n");

    const { task: updated } = await updateTaskForAgent(actor(task), undefined, { status: "on_hold" });
    expect(updated?.status).toBe("on_hold");
  });
});
