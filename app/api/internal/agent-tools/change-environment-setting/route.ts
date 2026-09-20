import { NextResponse, type NextRequest } from "next/server";
import { getTask } from "@/lib/store";
import { startEnvironmentProposal } from "@/lib/agentTools";
import { logAgentToolArrival } from "@/lib/agentToolLog";
import { TURN_CAPABILITY_HEADER, verifyTurnCapability } from "@/lib/advanced-env/capabilities";
import type { ProposalInput } from "@/lib/advanced-env/proposals";
import type { EnvScope } from "@/lib/advanced-env/types";

export const dynamic = "force-dynamic";

// Internal endpoint behind the `change_environment_setting` tool for the
// stdio MCP bridge (scripts/calandria-mcp.mjs). The only mutation endpoint
// under app/api/internal/agent-tools/, so it is the only one that checks a
// second identity beyond the per-instance SERVICE_TOKEN (middleware.ts,
// isAgentToolPath): the turn capability lib/runner.ts mints at turn start and
// lib/agents/{claude,codex,gemini}/mcp.ts inject into the bridge's env as
// CALANDRIA_ENV_EDIT_CAPABILITY, carried here as the x-calandria-turn-capability
// header. Neither check substitutes for the other, and identity comes from
// the token alone, never from the request body's taskId: a mismatched or
// stale capability is refused even when the service token is valid.
//
// Held open as briefly as possible: proposeEnvironmentMutation can await a
// human for hours (the mandatory prompt's own attended deadline), which an
// HTTP request from the bridge cannot survive (the ask_user tool hit this
// same wall). startEnvironmentProposal kicks the same call off detached and
// this returns a proposalId at once; the sibling wait/route.ts polls it.
export async function POST(req: NextRequest) {
  let body: {
    taskId?: string;
    operation?: string;
    scope?: unknown;
    id?: string;
    name?: string;
    value?: string;
    secret?: unknown;
    reason?: string;
    expectedRevision?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  logAgentToolArrival("change_environment_setting", "bridge", body.taskId);

  const task = body.taskId ? getTask(body.taskId) : undefined;
  if (!task) return NextResponse.json({ error: "unknown task" }, { status: 404 });

  const capability = req.headers.get(TURN_CAPABILITY_HEADER) || "";
  const verified = capability ? verifyTurnCapability(capability) : null;
  if (!verified || verified.taskId !== task.id) {
    return NextResponse.json({ error: "This turn's capability to edit environment settings has expired or does not match." }, { status: 403 });
  }

  if (!Number.isInteger(body.expectedRevision)) {
    return NextResponse.json({ error: "expectedRevision is required." }, { status: 400 });
  }
  const expectedRevision = body.expectedRevision as number;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;

  let input: ProposalInput;
  if (body.operation === "create") {
    if (body.scope !== "app" && body.scope !== "agent") return NextResponse.json({ error: "scope must be app or agent." }, { status: 400 });
    if (typeof body.name !== "string" || !body.name) return NextResponse.json({ error: "name is required." }, { status: 400 });
    input = {
      operation: "create",
      scope: body.scope as EnvScope,
      name: body.name,
      value: typeof body.value === "string" ? body.value : undefined,
      secret: body.secret === true,
      expectedRevision,
      reason,
    };
  } else if (body.operation === "patch") {
    if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    input = {
      operation: "patch",
      id: body.id,
      name: typeof body.name === "string" ? body.name : undefined,
      value: typeof body.value === "string" ? body.value : undefined,
      secret: typeof body.secret === "boolean" ? body.secret : undefined,
      expectedRevision,
      reason,
    };
  } else if (body.operation === "delete") {
    if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    input = { operation: "delete", id: body.id, expectedRevision, reason };
  } else {
    return NextResponse.json({ error: "operation must be create, patch, or delete." }, { status: 400 });
  }

  const { proposalId } = startEnvironmentProposal(task, input);
  return NextResponse.json({ ok: true, proposalId });
}
