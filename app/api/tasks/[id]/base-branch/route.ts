import { NextResponse } from "next/server";
import { getProject, getTask } from "@/lib/store";
import { setTaskBaseBranch } from "@/lib/baseBranch";
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
 * fail halfway. All of the policy lives in `lib/baseBranch.ts`, so this route
 * and the `set_base_branch` agent tool cannot drift.
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

    // An empty branch is "go back to inheriting", which is not a column write —
    // the task may be pinned to a branch it is now leaving, so it reconciles
    // under the inherited name first. setTaskBaseBranch owns that, shared with
    // the `set_base_branch` agent tool so the two cannot drift.
    const result = await setTaskBaseBranch(task, project, branch);
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  }));
}
