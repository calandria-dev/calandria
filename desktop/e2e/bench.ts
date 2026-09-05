/**
 * Session-level assertions for the desktop bench specs: notifications, tray
 * status and window-manager state, none of which the Electron process itself
 * can confirm (a notification call succeeds whether or not a daemon received
 * it, and `win.minimize()` is a no-op with no window manager but still
 * reports `isMinimized()` as true). Every helper here reads the answer from
 * outside the app: the session D-Bus (`dbus-monitor`, `gdbus`) and the X
 * server's EWMH properties (`xprop`).
 *
 * These specs are ordinary members of `playwright.desktop.config.ts`, gated
 * by `CALANDRIA_DESKTOP_BENCH=1` rather than a separate config, and they
 * launch the shell through the same `launchShell()` as every other spec.
 *
 * The session bus is not the systemd user bus: over SSH, `pam_systemd`
 * exports a `DBUS_SESSION_BUS_ADDRESS` for a bus with none of the desktop
 * session's daemons on it. The graphical session's own bus address is
 * published to `~/.vnc/session-bus` by its xstartup; every helper here reads
 * that file and overrides the inherited value, and `benchEnv()` passes the
 * same override to the launched shell so the app and the assertions share
 * one bus.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Enables these specs. Opt-in rather than auto-detected: a runner with a
 * partially present session would otherwise run them and fail on the parts
 * it cannot support, and a lane that disables itself whenever the tray is
 * missing could never catch a missing tray.
 */
export const BENCH = process.env.CALANDRIA_DESKTOP_BENCH === "1";

/**
 * The bench session's display. `:1` is where the VNC session lives (the role in
 * `ansible-orion` pins it); an inherited `DISPLAY` wins if a job set one.
 */
export const BENCH_DISPLAY = process.env.CALANDRIA_DESKTOP_BENCH_DISPLAY || process.env.DISPLAY || ":1";

/** Where the graphical session publishes the address of the bus it owns. */
const SESSION_BUS_FILE = process.env.CALANDRIA_BENCH_SESSION_BUS || path.join(os.homedir(), ".vnc", "session-bus");

/** The health check the bench installs; see `assertBenchSession()`. */
const BENCH_CHECK = process.env.CALANDRIA_BENCH_CHECK || "desktop-bench-check";

let cachedBusAddress: string | null = null;

/**
 * The session bus's address, read from the session rather than the
 * environment. Cached because the file is written once per session start.
 */
export function sessionBusAddress(): string {
  if (cachedBusAddress) return cachedBusAddress;
  if (!fs.existsSync(SESSION_BUS_FILE)) {
    throw new Error(
      `No session bus address at ${SESSION_BUS_FILE}. These specs need the bench VM's graphical ` +
        `session (docs/DESKTOP_E2E.md §5), whose xstartup writes that file. If the session is up ` +
        `but the path differs, set CALANDRIA_BENCH_SESSION_BUS.`
    );
  }
  cachedBusAddress = fs.readFileSync(SESSION_BUS_FILE, "utf8").trim();
  if (!cachedBusAddress) throw new Error(`${SESSION_BUS_FILE} is empty — the session did not publish a bus address.`);
  return cachedBusAddress;
}

/**
 * Environment to merge into a `launchShell()` call so the shell joins the
 * real session.
 *
 * `DBUS_SESSION_BUS_ADDRESS` here overrides `fixtures.ts`'s
 * `NO_NOTIFICATION_BUS`, which points other Linux runs at a socket that does
 * not exist so libnotify fails immediately instead of blocking the main
 * process on GDBus's 25 s timeout. That default holds when no daemon is
 * present; these specs need the daemon reachable.
 */
export function benchEnv(): Record<string, string> {
  return { DISPLAY: BENCH_DISPLAY, DBUS_SESSION_BUS_ADDRESS: sessionBusAddress() };
}

/**
 * Refuses to run against a session that is not a real one.
 *
 * `desktop-bench-check` is the bench's precondition script, installed by the
 * `desktop_bench` Ansible role: it prints one `ok`/`FAIL` line per capability
 * Xvfb cannot provide on its own. Called from every bench spec's `beforeAll`,
 * because a session that lost its panel would otherwise fail these specs as
 * if the shell had regressed.
 *
 * Each file asks only for the capabilities it uses rather than requiring a
 * clean report overall. On this bench, the status area dies as soon as any
 * spec in the suite launches the shell, because xfce4-panel's systray plugin
 * crashes on Electron's status icon. An all-or-nothing check would fail the
 * notification and window-manager files along with the tray one, over a
 * capability neither of them uses.
 */
