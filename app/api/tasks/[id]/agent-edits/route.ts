import { NextResponse } from "next/server";
import { getProject, getTask, getTaskDeps, getTag, getTaskTagIds, setTaskTags, listAgentEdits, getAgentEdit, markAgentEditReverted, hasOutstandingAgentEdits, clearAgentEditFlag, acknowledgeAgentEdits, updateTask, setTaskDeps } from "@/lib/store";
import { setTaskBaseBranch } from "@/lib/baseBranch";
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
 * every field except `blocked_by`, `tags` and `base_branch`, which POST handles
 * separately (the first two live in their own tables; the third has to go back
 * through the same git reconciliation that set it, since a raw column write
 * would leave `base_sha` describing a branch the task is no longer on). A
 * failure in any of the three has to become a 409 with the row untouched.
 * Accumulated into ONE patch rather than written per field: a revert of a
 * four-field edit is one user action and should be one row write, so a
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
    case "tags":
    case "blocked_by":
    case "base_branch":
      break;
  }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * The fields of an edit whose live value no longer matches what the edit left
 * behind, each rendered for the refusal. Scalars compare through `after` (raw
 * there); tags and blocked_by need `after_value`, and a row recorded before
 * that existed is reverted unchecked for those two, as it always was.
 */
function staleFields(task: Task, changes: AgentEditChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    switch (c.field) {
      case "title":
      case "description":
      case "priority":
      case "status":
        if (task[c.field] !== c.after) out.push(`${c.field} is now "${task[c.field]}"`);
        break;
      case "tags":
        if (Array.isArray(c.after_value) && !sameSet(getTaskTagIds(task.id), c.after_value)) out.push("tags have changed");
        break;
      case "blocked_by":
        if (Array.isArray(c.after_value) && !sameSet(getTaskDeps(task.id), c.after_value)) out.push("blocked_by has changed");
        break;
      case "base_branch":
        // The RAW column, not `after` — that one is the resolved name for
        // reading ("main" where the column says ""), and comparing against it
        // would call an untouched task stale the moment its pin was cleared.
        if (typeof c.after_value === "string" && task.base_branch !== c.after_value)
          out.push(`the base branch is now "${task.base_branch || "inherited"}"`);
        break;
    }
  }
  return out;
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
    acknowledgeAgentEdits(id);
    publishGlobal(id, { type: "task_edited" });
    return NextResponse.json({ task: getTask(id) });
  }

  if (body.action === "revert") {
    if (typeof body.edit_id !== "string" || !body.edit_id) return NextResponse.json({ error: "edit_id is required" }, { status: 400 });
    const edit = getAgentEdit(body.edit_id);
    if (!edit) return NextResponse.json({ error: "no such edit" }, { status: 404 });
    if (edit.task_id !== id) return NextResponse.json({ error: "that edit belongs to another task" }, { status: 400 });
    if (edit.reverted_at > 0) return NextResponse.json({ error: "already reverted" }, { status: 400 });

    // Compare-and-swap, not an unconditional write. The panel shows what THIS
    // edit changed, not the live row, so a field the user (or a later agent
    // edit) has since moved on would be silently overwritten by an older
    // before_value — a rename to C lost to a revert of A→B, or two stacked
    // edits A→B→C reverted oldest-first landing on B with both rows marked
    // reverted. Refuse with the current value instead; reverting newest-first
    // still walks the whole stack back.
    const stale = staleFields(getTask(id)!, edit.changes);
    if (stale.length) {
      return NextResponse.json(
        { error: `${stale.join("; ")}: changed since this edit, so reverting it would overwrite a later change. Revert newer edits first, or edit the task directly.` },
        { status: 409 }
      );
    }

    // The base branch goes FIRST, before anything is written: putting it back
    // re-runs the whole retarget (git, a possible reset --hard, a branch that
    // may since have been deleted or checked out elsewhere), so it is by far the
    // likeliest half to refuse — and a refusal has to leave the edit entirely
    // un-reverted rather than land its other fields. Routed through
    // setTaskBaseBranch, never a column write: an UPDATE would restore the name
    // while leaving base_sha pointing at a commit on the branch being left.
    const baseChange = edit.changes.find((c) => c.field === "base_branch");
    if (baseChange) {
      const task = getTask(id)!;
      const project = getProject(task.project_id);
      if (!project) return NextResponse.json({ error: "that task's project no longer exists" }, { status: 409 });
      // "" is a real value here — the edit may have pinned a task that was
      // inheriting, and setTaskBaseBranch reconciles that case too.
      const back = await setTaskBaseBranch(task, project, typeof baseChange.before_value === "string" ? baseChange.before_value : "");
      if (!back.ok)
        return NextResponse.json(
          { error: `could not put the base branch back: ${back.error} Nothing was reverted. Set it by hand from the task's edit dialog.` },
          { status: 409 }
        );
    }

    // Deps next, exactly like updateTaskForAgent orders edges before fields:
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
    // Tags next, for the same reason and with the same failure shape: setTaskTags
    // refuses a tag that has since been deleted or moved, and that refusal must
    // not land on top of a half-applied revert.
    const tagsChange = edit.changes.find((c) => c.field === "tags");
    if (tagsChange) {
      try {
        // A tag deleted since the edit is dropped rather than refused — the
        // same tolerance setTaskDeps shows a vanished blocker.
        setTaskTags([id], (tagsChange.before_value as string[]).filter((tagId) => !!getTag(tagId)));
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "invalid tags" }, { status: 409 });
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
    // one in the history may still be applied and unacknowledged. (Acked rows
    // don't count: that's what acknowledged_at is for.)
    if (!hasOutstandingAgentEdits(id)) clearAgentEditFlag(id);

    publishGlobal(id, { type: "task_edited" });
    // One response carries both the refreshed row and the refreshed history,
    // so the client can re-render the whole panel without a second round trip.
    return NextResponse.json({ task: getTask(id), edits: listAgentEdits(id) });
  }

  return NextResponse.json({ error: `unknown action "${body.action}"` }, { status: 400 });
}
