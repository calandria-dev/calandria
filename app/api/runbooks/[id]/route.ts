import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { deleteRunbook, getRunbook, lastRunOf, schedulesUsing, updateRunbook } from "@/lib/runbooks/store";
import { PRIORITIES } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runbook = getRunbook(id);
  if (!runbook) return NextResponse.json({ error: "no such runbook" }, { status: 404 });
  return NextResponse.json({ runbook, last_run: lastRunOf(id), used_by: schedulesUsing(id) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getRunbook(id);
  if (!before) return NextResponse.json({ error: "no such runbook" }, { status: 404 });
  const body = await req.json();
  // priority has a fixed legal set and no CHECK constraint behind it; the
  // other fields copied below are free-form strings the driver resolves.
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) {
    return NextResponse.json({ error: `priority must be one of: ${PRIORITIES.join(", ")}` }, { status: 400 });
  }
  const fields: Record<string, unknown> = {};
  for (const k of ["name", "description", "prompt", "agent", "permission_mode", "priority", "position"]) {
    if (body[k] !== undefined) fields[k] = body[k];
  }
  if (body.send_context !== undefined) fields.send_context = body.send_context ? 1 : 0;
  const runbook = updateRunbook(id, fields);
  publishGlobal("", { type: "runbooks_changed", projectId: before.project_id });
  return NextResponse.json(runbook);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getRunbook(id);
  if (!before) return NextResponse.json({ error: "no such runbook" }, { status: 404 });
  // Hard delete, like everything else here — but a linked schedule keeps
  // working: deleteRunbook copies the recipe back into it first, in the same
  // transaction. The tasks it dispatched survive too.
  deleteRunbook(id);
  publishGlobal("", { type: "runbooks_changed", projectId: before.project_id });
  return NextResponse.json({ ok: true });
}
