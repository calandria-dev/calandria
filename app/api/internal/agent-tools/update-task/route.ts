import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { updateOwnTask } from "@/lib/agentTools";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import type { Priority, Status } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `update_task` tool for the stdio MCP bridge
// (scripts/orch-mcp.mjs) — the same write the Claude driver mounts in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// The write target is `taskId`, the calling session's OWN task, injected into
// the bridge's env by lib/agents/codex/driver.ts — never a field the model can
// set. That's the whole blast-radius story: a detached turn can retitle,
// reprioritize or close itself, and nothing else on the board. Field validation
// (including the refusal to accept "cancelled") lives in updateOwnTask, shared
// with the in-process server, so the two can't drift.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; title?: string; description?: string; priority?: Priority; status?: Status };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const task = body.taskId ? getTask(body.taskId) : undefined;
  if (!task) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const { task: updated, text, autoStartDependents } = updateOwnTask(task, {
    title: body.title,
    description: body.description,
    priority: body.priority,
    status: body.status,
  });
  // 400, not 404: the row exists (we just read it), the request named a value
  // the tool won't write. `error` is what the bridge shows the agent as the
  // tool's failure text, which is what tells it how to retry.
  if (!updated) return NextResponse.json({ error: text }, { status: 400 });

  // Marking a task done may have cleared the last blocker some auto-start
  // dependent was waiting on. Fire-and-forget, exactly as PATCH /api/tasks/[id]
  // does it: the launch runs detached and must never delay this response.
  // Fired here rather than inside updateOwnTask because lib/autoStart reaches
  // the agent SDKs and lib/agentTools is pinned SDK-free (tests/importGraph).
  if (autoStartDependents) maybeAutoStartDependents(updated.id);

  return NextResponse.json({ ok: true, id: updated.id, title: updated.title, status: updated.status, text });
}
