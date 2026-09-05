import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { setBaseBranchForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Internal endpoint behind the `set_base_branch` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same retarget the Claude driver mounts
// in-process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath).
//
// Two ids, the same split every agent-tool endpoint makes:
//
//   body.taskId  the CALLER. CALANDRIA_TASK_ID, injected into the bridge's env
//                by lib/agents/codex/driver.ts, never a field the model can set.
//   body.task    the TARGET the MODEL named, and therefore untrusted. Optional;
//                omitted means "my own row", the common case of a session
//                retargeting itself mid-turn.
//
// The policy is entirely in lib/agentTools.setBaseBranchForAgent ->
// lib/baseBranch.setTaskBaseBranch, shared with POST /api/tasks/[id]/base-branch
// so a user's retarget and an agent's mean the same thing.
//
// The per-task lock that makes the liveness check atomic with the worktree
// write is taken inside that function, not here, so the Claude driver's
// in-process tool gets it too.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; task?: string; branch?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("set_base_branch", "bridge", body.taskId);

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  const branch = typeof body.branch === "string" ? body.branch : "";

  const { task: updated, text } = await setBaseBranchForAgent(caller, body.task, branch);

  // The refusal here is 400: the caller's row exists (we just read it), and the
  // request either named a branch that can't be used or a row that may not be
  // retargeted. `error` is what the bridge shows the agent as the tool's
  // failure text, and what tells it how to retry.
  if (!updated) return NextResponse.json({ error: text }, { status: 400 });
  return NextResponse.json({ ok: true, id: updated.id, base_branch: updated.base_branch, text });
}
