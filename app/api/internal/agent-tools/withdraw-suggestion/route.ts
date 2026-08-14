import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { withdrawSuggestionForAgent } from "@/lib/agentTools";
import { maybeAutoStartDependents } from "@/lib/autoStart";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `withdraw_suggestion` tool for the stdio MCP
// bridge (scripts/orch-mcp.mjs) — the same write the Claude driver mounts
// in-process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath).
//
// Same two-id split as update-task, and for the same reason:
//
//   body.taskId  the CALLER. ORCH_TASK_ID, injected into the bridge's env by
//                lib/agents/codex/driver.ts — never a field the model can set.
//   body.task    the TARGET the MODEL named, and therefore untrusted. Required
//                here: there is no "my own row" default, because a task with a
//                live turn can never be an inert suggestion anyway.
//
// The endpoint enforces nothing itself. withdrawSuggestionForAgent owns the
// policy — the SAME isInertSuggestion screen update_task uses, so a row one tool
// will touch is exactly a row the other will — plus the required, non-empty
// reason, and it is shared with the in-process server so the two can't drift.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; task?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const { task: updated, text, autoStartDependents } = withdrawSuggestionForAgent(caller, body.task, body.reason ?? "");
  // 400, not 404: the caller's row exists (we just read it), and the request
  // either omitted the reason or aimed at a row this tool may not retract.
  // `error` is what the bridge shows the agent as the tool's failure text, and
  // therefore what tells it how to retry.
  if (!updated) return NextResponse.json({ error: text }, { status: 400 });

  // Cancelling a suggestion CLEARS it as a blocker (lib/autoStart's blocks()
  // has always treated cancelled as terminal), so anything auto-starting behind
  // it is now ready and has to actually launch — otherwise a withdrawal strands
  // it unblocked forever. Fired against `updated.id`, the TARGET, and
  // fire-and-forget exactly as the update-task and PATCH paths do it.
  // Fired here rather than inside withdrawSuggestionForAgent because
  // lib/autoStart reaches the agent SDKs and lib/agentTools is pinned SDK-free
  // (tests/importGraph).
  if (autoStartDependents) maybeAutoStartDependents(updated.id);

  return NextResponse.json({ ok: true, id: updated.id, title: updated.title, status: updated.status, text });
}
