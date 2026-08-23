import { NextResponse } from "next/server";
import { getTask, listTaskComments, addTaskComment } from "@/lib/store";

export const dynamic = "force-dynamic";

// List review comments for a task's diff (Changes tab).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ comments: listTaskComments(id) });
}

// File a review comment anchored to a file + line range. sentToAgent only
// marks the row — the caller (TaskChanges) is responsible for actually
// starting the turn, since that path runs through the client's runTurn to
// keep local running state in sync.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { file, lineStart, lineEnd, body, sentToAgent } = await req.json();
  const f = String(file ?? "").trim();
  const text = String(body ?? "").trim();
  if (!f || !text) return NextResponse.json({ error: "file and body are required" }, { status: 400 });
  const ls = Number.isFinite(lineStart) ? Math.max(1, Math.trunc(lineStart)) : 1;
  const le = Number.isFinite(lineEnd) ? Math.max(ls, Math.trunc(lineEnd)) : ls;
  const comment = addTaskComment(id, f, ls, le, text, !!sentToAgent);
  return NextResponse.json({ ok: true, comment }, { status: 201 });
}
