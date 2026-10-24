// Shared fixture for the review tests: a project over a real repo, a task with a
// real linked worktree, and a submission body builder.
import { ensureWorktree } from "../lib/git";
import type { SubmitterContext } from "../lib/reviews/types";
import { createProject, createTask, getTask, updateTask } from "../lib/store";
import { makeRepo, uid } from "./helpers";

export async function reviewTask(opts: { status?: "not_started" | "in_progress" | "done" | "cancelled" } = {}) {
  const repo = await makeRepo();
  const project = createProject({ name: `Review-${uid()}`, repo_path: repo, branch: "main" });
  const id = uid();
  createTask({ id, project_id: project.id, title: "Reviewed work", description: "" });
  const wt = await ensureWorktree(repo, id, "main");
  if (!wt) throw new Error("no worktree");
  updateTask(id, { worktree_path: wt.path, base_branch: "main", status: opts.status ?? "in_progress" });
  const task = getTask(id)!;
  const ctx: SubmitterContext = { taskId: id, sessionId: `sess-${uid()}`, generation: task.generation, agent: "claude", model: "test-model" };
  return { repo, project, taskId: id, wt, ctx };
}

export function docBody(over: Record<string, unknown> = {}) {
  return {
    requestId: null,
    expectedVersion: 0,
    expectedSubmissionId: null,
    outputKey: "plan",
    kind: "document",
    required: true,
    summary: "Please review the plan",
    requestedDecision: "Accept or request changes",
    evidence: [{ url: "https://example.com/spec", label: "spec" }],
    validation: [{ command: "npm test", result: "passed" }],
    idempotencyKey: `k-${uid()}`,
    artifact: { kind: "document", path: "docs/plan.md" },
    ...over,
  };
}

export function codeBody(over: Record<string, unknown> = {}) {
  return docBody({ outputKey: "code", kind: "code", artifact: { kind: "code" }, ...over });
}
