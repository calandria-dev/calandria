import { NextResponse, type NextRequest } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { publishGlobal } from "@/lib/events";
import { updateRunbookForAgent } from "@/lib/runbookTools";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `update_runbook` tool for the stdio MCP bridge
// (scripts/orch-mcp.mjs) — the same write the Claude driver mounts in-process.
//
//   body.taskId   the CALLER (CALANDRIA_TASK_ID, injected by the driver).
//   body.runbook  the TARGET the MODEL named, and therefore untrusted.
//
// The endpoint enforces nothing itself. updateRunbookForAgent owns the policy —
// notably the refusal for any runbook a schedule fires, which is what stops a
// model quietly rewriting work that runs unattended — and it is shared with the
// in-process server so the two can't drift.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; runbook?: string; name?: string; description?: string; prompt?: string; priority?: "hi" | "med" | "lo"; permission_mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });
  const project = getProject(caller.project_id);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

  const { runbook, text } = updateRunbookForAgent(project, body.runbook ?? "", {
    name: body.name,
    description: body.description,
    prompt: body.prompt,
    priority: body.priority,
    permission_mode: body.permission_mode,
  });
  // 400: the caller exists, so this is either an unknown runbook or one this
  // tool may not touch. The reason travels — a bare refusal leaves the agent
  // nothing to tell the user.
  if (!runbook) return NextResponse.json({ error: text }, { status: 400 });

  publishGlobal("", { type: "runbooks_changed", projectId: runbook.project_id });
  return NextResponse.json({ ok: true, id: runbook.id, name: runbook.name, text });
}
