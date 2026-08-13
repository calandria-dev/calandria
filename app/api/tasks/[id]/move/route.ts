import { NextResponse } from "next/server";
import { getProject, getTask, getTaskDeps } from "@/lib/store";
import { moveTasksToProject } from "@/lib/taskMove";

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
 * Only unstarted tasks move: see moveTaskBlockedReason. The eligibility check,
 * the task locks it has to be atomic with, and the event the change announces
 * all live in lib/taskMove.ts, shared with the bulk route — this one just
 * translates a one-task result into the strict manner it has always had: a
 * refusal is a 409, not a report. (POST /api/tasks/move is the same operation
 * for a selection, where a refusal is a line item instead.)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { project_id?: unknown } | null;
  const projectId = typeof body?.project_id === "string" ? body.project_id : "";
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!getProject(projectId)) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const result = await moveTasksToProject([id], projectId);
  // The destination was deleted while we queued for the task lock.
  if (!result) return NextResponse.json({ error: "project not found" }, { status: 404 });
  // The one task didn't move. Deleted between the check above and the lock is a
  // 404; anything else is the point-of-no-return refusal, which the caller is
  // expected to show the user verbatim.
  const refused = result.skipped[0];
  if (refused) return NextResponse.json({ error: refused.reason }, { status: refused.reason === "task not found" ? 404 : 409 });
  // Already there: nothing happened, so re-read and report the row as it stands.
  const moved = result.moved[0];
  if (!moved) return NextResponse.json({ ...getTask(id)!, depends_on: getTaskDeps(id), dropped_blockers: [], dropped_dependents: [] });
  return NextResponse.json({
    // The snapshot the store took INSIDE the lock, not a fresh read: by now the
    // lock is released, and a queued second move (or a delete) would make a
    // re-read describe someone else's outcome — or, after a delete, spread
    // undefined into a response with no task fields at all.
    ...moved,
    // A task moving alone can never have both ends of an edge in its set, so
    // every edge touching it dropped — reported as the two id lists this route
    // has always returned, and leaving it with no blockers at all.
    depends_on: result.kept.filter((e) => e.task_id === id).map((e) => e.depends_on_id),
    dropped_blockers: result.dropped.filter((e) => e.task_id === id).map((e) => e.depends_on_id),
    dropped_dependents: result.dropped.filter((e) => e.depends_on_id === id).map((e) => e.task_id),
  });
}
