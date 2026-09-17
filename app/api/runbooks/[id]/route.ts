import { NextResponse } from "next/server";
import { publishGlobal } from "@/lib/events";
import { deleteRunbook, getRunbook, lastRunOf, schedulesUsing, updateRunbook } from "@/lib/runbooks/store";
import { getProvider } from "@/lib/providers/store";
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
  // Same screen as the task routes': a provider must exist, and model is a
  // shape check only (provider-native ids and inference-profile ARNs are the
  // driver's business); a control character would reach a spawned process.
  if ("provider_id" in body && body.provider_id !== null && (typeof body.provider_id !== "string" || !getProvider(body.provider_id)))
    return NextResponse.json({ error: "valid provider_id required" }, { status: 400 });
  if ("model" in body && body.model !== null) {
    if (typeof body.model !== "string") return NextResponse.json({ error: "model must be a string or null" }, { status: 400 });
    if (body.model.length > 2048 || /[\0-\x1f\x7f]/.test(body.model))
      return NextResponse.json({ error: "invalid model id" }, { status: 400 });
  }
  const fields: Record<string, unknown> = {};
  for (const k of ["name", "description", "prompt", "agent", "permission_mode", "priority", "position", "provider_id"]) {
    if (body[k] !== undefined) fields[k] = body[k];
  }
  if (body.model !== undefined) fields.model = typeof body.model === "string" ? (body.model.trim() || null) : null;
  if (body.send_context !== undefined) fields.send_context = body.send_context ? 1 : 0;
  const runbook = updateRunbook(id, fields);
  publishGlobal("", { type: "runbooks_changed", projectId: before.project_id });
  return NextResponse.json(runbook);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const before = getRunbook(id);
  if (!before) return NextResponse.json({ error: "no such runbook" }, { status: 404 });
  // Hard delete. A linked schedule keeps working because deleteRunbook copies
  // the recipe back into it first, in the same transaction. The tasks it
  // dispatched survive too.
  deleteRunbook(id);
  publishGlobal("", { type: "runbooks_changed", projectId: before.project_id });
  return NextResponse.json({ ok: true });
}
