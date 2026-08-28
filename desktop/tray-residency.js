/* Is the tray icon actually in a status area? — the question `new Tray()`
 * cannot answer.
 *
 * SPIKE CODE. See ./README.md and docs/DESKTOP_APP.md §5.1.
 *
 * `main.js` lets the X button HIDE the window instead of quitting, and the
 * whole safety of that rests on the user being able to get the window back
 * from a tray icon. Electron gives no way to check: on Linux `new Tray()`
 * succeeds whether or not the icon ever reaches a status area — it constructs a
 * Chromium `StatusIconLinuxDbus`, which registers a `StatusNotifierItem` on the
 * session bus and never reports back — and there is no callback for a host that
 * later goes away. Measured on the desktop bench 2026-08-28 (Ubuntu 24.04,
 * Xfce, Electron 44): xfce4-panel 4.18.4's `systray` plugin CRASHES when
 * Electron registers its item, taking `org.kde.StatusNotifierWatcher` off the
 * bus with it, so no icon appears — while `tray` is a live object, the window
 * hides, and the "open it again from the tray icon" notification points at
 * nothing. That is one panel bug, but the class is every session with no
 * status-notifier host: GNOME without the AppIndicator extension, a bare window
 * manager, a headless X server. There is no XEmbed fallback left in Chromium to
 * catch them.
 *
 * So ask the session. The status-notifier spec puts both halves of the answer
 * on the watcher: `IsStatusNotifierHostRegistered` says somebody is drawing
 * icons at all, and `RegisteredStatusNotifierItems` says whether OURS is among
 * them. Matched by the OWNER of the D-Bus connection rather than by the item's
 * name — Electron's item is `org.kde.StatusNotifierItem-<pid>-<n>` on some
 * hosts and a bare unique name on others, and its `Id` is Chromium's internal
 * `chrome_status_icon_N`, none of which picks our shell out of a session that
 * also has NetworkManager and a clipboard manager in the tray. This is the
 * same read `desktop/e2e/bench.ts` makes from outside; it is done here through
 * a CLI for the same reason it is done there — Electron ships no D-Bus binding
 * and this spike is not adding a native dependency to answer one question.
 *
 * THREE-VALUED ON PURPOSE. `hosted` is `true`, `false`, or `null` for "could
 * not find out", and the caller must not collapse the last two: a missing
 * `gdbus` or a timed-out call is not evidence that a working tray vanished.
 * `main.js` only ever moves its flag on an answer.
 */
"use strict";

const { execFile } = require("node:child_process");

const WATCHER = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";

/**
 * The two CLIs worth trying, in order. `gdbus` is glib's (`libglib2.0-bin`) and
 * is what bench.ts uses; `dbus-send` ships with the bus daemon itself, so it is
 * all but guaranteed to exist wherever there is a session bus to ask. Their
 * output formats differ only in quoting, which the parsers below tolerate
 * rather than branch on.
 */
const TOOLS = [
  {
    file: "gdbus",
    get: (dest, objectPath, iface, prop) => [
      "call",
      "--session",
      "-d",
      dest,
      "-o",
      objectPath,
      "-m",
      "org.freedesktop.DBus.Properties.Get",
      iface,
      prop,
    ],
    pid: (service) => [
      "call",
      "--session",
      "-d",
      DBUS,
      "-o",
      DBUS_PATH,
      "-m",
      `${DBUS}.GetConnectionUnixProcessID`,
      service,
    ],
  },
  {
    file: "dbus-send",
    get: (dest, objectPath, iface, prop) => [
      "--session",
      "--print-reply",
      `--dest=${dest}`,
      objectPath,
      "org.freedesktop.DBus.Properties.Get",
      `string:${iface}`,
      `string:${prop}`,
    ],
    pid: (service) => [
      "--session",
      "--print-reply",
      `--dest=${DBUS}`,
      DBUS_PATH,
      `${DBUS}.GetConnectionUnixProcessID`,
      `string:${service}`,
    ],
  },
];

