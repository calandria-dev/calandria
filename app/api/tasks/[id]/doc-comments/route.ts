import { NextResponse } from "next/server";
import { getTask, listTaskDocComments, addTaskDocComment } from "@/lib/store";

export const dynamic = "force-dynamic";

const SHA = /^[0-9a-f]{40}$/;

// List a task's document (collaboration modal) comments, optionally for one
// file — the modal only ever wants the document it has open.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const file = new URL(req.url).searchParams.get("file");
  return NextResponse.json({ comments: listTaskDocComments(id, file ? file : undefined) });
}

// File a passage comment: the rendered text the user selected, the nearest
// heading above it, the note, and the file's blob sha as the modal loaded it
// (anchorSha, from GET /file) — see TaskDocComment in lib/types.ts. Always
// created UNSENT: sending is a separate step (POST ./sent) taken when the
// user presses Send, because the packet that reaches the agent is built by
// the client from the whole draft list and goes through its runTurn path.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const payload = (await req.json().catch(() => null)) as
    | { file?: unknown; quote?: unknown; heading?: unknown; body?: unknown; anchorSha?: unknown }
    | null;
  if (!payload) return NextResponse.json({ error: "malformed request body" }, { status: 400 });

  const file = String(payload.file ?? "").trim();
  const quote = String(payload.quote ?? "").trim();
  const body = String(payload.body ?? "").trim();
  if (!file || !quote || !body) return NextResponse.json({ error: "file, quote and body are required" }, { status: 400 });
  const heading = typeof payload.heading === "string" && payload.heading.trim() ? payload.heading.trim() : null;
  const sha = typeof payload.anchorSha === "string" && SHA.test(payload.anchorSha) ? payload.anchorSha : null;
  const comment = addTaskDocComment(id, file, quote, heading, body, sha);
  return NextResponse.json({ ok: true, comment }, { status: 201 });
}
