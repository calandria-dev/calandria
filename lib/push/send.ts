// The push channel: every notification the server composes goes out to every
// subscribed browser, through the same emitter the in-tab channel hangs off
// (lib/notifications/notify.ts calls pushNotification from its single exit),
// so the two can't disagree about what's worth a buzz or how it reads.
//
// Fire-and-forget by contract: deliver() runs synchronously inside the runner's
// publish, i.e. inside the TURN that stopped. The DB read here is sync and
// cheap (a handful of rows); everything after it is detached network I/O that
// must never be awaited by, or throw into, that turn.
//
// fetch-only, no SDK — pinned by tests/importGraph.test.ts.

import { createHash } from "node:crypto";
import type { NotificationPayload } from "@/lib/notifications/types";
import { encryptPushPayload } from "./encrypt";
import {
  deletePushSubscription, listPushSubscriptions, recordPushResult, type PushSubscriptionRow,
} from "./store";
import type { PushMessage } from "./types";
import { vapidAuthorization } from "./vapid";

export type Urgency = "very-low" | "low" | "normal" | "high";

export interface PushSendOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttl: number;
  urgency: Urgency;
  /** RFC 8030 §5.4 — a pending message with the same topic is REPLACED at the
   *  push service, the way the notification tag collapses on the device. */
  topic?: string;
}

export interface PushSendResult {
  status: number;
  ok: boolean;
  /** 404/410: the push service says this subscription no longer exists. */
  gone: boolean;
  error: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Deliver one encrypted message to one subscription. Returns rather than
 * throws on every outcome — a network error is a result with status 0 — so the
 * fan-out above can prune and record without a try/catch per device.
 */
export async function sendWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  body: Buffer,
  opts: PushSendOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<PushSendResult> {
  let headers: Record<string, string>;
  let payload: Buffer;
  try {
    payload = encryptPushPayload(body, { p256dh: sub.p256dh, auth: sub.auth });
    headers = {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: String(opts.ttl),
      urgency: opts.urgency,
      authorization: vapidAuthorization(sub.endpoint),
    };
    if (opts.topic) headers.topic = opts.topic;
  } catch (err) {
    return { status: 0, ok: false, gone: false, error: `encrypt: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: "POST",
      headers,
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const gone = res.status === 404 || res.status === 410;
    let error = "";
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).trim();
      error = text ? `${res.status}: ${text.split("\n")[0].slice(0, 160)}` : `HTTP ${res.status}`;
    }
    return { status: res.status, ok: res.ok, gone, error };
  } catch (err) {
    return { status: 0, ok: false, gone: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** ≤32 chars from the base64url alphabet, as RFC 8030 requires of a Topic. */
export function pushTopic(id: string): string {
  return createHash("sha256").update(id).digest("base64url").slice(0, 32);
}

// A failure is urgent — the device should wake for it — and a question can
// wait for the next unlock. Either is still worth hearing hours later: a
// task that stopped stays stopped until someone picks it up, so the service
// holds it a day for a phone that was off.
const TTL_S = 24 * 60 * 60;
function optionsFor(payload: NotificationPayload): PushSendOptions {
  const urgent = payload.kind === "turn_failed" || payload.kind === "schedule_failed";
  return { ttl: TTL_S, urgency: urgent ? "high" : "normal", topic: pushTopic(payload.id) };
}

/** The deep link the worker opens on click — the app's own ?project/?task keys. */
export function taskUrl(payload: { projectId: string; taskId: string }): string {
  if (!payload.taskId) return "/";
  const q = new URLSearchParams();
  if (payload.projectId) q.set("project", payload.projectId);
  q.set("task", payload.taskId);
  return `/?${q}`;
}

export function toPushMessage(payload: NotificationPayload): PushMessage {
  return {
    id: payload.id,
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
    taskId: payload.taskId,
    projectId: payload.projectId,
    url: taskUrl(payload),
    ts: payload.ts,
  };
}

/**
 * Fan one notification out to every subscription. Resolves once every push
 * service has answered (or timed out); callers in the turn path do NOT await
 * it. A 404/410 prunes the row — the browser dropped the subscription (site
 * data cleared, permission revoked, the service rotated it and the
 * pushsubscriptionchange re-post never reached us) and nothing will ever
 * deliver there again. Every other failure is recorded on the row for the
 * device list and left alone: a 401/403 usually means the VAPID key changed
 * under the subscription, which the browser fixes on its next visit by
 * re-subscribing (usePush.ts compares keys), and a 5xx/timeout is the service's
 * bad day, not the device's.
 */
export async function pushNotification(payload: NotificationPayload, fetchImpl: typeof fetch = fetch): Promise<PushSendResult[]> {
  const subs = listPushSubscriptions();
  if (subs.length === 0) return [];
  const body = Buffer.from(JSON.stringify(toPushMessage(payload)));
  const opts = optionsFor(payload);
  return Promise.all(subs.map((sub) => deliverTo(sub, body, opts, fetchImpl)));
}

async function deliverTo(sub: PushSubscriptionRow, body: Buffer, opts: PushSendOptions, fetchImpl: typeof fetch): Promise<PushSendResult> {
  const result = await sendWebPush(sub, body, opts, fetchImpl);
  try {
    if (result.gone) {
      deletePushSubscription(sub.id);
      console.log(`[push] pruned subscription ${sub.id} (${sub.label || "unlabelled"}): ${result.status}`);
    } else {
      recordPushResult(sub.id, result.status, result.error);
      if (!result.ok) console.warn(`[push] delivery to ${sub.id} (${sub.label || "unlabelled"}) failed: ${result.error}`);
    }
  } catch (err) {
    // The DB write after the send is bookkeeping; a failure there must not
    // surface as a rejected promise nobody is awaiting.
    console.error("[push] recording delivery result failed:", err);
  }
  return result;
}

/** The detached form the emitter uses: never rejects, never awaited. */
export function pushNotificationDetached(payload: NotificationPayload): void {
  pushNotification(payload).catch((err) => console.error("[push] fan-out failed:", err));
}
