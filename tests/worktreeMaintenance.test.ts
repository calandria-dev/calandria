import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/maintenance/worktrees/route";
import { ensureWorktree } from "../lib/git";
import { createProject, createTag, createTask, getTask, setTaskTags, updateTask } from "../lib/store";
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

// The sweep is the one caller with no Task in hand, so it resolves the base in
// SQL (listReclaimableWorktrees). The chain has three legs and this asserts the
// PRECEDENCE among them through the route: worktreePruneSafety names the branch
// it judged "unmerged" against, so the reason string is the resolved base said
// out loud. Getting it wrong means the Storage sweep offers to delete a worktree
// whose work is unmerged, or refuses one whose work has landed.
describe("the reclaim sweep resolves each task's base: its own, then its tag's, then the project's", () => {
  it("picks the task's base over the tag's over the project's", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "release");
    await git(repo, "branch", "feature/auth");
    const project = createProject({ name: `basesweep-${Math.random()}`, repo_path: repo, branch: "main" });
    const authTag = createTag({ project_id: project.id, name: "Auth", base_branch: "feature/auth" });

    // Each task ends up with one commit that is on no other branch, so the
    // safety check reports it against whichever base was resolved.
    const cut = async (title: string, ownBase: string, tags: string[]) => {
      const task = createTask({ project_id: project.id, title });
      const wt = await ensureWorktree(repo, task.id, ownBase || "main");
      if (!wt) throw new Error("worktree fixture failed");
      await commitFile(wt.path, `${task.id}.txt`, "work\n", "task work");
      updateTask(task.id, {
        status: "done", started: 1, worktree_path: wt.path, work_branch: wt.branch,
        base_sha: wt.baseSha, base_branch: ownBase,
      });
      if (tags.length) setTaskTags([task.id], tags);
      return task.id;
    };

    // Own base set AND a tag naming another branch: the task's own wins.
    const own = await cut("pinned itself", "release", [authTag.id]);
    // No base of its own, one tag that has one: the tag's default answers.
    const viaTag = await cut("follows its plan", "", [authTag.id]);
    // Neither: the project's default is the last leg.
    const viaProject = await cut("follows the project", "", []);

    const data = await (await GET()).json();
    const reason = (id: string) => data.candidates.find((c: { taskId: string }) => c.taskId === id)!.unsafeReason as string;
    expect(reason(own)).toContain("not yet in release");
    expect(reason(viaTag)).toContain("not yet in feature/auth");
    expect(reason(viaProject)).toContain("not yet in main");
  });
});

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
