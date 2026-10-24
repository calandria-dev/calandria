import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { getReviewForAgent } from "@/lib/reviews/tool";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `get_review` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same policy the Claude driver mounts in
// process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath). body.taskId is the CALLER (CALANDRIA_TASK_ID injected into
// the bridge's env), never a field the model sets; the review service derives
// the submitter's session, generation, agent and model from that task row.
// This route exposes submit/read/withdraw only: accepting, waiving and merging
// are human routes, so an agent has no path to satisfy its own requirement.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; requestId?: string; limit?: number; cursor?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("get_review", "bridge", body.taskId);
  if (!body.taskId || !getTask(body.taskId)) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  const { ok, text } = await getReviewForAgent(body.taskId, body);
  if (!ok) return NextResponse.json({ error: text }, { status: 400 });
  return NextResponse.json({ ok: true, text });
}
