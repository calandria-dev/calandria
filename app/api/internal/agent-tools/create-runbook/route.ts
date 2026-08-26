import { NextResponse, type NextRequest } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { createRunbookForAgent } from "@/lib/runbookTools";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `create_runbook` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs) — the same write the Claude driver mounts in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// The same trust split every tool here makes:
//
//   body.taskId  the CALLER. CALANDRIA_TASK_ID, injected into the bridge's env by
//                lib/agents/codex/driver.ts — never a field the model can set.
//   body.project the TARGET the MODEL named, and therefore untrusted;
//                resolveTargetProject is strict about it.
//
// The agent id comes off the CALLER'S ROW, not the body: a model must not be
// able to file a recipe under another agent's name, and `created_by` is shown
// to the user as provenance.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; name?: string; description?: string; prompt?: string; priority?: "hi" | "med" | "lo"; permission_mode?: string; project?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  const project = getProject(caller.project_id);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const { runbook, text } = createRunbookForAgent(
    project,
    {
      name: body.name ?? "",
      description: body.description ?? "",
      prompt: body.prompt ?? "",
      priority: body.priority,
      permission_mode: body.permission_mode,
      project: body.project,
    },
    caller.agent
  );
  // 400, not 404: the caller's row exists (we just read it), and the request
  // either omitted a required field or named a project this tool can't resolve.
  // `error` is what the bridge shows the agent, and therefore what tells it how
  // to retry.
  if (!runbook) return NextResponse.json({ error: text }, { status: 400 });

  publishGlobal("", { type: "runbooks_changed", projectId: runbook.project_id });
  return NextResponse.json({ ok: true, id: runbook.id, name: runbook.name, project_id: runbook.project_id, text });
}
