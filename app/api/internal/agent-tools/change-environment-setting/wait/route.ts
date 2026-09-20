import { NextResponse, type NextRequest } from "next/server";
import { pollEnvironmentProposal } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";

export const dynamic = "force-dynamic";

// Poll target for the stdio MCP bridge's change_environment_setting tool,
// mirroring ask_user's wait/route.ts: instant check plus client-side sleep,
// no long-held request. `cancel: true` propagates a post-dispatch MCP
// cancellation of THIS tool call (the CLI cut it off, not necessarily the
// whole turn) into the parked mandatory decision, so a decision that arrives
// after cancellation can no longer commit. Outcomes are take-once, safe on
// the loopback hop.
export async function POST(req: NextRequest) {
  let body: { taskId?: string; proposalId?: string; cancel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("change_environment_setting.wait", "bridge", body.taskId);
  if (!body.taskId || !body.proposalId) {
    return NextResponse.json({ error: "taskId and proposalId are required" }, { status: 400 });
  }
  const outcome = pollEnvironmentProposal(body.taskId, body.proposalId, body.cancel === true);
  return NextResponse.json(outcome);
}
