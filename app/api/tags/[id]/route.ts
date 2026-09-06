import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { refNameSafe } from "@/lib/git";
import { getTag, updateTag, deleteTag, TagNameConflictError } from "@/lib/store";
import { parseTagColor } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tag = getTag(id);
  if (!tag) return NextResponse.json({ error: "no such tag" }, { status: 404 });
  return NextResponse.json(tag);
}

/**
 * Rename, describe, recolor, or set the base branch a whole plan is cut from.
 * Membership is not here: that's a task edit (PATCH /api/tasks/[id] tag_ids).
 *
 * `base_branch` is validated as a branch-shaped string and nothing more. Unlike
 * `POST /api/tasks/[id]/base-branch` this touches no git, because a tag has no
 * worktree to reconcile and its members may be in any state. It is a default
 * for cuts that haven't happened yet, so a branch that doesn't exist yet, such
 * as the integration branch the plan is about to create, must be settable now.
 * The name check is what stops `--upload-pack=evil` reaching a `git` argv
 * later.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getTag(id);
  if (!before) return NextResponse.json({ error: "no such tag" }, { status: 404 });
  const body = await req.json();
  const fields: { name?: string; description?: string; color?: string | null; base_branch?: string; position?: number } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    fields.name = body.name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    fields.description = body.description;
  }
  if (body.color !== undefined) {
    const color = parseTagColor(body.color);
    if (!color.ok) return NextResponse.json({ error: color.error }, { status: 400 });
    fields.color = color.color;
  }
  if (body.base_branch !== undefined) {
    if (typeof body.base_branch !== "string") return NextResponse.json({ error: "base_branch must be a string" }, { status: 400 });
    const want = body.base_branch.trim();
    // "" clears it back to "members follow the project".
    if (want && !refNameSafe(want)) return NextResponse.json({ error: `"${want}" isn't a usable git branch name.` }, { status: 400 });
    fields.base_branch = want;
  }
  if (body.position !== undefined) {
    if (typeof body.position !== "number" || !Number.isInteger(body.position)) return NextResponse.json({ error: "position must be an integer" }, { status: 400 });
    fields.position = body.position;
  }
  try {
    const tag = updateTag(id, fields);
    publishGlobal("", { type: "tags_changed", projectId: before.project_id });
    return NextResponse.json(tag);
  } catch (e) {
    if (e instanceof TagNameConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

/**
 * Hard delete. The tasks carrying the tag are untagged (task_tags is ON DELETE
 * CASCADE), never deleted, and each keeps whatever other tags it had: a deleted
 * tag removes exactly one label from a task, not its whole membership.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getTag(id);
  if (!before) return NextResponse.json({ error: "no such tag" }, { status: 404 });
  deleteTag(id);
  publishGlobal("", { type: "tags_changed", projectId: before.project_id });
  // Membership changed on every former member, but no task_edited fires per
  // row: the client refetches the whole project on tags_changed, which
  // re-reads the rows' now-shorter tag lists along with the chip bar.
  return NextResponse.json({ ok: true, untagged: before.counts.total });
}
