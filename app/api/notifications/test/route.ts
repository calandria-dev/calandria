import { NextResponse } from "next/server";
import { emitTestNotification, notificationsEnabled } from "@/lib/notifications/notify";

export const dynamic = "force-dynamic";

// Settings' "Send test notification". Publishes through the REAL emitter, bus
// and relay rather than calling new Notification() in the client, so a green
// result means the whole path works — not just that the browser granted
// permission. `ok: false` is the master switch being off, which is the one
// answer the button should report rather than appear broken over.
export async function POST() {
  const payload = emitTestNotification();
  return NextResponse.json({ ok: !!payload, enabled: notificationsEnabled(), payload });
}
