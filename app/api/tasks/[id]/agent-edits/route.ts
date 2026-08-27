import { NextResponse } from "next/server";
import { getTask, listAgentEdits, getAgentEdit, markAgentEditReverted, hasUnrevertedAgentEdits, clearAgentEditFlag, updateTask, setTaskDeps } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import type { AgentEditChange, Priority, Status, Task } from "@/lib/types";

export const dynamic = "force-dynamic";

// Terminal = no longer blocking anything, the same pair lib/autoStart's blocks()
// uses and PATCH /api/tasks/[id] repeats.
const isTerminal = (s: string) => s === "done" || s === "cancelled";

// The read side of the "changed since you accepted it" chip: the full history
// behind one task's rows in task_agent_edits, newest first — what the diff
// panel renders when the user opens it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ edits: listAgentEdits(id) });
}

/**
 * Fold one AgentEditChange's `before_value` into the patch that restores it —
 * every field except `blocked_by`, which POST handles separately (a cycle
 * failure there has to become a 409 with the row untouched, not a column
 * write). Accumulated into ONE patch rather than written per field: a revert of
 * a four-field edit is one user action and should be one row write, so a
 * listener refetching on task_edited can never catch it half-applied.
 */
function foldScalarChange(patch: Partial<Task>, change: AgentEditChange): void {
  switch (change.field) {
    case "title":
      patch.title = change.before_value as string;
      break;
    case "description":
      patch.description = change.before_value as string;
      break;
    case "priority":
      patch.priority = change.before_value as Priority;
      break;
    case "status":
      patch.status = change.before_value as Status;
      break;
    case "group":
      patch.group_id = change.before_value as string | null;
      break;
    case "blocked_by":
      break;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { action?: string; edit_id?: string } | null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "action is required" }, { status: 400 });

  if (body.action === "ack") {
    // Acknowledging clears the chip WITHOUT touching history — the audit trail
    // (task_agent_edits) always outlives it, so "I've seen this" and "undo
    // this" stay two separate actions even though both can clear the badge.
    clearAgentEditFlag(id);
    publishGlobal(id, { type: "task_edited" });
    return NextResponse.json({ task: getTask(id) });
  }

  if (body.action === "revert") {
    if (typeof body.edit_id !== "string" || !body.edit_id) return NextResponse.json({ error: "edit_id is required" }, { status: 400 });
    const edit = getAgentEdit(body.edit_id);
    if (!edit) return NextResponse.json({ error: "no such edit" }, { status: 404 });
    if (edit.task_id !== id) return NextResponse.json({ error: "that edit belongs to another task" }, { status: 400 });
    if (edit.reverted_at > 0) return NextResponse.json({ error: "already reverted" }, { status: 400 });

    // Revert writes `before_value` UNCONDITIONALLY, never checking the field
    // still holds `after` — the user is looking at the CURRENT value in the
    // diff panel when they press the button, so their intent is "make it this
    // again", not a compare-and-swap against whatever this one edit changed.
    //
    // Deps first, exactly like updateTaskForAgent orders edges before fields:
    // a cycle can have appeared since this edit landed (a later edit, or a
    // manual change), and a refusal here must leave the row completely
    // untouched rather than half-reverted under a 200.
    const depsChange = edit.changes.find((c) => c.field === "blocked_by");
    if (depsChange) {
      try {
        setTaskDeps(id, depsChange.before_value as string[]);
      } catch (e) {
        // Only a cycle reaches here. A blocker id that no longer exists is
        // silently dropped by setTaskDeps — that's fine, don't fight it.
        return NextResponse.json({ error: e instanceof Error ? e.message : "invalid dependencies" }, { status: 409 });
      }
    }
    const prevStatus = getTask(id)!.status;
    const patch: Partial<Task> = {};
    for (const change of edit.changes) foldScalarChange(patch, change);
    if (Object.keys(patch).length) updateTask(id, patch);

    markAgentEditReverted(edit.id);
    // Putting a status back can itself be a non-terminal → terminal transition
    // (an agent moved a done task to in_progress; the user disagrees), and that
    // is exactly what "Start when unblocked" waits on — the same rule PATCH
    // /api/tasks/[id] follows. Without this, undoing the agent's change would
    // leave every auto_start dependent unblocked but never launched.
    if (isTerminal(getTask(id)!.status) && !isTerminal(prevStatus)) maybeAutoStartDependents(id);
    // Only the LAST outstanding edit reverting clears the chip — an earlier
    // one in the history may still be applied and unacknowledged.
    if (!hasUnrevertedAgentEdits(id)) clearAgentEditFlag(id);

    publishGlobal(id, { type: "task_edited" });
    // One response carries both the refreshed row and the refreshed history,
    // so the client can re-render the whole panel without a second round trip.
    return NextResponse.json({ task: getTask(id), edits: listAgentEdits(id) });
  }

  return NextResponse.json({ error: `unknown action "${body.action}"` }, { status: 400 });
}
