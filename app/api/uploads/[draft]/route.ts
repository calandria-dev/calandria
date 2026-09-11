import { NextResponse } from "next/server";
import { removeDraftUploads } from "@/lib/uploads";

export const dynamic = "force-dynamic";

/**
 * Drop a draft's staged files: the New-task dialog's cancel. Best-effort and
 * idempotent, since the sweep in lib/uploads.ts removes what this misses.
 * Auth: middleware.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ draft: string }> }) {
  const { draft } = await params;
  return NextResponse.json({ ok: true, removed: removeDraftUploads(draft) });
}
