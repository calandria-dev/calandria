/* Window-manager behaviour, asserted against a window manager.
 *
 * This is the file with the least to say on a CI runner and the most to say
 * here. Under `xvfb-run` there is no window manager at all: `minimize()`
 * reaches nothing, `_NET_CLIENT_LIST` does not exist, and every Electron-side
 * read still answers cheerfully — `isMinimized()` reports what was asked for,
 * not what happened. So each assertion below is paired: what the app believes,
 * and what the session's own EWMH properties say, read with `xprop`. The bench
 * runs xfwm4, which reparents (docs/DESKTOP_E2E.md §5) — the class of
 * behaviour Xvfb hides and the reason this VM exists.
 *
 * SERIAL, AND THE ORDER IS THE POINT. The window is minimised and restored,
 * then closed (which hides it), then brought back by a second launch — each
 * test starts from the state the last one left, because that is the sequence a
 * user produces and because a hidden window is the state in which "focus the
 * existing window" is worth anything.
 *
 * CLOSE VS QUIT. `main.js` overrides Electron's usual Linux/Windows idiom
 * (`window-all-closed` → quit): the X button hides, and quitting is asked for
 * by name — but only while `tray` is set. That gate is on `new Tray()` not
 * THROWING, which is a weaker thing than an icon being on screen, so this file
 * deliberately does NOT require the session's status-notifier host: the hide
 * branch is what runs here either way, and requiring the host would fail these
 * specs over the panel bug that belongs to `10-bench-tray.spec.ts`. (That gap
 * between "the Tray object exists" and "the user can get the window back" is
 * real, and is its own task rather than something to assert around here.)
 *
 * The other branch — no tray, so a close quits — is reachable only in the
 * window between launch and the end of `boot()`, and nothing in this suite
 * covers it.
 */

import { expect, test } from "@playwright/test";
import { attachShellLog, launchDuplicate, launchShell, quitShell, serverIsUp, type Shell } from "./fixtures";
import {
  BENCH,
  NotifyWatch,
  activeWindowId,
  assertBenchSession,
  benchEnv,
  managedWindowIdsForPid,
  poll,
  windowStates,
} from "./bench";

test.describe.configure({ mode: "serial" });

test.skip(!BENCH, "bench-only: there is no window manager under xvfb, so none of this is observable");

let shell: Shell;
let watch: NotifyWatch | null = null;
/** The X window id of the shell's one window, learned in the first test. */
let windowId = "";

/** What Electron believes about its own window. Half of every assertion below. */
function windowFacts(): Promise<{ windows: number; visible: boolean; minimized: boolean; focused: boolean }> {
  return shell.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      windows: BrowserWindow.getAllWindows().length,
      visible: w?.isVisible() ?? false,
      minimized: w?.isMinimized() ?? false,
      focused: w?.isFocused() ?? false,
    };
  });
}

test.beforeAll(async () => {
  if (!BENCH) return;
  // The window manager is the subject. `notifications` is here too because the
  // close test asserts the tray-residency toast on the bus — but NOT `tray`:
  // hiding is gated on `new Tray()` not throwing, which holds whether or not
  // the icon ever reached a status area.
  assertBenchSession(["x", "wm", "notifications"]);
  watch = await NotifyWatch.start();
  shell = await launchShell("bench-window", { env: benchEnv() });
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  if (!BENCH) return;
  watch?.stop();
  await quitShell(shell);
});