/* ---- Parsing ------------------------------------------------------------ */

/**
 * Every string in a D-Bus reply, whichever CLI printed it: `gdbus` single-quotes
 * (`(<[':1.25/StatusNotifierItem']>,)`), `dbus-send` double-quotes inside an
 * `array [ ... ]` block. An empty array yields none, which is the answer that
 * matters most here.
 */
function parseDbusStrings(raw) {
  return [...String(raw).matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).filter((s) => s.length > 0);
}

/** A boolean property, or null if the reply carried neither literal. */
function parseDbusBoolean(raw) {
  const m = /\b(true|false)\b/.exec(String(raw));
  return m ? m[1] === "true" : null;
}

/** The pid out of a `GetConnectionUnixProcessID` reply, or null. */
function parseDbusPid(raw) {
  const m = /uint32\s+(\d+)/.exec(String(raw));
  return m ? Number(m[1]) || null : null;
}

/**
 * Split a `RegisteredStatusNotifierItems` entry into the bus name and the
 * object path glued onto it. An entry with no path uses the spec's default of
 * `/StatusNotifierItem`.
 */
function splitTrayItem(entry) {
  const slash = entry.indexOf("/");
  return slash === -1
    ? { service: entry, objectPath: "/StatusNotifierItem" }
    : { service: entry.slice(0, slash), objectPath: entry.slice(slash) };
}

/**
 * Does this error mean "nobody owns that bus name"? Both CLIs report it as
 * `org.freedesktop.DBus.Error.ServiceUnknown`, which is a definitive NO rather
 * than a failure to ask: there is no status-notifier host on this session.
 */
function isNameUnowned(err) {
  return /ServiceUnknown|was not provided by any \.service files/.test(String(err?.message || err));
}

function isMissingTool(err) {
  return err?.code === "ENOENT" || /ENOENT/.test(String(err?.message || err));
}

/**
 * Does this error mean the session bus itself is unreachable? Also a definitive
 * NO rather than a failure to ask: Electron had nowhere to register the icon.
 * `gdbus` says "Error connecting: Could not connect", `dbus-send` says "Failed
 * to open connection to \"session\" message bus" — measured, both exit 1.
 */
function isBusUnreachable(err) {
  return /Could not connect|Failed to (?:open connection|connect)|Cannot autolaunch/.test(String(err?.message || err));
}

/* ---- The probe ---------------------------------------------------------- */

/** `exec(file, args) -> Promise<stdout>`, rejecting with stderr in the message. */
function defaultExec(timeoutMs, env) {
  return (file, args) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { encoding: "utf8", timeout: timeoutMs, env, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        // Stderr FIRST: it is where both CLIs put the D-Bus error, and it is
        // what the callers match on and what a log line has room for — Node's
        // own "Command failed: <the whole argv>" would crowd it out.
        err.message = [stderr && String(stderr).trim(), err.message].filter(Boolean).join(" | ");
        reject(err);
      });
    });
}

/**
 * One pass at the question.
 *
 * Resolves `{ hosted, reason, retryable }`. `hosted: null` means the session
 * could not be asked — no D-Bus CLI, a timeout, an unexpected error — and the
 * caller must treat that as "no new information", never as a no.
 * `retryable: false` marks the answers that cannot change by waiting, so
 * `confirmTrayResidency()` stops instead of re-spawning for its whole budget.
 */
