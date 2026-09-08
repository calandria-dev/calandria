import { NextResponse } from "next/server";
import { getTask, markTaskDocCommentsSent } from "@/lib/store";

export const dynamic = "force-dynamic";

// Mark a set of the task's document comments as sent to the agent. The modal
// calls this with every draft folded into the packet, right before handing
// the packet to the chat path: one call for the whole Send, so the rows flip
// together. `updated` is how many rows actually changed; ids that belong to
// another task, do not exist, or were already sent are skipped instead of
// raising an error, since the packet is being sent either way.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const payload = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!payload || !Array.isArray(payload.ids) || !payload.ids.every((x) => typeof x === "string")) {
    return NextResponse.json({ error: "ids must be an array of comment ids" }, { status: 400 });
  }
  const updated = markTaskDocCommentsSent(id, payload.ids as string[]);
  return NextResponse.json({ ok: true, updated });
}
