import { NextResponse } from "next/server";

import { reviewErrorResponse } from "@/lib/reviews/http";
import { readArtifact } from "@/lib/reviews/read";

export const dynamic = "force-dynamic";

/**
 * The exact captured manifest of one submission plus its bounded code diff or
 * its document text, read from review-owned refs and stored bytes. Every path
 * segment is checked against its parent. Auth: middleware.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; requestId: string; submissionId: string }> }) {
  const { id, requestId, submissionId } = await params;
  try {
    return NextResponse.json(await readArtifact(id, requestId, submissionId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return reviewErrorResponse(e);
  }
}
