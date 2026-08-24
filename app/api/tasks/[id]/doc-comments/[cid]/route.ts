import { NextResponse } from "next/server";
import { getTask, deleteTaskDocComment } from "@/lib/store";

export const dynamic = "force-dynamic";

// Remove an unsent document comment (the × on a draft card). A sent comment is
// the record of what the agent was told and is refused with 409 — the modal
// renders those read-only, so this is the server-side half of that rule.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const res = deleteTaskDocComment(id, cid);
  if (res === "missing") return NextResponse.json({ error: "comment not found" }, { status: 404 });
  if (res === "sent") return NextResponse.json({ error: "a comment already sent to the agent can't be removed" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
