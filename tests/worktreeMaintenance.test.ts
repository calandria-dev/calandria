import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/maintenance/worktrees/route";
import { ensureWorktree } from "../lib/git";
import { createProject, createTask, getTask, updateTask } from "../lib/store";
import { commitFile, git, makeRepo, writeFile } from "./helpers";

async function taskWithWorktree(status: "in_progress" | "done") {
  const repo = await makeRepo();
  const project = createProject({ name: `storage-${Math.random()}`, repo_path: repo, branch: "main" });
  const task = createTask({ project_id: project.id, title: "large task" });
  const wt = await ensureWorktree(repo, task.id, "main");
  if (!wt) throw new Error("worktree fixture failed");
  updateTask(task.id, {
    status,
    started: 1,
    worktree_path: wt.path,
    work_branch: wt.branch,
    base_sha: wt.baseSha,
  });
  return { repo, task, wt };
}

const post = (body: object) =>
  POST(new Request("http://test/api/maintenance/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

describe("worktree storage cleanup", () => {
  it("lists a Done task even when its work was never merged", async () => {
    const { task, wt } = await taskWithWorktree("done");
    writeFile(wt.path, "unfinished.txt", "not merged\n");

    const data = await (await GET()).json();
    const candidate = data.candidates.find((c: { taskId: string }) => c.taskId === task.id);
    expect(candidate).toMatchObject({ mergedAt: 0, status: "done", unsafe: true, canDiscard: true });
    expect(candidate.unsafeReason).toContain("uncommitted");
  });

  it("requires explicit discard acknowledgement for unmerged work", async () => {
    const { repo, task, wt } = await taskWithWorktree("done");
    await commitFile(wt.path, "unfinished.txt", "not merged\n", "unfinished task work");

    const refused = await (await post({ taskIds: [task.id] })).json();
    expect(refused.pruned).toEqual([]);
    expect(refused.skipped[0].reason).toContain("has unmerged work");
    expect(fs.existsSync(wt.path)).toBe(true);

    const removed = await (await post({ taskIds: [task.id], discardChanges: true })).json();
    expect(removed.pruned).toEqual([task.id]);
    expect(removed.discarded).toEqual([task.id]);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(getTask(task.id)).toMatchObject({ worktree_path: "", work_branch: "", base_sha: "" });
    await expect(git(repo, "rev-parse", "--verify", `refs/heads/${wt.branch}`)).rejects.toThrow();
  });

  it("does not offer or discard an active unmerged task", async () => {
    const { task, wt } = await taskWithWorktree("in_progress");
    writeFile(wt.path, "active.txt", "still working\n");

    const data = await (await GET()).json();
    expect(data.candidates.some((c: { taskId: string }) => c.taskId === task.id)).toBe(false);
    const result = await (await post({ taskIds: [task.id], discardChanges: true })).json();
    expect(result.skipped[0].reason).toContain("neither merged nor done");
    expect(fs.existsSync(wt.path)).toBe(true);
  });
});
