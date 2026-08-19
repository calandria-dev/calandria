import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { updateTaskForAgent } from "@/lib/agentTools";
import { maybeAutoStartDependents } from "@/lib/autoStart";
import type { Priority, Status } from "@/lib/types";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `update_task` tool for the stdio MCP bridge
// (scripts/orch-mcp.mjs) — the same write the Claude driver mounts in-process.
// Auth is the per-instance SERVICE_TOKEN (middleware.ts, isAgentToolPath).
//
// Two ids, and the difference between them is the whole blast-radius story:
//
//   body.taskId  the CALLER. ORCH_TASK_ID, injected into the bridge's env by
//                lib/agents/codex/driver.ts — never a field the model can set.
//   body.task    the TARGET the MODEL named, and therefore untrusted. Optional;
//                omitted means "my own row".
//
// This is the path where the model, not the server, picks what gets written, so
// the endpoint hands both to updateTaskForAgent and enforces nothing itself.
// That function owns the policy (own row, or an inert tray suggestion in any
// project) along with field validation and the refusal to accept "cancelled",
// and it is shared with the in-process server, so the two can't drift.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; task?: string; title?: string; description?: string; priority?: Priority; status?: Status; blocked_by?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const { task: updated, text, autoStartDependents } = updateTaskForAgent(caller, body.task, {
    title: body.title,
    description: body.description,
    priority: body.priority,
    status: body.status,
    // Only forwarded when it really is a list: `undefined` means "leave the
    // edges alone" and `[]` means "clear them", so a malformed value must not
    // arrive as the second one.
    blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : undefined,
  });
  // 400, not 404: the caller's row exists (we just read it), and the request
  // either named a value the tool won't write or aimed at a row it may not
  // touch. `error` is what the bridge shows the agent as the tool's failure
  // text, which is what tells it how to retry — including the refusal that
  // explains why somebody else's task is off limits.
  if (!updated) return NextResponse.json({ error: text }, { status: 400 });

  // Marking a task done may have cleared the last blocker some auto-start
  // dependent was waiting on. Fired against `updated.id` — the TARGET, which
  // isn't necessarily the caller. Fire-and-forget, exactly as PATCH
  // /api/tasks/[id] does it: the launch runs detached and must never delay this
  // response.
  // Fired here rather than inside updateTaskForAgent because lib/autoStart reaches
  // the agent SDKs and lib/agentTools is pinned SDK-free (tests/importGraph).
  if (autoStartDependents) maybeAutoStartDependents(updated.id);

  return NextResponse.json({ ok: true, id: updated.id, title: updated.title, status: updated.status, text });
}
