/* Calandria's service worker. Its ONE job is Web Push: receive a push, show it,
 * open the task on click, and keep the subscription registered if the browser
 * rotates it.
 *
 * Deliberately NO `fetch` handler — this must never become an offline cache.
 * Everything on screen is live server state (SSE event streams, the terminal's
 * WebSocket); there is nothing useful to serve from a cache, and a stale one
 * intercepting the event stream would be far worse than a browser error page
 * when the server is unreachable (docs/FEATURES.md, "Install as an app").
 * tests/webpush.test.ts pins the absence.
 *
 * The message body is the server-composed notification, verbatim
 * (lib/push/types.ts PushMessage); this file renders it and invents nothing,
 * so a phone with no tab open reads exactly what a desktop toast reads.
 */

self.addEventListener("install", () => {
  // No cache to prime; an updated worker can take over at once.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Not strictly needed without a fetch handler, but it lets an updated
  // worker post to the open pages immediately rather than after a reload.
  event.waitUntil(self.clients.claim());
});

function parseMessage(event) {
  try {
    const m = event.data ? event.data.json() : null;
    if (m && typeof m.title === "string") return m;
  } catch {
    /* not our JSON — fall through to a generic notice */
  }
  return { id: "", kind: "", title: "Calandria", body: event.data ? event.data.text() : "A task needs you.", url: "/", taskId: "", projectId: "" };
}

self.addEventListener("push", (event) => {
  const msg = parseMessage(event);
  event.waitUntil((async () => {
    // A FOCUSED page of the app is already showing this through the in-tab
    // channel, which applies the one rule the worker can't ("is the user
    // looking at this very task?"). Stand down and let it decide. A page
    // that's open but not focused (another window, a background tab) is
    // exactly where a toast is the point, so only focus counts.
    const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (pages.some((c) => c.focused)) return;
    await self.registration.showNotification(msg.title, {
      body: msg.body,
      // The payload id — stable per (kind, task) — so a second push about the
      // same task replaces the first instead of stacking, matching the in-tab
      // channel's tag exactly (which is also what collapses the pair on a
      // device that has both).
      tag: msg.id || undefined,
      icon: "/icons/icon-192.png",
      data: { url: msg.url || "/", taskId: msg.taskId || "", projectId: msg.projectId || "" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer a page that's already open — the installed app's standalone
    // window, or a tab. Opening a second window would leave two copies
    // fighting over the same selection.
    const page = pages.find((c) => c.focused) || pages.find((c) => c.visibilityState === "visible") || pages[0];
    if (page) {
      if ("focus" in page) await page.focus().catch(() => {});
      // Steer it to the task by NAVIGATING, not by postMessage. A warm PWA
      // that's foregrounded by the tap stays on whatever view it was last on
      // (Settings, say), and the in-page relay that would jump it races the
      // focus and, on iOS, often never receives the message at all — so the
      // app opened but didn't move. navigate() puts ?project/&task in the URL,
      // which readUrlSel applies on load and which forces the default
      // `workspace` view, so the task is what shows. postMessage stays as the
      // no-reload fallback for a browser whose WindowClient can't navigate.
      if (data.taskId && "navigate" in page) {
        try { await page.navigate(url); return; } catch { /* fall through to the message */ }
      }
      if (data.taskId) page.postMessage({ type: "goto-task", projectId: data.projectId, taskId: data.taskId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // The push service (or the browser) rotated the subscription. Re-subscribe
  // under the same server key and tell the server, or this device goes quiet
  // with no symptom: the server keeps posting to an endpoint that now 410s
  // and prunes it, and nothing on the device ever says so.
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const key = (old && old.options && old.options.applicationServerKey) || null;
    if (!key) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch("/api/notifications/push", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), label: "" }),
    });
  })());
});
