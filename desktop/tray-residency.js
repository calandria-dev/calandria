/* Whether the tray icon is actually visible in a status area, which
 * `new Tray()` cannot answer on its own: on Linux it succeeds whether or not
 * the icon ever reaches a status area, and there is no callback for a host
 * that later goes away. `main.js` hides the window instead of quitting on the
 * X button, which is only safe if the user can get it back from a tray icon.
 *
 * This asks the session directly, through the status-notifier watcher, and
 * matches by the owner of the D-Bus connection rather than by item name,
 * since Electron's item name and id vary by host.
 *
 * `hosted` is `true`, `false`, or `null` for "could not find out"; the caller
 * must not collapse the last two into a no.
 */
"use strict";

const { execFile } = require("node:child_process");

const WATCHER = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH = "/StatusNotifierWatcher";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";

/**
 * The two CLIs to try, in order: `gdbus` (glib, `libglib2.0-bin`) first, then
 * `dbus-send`, which ships with the bus daemon itself and is nearly always
 * present. The parsers below tolerate the quoting differences between their
 * output formats.
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
 * `org.freedesktop.DBus.Error.ServiceUnknown`: a definitive no, meaning there
 * is no status-notifier host on this session.
 */
function isNameUnowned(err) {
  return /ServiceUnknown|was not provided by any \.service files/.test(String(err?.message || err));
}

function isMissingTool(err) {
  return err?.code === "ENOENT" || /ENOENT/.test(String(err?.message || err));
}

/**
 * Does this error mean the session bus itself is unreachable? Also a
 * definitive no: Electron had nowhere to register the icon. `gdbus` says
 * "Error connecting: Could not connect", `dbus-send` says "Failed to open
 * connection to \"session\" message bus", and both exit 1.
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
        // Stderr first: it is where both CLIs put the D-Bus error, what the
        // callers match on, and what a log line has room for. Node's own
        // "Command failed: <the whole argv>" would crowd it out.
        err.message = [stderr && String(stderr).trim(), err.message].filter(Boolean).join(" | ");
        reject(err);
      });
    });
}

/**
 * One pass at the question.
 *
 * Resolves `{ hosted, reason, retryable }`. `hosted: null` means the session
 * could not be asked (no D-Bus CLI, a timeout, an unexpected error), and the
 * caller must treat that as "no new information", never as a no.
 * `retryable: false` marks answers that cannot change by waiting, so
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
  // No bus, no StatusNotifierItem: Electron had nowhere to register the icon
  // either. This is checked before calling the CLI because `gdbus` would try
  // to autolaunch a bus daemon of its own, and a stray one answers for
  // nobody.
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
 * Registration is asynchronous: Electron puts the item on the bus and the
 * panel picks it up a round trip later, so a single read straight after
 * `new Tray()` would report a healthy session as trayless. The same function
 * does the re-check at close time with a much shorter budget, covering a
 * panel that is restarting.
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
