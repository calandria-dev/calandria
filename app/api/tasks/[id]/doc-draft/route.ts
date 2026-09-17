import { NextResponse } from "next/server";
import { getTask, getTaskDocDraft, putTaskDocDraft, deleteTaskDocDraft } from "@/lib/store";

export const dynamic = "force-dynamic";

const SHA = /^[0-9a-f]{40}$/;

// The modal-local draft for one (task, file): the Edit tab's text and the
// General comments note, one row rather than one per passage (that's
// task_doc_comments). Autosaved by the modal on every change so a rail
// collapse or a reload doesn't lose them, and cleared on Send. A PUT with
// nothing in it (no edit, empty note) deletes the row.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const file = new URL(req.url).searchParams.get("file");
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });
  return NextResponse.json({ draft: getTaskDocDraft(id, file) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const payload = (await req.json().catch(() => null)) as
    | { file?: unknown; text?: unknown; general?: unknown; anchorSha?: unknown }
    | null;
  if (!payload) return NextResponse.json({ error: "malformed request body" }, { status: 400 });

  const file = String(payload.file ?? "").trim();
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });

  if (payload.text !== undefined && payload.text !== null && typeof payload.text !== "string") {
    return NextResponse.json({ error: "text must be a string or null" }, { status: 400 });
  }
  const text = payload.text === undefined ? null : payload.text;

  if (payload.general !== undefined && typeof payload.general !== "string") {
    return NextResponse.json({ error: "general must be a string" }, { status: 400 });
  }
  const general = payload.general === undefined ? "" : payload.general;

  const anchorSha = typeof payload.anchorSha === "string" && SHA.test(payload.anchorSha) ? payload.anchorSha : null;

  const draft = putTaskDocDraft(id, file, { text, general, anchorSha });
  return NextResponse.json({ ok: true, draft });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const file = new URL(req.url).searchParams.get("file");
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });
  return NextResponse.json({ ok: true, deleted: deleteTaskDocDraft(id, file) });
}
