import { NextResponse, type NextRequest } from "next/server";
import { listEnvironmentSettingsForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";
import type { EnvScope } from "@/lib/advanced-env/types";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `list_environment_settings` tool for the stdio
// MCP bridge (scripts/calandria-mcp.mjs), the same read the Claude driver
// serves in-process. A plain read: no capability header is checked here, only
// the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath) every
// agent-tool endpoint already requires. Only change-environment-setting, the
// mutation, additionally demands the turn capability.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; scope?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("list_environment_settings", "bridge", body.taskId);
  const scope = body.scope === "app" || body.scope === "agent" ? (body.scope as EnvScope) : undefined;
  return NextResponse.json({ ok: true, ...listEnvironmentSettingsForAgent(scope) });
}
