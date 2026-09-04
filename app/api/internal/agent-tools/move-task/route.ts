import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { moveTasksForAgent } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Internal endpoint behind the `move_task` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs) — the same re-parenting the Claude driver mounts
// in-process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath).
//
// The same two-id split every agent-tool endpoint makes:
//
//   body.taskId  the CALLER. CALANDRIA_TASK_ID, injected into the bridge's env by
//                lib/agents/codex/driver.ts — never a field the model can set.
//   body.tasks   the TARGETS the MODEL named, and therefore untrusted. Every
//                rule about which of them may move lives in
//                lib/agentTools.moveTasksForAgent → lib/taskMove.ts, shared with
//                the two user-facing move routes.
//
// There is deliberately NO discard acknowledgement in this body. The bulk route
// takes those as lists of ids because each discarded worktree is a separate
// irreversible answer; an agent-facing verb must not become the shortcut past
// that question, so a started task is refused here and the user answers from
// the board.
//
// 400 rather than 404 on a refusal: the caller's row exists (we just read it),
// and what failed is the destination or the whole selection. Per-task refusals
// are not failures at all — they come back inside `text`, which is what the
// bridge shows the agent.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; tasks?: unknown; project?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("move_task", "bridge", body.taskId);

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const tasks = Array.isArray(body.tasks) ? body.tasks.filter((t): t is string => typeof t === "string") : [];
  const project = typeof body.project === "string" ? body.project : "";

  const { ok, moved, text } = await moveTasksForAgent(caller, tasks, project);
  // `ok` rather than a zero count: a selection of entirely started tasks moves
  // nothing and is still a well-formed answer naming each refusal, which the
  // agent must read as a result rather than as a broken call.
  if (!ok) return NextResponse.json({ error: text }, { status: 400 });
  return NextResponse.json({ ok: true, moved: moved.map((t) => t.id), text });
}
