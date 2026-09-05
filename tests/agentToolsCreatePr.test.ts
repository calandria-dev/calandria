import { describe, it, expect, beforeEach, vi } from "vitest";

// Pins the policy of the `create_pr` agent tool (lib/prTools.ts): it runs the
// same machinery as POST /api/tasks/[id]/pr, since the sandbox classifier
// blocks `git push` and `gh pr create` from inside a task. `gh` is mocked; the
// commit, store writes, and policy (the landing_mode gate, the no-worktree
// refusal, the own-row-only scope, and that success persists
// pr_url/pr_number the way the route does) are real.
const { createTaskPrMock, fetchPrStateMock } = vi.hoisted(() => ({
  createTaskPrMock: vi.fn(),
  fetchPrStateMock: vi.fn(),
}));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  createTaskPr: createTaskPrMock,
  fetchPrState: fetchPrStateMock,
}));

import { createProject, createTask, getTask, updateTask, deleteTask } from "@/lib/store";
import { ensureWorktree } from "@/lib/git";
import { createPrForAgent } from "@/lib/prTools";
import { makeRepo, uid, writeFile } from "./helpers";
import type { Task } from "@/lib/types";

// A started task on a project that lands by PR, the only shape the tool runs
// in.
async function prTask(over: { landing_mode?: "merge" | "pr" } = {}) {
  const repo = await makeRepo();
  const project = createProject({
    name: `pr-tool-${uid()}`,
    repo_path: repo,
    branch: "main",
    landing_mode: over.landing_mode ?? "pr",
  });
  const task = createTask({ project_id: project.id, title: "Give the agent a create_pr tool" });
  const wt = await ensureWorktree(repo, task.id);
  if (!wt) throw new Error("ensureWorktree returned null in fixture");
  updateTask(task.id, { worktree_path: wt.path, work_branch: wt.branch, running: 1 });
  return { repo, project, task: getTask(task.id) as Task, wt };
}

beforeEach(() => {
  createTaskPrMock.mockReset();
  fetchPrStateMock.mockReset();
  // The success path kicks a detached state read; keep it off github.com.
  fetchPrStateMock.mockResolvedValue({ ok: false, error: "mocked" });
});

describe("create_pr", () => {
  it("commits, pushes and records the PR on the task", async () => {
    const { task, wt } = await prTask();
    // Work the session did but never committed is committed by the tool, the
    // same way Merge does, so the PR shows the diff the Changes tab shows.
    writeFile(wt.path, "new.txt", "from the session\n");
    createTaskPrMock.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/7" });

    const { url, number, text } = await createPrForAgent(task, {});
    expect(url).toBe("https://github.com/o/r/pull/7");
    // The success result names the PR by number and URL, so the model can
    // only report success by quoting values it was actually handed.
    expect(number).toBe(7);
    expect(text).toContain("#7");
    expect(text).toContain("https://github.com/o/r/pull/7");

    const arg = createTaskPrMock.mock.calls[0][0];
    expect(arg.workBranch).toBe(wt.branch);
    expect(arg.baseBranch).toBe("main");
    // No title or body given, so the PR is described from the task row.
    expect(arg.title).toBe("Give the agent a create_pr tool");
    expect(arg.body).toContain(`task ${task.id}`);

    // Persisted exactly as the route persists it, with the number parsed once here.
    const after = getTask(task.id)!;
    expect(after.pr_url).toBe("https://github.com/o/r/pull/7");
    expect(after.pr_number).toBe(7);
    // And the session is told the part it cannot do.
    expect(text).toMatch(/merg/i);
  });

  it("uses the title and body the session wrote when it gives them", async () => {
    const { task } = await prTask();
    createTaskPrMock.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/8" });

    await createPrForAgent(task, { title: "feat: add a create_pr tool", body: "## What\n\nA tool." });
    const arg = createTaskPrMock.mock.calls[0][0];
    expect(arg.title).toBe("feat: add a create_pr tool");
    expect(arg.body).toBe("## What\n\nA tool.");
  });

  it("does NOT refuse on the caller's own running turn, unlike the route's 409", async () => {
    // The route refuses a running task because a human clicking mid-session
    // would commit a half-written tree. This call IS the session, so the same
    // guard would refuse every legitimate use.
    const { task } = await prTask();
    expect(task.running).toBe(1);
    createTaskPrMock.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/9" });
    expect((await createPrForAgent(task, {})).url).toBe("https://github.com/o/r/pull/9");
  });

  it("re-pushing an already-open PR reports it as an update, not a second PR", async () => {
    const { task } = await prTask();
    createTaskPrMock.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/7", existing: true });
    const { url, number, text } = await createPrForAgent(task, {});
    expect(number).toBe(7);
    expect(text).toContain("#7");
    expect(url).toBe("https://github.com/o/r/pull/7");
    expect(text).toContain("already open");
  });

  it("refuses on a project that lands by merging, without pushing anything", async () => {
    const { task } = await prTask({ landing_mode: "merge" });
    const { url, text } = await createPrForAgent(task, {});
    expect(url).toBeNull();
    expect(text).toContain("lands work by merging");
    expect(text).toContain("Nothing was pushed");
    expect(createTaskPrMock).not.toHaveBeenCalled();
  });

  it("refuses a task with no worktree or work branch, matching the route's 400", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `pr-tool-${uid()}`, repo_path: repo, branch: "main", landing_mode: "pr" });
    const task = createTask({ project_id: project.id, title: "never started" });
    const { url, text } = await createPrForAgent(task, {});
    expect(url).toBeNull();
    expect(text).toContain("no isolated branch");
    expect(createTaskPrMock).not.toHaveBeenCalled();
  });

  it("re-reads the caller's row: a detached turn's snapshot predates its own worktree cut", async () => {
    const repo = await makeRepo();
    const project = createProject({ name: `pr-tool-${uid()}`, repo_path: repo, branch: "main", landing_mode: "pr" });
    // The snapshot the turn is holding was read before ensureWorktree filled
    // the columns in; this is the ordinary case, not an exotic one.
    const stale = createTask({ project_id: project.id, title: "cut after the read" });
    const wt = await ensureWorktree(repo, stale.id);
    updateTask(stale.id, { worktree_path: wt!.path, work_branch: wt!.branch });
    createTaskPrMock.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/10" });

    expect(stale.worktree_path).toBeFalsy();
    expect((await createPrForAgent(stale, {})).url).toBe("https://github.com/o/r/pull/10");
  });

  it("reports gh's own failure back to the session, and records nothing", async () => {
    const { task } = await prTask();
    createTaskPrMock.mockResolvedValue({ ok: false, error: "push failed: protected branch", detail: "remote: hook declined" });
    const { url, text } = await createPrForAgent(task, {});
    expect(url).toBeNull();
    expect(text).toContain("push failed: protected branch");
    // The detail travels too, since it says what to fix.
    expect(text).toContain("hook declined");
    expect(getTask(task.id)!.pr_url).toBeFalsy();
  });

  it("refuses when the caller's row is gone", async () => {
    const { task } = await prTask();
    deleteTask(task.id);
    const { url, text } = await createPrForAgent(task, {});
    expect(url).toBeNull();
    expect(text).toContain("no longer exists");
  });
});
