import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { getGroup, getTask, setTaskGroup } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Assign (or clear) the group on a SELECTION of tasks — the bulk sibling of the
 * `group_id` field on PATCH /api/tasks/[id], and what the list's selection bar
 * posts. Its own route for the same reason POST /api/tasks/move is: regrouping
 * the seven suggestions an agent filed before the group existed was seven
 * round trips, and this is one write in one transaction.
 *
 * Whole-batch rather than per-task partial, unlike the move: assigning a group
 * has nothing to refuse per row (no worktree, no turn, nothing irreversible),
 * so the only failure is the caller's own — an unknown group, or a task from
 * another project, which a group may never span. Reporting those per row would
 * leave a half-grouped feature nobody asked for.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { ids?: unknown; group_id?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : null;
  if (!ids || ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });
  const gid = body?.group_id;
  if (gid !== null && gid !== undefined && typeof gid !== "string")
    return NextResponse.json({ error: "group_id must be a string or null" }, { status: 400 });
  const groupId = typeof gid === "string" && gid ? gid : null;
  if (groupId && !getGroup(groupId)) return NextResponse.json({ error: "no such group" }, { status: 400 });

  // The projects to announce to, read BEFORE the write: a task that was in a
  // group is leaving that project's chip bar counts alone (a group can't span
  // projects, so this is the same project either way), but a selection can span
  // trays — the tray a suggestion sits in is the one whose bar has to refresh.
  const projectIds = new Set(ids.map((id) => getTask(id)?.project_id).filter((p): p is string => !!p));

  let changed: string[];
  try {
    changed = setTaskGroup(ids, groupId);
  } catch (e) {
    // setTaskGroup's own refusals: a group from another project, or one that
    // was deleted between the check above and the write. Both are the caller's
    // mistake, and both left the batch untouched.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  // Membership moved, so every group's derived counts did too. `task_groups_changed`
  // rather than N `task_edited`s: the client's answer to both is to refetch the
  // project, and eleven regrouped tasks should cost that once. ("" keys the bus
  // because no single task published this — see lib/events.ts.)
  if (changed.length > 0) for (const projectId of projectIds) publishGlobal("", { type: "task_groups_changed", projectId });
  return NextResponse.json({ changed, group: groupId ? getGroup(groupId) : null });
}
