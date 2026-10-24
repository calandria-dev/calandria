import { NextResponse } from "next/server";
import { acknowledgeTurnFailure, getTask } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { withTaskLock } from "@/lib/taskLock";

export const dynamic = "force-dynamic";

const err = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message, retryable: false } }, { status });

// Acknowledge a generic execution failure for exactly one turn (contract
// work-center/1). Context, auth and approval failures recover through their
// own actions and clear only after a successful replacement turn, so they are
// refused here. The check and the write share one task-lock and one
// transaction, and the row is persisted before the event publishes.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return err(404, "not_found", "task not found");
  const body = (await req.json().catch(() => null)) as { turnId?: unknown } | null;
  if (!body || typeof body.turnId !== "string" || !body.turnId) return err(400, "invalid_request", "turnId is required");
  const turnId = body.turnId;

  const outcome = await withTaskLock(id, async () => {
    const cur = getTask(id);
    if (!cur) return "gone" as const;
    if (cur.latest_turn_id === turnId && cur.latest_turn_failure_code && cur.latest_turn_failure_code !== "execution") return "unsupported" as const;
    return acknowledgeTurnFailure(id, turnId) ? ("ok" as const) : ("changed" as const);
  });
  if (outcome === "gone") return err(404, "not_found", "task not found");
  if (outcome === "unsupported") return err(400, "unsupported_recovery", "this failure recovers through its own action");
  if (outcome === "changed") return err(409, "source_changed", "that turn is no longer the latest failed turn");
  publishGlobal(id, { type: "task_edited" });
  return NextResponse.json({ ok: true, turnId });
}
