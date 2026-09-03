/* The one thing a desktop shell does that a browser tab cannot: tell you a task
 * needs you while you are looking at something else.
 *
 * SPIKE CODE. See ./README.md and docs/DESKTOP_APP.md §5.1.
 *
 * Everything here is Electron-free on purpose — same split as supervisor.js, so
 * the parts with policy in them (which events raise a toast, what the badge
 * count is, when a toast is redundant) are verifiable on a headless box by
 * `node desktop/test-supervisor.js`. main.js keeps only the calls that need a
 * display: Notification, Tray, setBadgeCount, setOverlayIcon.
 *
 * THIS DOES NOT COMPOSE NOTIFICATIONS. The server already does that
 * (lib/notifications/notify.ts): it owns which kinds are enabled, which rows
 * stay quiet, how a repeat inside 10 s is collapsed, and the exact wording —
 * and it publishes the finished payload on the same GET /api/events stream the
 * web UI reads (app/shell/useGlobalEvents.ts). So the shell subscribes to that
 * and renders what it is handed. Re-deriving "a task went awaiting_input" from
 * the raw task events would give the user a second, differently-worded, differently
 * -gated notification channel out of the same facts, and would ignore the
 * switches in Settings → Notifications.
 *
 * The Web Push half of that server-side fan-out (service worker + VAPID, aimed
 * at phones) is untouched: this is a third consumer of the same payload, not a
 * rewiring of the second.
 */
"use strict";

/**
 * Incremental `text/event-stream` reader.
 *
 * Only `data:` matters here — /api/events sends no `event:` names and no ids,
 * and its keep-alive is a bare `: ping` comment, which falls out for free.
 * Written as a push parser because a chunk boundary lands mid-frame often
 * enough to matter on a stream that is idle for minutes and then bursts.
 */
function createSseParser(onData) {
  let buf = "";
  return {
    push(text) {
      buf += text;
      // Frames are separated by a blank line. \r\n is legal in the spec and
      // costs one alternation to accept.
      const sep = /\r?\n\r?\n/g;
      for (;;) {
        sep.lastIndex = 0;
        const m = sep.exec(buf);
        if (!m) break;
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) onData(data);
      }
    },
    /** Test seam: what is still held back waiting for a frame terminator. */
    get pending() {
      return buf;
    },
  };
}

/**
 * One instance's "N need you" count — the same number that instance's own
 * titlebar pill shows (app/shell/useShell.ts: sum of every non-deprecated
 * project's awaiting_count).
 *
 * There is one of these per SUBSCRIBED INSTANCE, and the dock badge is the sum
 * across them (main.js `totalNeedsYou`). Kept per instance rather than as one
 * shared map because project ids are only unique within a database: two servers
 * that both seeded the tutorial project would otherwise overwrite each other's
 * count, and a reseed of one would have to know which keys belonged to it.
 *
 * It is a SUM because the wire has no instance-wide total on it: every task
 * event carries `awaiting_count` for the one project it belongs to, so the
 * shell keeps the per-project figures and adds them up, exactly as the web
 * client does. `deprecated` projects are excluded there and here — an archived
 * project must not badge the dock.
 *
 * `apply` returns `"reseed"` when an event names a project this map has never
 * heard of, or moves rows between projects without saying what the counts
 * became. Both are real (a project created in another window; a bulk move), and
 * both are rare enough that refetching /api/projects is cheaper than modelling
 * them.
 */
class NeedsYou {
  constructor() {
    /** @type {Map<string, number>} */
    this.counts = new Map();
  }

  /** Adopt the authoritative list. Projects that vanished are dropped. */
  seed(projects) {
    this.counts = new Map(
      (projects || []).filter((p) => p && !p.deprecated).map((p) => [p.id, Number(p.awaiting_count) || 0]),
    );
    return this.total;
  }

  /** @returns {"ok"|"reseed"|null} null = this event says nothing about the count. */
  apply(ev) {
    if (!ev) return null;
    if (ev.type === "tasks_moved") return "reseed";
    if (ev.type !== "task" && ev.type !== "task_deleted") return null;
    // A project we have never seen is either brand new or one we filtered as
    // deprecated. Only the server can tell those apart.
    if (!this.counts.has(ev.projectId)) return "reseed";
    this.counts.set(ev.projectId, Number(ev.awaiting_count) || 0);
    return "ok";
  }

