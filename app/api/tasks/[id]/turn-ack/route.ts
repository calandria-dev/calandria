import { NextResponse } from "next/server";
import { acknowledgeTurnResult, getTask } from "@/lib/store";
import { hasTurn } from "@/lib/abort";
import { publishGlobal } from "@/lib/events";
import { withTaskLock } from "@/lib/taskLock";

export const dynamic = "force-dynamic";

const err = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message, retryable: false } }, { status });

// Acknowledge a finished turn's result for exactly one turn (the Work Center
// turn_result item). Refused while a turn is live, and when a newer turn has
// finished since the item was read, so an acknowledgement never clears a
// result the person has not seen. The check and the write share one task
// lock, and the row is persisted before the event publishes.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return err(404, "not_found", "task not found");
  const body = (await req.json().catch(() => null)) as { turnId?: unknown } | null;
  if (!body || typeof body.turnId !== "string") return err(400, "invalid_request", "turnId is required");
  const turnId = body.turnId;

  const outcome = await withTaskLock(id, async () => {
    if (!getTask(id)) return "gone" as const;
    if (hasTurn(id)) return "changed" as const;
    return acknowledgeTurnResult(id, turnId) ? ("ok" as const) : ("changed" as const);
  });
  if (outcome === "gone") return err(404, "not_found", "task not found");
  if (outcome === "changed") return err(409, "source_changed", "that turn is no longer the latest finished turn");
  publishGlobal(id, { type: "task_edited" });
  return NextResponse.json({ ok: true, turnId });
}