test("minimize and restore are carried out by the window manager", async () => {
  const ids = await poll(() => managedWindowIdsForPid(shell.proc.pid!), (v) => v.length === 1, {
    timeoutMs: 30_000,
    label: "the shell's window appearing in _NET_CLIENT_LIST",
  });
  windowId = ids[0];

  await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());

  // `_NET_WM_STATE_HIDDEN` is set BY THE WINDOW MANAGER on a window it has
  // iconified — the app cannot set it, and on a display with no WM it never
  // appears. That is the assertion Xvfb cannot make: `isMinimized()` alone
  // would pass there too.
  await poll(() => windowStates(windowId), (s) => s.includes("_NET_WM_STATE_HIDDEN"), {
    timeoutMs: 15_000,
    label: "_NET_WM_STATE_HIDDEN on the minimised window",
  });
  expect(await windowFacts()).toMatchObject({ windows: 1, minimized: true });

  await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());

  await poll(() => windowStates(windowId), (s) => !s.includes("_NET_WM_STATE_HIDDEN"), {
    timeoutMs: 15_000,
    label: "_NET_WM_STATE_HIDDEN clearing on the restored window",
  });
  // Still the same window: a restore that rebuilt the window would break the
  // renderer's state, which is the reason the shell hides rather than destroys.
  expect(managedWindowIdsForPid(shell.proc.pid!)).toEqual([windowId]);
  expect(await windowFacts()).toMatchObject({ windows: 1, visible: true, minimized: false });
});

test("closing the window withdraws it from the window manager without quitting", async () => {
  await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());

  // A hidden window is not merely unfocused — it is gone from the WM's list of
  // managed clients, which is what "the app disappeared from the taskbar" means
  // and what Electron's `isVisible()` alone cannot distinguish from "behind
  // something".
  await poll(() => managedWindowIdsForPid(shell.proc.pid!), (v) => v.length === 0, {
    timeoutMs: 15_000,
    label: "the window leaving _NET_CLIENT_LIST",
  });

  // The window OBJECT survives (so does the renderer's state), and so does the
  // server: `window-all-closed` is gated on there being no tray, so on this
  // session the close is a hide and nothing quits.
  expect(await windowFacts()).toMatchObject({ windows: 1, visible: false });
  expect(shell.proc.exitCode ?? shell.proc.signalCode, "the shell quit on a window close").toBeNull();
  expect(await serverIsUp(shell.origin), "the server stopped when the window was closed").toBe(true);

  // Hiding is the one action with no visible result, so the shell says so —
  // and on this session we can prove the saying reached the desktop rather
  // than a dead bus.
  const toast = await watch!.waitFor((c) => c.summary === "Calandria is still running" && c.daemonId !== null, {
    what: "the tray-residency notification raised by the first close",
    timeoutMs: 30_000,
  });
  expect(toast.body).toContain("tray icon");
});

test("a second launch is refused and brings the existing window back, focused", async () => {
  const { refused } = await launchDuplicate(shell);
  expect(refused, "a second launch started its own shell instead of being refused").toBe(true);

  // `second-instance` → `showWindow()`. THE SAME window id: a second launch
  // that opened a new window would satisfy "something is on screen" while
  // having thrown away the session the user left behind, and would also mean
  // two servers were in play.
  const ids = await poll(() => managedWindowIdsForPid(shell.proc.pid!), (v) => v.length === 1, {
    timeoutMs: 30_000,
    label: "the hidden window coming back after a second launch",
  });
  expect(ids).toEqual([windowId]);

  // Focus is the WM's to grant, so it is read from the WM. `showWindow()` calls
  // `show()` and then `focus()` precisely because a raised-but-unfocused window
  // is what a user experiences as the second launch having done nothing.
  await poll(() => activeWindowId(), (a) => a === windowId, {
    timeoutMs: 15_000,
    label: "_NET_ACTIVE_WINDOW naming the shell's window",
  });
  expect(await windowFacts()).toMatchObject({ windows: 1, visible: true, minimized: false });
});

test("the tray-residency notification is announced once per launch, not once per close", async () => {
  await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await poll(() => managedWindowIdsForPid(shell.proc.pid!), (v) => v.length === 0, {
    timeoutMs: 15_000,
    label: "the window leaving _NET_CLIENT_LIST a second time",
  });

  // Give a second toast every chance to arrive before claiming none did: the
  // first one took a round trip on the bus, so an equal wait here is the
  // evidence that the suppression is real and not just faster than the poll.
  await new Promise((r) => setTimeout(r, 3_000));
  expect(
    watch!.count((c) => c.summary === "Calandria is still running"),
    "the shell nagged about the tray on every close"
  ).toBe(1);
});