export const BENCH_CHECKS = {
  x: "X server reachable",
  wm: "window manager running",
  notifications: "notification daemon",
  tray: "status notifier host",
} as const;

export type BenchCapability = keyof typeof BENCH_CHECKS;

export function assertBenchSession(requires: BenchCapability[]): void {
  let out: string;
  try {
    out = execFileSync(BENCH_CHECK, {
      encoding: "utf8",
      env: { ...process.env, DISPLAY: BENCH_DISPLAY },
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        `${BENCH_CHECK} is not on PATH. CALANDRIA_DESKTOP_BENCH=1 says this is the bench VM, and ` +
          `that script is what proves it (docs/DESKTOP_E2E.md §5). Re-run the desktop-bench.yml ` +
          `playbook in ansible-orion, or set CALANDRIA_BENCH_CHECK.`
      );
    }
    // A non-zero exit means something failed, not necessarily something this
    // file needs. The report is on stdout either way, so read it instead of
    // trusting the status.
    out = e.stdout ?? "";
    if (!out) throw new Error(`${BENCH_CHECK} produced no report: ${e.stderr ?? String(err)}`);
  }

  const missing: string[] = [];
  for (const cap of requires) {
    const label = BENCH_CHECKS[cap];
    if (out.includes(`ok    ${label}`)) continue;
    if (out.includes(`FAIL  ${label}`)) missing.push(label);
    else throw new Error(`${BENCH_CHECK} reported no line for "${label}" — has the script changed?\n${out}`);
  }
  if (missing.length) {
    throw new Error(
      `The bench session is missing ${missing.map((m) => `"${m}"`).join(", ")}, so these specs would ` +
        `be testing a broken session rather than the shell:\n${out}`
    );
  }
}

/**
 * Polls `read()` until `ok()` accepts it.
 *
 * A throw from `read()` counts as a retry, not a failure: the things these
 * helpers read are owned by other processes that come and go. A panel plugin
 * restarting takes `org.kde.StatusNotifierWatcher` off the bus for a second
 * or two, and a window that was just withdrawn makes `xprop -id` fail
 * outright. Both are transient states, not verdicts. The last error is kept
 * and reported on timeout, so an absent daemon is named instead of reported
 * only as "never settled".
 */
