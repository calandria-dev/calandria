import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { moveTasksToProject } from "@/lib/taskMove";

export const dynamic = "force-dynamic";

/**
 * Re-parent a SELECTION of tasks to another project — the bulk sibling of
 * POST /api/tasks/[id]/move. Eleven misfiled tasks were eleven open-edit-pick-
 * move round trips; this is one, under one transaction, announced by one event.
 *
 * The two routes differ only in manner. This one reports rather than refuses:
 * a task that can't move (started, or a turn in flight) comes back in `skipped`
 * with its reason so the caller can say so, while its neighbours still move.
 * Only the caller's own mistakes are status codes — a malformed body (400) or a
 * destination that doesn't exist (404).
 *
 * Rules per task are unchanged (see lib/store.ts moveTasks): unstarted only,
 * positions renumbered in the destination, inherited settings re-derived. The
 * one thing only the batch can do is keep a dependency edge whose BOTH ends are
 * in the selection — a chain that moves together stays intra-project, so
 * nothing has to be dropped.
 *
 * Deliberately NOT on offer here: the single route's `discard_worktree`, which
 * moves a started task by destroying its checkout. The operation supports a
 * selection, but the acknowledgement doesn't — each worktree is a different
 * irreversible answer ("yes, throw away these three uncommitted files") and one
 * checkbox over eleven of them isn't consent, it's a shrug. A started task in a
 * bulk selection is still reported in `skipped`, and the user re-files it from
 * the Edit modal where the cost is named.
 *
 * Responds with ids, not rows: the client refetches the trays either way (the
 * move changes both projects' counts and its neighbours' dependency links), so
 * what it needs here is the account of what happened, not the new rows.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ids?: unknown; project_id?: unknown } | null;
  const projectId = typeof body?.project_id === "string" ? body.project_id : "";
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : null;
  if (!ids || !projectId) return NextResponse.json({ error: "ids and project_id required" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "project not found" }, { status: 404 });

  // Null = the destination was deleted while we queued for the task locks.
  const result = await moveTasksToProject(ids, projectId);
  if (!result) return NextResponse.json({ error: "project not found" }, { status: 404 });
  return NextResponse.json({
    moved: result.moved.map((t) => t.id),
    unchanged: result.unchanged,
    skipped: result.skipped,
    dropped: result.dropped,
    kept: result.kept,
  });
}
