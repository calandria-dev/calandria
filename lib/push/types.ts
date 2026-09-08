// Wire shapes shared by the push routes and the Settings device list.
// Import-free so a client component can `import type` it without dragging the
// DB in, the same rule as lib/notifications/types.ts.

/** What the browser hands us from PushManager.subscribe().toJSON(). */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** One subscribed browser, as Settings → Notifications lists it. */
export interface PushDevice {
  id: string;
  /** Client-supplied ("iPhone · Safari"); the server only trims it. */
  label: string;
  /** The push service's host, e.g. web.push.apple.com. The best hint at
   *  which device this is when the label is generic. */
  service: string;
  created_at: number;
  last_seen_at: number;
  last_sent_at: number;
  /** HTTP status of the last delivery attempt; 0 = never sent. */
  last_status: number;
  last_error: string;
}

/**
 * The message a push carries: the server-composed notification, verbatim, plus
 * the URL the service worker opens on click. The worker renders this
 * unmodified; see public/sw.js.
 */
export interface PushMessage {
  id: string;
  kind: string;
  title: string;
  body: string;
  taskId: string;
  projectId: string;
  url: string;
  ts: number;
}
