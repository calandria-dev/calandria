import { NextResponse } from "next/server";
import { jsonGuard } from "@/lib/apiGuard";
import {
  deletePushSubscriptionByEndpoint, listPushSubscriptions, toPushDevice, upsertPushSubscription,
} from "@/lib/push/store";
import type { PushSubscriptionJson } from "@/lib/push/types";
import { vapidKeys } from "@/lib/push/vapid";
import { VAPID_SUBJECT } from "@/lib/config";

export const dynamic = "force-dynamic";

// The Web Push subscription surface behind Settings → Notifications. Plain
// same-origin credentialed fetches from the app (and from the service worker's
// pushsubscriptionchange re-post), so they pass middleware's gate the way every
// other /api call does: under Cloudflare Access the session cookie rides
// along, and the Origin header matches Host. No service-token path: nothing
// outside the browser ever calls these.

/** The VAPID public key the browser subscribes under, plus every known device. */
export async function GET() {
  return jsonGuard("push/list", async () => {
    // Minting the key lazily HERE (not at boot) keeps an instance that never
    // opens Settings from writing a key file it will never use.
    const { publicKey } = vapidKeys();
    return NextResponse.json({
      publicKey,
      subject: VAPID_SUBJECT,
      subscriptions: listPushSubscriptions().map(toPushDevice),
    });
  });
}

function parseSubscription(raw: unknown): PushSubscriptionJson | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const keys = s.keys as Record<string, unknown> | undefined;
  if (typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 2048) return null;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  const expirationTime = typeof s.expirationTime === "number" ? s.expirationTime : null;
  return { endpoint: s.endpoint, expirationTime, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Register (or refresh) this browser's subscription. */
export async function POST(req: Request) {
  return jsonGuard("push/subscribe", async () => {
    const body = (await req.json().catch(() => null)) as { subscription?: unknown; label?: unknown } | null;
    const sub = parseSubscription(body?.subscription);
    if (!sub) return NextResponse.json({ error: "A push subscription with an https endpoint and p256dh/auth keys is required." }, { status: 400 });
    const label = typeof body?.label === "string" ? body.label : "";
    const row = upsertPushSubscription(sub, label);
    return NextResponse.json({ ok: true, device: toPushDevice(row) });
  });
}

/** Forget this browser's subscription (by endpoint, since the browser knows no id). */
export async function DELETE(req: Request) {
  return jsonGuard("push/unsubscribe", async () => {
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== "string" || !body.endpoint) {
      return NextResponse.json({ error: "endpoint is required." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, removed: deletePushSubscriptionByEndpoint(body.endpoint) });
  });
}
