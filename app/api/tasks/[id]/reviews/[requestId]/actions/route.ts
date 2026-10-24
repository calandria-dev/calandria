import { NextResponse } from "next/server";

import { resolveHumanActor } from "@/lib/reviews/actor";
import { performReviewAction } from "@/lib/reviews/actions";
import { reviewErrorResponse } from "@/lib/reviews/http";
import { REVIEW_LIMITS, ReviewError } from "@/lib/reviews/types";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * A person's decision on a review request: accept, request changes, withdraw,
 * waive, merge, or resend failed feedback. Human-only: the actor is set from
 * the authenticated browser context, and a service-token or bearer request is
 * refused as human authority. No agent tool transport reaches this route.
 *
 * Body `{submissionId, expectedVersion, action, idempotencyKey, reason?}`.
 * A repeated key with the same payload returns the stored receipt verbatim;
 * 200/201 is a settled result, 202 an effect still in flight (read it back
 * through GET /api/tasks/[id]/reviews).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  try {
    const actor = await resolveHumanActor(req);
    const text = await req.text();
    if (Buffer.byteLength(text) > REVIEW_LIMITS.bodyBytes) throw new ReviewError("payload_too_large", "request body is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ReviewError("bad_request", "body must be JSON");
    }
    const out = await performReviewAction(id, requestId, body, actor);
    return NextResponse.json(out.body, { status: out.status });
  } catch (e) {
    return reviewErrorResponse(e, "decision");
  }
}
