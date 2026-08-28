"use client";

import { useEffect } from "react";
import type { PushDevice } from "@/lib/push/types";
import { jget, jsend } from "./api";

// The Web Push channel's browser half: whether THIS browser can subscribe, the
// subscribe/unsubscribe calls Settings → Notifications makes, the re-sync every
// page load runs for a browser that already subscribed, and the relay that
// turns a notification click in the service worker into the app's own
// calandria:goto-task jump. The worker itself is public/sw.js.

export type PushSupportState = "insecure" | "unsupported" | "needs_install" | "ready";

/**
 * Pure classifier, pinned by a test. `insecure` first for the same reason
 * classifyNotificationSupport puts it first: outside a secure context the
 * browser hides the whole API, and "unsupported" would send the user to a
 * different browser when the fix is https. `needs_install` is iOS's rule —
 * Safari exposes PushManager only to an app on the Home Screen, so a phone
 * that is "unsupported" in the browser is one Add-to-Home-Screen away.
 */
export function classifyPushSupport(env: {
  secureContext: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  ios: boolean;
  standalone: boolean;
}): PushSupportState {
  if (!env.secureContext) return "insecure";
  if (env.hasServiceWorker && env.hasPushManager) return "ready";
  if (env.ios && !env.standalone) return "needs_install";
  return "unsupported";
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch points give it away.
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupportState {
  if (typeof window === "undefined") return "unsupported";
  return classifyPushSupport({
    secureContext: window.isSecureContext,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    ios: isIos(),
    standalone: isStandalone(),
  });
}

/** "iPhone · Safari (app)" — what the device list shows for this browser. */
export function deviceLabel(ua: string = navigator.userAgent, standalone: boolean = isStandalone()): string {
  const os = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux"
    : "Device";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  return `${os} · ${browser}${standalone ? " (app)" : ""}`;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The VAPID key this subscription was made under, base64url, or "" if unknown. */
function keyOf(sub: PushSubscription): string {
  const k = sub.options?.applicationServerKey;
  return k ? bytesToB64url(k) : "";
}

const SW_URL = "/sw.js";

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

async function subscribeUnder(publicKey: string): Promise<PushSubscription> {
  await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  // subscribe() needs an ACTIVE worker; `ready` waits for the first activation.
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription under a different server key can never be pushed to by this
  // server (the push service rejects the signature) — replace it.
  if (sub && keyOf(sub) !== publicKey) { await sub.unsubscribe(); sub = null; }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
}

type RegisterReply = { ok: boolean; device: PushDevice };

async function register(sub: PushSubscription): Promise<PushDevice> {
  const r = await jsend<RegisterReply>("/api/notifications/push", "POST", { subscription: sub.toJSON(), label: deviceLabel() });
  return r.device;
}

/**
 * Subscribe this browser. Called from a click: on iOS the permission prompt
 * only opens inside a user gesture, so the prompt comes FIRST, before any
 * await that could spend the activation window.
 */
export async function enablePush(): Promise<PushDevice> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(perm === "denied"
      ? "Notifications are blocked for this site. Unblock them in the browser's site settings."
      : "Notification permission wasn't granted.");
  }
  const { publicKey } = await jget<{ publicKey: string }>("/api/notifications/push");
  return register(await subscribeUnder(publicKey));
}

/** Unsubscribe this browser. The server is told first, while the endpoint is still known. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await jsend("/api/notifications/push", "DELETE", { endpoint: sub.endpoint });
  } finally {
    // Even if the server call failed: an unsubscribed endpoint answers 410 to
    // the next push and the server prunes it then.
    await sub.unsubscribe();
  }
}

/**
 * Re-register an existing subscription with the server — once per page load,
 * and only for a browser that subscribed at some point (no subscription, no
 * request). This is what keeps a device alive across the cases the worker's
 * pushsubscriptionchange can't reach: its re-post failed (an expired Access
 * session), the row was removed from another device's Settings, or the
 * instance's VAPID key changed and the subscription must be remade under the
 * new one. Returns this device's row, or null when it isn't subscribed.
 */
export async function syncPushSubscription(): Promise<PushDevice | null> {
  if (pushSupport() !== "ready") return null;
  const sub = await currentSubscription();
  if (!sub) return null;
  if (Notification.permission !== "granted") {
    // Permission revoked since subscribing: the subscription is dead weight
    // the server would keep pushing to. Drop it on both sides.
    await disablePush();
    return null;
  }
  const { publicKey } = await jget<{ publicKey: string }>("/api/notifications/push");
  const fresh = keyOf(sub) === publicKey ? sub : await subscribeUnder(publicKey);
  return register(fresh);
}

/**
 * Mount-once: relay the worker's notificationclick into the app's task jump,
 * and re-sync this browser's subscription. Lives in useShell beside the
 * calandria:goto-task listener it feeds.
 */
export function usePushRelay(): void {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; projectId?: string; taskId?: string } | null;
      if (d?.type !== "goto-task" || !d.taskId) return;
      window.dispatchEvent(new CustomEvent("calandria:goto-task", { detail: { projectId: d.projectId ?? "", taskId: d.taskId } }));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    syncPushSubscription().catch((err) => console.warn("[push] subscription re-sync failed:", err));
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
