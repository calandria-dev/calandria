import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { getGroup, updateGroup, deleteGroup, GroupNameConflictError } from "@/lib/store";
import { parseGroupColor } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const group = getGroup(id);
  if (!group) return NextResponse.json({ error: "no such group" }, { status: 404 });
  return NextResponse.json(group);
}

/** Rename, describe, recolor. Membership is NOT here — that's a task edit (PATCH /api/tasks/[id] group_id). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getGroup(id);
  if (!before) return NextResponse.json({ error: "no such group" }, { status: 404 });
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
    const color = parseGroupColor(body.color);
    if (!color.ok) return NextResponse.json({ error: color.error }, { status: 400 });
    fields.color = color.color;
  }
  if (body.position !== undefined) {
    if (typeof body.position !== "number" || !Number.isInteger(body.position)) return NextResponse.json({ error: "position must be an integer" }, { status: 400 });
    fields.position = body.position;
  }
  try {
    const group = updateGroup(id, fields);
    publishGlobal("", { type: "task_groups_changed", projectId: before.project_id });
    return NextResponse.json(group);
  } catch (e) {
    if (e instanceof GroupNameConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

/** Hard delete. Members are ungrouped (tasks.group_id ON DELETE SET NULL), never deleted. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getGroup(id);
  if (!before) return NextResponse.json({ error: "no such group" }, { status: 404 });
  deleteGroup(id);
  publishGlobal("", { type: "task_groups_changed", projectId: before.project_id });
  // Membership changed on every former member, but no task_edited fires per
  // row: the client refetches the whole project on task_groups_changed, which
  // re-reads the rows' now-null group_id along with the chip bar.
  return NextResponse.json({ ok: true, ungrouped: before.counts.total });
}