export async function poll<T>(
  read: () => T | Promise<T>,
  ok: (value: T) => boolean,
  opts: { timeoutMs?: number; label?: string } = {}
): Promise<T> {
  const timeout = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      last = await read();
      lastError = undefined;
      if (ok(last)) return last;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const detail = lastError
        ? `Last error: ${String((lastError as Error).message ?? lastError).slice(0, 400)}`
        : `Last read: ${JSON.stringify(last)}`;
      throw new Error(`${opts.label ?? "poll"} never settled within ${timeout} ms. ${detail}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* ---- The session bus ---------------------------------------------------- */

function benchExec(file: string, args: string[]): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    env: { ...process.env, ...benchEnv() },
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** One `gdbus call`, against the session's own bus. */
function gdbus(args: string[]): string {
  return benchExec("gdbus", ["call", "--session", ...args]).trim();
}

/**
 * One captured `org.freedesktop.Notifications.Notify` call, plus the answer
 * the daemon gave it.
 */
export type NotifyCall = {
  /** D-Bus serial of the method call; what a reply names in `reply_serial`. */
  serial: number;
  /** `app_name`, arg 0. Electron sends `app.getName()`. */
  appName: string;
  /** `summary`, arg 3, the notification's title. */
  summary: string;
  /** `body`, arg 4. Multi-line bodies arrive verbatim. */
  body: string;
  /** libnotify's `sender-pid` hint, when the sender set one. */
  senderPid: number | null;
  /**
   * The id the notification daemon replied with, or null if no reply has
   * been seen yet. Non-null distinguishes "the app called Notify" from "a
   * daemon accepted it", which is what this lane asserts.
   */
  daemonId: number | null;
};

type Record_ = { header: string; body: string };

/**
 * A running `dbus-monitor` over the session bus, watching notification
 * traffic.
 *
 * Two match rules matter: `member=Notify` catches what the shell sent, and
 * `type=method_return` catches the daemon's reply, which carries the
 * notification id it assigned. Correlating them by serial/reply_serial turns
 * "the app made a D-Bus call" into "a notification daemon received it and
 * assigned an id".
 *
 * Daemon-agnostic on purpose: the bench runs dunst, and `dunstctl history`
 * would be a shorter read, but that would assert something about dunst
 * instead of the session, and would fail if the Xfce session ran
 * `xfce4-notifyd` instead.
 */
export class NotifyWatch {
  private buf = "";
  private constructor(private readonly proc: ChildProcess) {}

  /** Start capturing. Resolves once dbus-monitor is actually on the bus. */
  static async start(): Promise<NotifyWatch> {
    const proc = spawn(
      "dbus-monitor",
      [
        "--address",
        sessionBusAddress(),
        "interface=org.freedesktop.Notifications,member=Notify",
        "type=method_return",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const watch = new NotifyWatch(proc);
    proc.stdout?.on("data", (d: Buffer) => {
      watch.buf += String(d);
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += String(d);
    });

    // dbus-monitor announces its own connection (NameAcquired/NameLost) as
    // soon as it is on the bus, so the first byte of output is a readiness
    // signal. A monitor started after the shell would miss the notification
    // it is meant to observe.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`dbus-monitor did not start within 10 s: ${stderr}`)), 10_000);
      const tick = setInterval(() => {
        if (watch.buf) {
          clearInterval(tick);
          clearTimeout(deadline);
          resolve();
        }
      }, 50);
      proc.on("exit", (code) => {
        clearInterval(tick);
        clearTimeout(deadline);
        reject(new Error(`dbus-monitor exited with ${code}: ${stderr}`));
      });
    });
    return watch;
  }

  /** Every message seen so far, split at its header line. */
  private records(): Record_[] {
    const out: Record_[] = [];
    let current: Record_ | null = null;
    for (const line of this.buf.split("\n")) {
      if (/^(method call|method return|signal|error) /.test(line)) {
        current = { header: line, body: "" };
        out.push(current);
      } else if (current) {
        current.body += line + "\n";
      }
    }
    return out;
  }

  /**
   * Every Notify call captured, newest last, each carrying the daemon's reply
   * if one has arrived. Re-parsed on each call so a caller can poll it.
   *
   * `dbus-monitor`'s argument dump is positional: `app_name`, `replaces_id`,
   * `app_icon`, `summary`, `body`, then the actions and hints arrays. Only
   * the strings before the first array are scalar arguments; the hints array
   * contains `string "urgency"`-shaped entries that would otherwise read as
   * a sixth and seventh argument.
   */
  calls(): NotifyCall[] {
    const records = this.records();
    const replies = new Map<number, number>();
    for (const r of records) {
      if (!r.header.startsWith("method return")) continue;
      const serial = Number(r.header.match(/reply_serial=(\d+)/)?.[1] ?? 0);
      const id = r.body.match(/^\s*uint32 (\d+)\s*$/m)?.[1];
      if (serial && id !== undefined) replies.set(serial, Number(id));
    }

    const calls: NotifyCall[] = [];
    for (const r of records) {
      if (!r.header.startsWith("method call") || !/member=Notify\b/.test(r.header)) continue;
      const serial = Number(r.header.match(/ serial=(\d+)/)?.[1] ?? 0);
      const scalars = r.body.split(/^\s*array \[/m)[0];
      // Lazy up to a closing quote at end of line: a notification body can
      // contain newlines (turn_failed appends the error under the task
      // title), and dbus-monitor prints them raw.
      const strings = [...scalars.matchAll(/^[ \t]*string "([\s\S]*?)"[ \t]*$/gm)].map((m) => m[1]);
      const senderPid = r.body.match(/string "sender-pid"[\s\S]*?int64 (\d+)/)?.[1];
      calls.push({
        serial,
        appName: strings[0] ?? "",
        summary: strings[2] ?? "",
        body: strings[3] ?? "",
        senderPid: senderPid ? Number(senderPid) : null,
        daemonId: replies.get(serial) ?? null,
      });
    }
    return calls;
  }

  /** Waits for a captured Notify matching `match`, or fails naming what was seen. */
  async waitFor(match: (call: NotifyCall) => boolean, opts: { timeoutMs?: number; what?: string } = {}): Promise<NotifyCall> {
    const timeout = opts.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = this.calls().find(match);
      if (hit) return hit;
      if (Date.now() >= deadline) {
        const seen = this.calls().map((c) => `${c.appName}: ${c.summary} / ${c.body.replace(/\n/g, " ⏎ ")}`);
        throw new Error(
          `No notification matching ${opts.what ?? "the predicate"} reached the session bus within ` +
            `${timeout} ms.\nCaptured ${seen.length}:\n${seen.map((s) => `  · ${s}`).join("\n")}`
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** How many captured calls match: the "exactly once" half of an assertion. */
  count(match: (call: NotifyCall) => boolean): number {
    return this.calls().filter(match).length;
  }

  stop(): void {
    this.proc.kill();
  }
}

/* ---- The status area (StatusNotifierItem / dbusmenu) -------------------- */

/** A tray icon as the session's status-notifier host sees it. */
export type TrayItem = { service: string; objectPath: string };

/** One entry of a tray icon's menu, as a panel would draw it. */
export type TrayMenuItem = { id: number; label: string; enabled: boolean };

/**
 * Every tray icon currently registered with the session's status-notifier
 * host, as `(':1.25/org/ayatana/NotificationItem/foo',)`: a bus name with the
 * item's object path attached. An entry with no path uses the spec's default
 * of `/StatusNotifierItem`.
 */
export function registeredTrayItems(): TrayItem[] {
  let raw: string;
  try {
    raw = gdbus([
      "-d",
      "org.kde.StatusNotifierWatcher",
      "-o",
      "/StatusNotifierWatcher",
      "-m",
      "org.freedesktop.DBus.Properties.Get",
      "org.kde.StatusNotifierWatcher",
      "RegisteredStatusNotifierItems",
    ]);
  } catch (err) {
    // `ServiceUnknown` means nobody owns the watcher name. `assertBenchSession()`
    // confirmed the host a moment before, so this means it went away since;
    // the reason is worth naming here instead of surfacing as a raw gdbus
    // error, since it looks identical to "the tray never registered".
    if (/ServiceUnknown/.test(String((err as Error).message ?? err))) {
      throw new Error(
        `org.kde.StatusNotifierWatcher has no owner: the session's status-notifier host went away ` +
          `after the session check passed. Measured on the bench (2026-08-28, xfce4-panel 4.18.4, ` +
          `Electron 44): the panel's built-in \`systray\` plugin CRASHES when Electron registers its ` +
          `status icon — "Plugin systray-6 has been automatically restarted after crash" in the ` +
          `session log — and the shell's icon is gone with it. That is a bench-provisioning defect, ` +
          `not a shell regression: the session needs a status-notifier host that survives a ` +
          `Chromium-shaped item. docs/DESKTOP_E2E.md §5.`
      );
    }
    throw err;
  }
  return [...raw.matchAll(/'([^']+)'/g)].map((m) => {
    const entry = m[1];
    const slash = entry.indexOf("/");
    return slash === -1
      ? { service: entry, objectPath: "/StatusNotifierItem" }
      : { service: entry.slice(0, slash), objectPath: entry.slice(slash) };
  });
}

