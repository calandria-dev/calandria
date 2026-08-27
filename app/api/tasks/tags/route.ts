import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { addTaskTags, getTag, getTask, removeTaskTags, setTaskTags } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The three shapes the body may take, in the order they're checked. */
const VERBS = ["add", "remove", "set"] as const;

/**
 * Apply tags to a SELECTION of tasks — the bulk sibling of the `tag_ids` field
 * on PATCH /api/tasks/[id], and what the list's selection bar posts. Its own
 * route for the same reason POST /api/tasks/move is: tagging the seven
 * suggestions an agent filed before the tag existed was seven round trips, and
 * this is one write in one transaction.
 *
 * Three verbs rather than one, because many-to-many makes them different
 * questions. `add` and `remove` are what a selection bar means — the tasks in a
 * selection rarely carry the same tags, and `set` over a mixed selection would
 * silently strip the ones it didn't know about. `set` is still here for the
 * caller that really does mean "these and only these" (the edit dialog's batch
 * equivalent), and it says so in the body rather than being inferred.
 *
 * Whole-batch rather than per-task partial, unlike the move: tagging has
 * nothing to refuse per row (no worktree, no turn, nothing irreversible), so
 * the only failure is the caller's own — an unknown tag, or a task from another
 * project, which a tag may never span. Reporting those per row would leave a
 * half-tagged feature nobody asked for.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : null;
  if (!ids || ids.length === 0) return NextResponse.json({ error: "ids required" }, { status: 400 });

  const verb = VERBS.find((v) => Array.isArray(body?.[v]));
  if (!verb) return NextResponse.json({ error: `one of ${VERBS.join(", ")} must be an array of tag ids` }, { status: 400 });
  const tagIds = (body![verb] as unknown[]).filter((id): id is string => typeof id === "string");
  // `set: []` is the documented way to clear a selection's tags; add/remove
  // with nothing in them is a no-op the caller didn't mean, so it's refused
  // rather than reported as a successful write of nothing.
  if (verb !== "set" && tagIds.length === 0) return NextResponse.json({ error: `${verb} needs at least one tag id` }, { status: 400 });
  const unknown = tagIds.find((id) => !getTag(id));
  if (unknown) return NextResponse.json({ error: "no such tag" }, { status: 400 });

  // The projects to announce to, read BEFORE the write: a selection can span
  // trays, and the tray a suggestion sits in is the one whose chip bar has to
  // refresh.
  const projectIds = new Set(ids.map((id) => getTask(id)?.project_id).filter((p): p is string => !!p));

  let changed: string[];
  try {
    changed = verb === "add" ? addTaskTags(ids, tagIds) : verb === "remove" ? removeTaskTags(ids, tagIds) : setTaskTags(ids, tagIds);
  } catch (e) {
    // The store's own refusals: a tag from another project, or one deleted
    // between the check above and the write. Both are the caller's mistake, and
    // both left the batch untouched.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  // Membership moved, so every tag's derived counts did too. `tags_changed`
  // rather than N `task_edited`s: the client's answer to both is to refetch the
  // project, and eleven retagged tasks should cost that once. ("" keys the bus
  // because no single task published this — see lib/events.ts.)
  if (changed.length > 0) for (const projectId of projectIds) publishGlobal("", { type: "tags_changed", projectId });
  return NextResponse.json({ changed, tags: tagIds.map((id) => getTag(id)).filter(Boolean) });
}
