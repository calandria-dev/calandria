// Shared HTTP shaping for the review routes: one error body and one status
// mapping, so no route leaks a host path or an unclassified exception.

import { NextResponse } from "next/server";

import { ReviewError } from "./types";

/** `read` maps an unavailable artifact to 404; decisions keep the contract's 409. */
export function reviewErrorResponse(e: unknown, mode: "read" | "decision" = "read"): NextResponse {
  if (e instanceof ReviewError) {
    const status = mode === "read" && e.code === "artifact_unavailable" ? 404 : e.status;
    return NextResponse.json(e.body(), { status });
  }
  return NextResponse.json({ error: { code: "snapshot_busy", message: "the review could not be read", retryable: true } }, { status: 503 });
}
