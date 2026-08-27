import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { getTag, updateTag, deleteTag, TagNameConflictError } from "@/lib/store";
import { parseTagColor } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tag = getTag(id);
  if (!tag) return NextResponse.json({ error: "no such tag" }, { status: 404 });
  return NextResponse.json(tag);
}

/** Rename, describe, recolor. Membership is NOT here — that's a task edit (PATCH /api/tasks/[id] tag_ids). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getTag(id);
  if (!before) return NextResponse.json({ error: "no such tag" }, { status: 404 });
  const body = await req.json();
  const fields: { name?: string; description?: string; color?: string | null; position?: number } = {};
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
 * Hard delete. The tasks carrying the tag are UNTAGGED (task_tags is ON DELETE
 * CASCADE), never deleted, and each keeps whatever OTHER tags it had — which is
 * the difference from the one-container-per-task version of this feature: a
 * deleted tag takes exactly one label off a task, not its whole membership.
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
