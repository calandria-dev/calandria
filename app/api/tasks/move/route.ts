import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";
import { moveTasksToProject, previewDiscards } from "@/lib/taskMove";

export const dynamic = "force-dynamic";

/**
 * What moving each of these tasks would cost its checkout — the batch sibling
 * of GET /api/tasks/[id]/move, and the read behind the per-row acknowledgements
 * the POST below demands. `?ids=a,b,c`; the answer is keyed by id, with unknown
 * ones absent rather than fatal (a selection can go stale while a modal is
 * open, and the move reports those anyway).
 *
 * Its own request rather than N calls to the single route for the obvious
 * reason — a selection of eleven is eleven round trips — and its own route
 * rather than riding along on the task list because the answer costs git
 * subprocesses per STARTED task. Tasks with no checkout, which is most of any
 * selection, are answered without touching git.
 */
export async function GET(req: Request) {
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });
  return NextResponse.json({ previews: await previewDiscards(ids) });
}

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
 * A STARTED task moves here too, by destroying the checkout it cut from the old
 * repo — but the acknowledgement is a LIST OF IDS, never a flag over the batch.
 * `discard_worktree` names the tasks whose worktree may be torn down and
 * `discard_unsafe` those whose unsaved work was shown and accepted; each is one
 * row's answer about one worktree, given with that worktree's cost on screen
 * (GET above). One checkbox over eleven of them would be a shrug, not consent —
 * eleven answers over eleven worktrees is the thing itself. A boolean is
 * therefore not accepted: a caller sending the single route's `true` gets the
 * ordinary started-task refusal, not a shortcut past the question.
 *
 * Partial by the same manner as everything else here: three dirty worktrees in
 * a selection of eleven don't refuse the eight. The three are reported in
 * `skipped` — including one that picked up unsaved work after its preview was
 * taken, since the teardown re-reads and that answer no longer describes it.
 *
 * Responds with ids, not rows: the client refetches the trays either way (the
 * move changes both projects' counts and its neighbours' dependency links), so
 * what it needs here is the account of what happened, not the new rows —
 * `discarded` being the part of that account nobody can get back.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { ids?: unknown; project_id?: unknown; discard_worktree?: unknown; discard_unsafe?: unknown }
    | null;
  const projectId = typeof body?.project_id === "string" ? body.project_id : "";
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : null;
  if (!ids || !projectId) return NextResponse.json({ error: "ids and project_id required" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "project not found" }, { status: 404 });
  const idList = (v: unknown) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : []);

  // Null = the destination was deleted while we queued for the task locks.
  const result = await moveTasksToProject(ids, projectId, {
    discardWorktree: idList(body?.discard_worktree),
    discardUnsafe: idList(body?.discard_unsafe),
  });
  if (!result) return NextResponse.json({ error: "project not found" }, { status: 404 });
  return NextResponse.json({
    moved: result.moved.map((t) => t.id),
    unchanged: result.unchanged,
    skipped: result.skipped,
    dropped: result.dropped,
    kept: result.kept,
    // What the teardowns destroyed, per task, so the modal can say what it cost
    // rather than leaving the user to notice a branch missing.
    discarded: result.discarded,
    // The tag account, on the same footing as `dropped`/`kept`: a tag whose
    // every member was selected travels with them (renamed when the destination
    // already had that name), and one selected in part is left behind by the
    // rows that went.
    untagged: result.untagged,
    carried: result.carried,
  });
}
