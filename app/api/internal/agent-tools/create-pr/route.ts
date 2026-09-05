import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { createPrForAgent } from "@/lib/prTools";
import { schedulePrRefresh, startPrPolling } from "@/lib/prState";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";
// Push + `gh pr create` against github.com, with createTaskPr's own 120s
// subprocess cap under it, the same ceiling POST /api/tasks/[id]/pr uses.
export const maxDuration = 180;

// Internal endpoint behind the `create_pr` tool for the stdio MCP bridge
// (scripts/calandria-mcp.mjs), the same push the Claude driver mounts
// in-process. Auth is the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath).
//
// This body carries only one id:
//
//   body.taskId  the CALLER. CALANDRIA_TASK_ID, injected into the bridge's env
//                by lib/agents/codex/driver.ts, never a field the model can set.
//
// There is no target parameter: this tool acts on the caller's own row only.
// Pushing another task's branch would commit a checkout this session has never
// seen, and only the session that did the work can judge whether it's finished.
//
// The policy (the landing_mode gate, the no-worktree refusal, the push itself)
// is entirely in lib/prTools.ts, shared with the in-process Claude tool and, for
// the machinery half, with POST /api/tasks/[id]/pr.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; title?: unknown; body?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("create_pr", "bridge", body.taskId);

  const caller = body.taskId ? getTask(body.taskId) : undefined;
  if (!caller) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const { url, number, text } = await createPrForAgent(
    caller,
    {
      title: typeof body.title === "string" ? body.title : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
    },
    // The bridge's own kick: this is an ordinary sync route entry, so unlike
    // the in-process driver it may reach lib/prState.ts directly.
    (id) => { schedulePrRefresh(id, { force: true }); startPrPolling(); }
  );

  // A refusal here is 400: the caller's row exists (we just read it), and the
  // request either landed on a project that doesn't open PRs at all or on a
  // push github refused. `error` is what the bridge shows the agent as the
  // tool's failure text, and what tells it how to retry.
  if (!url) return NextResponse.json({ error: text }, { status: 400 });
  return NextResponse.json({ ok: true, url, number, text });
}
