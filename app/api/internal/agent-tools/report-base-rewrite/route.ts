import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { reportBaseRewriteForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Internal endpoint behind the `report_base_rewrite` tool for the stdio MCP
// bridge (scripts/calandria-mcp.mjs), the same flag-and-notify sweep the
// Claude driver mounts in-process. Auth is the per-instance SERVICE_TOKEN
// (middleware.ts, isAgentToolPath).
//
// Two ids, the same split every agent-tool endpoint makes:
//
//   body.taskId  the CALLER. CALANDRIA_TASK_ID, injected into the bridge's env
//                by lib/agents/codex/driver.ts, never a field the model can set.
//   body.branch  the branch the MODEL says it rewrote, and therefore untrusted.
//                Optional; omitted means this task's own base branch.
//
// The policy is entirely in lib/agentTools.reportBaseRewriteForAgent ->
// lib/baseRewrite.flagBaseRewrite, which re-derives every affected task from
// git instead of trusting the branch name.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("report_base_rewrite", "bridge", body.taskId);

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const { ok, text } = await reportBaseRewriteForAgent(caller, typeof body.branch === "string" ? body.branch : undefined);

  if (!ok) return NextResponse.json({ error: text }, { status: 400 });
  return NextResponse.json({ ok: true, text });
}
