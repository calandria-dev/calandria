/* Asserts window-manager behavior against a real window manager.
 *
 * Under `xvfb-run` there is no window manager: `minimize()` reaches nothing,
 * `_NET_CLIENT_LIST` does not exist, and every Electron-side read still
 * answers as asked: `isMinimized()` reports what was requested, not what
 * happened. Each assertion below is paired: what the app reports, and what
 * the session's own EWMH properties say, read with `xprop`. The bench runs
 * xfwm4, which reparents (docs/DESKTOP_E2E.md §5), a class of behavior Xvfb
 * hides.
 *
 * Tests run serial and in order: the window is minimized and restored, then
 * closed (which hides it), then brought back by a second launch. Each test
 * starts from the state the last one left, matching the sequence a user
 * produces, and a hidden window is the state in which "focus the existing
 * window" is meaningful.
 *
 * The file branches on close versus quit. `main.js` overrides Electron's
 * usual Linux/Windows idiom (`window-all-closed` → quit): the X button hides,
 * and quitting is asked for by name, but only while a status area is really
 * drawing the tray icon. `desktop/tray-residency.js` asks the session, so on a
 * session whose panel dropped the icon (this bench, see `10-bench-tray.spec.ts`
 * and docs/DESKTOP_E2E.md §5), a close quits instead of hiding into nowhere.
 *
 * The close test reads the shell's own verdict and asserts the matching
 * behavior, instead of requiring the host (which would fail this whole file
 * over a panel bug that belongs to the tray spec) or assuming the hide (which
 * would fail it over a fix). Both answers are correct; only the session says
 * which. The two tests after it need a window that is still there, so they
 * skip with the reason on the quit branch. The quit branch also carries the
 * assertion that matters most: the "open it again from the tray icon" toast
 * must not be raised where there is no icon, since it is the message that
 * tells the user where the window went.
 */

import { expect, test } from "@playwright/test";
import {
  attachShellLog,
  launchDuplicate,
  launchShell,
  quitShell,
  serverIsUp,
  trayIsHosted,
  type Shell,
} from "./fixtures";
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
/**
 * Did the close hide the window, or quit the app? Set by the close test from
 * the session's own answer; the two tests after it need a window that is still
 * there, and skip instead of fail when this session had no icon to hide into.
 */
let hidden = false;

/** What Electron reports about its own window. Half of every assertion below. */
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
  // close test asserts the tray-residency toast on the bus, in one direction or
  // the other, since a toast that must not appear also needs a daemon that
  // would have delivered it. `tray` is not required: which close branch runs is
  // what this file reads, not what it demands.
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

  // `_NET_WM_STATE_HIDDEN` is set by the window manager on a window it has
  // iconified: the app cannot set it, and on a display with no WM it never
  // appears. That is the assertion Xvfb cannot make, since `isMinimized()`
  // alone would pass there too.
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
  // renderer's state, which is why the shell hides instead of destroying it.
  expect(managedWindowIdsForPid(shell.proc.pid!)).toEqual([windowId]);
  expect(await windowFacts()).toMatchObject({ windows: 1, visible: true, minimized: false });
});

test("closing the window withdraws it from the window manager — into the tray, or into a quit", async () => {
  // Read before the close, so the expectation comes from the session and not
  // from whatever happened. On a session drawing the icon this is a hide; on
  // one that is not, it is a quit, and both are the shell working correctly.
  hidden = await trayIsHosted(shell);
  await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());

  if (!hidden) {
    // With no icon, there is no hiding: the whole app goes through
    // `app.quit()`, so the drain still runs (`03-quit-drain.spec.ts` owns that
    // half). The exit is waited for before the window, not after it: the
    // window stays up for the drain here and only leaves with the process.
    await poll(() => shell.proc.exitCode ?? shell.proc.signalCode, (v) => v !== null, {
      timeoutMs: 60_000,
      label: "the shell exiting after a close with no tray to hide into",
    });
    expect(await serverIsUp(shell.origin), "the server outlived the shell").toBe(false);
    // Not left withdrawn with a live server behind it, which is the state a
    // user cannot get out of.
    expect(managedWindowIdsForPid(shell.proc.pid!)).toEqual([]);

    // And the shell said nothing: "Open it again from the tray icon" is the
    // message that tells the user where the window went, and raising it on a
    // session with no icon would send them looking for something that is not
    // there. Asserted on the bus and not in the log, because the daemon
    // accepting it is what the user would have seen.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(
      watch!.count((c) => c.summary === "Calandria is still running"),
      "the shell promised a tray icon this session never drew"
    ).toBe(0);
    return;
  }

  // The window leaves the WM's list of managed clients, which is what "the app
  // disappeared from the taskbar" means, and what Electron's `isVisible()`
  // alone cannot distinguish from "behind something".
  await poll(() => managedWindowIdsForPid(shell.proc.pid!), (v) => v.length === 0, {
    timeoutMs: 15_000,
    label: "the window leaving _NET_CLIENT_LIST",
  });

  // The window object survives (so does the renderer's state), and so does the
  // server: on a session that really is drawing the icon, the close is a hide
  // and nothing quits.
  expect(await windowFacts()).toMatchObject({ windows: 1, visible: false });
  expect(shell.proc.exitCode ?? shell.proc.signalCode, "the shell quit on a window close").toBeNull();
  expect(await serverIsUp(shell.origin), "the server stopped when the window was closed").toBe(true);

  // Hiding has no visible result, so the shell raises a notification, and on
  // this session that notification can be proven to reach the desktop instead
  // of a dead bus.
  const toast = await watch!.waitFor((c) => c.summary === "Calandria is still running" && c.daemonId !== null, {
    what: "the tray-residency notification raised by the first close",
    timeoutMs: 30_000,
  });
  expect(toast.body).toContain("tray icon");
});

test("a second launch is refused and brings the existing window back, focused", async () => {
  test.skip(!hidden, "the close quit the app on this session: there is no hidden window to bring back");
  const { refused } = await launchDuplicate(shell);
  expect(refused, "a second launch started its own shell instead of being refused").toBe(true);

  // `second-instance` → `showWindow()`. The same window id matters: a second
  // launch that opened a new window would satisfy "something is on screen"
  // while discarding the session the user left behind, and would also mean two
  // servers were in play.
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
  test.skip(!hidden, "the close quit the app on this session, and raised no residency toast to repeat");
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
