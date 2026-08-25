import { NextResponse } from "next/server";
import { getProject, getTask, getTaskDeps } from "@/lib/store";
import { moveTasksToProject, previewDiscard, UNSAFE_DISCARD_REASON } from "@/lib/taskMove";

export const dynamic = "force-dynamic";

/**
 * What moving this task would cost its checkout — the read behind the
 * confirmation the POST below demands. Git subprocesses, so it lives here
 * rather than on GET /api/tasks/[id], which every task selection hits.
 *
 * See lib/taskMove.ts previewDiscard: whether there's a worktree at all, and
 * whether removing it would lose anything (uncommitted edits, or commits the
 * base branch never absorbed). A clean merged worktree is the safe case.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preview = await previewDiscard(id);
  if (!preview) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(preview);
}

/**
 * Re-parent a task to another project. Its own route rather than a PATCH field
 * because a move isn't a field set: it renumbers the task's per-project
 * position, re-derives whatever it inherited from the old project, re-points
 * the project-keyed child rows that record its sessions and spend, and drops
 * the dependency edges that would otherwise span projects (task_dependencies
 * has no project column and setTaskDeps rejects cross-project edges, so those
 * rows would silently violate the invariant). The dropped ids come back in the
 * response so the caller can say what it cost.
 *
 * A STARTED task moves only with `discard_worktree` — the acknowledgement that
 * its checkout, cut from the old project's repo, is being thrown away so the
 * next turn can cut a fresh one from the destination. Everything that made the
 * move worth having (transcript, summaries, usage history) is task-keyed and
 * survives; see lib/store.ts moveTasks for what the row loses.
 *
 * When that checkout turns out to hold work — uncommitted edits, or commits the
 * base branch never absorbed — a second acknowledgement, `discard_unsafe`, is
 * required, and the 409 names what would be lost. Checked against the worktree
 * as it stands at teardown, not as the GET above described it, so nothing
 * unsaved is ever destroyed without having been named first.
 *
 * The eligibility check, the task locks it has to be atomic with, the teardown
 * and the event the change announces all live in lib/taskMove.ts, shared with
 * the bulk route — this one just translates a one-task result into the strict
 * manner it has always had: a refusal is a 409, not a report. (POST
 * /api/tasks/move is the same operation for a selection, where a refusal is a
 * line item instead, and where both acknowledgements are lists of ids — one per
 * worktree the user answered for.)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { project_id?: unknown; discard_worktree?: unknown; discard_unsafe?: unknown }
    | null;
  const projectId = typeof body?.project_id === "string" ? body.project_id : "";
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!getProject(projectId)) return NextResponse.json({ error: "project not found" }, { status: 404 });

  // The operation takes the acknowledgements per id, since a selection can
  // answer for some of its tasks and not others; one task's answer is that
  // list with one entry in it.
  const result = await moveTasksToProject([id], projectId, {
    discardWorktree: body?.discard_worktree === true ? [id] : [],
    // Only meaningful alongside the first acknowledgement, and the operation
    // reads it that way — but never infer one from the other: they answer
    // different questions ("drop the checkout" vs "drop the work in it").
    discardUnsafe: body?.discard_unsafe === true ? [id] : [],
  });
  // The destination was deleted while we queued for the task lock.
  if (!result) return NextResponse.json({ error: "project not found" }, { status: 404 });
  // The one task didn't move. Deleted between the check above and the lock is a
  // 404; anything else is the point-of-no-return refusal, which the caller is
  // expected to show the user verbatim. `needs_discard_unsafe` flags the one
  // refusal the user can answer without changing anything — the client re-reads
  // the preview, names the work, and asks again.
  const refused = result.skipped[0];
  if (refused)
    return NextResponse.json(
      {
        error: refused.reason,
        ...(refused.reason.startsWith(UNSAFE_DISCARD_REASON) ? { needs_discard_unsafe: true } : {}),
      },
      { status: refused.reason === "task not found" ? 404 : 409 }
    );
  // Already there: nothing happened, so re-read and report the row as it stands.
  const moved = result.moved[0];
  if (!moved)
    return NextResponse.json({ ...getTask(id)!, depends_on: getTaskDeps(id), dropped_blockers: [], dropped_dependents: [], discarded: null });
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
    // What the teardown destroyed, so the caller can say so rather than leaving
    // the user to notice. Null when the move needed no teardown.
    discarded: result.discarded[0] ?? null,
    // The group half of the same account. A task moving alone takes its group
    // with it only when it was the group's ONLY member (the container follows
    // its whole contents, never part of them); otherwise it leaves the group
    // behind and the name says which feature it just stepped out of.
    dropped_group: result.ungrouped[0]?.group_name ?? null,
    carried_group: result.carried[0] ?? null,
  });
}
