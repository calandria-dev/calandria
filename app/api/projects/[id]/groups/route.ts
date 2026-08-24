import { NextResponse } from "next/server";
import { getProject, listGroups, createGroup, GroupNameConflictError } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { parseGroupColor } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The project's groups with their derived counts — the same rows the project GET embeds. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  return NextResponse.json({ groups: listGroups(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getProject(id)) return NextResponse.json({ error: "no such project" }, { status: 404 });
  const body = await req.json();
  // Type-checked, not just optional-chained, for the same reason the runbooks
  // POST is: a non-string name would sail past `?.trim()` into a 500.
  if (typeof body?.name !== "string" || !body.name.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  const color = parseGroupColor(body.color);
  if (!color.ok) return NextResponse.json({ error: color.error }, { status: 400 });
  try {
    const group = createGroup({
      project_id: id,
      name: body.name,
      description: typeof body.description === "string" ? body.description : "",
      color: color.color,
    });
    // "" because no task published this — see the task_groups_changed note in lib/events.ts.
    publishGlobal("", { type: "task_groups_changed", projectId: id });
    return NextResponse.json(group, { status: 201 });
  } catch (e) {
    // UNIQUE(project_id, name): a duplicate is a conflict the caller can fix
    // by picking the existing group, so it says which name collided.
    if (e instanceof GroupNameConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
