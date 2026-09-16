import { NextResponse, type NextRequest } from "next/server";
import { reportBridgeToolCutoff } from "@/lib/agentToolCutoff";

export const dynamic = "force-dynamic";

// The stdio MCP bridge reporting that the agent CLI cut one of its tool calls
// off: it sent notifications/cancelled (or dropped the transport) after the
// request was already dispatched, so the MCP SDK threw Calandria's answer away
// and the model never saw it. Auth is the per-instance SERVICE_TOKEN
// (middleware.ts, isAgentToolPath), like every other endpoint here.
//
// Not a tool call, so there is no arrival log line and no `text` for a model to
// read: by the time this arrives the model is unreachable, holding whatever
// sentence its CLI wrote. This exists so the occurrence is not silent, which is
// what lib/agentToolCutoff.ts does with it.
//
//   body.taskId  the CALLER, from CALANDRIA_TASK_ID in the bridge's env, never
//                a field the model can set. The only id this route takes.
//   body.tool    which tool was cut off, as the bridge registered it.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; tool?: unknown; ms?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const tool = typeof body.tool === "string" ? body.tool.trim() : "";
  if (!body.taskId || !tool) return NextResponse.json({ error: "taskId and tool are required" }, { status: 400 });

  const { notified } = reportBridgeToolCutoff(body.taskId, {
    tool,
    ms: typeof body.ms === "number" && Number.isFinite(body.ms) && body.ms >= 0 ? body.ms : 0,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  });

  // 200 either way. The bridge cannot act on a refusal (its own call is already
  // lost) and must not retry, so the only thing worth reporting back is whether
  // this was the notice the turn got.
  return NextResponse.json({ ok: true, notified });
}
