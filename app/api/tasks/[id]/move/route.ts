import { NextResponse } from "next/server";
import { getProject, getTask, getTaskDeps, moveTask, moveTaskBlockedReason } from "@/lib/store";
import { withTaskLock } from "@/lib/taskLock";
import { hasTurn } from "@/lib/abort";
import { publishGlobal } from "@/lib/events";

export const dynamic = "force-dynamic";

/**
 * Re-parent a task to another project. Its own route rather than a PATCH field
 * because a move isn't a field set: it renumbers the task's per-project
 * position, re-derives whatever it inherited from the old project, and drops
 * the dependency edges that would otherwise span projects (task_dependencies
 * has no project column and setTaskDeps rejects cross-project edges, so those
 * rows would silently violate the invariant). The dropped ids come back in the
 * response so the caller can say what it cost.
 *
 * Only unstarted tasks move: see moveTaskBlockedReason.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { project_id?: unknown } | null;
  const projectId = typeof body?.project_id === "string" ? body.project_id : "";
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });

  // Under the same per-task lock the turn-launch path takes, so a turn can't
  // start (and cut a worktree from the OLD repo) between the check below and
  // the write.
  return withTaskLock(id, () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!getProject(projectId)) return NextResponse.json({ error: "project not found" }, { status: 404 });
    const from = task.project_id;
    // Already there: nothing to do, and nothing to refuse either.
    if (from === projectId) return NextResponse.json({ ...task, depends_on: getTaskDeps(id), dropped_blockers: [], dropped_dependents: [] });
    const blocked = moveTaskBlockedReason(task);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
    // The row's own flags aren't the whole story: POST /messages claims the
    // turn slot BEFORE it takes this lock, so a launch can be in flight with
    // running still 0. The abort registry is the liveness truth (same re-check
    // the merge/sync routes make under this lock).
    if (hasTurn(id)) return NextResponse.json({ error: "a task with a running turn can't be moved" }, { status: 409 });

    const moved = moveTask(id, projectId);
    // Announce AFTER the write: both project trays change, and no runner
    // publish will follow a hand-driven mutation like this one.
    publishGlobal(id, { type: "task_moved", fromProjectId: from, toProjectId: projectId });
    return NextResponse.json({
      ...moved.task,
      depends_on: getTaskDeps(id),
      dropped_blockers: moved.dropped_blockers,
      dropped_dependents: moved.dropped_dependents,
    });
  });
}
