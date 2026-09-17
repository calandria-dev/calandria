import { describe, expect, beforeEach, it, vi } from "vitest";

const { createTaskPrMock } = vi.hoisted(() => ({
  createTaskPrMock: vi.fn(),
}));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  createTaskPr: createTaskPrMock,
}));

vi.mock("@/lib/prState", () => ({
  prView: () => null,
  schedulePrRefresh: vi.fn(),
  startPrPolling: vi.fn(),
}));

import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { ensureWorktree } from "@/lib/git";
import { POST as prRoute } from "@/app/api/tasks/[id]/pr/route";
import { makeRepo, uid } from "./helpers";

const post = (id: string, body?: unknown) => new Request("http://localhost/x", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function prTask() {
  const repo = await makeRepo();
  const project = createProject({ name: `pr-route-${uid()}`, repo_path: repo, branch: "main", landing_mode: "pr" });
  const task = createTask({ project_id: project.id, title: "Plain task title" });
  const worktree = await ensureWorktree(repo, task.id);
  if (!worktree) throw new Error("ensureWorktree returned null in fixture");
  updateTask(task.id, { worktree_path: worktree.path, work_branch: worktree.branch });
  return task.id;
}

beforeEach(() => {
  createTaskPrMock.mockReset();
  createTaskPrMock.mockResolvedValue({ ok: true, url: "https://github.com/o/r/pull/7" });
});

describe("POST /api/tasks/[id]/pr", () => {
  it("passes an explicit title through to createTaskPr", async () => {
    const id = await prTask();
    const response = await prRoute(post(id, { title: "feat: add PR title picker" }), { params: Promise.resolve({ id }) });

    expect(response.status).toBe(200);
    expect(createTaskPrMock.mock.calls[0][0].title).toBe("feat: add PR title picker");
  });

  it.each([undefined, "   "])("falls back to the task title for %j", async (title) => {
    const id = await prTask();
    const response = await prRoute(post(id, title === undefined ? undefined : { title }), { params: Promise.resolve({ id }) });

    expect(response.status).toBe(200);
    expect(createTaskPrMock.mock.calls[0][0].title).toBe(getTask(id)!.title);
  });
});
