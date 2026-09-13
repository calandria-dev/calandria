import { NextResponse } from "next/server";
import { listProvidersForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_providers` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same list the Claude driver serves
// in-process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath). Instance-wide, like list_projects: a provider isn't
// scoped to one project.
export async function POST() {
  logAgentToolArrival("list_providers", "bridge", undefined);
  return NextResponse.json({ ok: true, providers: listProvidersForAgent() });
}