/**
 * The registered tray item owned by `pid`, or null.
 *
 * Matched by the owner of the D-Bus connection rather than by the icon's
 * name or title: Electron's item is named `org.kde.StatusNotifierItem-<pid>-<n>`
 * on some hosts and a bare unique name on others, and its `Id` is Chromium's
 * internal `chrome_status_icon_N`, none of which identifies this shell on a
 * session that also has NetworkManager, a clipboard manager and whatever
 * else is in the tray. The connection's pid does.
 */
export function trayItemForPid(pid: number): TrayItem | null {
  for (const item of registeredTrayItems()) {
    if (connectionPid(item.service) === pid) return item;
  }
  return null;
}

function connectionPid(service: string): number | null {
  try {
    const raw = gdbus([
      "-d",
      "org.freedesktop.DBus",
      "-o",
      "/org/freedesktop/DBus",
      "-m",
      "org.freedesktop.DBus.GetConnectionUnixProcessID",
      service,
    ]);
    return Number(raw.match(/uint32 (\d+)/)?.[1] ?? 0) || null;
  } catch {
    // The item disconnected between listing and asking. Not ours, then.
    return null;
  }
}

/** The dbusmenu object a tray item points its host at. */
function trayMenuPath(item: TrayItem): string {
  const raw = gdbus([
    "-d",
    item.service,
    "-o",
    item.objectPath,
    "-m",
    "org.freedesktop.DBus.Properties.Get",
    "org.kde.StatusNotifierItem",
    "Menu",
  ]);
  const menu = raw.match(/'(\/[^']*)'/)?.[1];
  if (!menu) throw new Error(`${item.service}${item.objectPath} exposes no Menu property: ${raw}`);
  return menu;
}

