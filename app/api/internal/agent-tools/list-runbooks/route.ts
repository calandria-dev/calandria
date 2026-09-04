import { NextResponse, type NextRequest } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { listRunbooksForAgent } from "@/lib/runbookTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the read-only `list_runbooks` tool for the stdio MCP
// bridge (scripts/calandria-mcp.mjs). Same caller/target split as its siblings:
// `taskId` is the server's word for who is asking, `project` the model's word
// for which board to read.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; project?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("list_runbooks", "bridge", body.taskId);

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  const project = getProject(caller.project_id);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const out = listRunbooksForAgent(project, body.project);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json({ ok: true, ...out, text: JSON.stringify(out, null, 2) });
}
