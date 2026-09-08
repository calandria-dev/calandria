import { NextResponse } from "next/server";
import { abortTurn } from "@/lib/abort";
import { clearPendingMessages } from "@/lib/store";
import { publish } from "@/lib/events";

export const dynamic = "force-dynamic";

// Signal the active turn for a task to stop. The streaming turn's loop exits,
// persists its partial transcript, and leaves the task awaiting_input (see the
// runner's finally block). No-op (aborted=false) if nothing is running.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const aborted = abortTurn(id);
  // Stop discards the parked queue, since those follow-ups were queued behind
  // the turn the user just interrupted. Clear it here, synchronously, rather
  // than only in the dying turn's finally: if a new turn starts before the
  // stopped one exits, that finally defers to the successor and would leave
  // pre-Stop follow-ups queued behind a turn they were never meant for.
  // Messages sent after this instant belong to whatever comes next.
  if (aborted) {
    for (const p of clearPendingMessages(id)) publish(id, { type: "dequeued", msgId: p.id });
  }
  return NextResponse.json({ ok: true, aborted });
}
