import { NextResponse, type NextRequest } from "next/server";
import { listProjectsForAgent } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_projects` tool for the stdio MCP bridge
// (scripts/orch-mcp.mjs) — the same list the Claude driver serves in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// POST rather than GET only because the bridge speaks one shape to every
// agent-tool endpoint; `projectId` is the session's own project, used solely to
// flag which row is "current". An unknown one isn't an error — the list is
// still useful, nothing is just marked current.
export async function POST(req: NextRequest) {
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, projects: listProjectsForAgent(body.projectId ?? "") });
}