/**
 * The tray menu's items, read over `com.canonical.dbusmenu`: the menu the
 * panel would draw, not the `Menu` object the main process built. Electron's
 * `Tray` has no getter for a menu, so this is the only way to assert it, and
 * it fails if the menu never reached the host.
 *
 * Separators carry no `label` and drop out; `enabled` is omitted by dbusmenu
 * when it is true, so absence means enabled here.
 */
export function trayMenuItems(item: TrayItem): TrayMenuItem[] {
  const raw = gdbus([
    "-d",
    item.service,
    "-o",
    trayMenuPath(item),
    "-m",
    "com.canonical.dbusmenu.GetLayout",
    "0",
    // Depth 2, not the spec's -1 ("everything"): gdbus's option parser reads
    // a bare `-1` as a flag and prints its usage instead. Two levels covers
    // this menu (a flat list under the root) with a submenu's worth of room
    // to spare.
    "2",
    "['label', 'enabled']",
  ]);
  const out: TrayMenuItem[] = [];
  for (const m of raw.matchAll(/\((\d+),\s*\{([^}]*)\}/g)) {
    const dict = m[2];
    const label = dict.match(/'label':\s*<'(.*?)'>/)?.[1];
    if (label === undefined) continue;
    out.push({ id: Number(m[1]), label, enabled: dict.match(/'enabled':\s*<(true|false)>/)?.[1] !== "false" });
  }
  return out;
}

/* ---- The window manager (EWMH, via xprop) -------------------------------- */

function xprop(args: string[]): string {
  try {
    return benchExec("xprop", args);
  } catch {
    // A window that went away between listing and reading is not an error
    // here; every caller polls.
    return "";
  }
}

/** Hex window ids print with different padding depending on the property. */
function normalizeId(id: string): string {
  return `0x${Number(id).toString(16)}`;
}

/** Every top-level window the window manager is currently managing. */
export function managedWindowIds(): string[] {
  const raw = xprop(["-root", "_NET_CLIENT_LIST"]);
  return [...raw.matchAll(/0x[0-9a-f]+/gi)].map((m) => normalizeId(m[0]));
}

/**
 * The managed windows belonging to `pid`.
 *
 * An empty result is not an error: a hidden window is withdrawn from
 * `_NET_CLIENT_LIST` entirely, which is how a spec distinguishes "Electron
 * says it hid" from "the window manager agrees it is gone".
 */
export function managedWindowIdsForPid(pid: number): string[] {
  return managedWindowIds().filter((id) => Number(xprop(["-id", id, "_NET_WM_PID"]).match(/= (\d+)/)?.[1] ?? 0) === pid);
}

/**
 * The `_NET_WM_STATE` atoms the window manager has set on a window:
 * `_NET_WM_STATE_HIDDEN` is present on a minimised window. Since the WM sets
 * this rather than the app, it reflects the WM's view of the minimise
 * state, not Electron's.
 */
export function windowStates(id: string): string[] {
  const raw = xprop(["-id", id, "_NET_WM_STATE"]);
  return [...raw.matchAll(/_NET_WM_STATE_[A-Z_]+/g)].map((m) => m[0]);
}

/** The window the window manager currently considers focused. */
export function activeWindowId(): string | null {
  const raw = xprop(["-root", "_NET_ACTIVE_WINDOW"]);
  const id = raw.match(/0x[0-9a-f]+/i)?.[0];
  return id && Number(id) !== 0 ? normalizeId(id) : null;
}
