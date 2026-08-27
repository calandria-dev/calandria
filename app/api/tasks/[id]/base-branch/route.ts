import { NextResponse } from "next/server";
import { getProject, getTask, updateTask } from "@/lib/store";
import { retargetTaskBase } from "@/lib/baseBranch";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Point this task at a different base branch — what it was cut from, what Sync
 * catches it up to, and what Merge lands it into.
 *
 * Deliberately NOT part of `PATCH /api/tasks/[id]`: that route is a synchronous
 * field write, and this can create a local ref, `reset --hard` a worktree and
 * fail halfway. All of the policy lives in `retargetTaskBase`, so this route and
 * the agent tool that arrives later cannot drift.
 *
 * Runs under the per-task lock shared with the turn-launch path, so the running
 * check inside stays true for the whole reconciliation — a turn can't start
 * writing into the worktree while it's being re-cut.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { branch?: unknown } | null;
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";

  return jsonGuard(`base-branch ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    // An empty branch is "go back to inheriting the project's default". It still
    // has to RECONCILE — the task may be pinned to a branch it is now leaving —
    // so it routes through the same function under the project's own base rather
    // than blanking the column and leaving base_sha describing a branch the task
    // is no longer on. The one exception is a project with no base branch
    // configured at all: there is nothing to reconcile against, and refusing on
    // the name check would make the field impossible to clear.
    if (!branch && !project.branch.trim()) {
      updateTask(id, { base_branch: "" });
      return NextResponse.json({ ok: true, inherited: true, baseBranch: "", message: "Now following the project, which has no base branch set." });
    }
    const result = await retargetTaskBase(task, project, branch || project.branch);
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    // Inheriting again is stored as "" so a later change to the project's
    // default still reaches an uncut task — the pin is for a cut worktree, not
    // for a user clearing the field.
    if (!branch) {
      updateTask(id, { base_branch: "" });
      return NextResponse.json({ ...result, baseBranch: project.branch, inherited: true });
    }
    return NextResponse.json(result);
  }));
}
