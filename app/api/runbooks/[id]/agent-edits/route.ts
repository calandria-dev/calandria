import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { publishGlobal } from "@/lib/events";
import {
  acknowledgeRunbookAgentEdits,
  getRunbook,
  getRunbookAgentEdit,
  hasOutstandingRunbookAgentEdits,
  listRunbookAgentEdits,
  markRunbookAgentEditReverted,
  schedulesUsing,
  updateRunbook,
} from "@/lib/runbooks/store";
import type { RunbookAgentEditChange, Runbook } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runbook = getRunbook(id);
  if (!runbook) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ runbook, edits: listRunbookAgentEdits(id) });
}

function staleFields(runbook: Runbook, changes: RunbookAgentEditChange[]): string[] {
  const stale: string[] = [];
  for (const change of changes) {
    const live = runbook[change.field as keyof Runbook];
    if (live !== change.after_value) stale.push(`${change.field} has changed since this edit`);
  }
  return stale;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRunbook(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { action?: string; edit_id?: string } | null;
  if (!body || typeof body.action !== "string") return NextResponse.json({ error: "action is required" }, { status: 400 });

  if (body.action === "ack") {
    acknowledgeRunbookAgentEdits(id);
    publishGlobal("", { type: "runbooks_changed", projectId: getRunbook(id)!.project_id });
    return NextResponse.json({ runbook: getRunbook(id), edits: listRunbookAgentEdits(id) });
  }

  if (body.action !== "revert") return NextResponse.json({ error: "action must be ack or revert" }, { status: 400 });
  if (typeof body.edit_id !== "string" || !body.edit_id) return NextResponse.json({ error: "edit_id is required" }, { status: 400 });
  const edit = getRunbookAgentEdit(body.edit_id);
  if (!edit) return NextResponse.json({ error: "no such edit" }, { status: 404 });
  if (edit.runbook_id !== id) return NextResponse.json({ error: "that edit belongs to another runbook" }, { status: 400 });
  if (edit.reverted_at > 0) return NextResponse.json({ error: "already reverted" }, { status: 400 });

  const db = getDb();
  const runbook = getRunbook(id)!;
  const stale = staleFields(runbook, edit.changes);
  if (stale.length) return NextResponse.json({ error: `${stale.join("; ")}. Revert newer edits first, or edit the runbook directly.` }, { status: 409 });
  const used = schedulesUsing(id);
  if (used.length) return NextResponse.json({ error: `This runbook is used by ${used.map((s) => s.name).join(", ")}; edit its schedule links first.` }, { status: 409 });

  const patch: Partial<Pick<Runbook, "name" | "description" | "prompt" | "permission_mode" | "priority" | "provider_id" | "model" | "send_context">> = {};
  for (const change of edit.changes) {
    if (change.before_value === null && (change.field === "provider_id" || change.field === "model" || change.field === "permission_mode")) {
      (patch as Record<string, unknown>)[change.field] = null;
    } else {
      (patch as Record<string, unknown>)[change.field] = change.before_value;
    }
  }
  db.transaction(() => {
    updateRunbook(id, patch);
    markRunbookAgentEditReverted(edit.id);
    if (!hasOutstandingRunbookAgentEdits(id)) db.prepare("UPDATE runbooks SET agent_edited_at = 0 WHERE id = ?").run(id);
  })();
  publishGlobal("", { type: "runbooks_changed", projectId: runbook.project_id });
  return NextResponse.json({ runbook: getRunbook(id), edits: listRunbookAgentEdits(id) });
}
