import { NextResponse } from "next/server";
import { assembleSnapshot, ScopeError, SnapshotBusy } from "@/lib/workCenter/snapshot";
import { RECENT_LIMIT_DEFAULT, RECENT_LIMIT_MAX } from "@/lib/workCenter/classify";

export const dynamic = "force-dynamic";

const err = (status: number, code: string, message: string, retryable: boolean, headers?: Record<string, string>) =>
  NextResponse.json({ error: { code, message, retryable } }, { status, headers });

// The Work Center snapshot (contract work-center/1). Reads only: it mutates
// nothing, makes no network call, and returns the same projection every
// surface renders. `project`, `include_deprecated`, `recent_cursor` and
// `recent_limit` are all optional. A deprecated project is reachable only
// with include_deprecated=1, and that never changes global counts.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const dep = q.get("include_deprecated");
  if (dep !== null && dep !== "0" && dep !== "1") return err(400, "invalid_scope", "include_deprecated must be 0 or 1", false);
  const limitRaw = q.get("recent_limit");
  let limit = RECENT_LIMIT_DEFAULT;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_LIMIT_MAX) return err(400, "invalid_scope", `recent_limit must be 1..${RECENT_LIMIT_MAX}`, false);
  }
  try {
    const snap = assembleSnapshot({
      projectId: q.get("project") || null,
      includeDeprecated: dep === "1",
      recentCursor: q.get("recent_cursor") || null,
      recentLimit: limit,
    });
    return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof ScopeError) {
      if (e.code === "unknown_project") return err(404, "not_found", "unknown project", false);
      return err(400, e.code, e.code === "invalid_cursor" ? "recent_cursor is not valid for this scope" : "that project needs include_deprecated=1", false);
    }
    if (e instanceof SnapshotBusy) return err(503, "snapshot_busy", "the snapshot changed while it was read; retry", true, { "Retry-After": "1" });
    throw e;
  }
}
