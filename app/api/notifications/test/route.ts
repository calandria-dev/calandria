import { NextResponse } from "next/server";
import { emitTestNotification, notificationsEnabled } from "@/lib/notifications/notify";

export const dynamic = "force-dynamic";

// Settings' "Send test notification". Publishes through the real emitter, bus
// and relay instead of calling new Notification() in the client, so a green
// result means the whole path works, not just that the browser granted
// permission. `ok: false` means the master switch is off, which the button
// reports plainly instead of appearing broken.
export async function POST() {
  const payload = emitTestNotification();
  return NextResponse.json({ ok: !!payload, enabled: notificationsEnabled(), payload });
}
