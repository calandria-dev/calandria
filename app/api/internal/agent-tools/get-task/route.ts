import { NextResponse, type NextRequest } from "next/server";
import { getTaskForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `get_task` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs). Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath).
//
// `taskId` is the calling session's own task, which is both the default target
// (an agent re-reading the brief it was started with) and what flags the row as
// `current`. `task` overrides it to read some other row — reads are inert, so
// they aren't scoped the way `update_task`'s writes are.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; task?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("get_task", "bridge", body.taskId);

  const id = body.task?.trim() || body.taskId?.trim() || "";
  if (!id) return NextResponse.json({ error: "task id is required" }, { status: 400 });

  const task = getTaskForAgent(id, body.taskId ?? "");
  if (!task) return NextResponse.json({ error: `No task with id "${id}". Call list_tasks for the ids.` }, { status: 404 });

  return NextResponse.json({ ok: true, task });
}
