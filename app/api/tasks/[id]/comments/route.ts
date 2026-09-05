import { NextResponse } from "next/server";
import { getTask, listTaskComments, addTaskComment } from "@/lib/store";

export const dynamic = "force-dynamic";

// List review comments for a task's diff (Changes tab).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ comments: listTaskComments(id) });
}

// File a review comment anchored to a file, side, and line range, stamped with
// the diff HEAD (anchorSha) it was written against; see TaskComment in
// lib/types.ts for why both exist. sentToAgent only marks the row. The caller
// (TaskChanges) is responsible for starting the turn, since that path runs
// through the client's runTurn to keep local running state in sync.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const payload = (await req.json().catch(() => null)) as
    | { file?: unknown; side?: unknown; lineStart?: unknown; lineEnd?: unknown; body?: unknown; sentToAgent?: unknown; anchorSha?: unknown }
    | null;
  if (!payload) return NextResponse.json({ error: "malformed request body" }, { status: 400 });

  const { file, side, lineStart, lineEnd, body, sentToAgent, anchorSha } = payload;
  const f = String(file ?? "").trim();
  const text = String(body ?? "").trim();
  if (!f || !text) return NextResponse.json({ error: "file and body are required" }, { status: 400 });
  if (typeof lineStart !== "number" || !Number.isFinite(lineStart) || typeof lineEnd !== "number" || !Number.isFinite(lineEnd)) {
    return NextResponse.json({ error: "lineStart and lineEnd must be numbers" }, { status: 400 });
  }
  const s = side === "old" ? "old" : "new";
  const ls = Math.max(1, Math.trunc(lineStart));
  const le = Math.max(ls, Math.trunc(lineEnd));
  const sha = typeof anchorSha === "string" && /^[0-9a-f]{40}$/.test(anchorSha) ? anchorSha : null;
  const comment = addTaskComment(id, f, s, ls, le, text, !!sentToAgent, sha);
  return NextResponse.json({ ok: true, comment }, { status: 201 });
}
