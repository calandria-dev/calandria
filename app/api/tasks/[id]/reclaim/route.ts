import { NextResponse } from "next/server";
import { reclaimPreview, reclaimTask } from "@/lib/reclaim";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
// Fetches origin and tears a checkout down; the same ceiling the merge routes take.
export const maxDuration = 120;

// GET: what reclaiming this task would do: the disk it frees, the branch it
// deletes, and whether the safety gate would refuse. Read-only, and a few git
// subprocesses, so it is not fetched when a task is merely selected; the
// button asks for it on the click that arms it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`reclaim/preview ${id}`, async () => {
    const preview = await reclaimPreview(id);
    if (!preview) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(preview);
  });
}

// POST: perform it. `discardUnsafe` is the acknowledgement lib/taskMove.ts
// demands, and lib/reclaim.ts re-reads the safety verdict under its own lock
// instead of trusting the preview this client rendered, so work that appeared
// after the preview is refused instead of swept up.
//
// A refusal from the safety gate answers 409 with `unsafe: true`, which is what
// tells the client to offer the acknowledgement instead of showing an error.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { discardUnsafe?: unknown } | null;
  return jsonGuard(`reclaim ${id}`, async () => {
    const result = await reclaimTask(id, { discardUnsafe: body?.discardUnsafe === true });
    if (result.ok) return NextResponse.json(result);
    // `error` alongside `reason`: every client fetch helper in app/shell/api.ts
    // unwraps that one key, so a refusal reads as its own sentence instead of
    // a raw JSON blob in a banner.
    return NextResponse.json(
      { ...result, error: result.reason },
      { status: result.reason === "not found" ? 404 : 409 }
    );
  });
}