async function probeTrayResidency(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const pid = opts.pid || process.pid;
  // Per-CALL, not the caller's overall budget: `confirmTrayResidency()` passes
  // its whole `timeoutMs` down, and letting one gdbus spawn consume all of it
  // would leave no room for the retry that budget exists to buy.
  const exec = opts.exec || defaultExec(opts.execTimeoutMs ?? 1500, env);

  // Windows always has a notification area and macOS always has a menu bar;
  // there is nothing to ask and no bus to ask it on. Only Linux makes the icon
  // somebody else's decision.
  if (platform !== "linux") {
    return { hosted: true, reason: `the status area is part of ${platform}`, retryable: false };
  }
  // No bus, no StatusNotifierItem — Electron had nowhere to register the icon
  // either. Checked rather than left to the CLI because `gdbus` would try to
  // autolaunch a bus daemon of its own, and a stray one answers for nobody.
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    return { hosted: false, reason: "no DBUS_SESSION_BUS_ADDRESS, so the session has no status area", retryable: false };
  }

  let tool = null;
  let lastError = null;
  /** Run `pick(tool)` against the first CLI that exists, remembering which. */
  const call = async (pick) => {
    for (const candidate of tool ? [tool] : TOOLS) {
      try {
        const out = await exec(candidate.file, pick(candidate));
        tool = candidate;
        return { out };
      } catch (err) {
        if (isMissingTool(err) && !tool) {
          lastError = err;
          continue; // Not installed. Try the next CLI.
        }
        tool = candidate;
        return { err };
      }
    }
    return { err: lastError || new Error("no D-Bus command-line tool found") };
  };

  const host = await call((t) => t.get(WATCHER, WATCHER_PATH, WATCHER, "IsStatusNotifierHostRegistered"));
  if (host.err) {
    if (isNameUnowned(host.err)) {
      return { hosted: false, reason: `no owner for ${WATCHER}: this session hosts no tray icons`, retryable: true };
    }
    if (isMissingTool(host.err)) {
      return { hosted: null, reason: "neither gdbus nor dbus-send is installed", retryable: false };
    }
    if (isBusUnreachable(host.err)) {
      return { hosted: false, reason: `the session bus is unreachable: ${short(host.err)}`, retryable: false };
    }
    return { hosted: null, reason: `asking ${WATCHER} failed: ${short(host.err)}`, retryable: true };
  }
  if (parseDbusBoolean(host.out) === false) {
    return { hosted: false, reason: `${WATCHER} is on the bus but no host has registered with it`, retryable: true };
  }

  const listed = await call((t) => t.get(WATCHER, WATCHER_PATH, WATCHER, "RegisteredStatusNotifierItems"));
  if (listed.err) {
    if (isNameUnowned(listed.err)) {
      return { hosted: false, reason: `${WATCHER} went off the bus mid-check`, retryable: true };
    }
    return { hosted: null, reason: `reading RegisteredStatusNotifierItems failed: ${short(listed.err)}`, retryable: true };
  }

  const items = parseDbusStrings(listed.out).map(splitTrayItem);
  for (const item of items) {
    const owner = await call((t) => t.pid(item.service));
    // An item that disconnected between the listing and the question is not
    // ours; anything else that fails here is one entry, not the verdict.
    if (owner.err) continue;
    if (parseDbusPid(owner.out) === pid) {
      return { hosted: true, reason: `${item.service}${item.objectPath} is registered with ${WATCHER}`, retryable: false };
    }
  }
  return {
    hosted: false,
    reason: `a host is registered but none of its ${items.length} item(s) belongs to this process`,
    retryable: true,
  };
}

/**
 * Poll `probeTrayResidency()` until it says yes, runs out of budget, or gives
 * an answer that waiting cannot change.
 *
 * Registration is asynchronous — Electron puts the item on the bus and the
 * panel picks it up a round trip later — so a single read straight after
 * `new Tray()` would report a healthy session as trayless. The same function
 * does the re-check at close time with a much shorter budget, where the retry
 * covers a panel that is restarting rather than one that never existed.
 */
async function confirmTrayResidency(opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  const intervalMs = opts.intervalMs ?? 400;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let verdict = await probeTrayResidency(opts);
  while (verdict.hosted !== true && verdict.retryable !== false && Date.now() + intervalMs < deadline) {
    await sleep(intervalMs);
    verdict = await probeTrayResidency(opts);
  }
  return verdict;
}

function short(err) {
  return String(err?.message || err)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 160);
}

module.exports = {
  confirmTrayResidency,
  parseDbusBoolean,
  parseDbusPid,
  parseDbusStrings,
  probeTrayResidency,
  splitTrayItem,
};