  get total() {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
}

/**
 * The one suppression, kept pure so a test can pin it — and deliberately the
 * SAME rule the browser channel applies (`shouldDisplay` in
 * app/shell/useNotifications.ts): don't interrupt someone about the very task
 * they are looking at. Everything else — window behind another app, hidden to
 * the tray, a different task selected — is the case a toast exists for.
 *
 * The shell can answer both halves without a preload or an IPC bridge, which is
 * why the rule can be shared rather than approximated. "Looking at" is the
 * window being visible AND focused (a browser tab only knows `visible`; a
 * window that is on screen behind the editor is not being looked at). "Which
 * task" comes off the window's own URL: the app mirrors the open project/task
 * into `?project=&task=` (app/shell/persist.ts) so a refresh lands back where
 * you were, which makes `webContents.getURL()` a synchronous, always-current
 * read of the selection.
 */
function shouldNotify(payload, ctx) {
  if (!payload || !payload.title) return false;
  if (!payload.taskId) return true; // a test send belongs to no task
  return !(ctx.focused && ctx.selectedTaskId === payload.taskId);
}

/** The task the window is currently showing, or null. */
function selectedTaskFromUrl(url) {
  try {
    return new URL(url).searchParams.get("task") || null;
  } catch {
    return null;
  }
}

/**
 * What the OS toast actually says, once more than one instance can raise one.
 *
 * The server composed the title and body for a reader who is looking at ONE
 * Calandria (lib/notifications/notify.ts), and with a subscriber per saved
 * instance that assumption is gone: "Needs you: rename the config loader" says
 * nothing about which machine is asking. So the instance name is appended to
 * the TITLE — the line every platform shows, at the size that survives a
 * notification centre collapsing the body — with the same `·` separator the
 * window title uses (instances.js `windowTitle`).
 *
 * `instanceName` is null on a shell that has only ever had one instance, and
 * then the text is byte-for-byte what it was before phase 3: naming the only
 * instance there is would be noise on every toast the single-instance app
 * raises, which is nearly all of them.
 */
function notificationText(payload, { instanceName = null } = {}) {
  const name = String(instanceName ?? "").trim();
  const title = String(payload?.title ?? "");
  return { title: name ? `${title} · ${name}` : title, body: String(payload?.body ?? "") };
}

/**
 * The URL that opens a notification's task on a DIFFERENT instance.
 *
 * Clicking a toast from a background instance has to switch instances first,
 * which is a page load in another session partition — so unlike the
 * same-instance click (main.js `gotoTask`, a custom event into a live SPA)
 * there is no running app to dispatch into. The app mirrors its selection into
 * `?project=&task=` and restores from it on load (app/shell/persist.ts), so the
 * selection rides in the URL the switch was going to load anyway. No timing
 * race, no waiting for hydration.
 *
 * Returns the bare origin when there is nothing to select, so a caller can use
 * it unconditionally.
 */
function gotoUrl(origin, { projectId = "", taskId = "" } = {}) {
  if (!taskId) return origin;
  try {
    const url = new URL(origin);
    if (projectId) url.searchParams.set("project", projectId);
    url.searchParams.set("task", taskId);
    return url.toString();
  } catch {
    return origin;
  }
}

/**
 * Which committed PNG to hand `win.setOverlayIcon`.
 *
 * Windows' taskbar badge is an image, not a number — there is no
 * `setBadgeCount` equivalent — so the digits are pre-rendered
 * (desktop/scripts/make-assets.py) and this picks one. Ten files against
 * shipping a PNG encoder and a bitmap font in the main process to draw a glyph
 * that never changes.
 */
function overlayIconName(count) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? "badge-9plus.png" : `badge-${Math.floor(count)}.png`;
}

/** What the tray tooltip says. The count is the whole message. */
function trayTooltip(count) {
  if (!count) return "Calandria";
  return `Calandria — ${count} task${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you`;
}

