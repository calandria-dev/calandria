import { NextResponse } from "next/server";
import { jsonGuard } from "@/lib/apiGuard";
import { deletePushSubscription } from "@/lib/push/store";

export const dynamic = "force-dynamic";

// Remove another device's subscription from the list in Settings, to silence
// a phone you no longer have. The server stops sending; the browser on that
// device still holds a subscription it will re-post on its next visit, which
// is the right outcome if the phone turns up again.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return jsonGuard("push/remove", async () => {
    const { id } = await params;
    const removed = deletePushSubscription(id);
    return removed
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "No such subscription." }, { status: 404 });
  });
}
