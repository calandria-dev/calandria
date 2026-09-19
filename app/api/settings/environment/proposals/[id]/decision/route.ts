import { NextResponse } from "next/server";

import { requestFromBrowser } from "@/lib/advanced-env/browserAuth";
import { hasMandatoryDecision, submitMandatoryDecision } from "@/lib/advanced-env/capabilities";
import { discardPrivateInput, stagePrivateInput } from "@/lib/advanced-env/proposals";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "no-store" };
const VALUE_CAP = 20_000;

/**
 * The only route that can settle an Advanced Settings mutation proposal
 * (lib/advanced-env/proposals.ts). Never the generic POST
 * /api/tasks/[id]/answer: that route's registry has no access to a mandatory
 * decision (lib/advanced-env/capabilities.ts), by construction.
 *
 * `privateName`/`privateValue` are the one way a secret's plaintext reaches a
 * commit: staged in memory here, consumed at most once by
 * proposeEnvironmentMutation, and never written to this response, the
 * transcript, an SSE event, or a log line. Only "allow_once" and "deny" are
 * accepted; there is no durable or session grant to request here at all.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const guard = requestFromBrowser(req);
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 403, headers: NO_STORE });
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as {
    taskId?: unknown;
    decision?: unknown;
    note?: unknown;
    privateName?: unknown;
    privateValue?: unknown;
  };

  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) return NextResponse.json({ error: "taskId is required." }, { status: 400, headers: NO_STORE });

  // allow_always is not offered: a mandatory proposal is one-use by design,
  // and there is no "trust this task's future proposals" concept.
  if (body.decision !== "allow_once" && body.decision !== "deny")
    return NextResponse.json({ error: "decision must be allow_once or deny." }, { status: 400, headers: NO_STORE });

  if (body.privateName !== undefined && typeof body.privateName !== "string")
    return NextResponse.json({ error: "privateName must be a string." }, { status: 400, headers: NO_STORE });
  if (body.privateValue !== undefined && typeof body.privateValue !== "string")
    return NextResponse.json({ error: "privateValue must be a string." }, { status: 400, headers: NO_STORE });
  if (((body.privateValue as string | undefined)?.length ?? 0) > VALUE_CAP)
    return NextResponse.json({ error: "privateValue is too long." }, { status: 400, headers: NO_STORE });

  if (!hasMandatoryDecision(taskId, id)) {
    return NextResponse.json({ error: "This proposal is no longer pending." }, { status: 409, headers: NO_STORE });
  }

  // Staged before the decision is settled: the awaiting proposal service
  // wakes on the same tick submitMandatoryDecision resolves it, so staging
  // has to already be visible by then.
  if (body.decision === "allow_once" && (body.privateName !== undefined || body.privateValue !== undefined)) {
    stagePrivateInput(taskId, id, {
      name: body.privateName as string | undefined,
      value: body.privateValue as string | undefined,
    });
  }

  const note = typeof body.note === "string" ? body.note : undefined;
  const settled = submitMandatoryDecision(taskId, id, body.decision, note);
  if (!settled) {
    discardPrivateInput(taskId, id);
    return NextResponse.json({ error: "This proposal is no longer pending." }, { status: 409, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