/**
 * A reconnecting subscription to GET /api/events on the loopback server.
 *
 * Not an EventSource: there isn't one in the main process, and the two things
 * EventSource would add (automatic retry, Last-Event-ID) are one loop here and
 * meaningless on a stream that is a live tail with no ids. The reconnect
 * behaviour mirrors the web client's, including the part that matters most —
 * on every REconnect the project list is refetched, because anything published
 * while we were dark is simply gone.
 *
 * `fetchImpl` is injectable for two reasons now. The first is the Supervisor's:
 * so the whole loop can be driven against a stub server, with no display and no
 * waiting, from test-supervisor.js. The second is the load-bearing one — main.js
 * passes `session.fromPartition("persist:instance-<id>").fetch` bound to the
 * instance THIS subscriber is for (there is one per saved instance now, not one
 * for the active one), so these requests carry that instance's cookies. Under
 * Cloudflare Access the login lands `CF_Authorization` in the window's cookie
 * jar, and `globalThis.fetch` in the main process is not in that jar: it would
 * get a redirect to the identity provider on every reconnect, leaving the badge
 * at zero and no notifications at all while the page beside it worked fine.
 * `globalThis.fetch` remains the DEFAULT because a bare `new AppEvents(...)`
 * against a loopback server (the tests) needs no session at all.
 */
class AppEvents {
  constructor({
    origin,
    serviceToken = null,
    onEvent = () => {},
    onProjects = () => {},
    onLog = () => {},
    fetchImpl = globalThis.fetch,
    minBackoffMs = 1000,
    maxBackoffMs = 15_000,
  }) {
    this.origin = origin.replace(/\/$/, "");
    this.serviceToken = serviceToken;
    this.onEvent = onEvent;
    this.onProjects = onProjects;
    this.onLog = onLog;
    this.fetch = fetchImpl;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.controller = null;
    this.stopped = false;
    /** Connections made, so the first open can skip the reconnect resync. */
    this.opens = 0;
  }

  headers() {
    // Mirrors supervisor.js's ready probe and drain POST. /api/events is not one
    // of the routes that accept a service token — under the default no-login
    // mode the loopback Host is what authorizes us — but sending it costs
    // nothing and is the difference on an instance that has one.
    //
    // The caller decides whether there IS one, and for a remote instance the
    // answer is always no: SERVICE_TOKEN belongs to the server this machine
    // spawned, so sending it anywhere else would hand a stranger a credential
    // for the local database. main.js's `serviceTokenFor` is that rule.
    return this.serviceToken ? { "x-service-token": this.serviceToken } : {};
  }

  /** Refetch the authoritative project list. Best-effort. */
  async refreshProjects() {
    try {
      const res = await this.fetch(`${this.origin}/api/projects`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.onProjects(await res.json());
      return true;
    } catch (err) {
      this.onLog(`[shell] project list refresh failed: ${err?.message || err}`);
      return false;
    }
  }

  start() {
    if (this.loop) return this.loop;
    this.loop = this.run();
    return this.loop;
  }

  async run() {
    let backoff = this.minBackoffMs;
    while (!this.stopped) {
      try {
        await this.connect();
        backoff = this.minBackoffMs; // a clean read means the next drop starts over
      } catch (err) {
        if (this.stopped) break;
        this.onLog(`[shell] event stream dropped: ${err?.message || err}`);
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, this.maxBackoffMs);
    }
  }

  async connect() {
    this.controller = new AbortController();
    const res = await this.fetch(`${this.origin}/api/events`, {
      headers: { Accept: "text/event-stream", ...this.headers() },
      signal: this.controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    this.opens += 1;
    // The first open is paired with the caller's own initial seed; every later
    // one has a hole behind it (laptop sleep, a server restart) that only a
    // refetch can close.
    if (this.opens > 1) await this.refreshProjects();
    const parser = createSseParser((data) => {
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return; // a malformed frame must not kill the stream
      }
      this.onEvent(ev);
    });
    const reader = res.body.getReader();
    const decode = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decode.decode(value, { stream: true }));
    }
    if (!this.stopped) throw new Error("stream closed by the server");
  }

  stop() {
    this.stopped = true;
    try {
      this.controller?.abort();
    } catch {
      // already gone
    }
  }
}

module.exports = {
  AppEvents,
  NeedsYou,
  createSseParser,
  gotoUrl,
  notificationText,
  overlayIconName,
  selectedTaskFromUrl,
  shouldNotify,
  trayTooltip,
};
