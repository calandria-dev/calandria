import { NextResponse } from "next/server";

import { reviewErrorResponse } from "@/lib/reviews/http";
import { listTaskReviews } from "@/lib/reviews/read";
import { ReviewError } from "@/lib/reviews/types";
import { listRequestsForOwner } from "@/lib/reviews/store";
import { getTask } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Current review requests for a task plus one page of submission and action
 * history. Auth: middleware. Reads stay available with CALANDRIA_REVIEW_REQUESTS
 * off. Submission is an agent-tool transport (lib/reviews/submit.ts), not a
 * browser route.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return reviewErrorResponse(new ReviewError("bad_request", "limit must be a positive integer"));
  }
  // History outlives its task row, so an unknown id is a 404 only when it owns no reviews either.
  if (!getTask(id) && listRequestsForOwner(id).length === 0) {
    return NextResponse.json({ error: { code: "not_found", message: "task not found", retryable: false } }, { status: 404 });
  }
  try {
    return NextResponse.json(await listTaskReviews(id, { requestId: url.searchParams.get("request_id"), limit, cursor: url.searchParams.get("cursor") }));
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
