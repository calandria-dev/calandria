/* Covers the shell layer on one running instance: boot handoff, the native
 * menu, renderer hardening, the permission handler, external-link policy and
 * the single-instance lock. Everything here reaches the main process through
 * `app.evaluate()` into `desktop/main.js`, which is why this suite exists
 * alongside the browser one. It does not repeat what the browser suite
 * already covers: no onboarding, no project/task flow (02-smoke covers one
 * pass of that to prove the renderer is a working browser), no API surface.
 *
 * The file shares one `launchShell()` instance because each test below reads
 * state without mutating the app's lifecycle, so a second Next boot per test
 * would add nothing. Tests that end the instance live in their own files.
 */

import { statSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { isDesktopShell } from "@/app/shell/useNotifications";
import { isBootHandoffUrl } from "./bootUrl";
import { attachShellLog, ensureOnboarded, launchDuplicate, launchShell, quitShell, serverIsUp, type Shell } from "./fixtures";

test.describe.configure({ mode: "serial" });

let shell: Shell;

test.beforeAll(async () => {
  shell = await launchShell("shell");
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
});

test("the boot screen streams supervisor logs, then hands off to the app", async () => {
  // The window is created on loading.html and swaps only once /api/version
  // answers, so these three facts together are the handoff.
  //
  // Either side of the swap can pass: on macOS the swap can land before the
  // fixture's first non-empty read, so the assertion accepts a fast app
  // coming up promptly as well as the boot screen. `isBootHandoffUrl` says
  // what is actually claimed, and `tests/bootUrl.test.ts` pins it on every
  // lane.
  expect(
    isBootHandoffUrl(shell.firstUrl, shell.origin),
    `the window's first URL was neither the boot screen nor the app: ${JSON.stringify(shell.firstUrl)}`
  ).toBe(true);
  // The supervisor narrated its start.
  expect(shell.log.join("\n")).toMatch(/\[shell] ready on http:\/\/127\.0\.0\.1:\d+/);
  // Those lines also reached the boot screen, a separate claim: they arrive
  // through `webContents.executeJavaScript`, the only bridge main.js has
  // without a preload, past loading.html's `default-src 'none'` CSP.
  expect(shell.bootScreenLog, "the boot screen never received a supervisor log line").toMatch(
    /\[shell] node: /
  );
  // Received, not displayed: the lines land in a pane clipped out of the
  // layout, so a person watching sees only a spinner. That clipping is also
  // why the assertion above (and 06-packaged's) can read the lines at all.
  expect(shell.bootScreen.spinner, "the boot screen showed no spinner").toBe(true);
  expect(
    shell.bootScreen.logWidth,
    "the log pane is back on screen — the boot screen is meant to be a spinner"
  ).toBeLessThanOrEqual(2);
  expect(shell.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(shell.win.url().startsWith(shell.origin)).toBe(true);

  // Confirms the app's own DOM rendered, not a blank frame: the
  // supervisor-to-window chain end to end.
  await expect(shell.win.locator("body")).not.toBeEmpty();
});

test("the window renders and can be captured", async () => {
  const shot = `${shell.root}/window.png`;
  await shell.win.screenshot({ path: shot });
  // The display differs by lane (Xvfb on the Ubuntu runner, a real window
  // station on Windows, the bench VM's session), but the rendering path does
  // not: SwiftShader is the only one available on any machine this runs on,
  // since no GPU exists on the fleet or on a runner. A blank or truncated PNG
  // is what a broken render looks like.
  expect(statSync(shot).size).toBeGreaterThan(5000);
});

test("the window carries the app title", async () => {
  const title = await shell.app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getTitle()
  );
  expect(title).toMatch(/Calandria/);
});

test("the application menu is installed with the roles the OS shortcuts need", async () => {
  // electron's own types are installed only under desktop/node_modules, so
  // the main-process argument arrives here as `any`; hence the annotations.
  const menu: Array<{ label: string; role?: string }> = await shell.app.evaluate(async ({ Menu }) =>
    (Menu.getApplicationMenu()?.items || []).map((i: any) => ({ label: i.label, role: i.role }))
  );

  // Without an Edit menu macOS has no Cmd+C/V/A: the roles wire the system
  // shortcuts, so this checks roles rather than labels. Electron lower-cases
  // a role on the way in, so `{ role: "fileMenu" }` reads back as
  // "filemenu"; the custom View submenu carries no role at all.
  expect(menu.map((i) => i.role)).toEqual(
    expect.arrayContaining(
      process.platform === "darwin"
        ? ["appmenu", "filemenu", "editmenu", "windowmenu"]
        : ["filemenu", "editmenu", "windowmenu"]
    )
  );
  expect(menu.map((i) => i.label)).toContain("View");

  // The two items the shell owns directly, not inherited from a role.
  const view: string[] = await shell.app.evaluate(async ({ Menu }) => {
    const v = (Menu.getApplicationMenu()?.items || []).find((i: any) => i.label === "View");
    return ((v as any)?.submenu?.items || []).map((i: any) => i.label);
  });
  expect(view).toContain("Reload app");
  expect(view).toContain("Open in browser");
});

test("the renderer stayed a hardened browser tab", async () => {
  const prefs = await shell.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences() || {};
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
      preload: p.preload || null,
    };
  });
  // main.js's policy: no bridge, so an XSS in the transcript renderer cannot
  // reach the Node API.
  expect(prefs.nodeIntegration).toBe(false);
  expect(prefs.contextIsolation).not.toBe(false);
  expect(prefs.sandbox).toBe(true);
  expect(prefs.preload).toBeNull();
});

test("the permission handler denies everything, notifications included", async () => {
  // Turn-finished pings are the point of a desktop shell, and they come from
  // the main process (`new Notification` in main.js, fed by the same GET
  // /api/events payload the renderer would otherwise use). Granting the
  // renderer as well would produce two toasts per event, so the page's
  // channel is switched off at the source: `notificationPermission()` in
  // app/shell/useNotifications.ts returns something other than `granted` and
  // the hook returns before constructing anything. It returns `desktop_shell`
  // rather than `denied`, off the user-agent token asserted below, which
  // gives Settings better copy while standing on the same `denied` read this
  // test checks.
  //
  // Both readings are asserted because they are answered by different
  // handlers, and only the second is on the path that matters: the hook
  // checks `Notification.permission`, a permission check, and Electron
  // answers those with a hardcoded "granted" unless a check handler says
  // otherwise. A shell that only denied the request would still show the
  // duplicate toast.
  const notifications = await shell.win.evaluate(async () => ({
    requested: await Notification.requestPermission(),
    checked: Notification.permission,
  }));
  expect(notifications.requested, "the renderer must not also raise notifications — main.js owns that channel").toBe(
    "denied"
  );
  expect(notifications.checked, "app/shell/useNotifications.ts reads THIS, and stands down only on 'denied'").toBe(
    "denied"
  );

  // Geolocation is the one call that can prove denial rather than merely
  // fail. Its error code discriminates: 1 is PERMISSION_DENIED (the handler
  // said no), 2 is POSITION_UNAVAILABLE (permitted, but nothing could
  // answer), which is what a granted request would return on a runner.
  const geo = await shell.win.evaluate(
    async () =>
      new Promise<number | string>((resolve) =>
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (err) => resolve(err.code)
        )
      )
  );
  expect(geo, "geolocation was not refused by setPermissionRequestHandler").toBe(1);

  // The camera is the case the handler is written for, but a headless runner
  // has no capture device, and Chromium answers `NotFoundError` from device
  // enumeration before the permission handler is consulted. This asserts
  // what it can, that no stream comes back; geolocation above is what proves
  // the default-deny policy.
  const camera = await shell.win.evaluate(async () =>
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((s) => {
        s.getTracks().forEach((t) => t.stop());
        return "granted";
      })
      .catch((err: DOMException) => err.name)
  );
  expect(camera).not.toBe("granted");
});

test("the user agent tells the page it is inside the shell", async () => {
  // The other half of the denial above: because the check handler makes
  // `Notification.permission` read "denied" on a valid 127.0.0.1 origin,
  // Settings → Notifications would otherwise tell the user they blocked
  // notifications for this site, even while OS toasts arrive from a channel
  // the page cannot see. `announceShell()` appends this token so
  // `isDesktopShell()` can report "handled by the desktop app" instead.
  //
  // Asserted against the app's own matcher rather than a re-spelled regex,
  // so a change to either end fails here instead of drifting apart.
  const ua = await shell.win.evaluate(() => navigator.userAgent);
  expect(ua, "announceShell() must run before the first load").toContain("Calandria-Desktop/");
  expect(isDesktopShell(ua)).toBe(true);
  // Appended rather than replaced: the app can still branch on Chrome's version.
  expect(ua).toContain("Chrome/");
});

test("Settings → Notifications says the shell owns push instead of offering a subscribe button", async () => {
  // What the two denials above look like from the panel. The Web Push field
  // reads the same user-agent token the field above it uses
  // (app/shell/usePush.ts, `desktop_shell`) rather than only the capability
  // checks (secure context, service worker, PushManager), so it stands down
  // instead of offering "Enable push on this device", which would fail the
  // click against the denied permission with copy pointing at browser site
  // settings the shell has no way to open. Nothing in this window may call
  // Notification.requestPermission() for push.
  await ensureOnboarded(shell.origin);
  await shell.win.addInitScript(() => {
    localStorage.setItem("calandria_agent_nudge_dismissed", "1");
    localStorage.setItem("calandria:welcomeCoach:dismissed", "1");
  });
  // Opened through the URL (`?view=settings`, app/shell/persist.ts) rather
  // than the projects column's gear: the hosted runners clamp the window
  // under AUTO_COLLAPSE_BELOW, where the column holding that button is a
  // 30px spine. 02-smoke.spec.ts navigates by URL for the same reason.
  await shell.win.goto(`${shell.origin}/?view=settings`);
  await shell.win.locator(".settings-nav .nav-item", { hasText: "Notifications" }).click();
  await expect(shell.win.getByText("Push notifications", { exact: true })).toBeVisible();
  // The sentence this fix exists to show: native is already on.
  await expect(shell.win.getByText(/Native notifications are already on/)).toBeVisible();
  // And nothing to click: no subscribe button, and none of the copy a
  // browser-only verdict would show in its place.
  await expect(shell.win.getByRole("button", { name: /push on this device/ })).toHaveCount(0);
  await expect(shell.win.getByText(/This browser can't receive push notifications/)).toHaveCount(0);
  await expect(shell.win.getByText(/blocked for this site/)).toHaveCount(0);
  // The browser-notifications field beside it stands down the same way; the
  // two must agree, or the panel contradicts itself two fields apart.
  await expect(shell.win.getByText("Desktop notifications", { exact: true })).toBeVisible();
});

test("copy and paste reach the system clipboard", async () => {
  // The menu test above checks that the Edit roles exist. This checks that
  // they do something: a keystroke in the renderer reaches the OS clipboard
  // and comes back. A user notices immediately when this is missing, and on
  // macOS the roles are where Cmd+C comes from: an application menu without
  // `{ role: "editMenu" }` leaves the app unable to copy, with no error to
  // explain why.
  //
  // Uses a textarea injected into the app's own page rather than a product
  // surface, since the subject is the shell's editing pipeline; depending on
  // the composer would make this fail for reasons unrelated to it.
  await shell.win.evaluate(() => {
    const t = document.createElement("textarea");
    t.id = "clipboard-probe";
    t.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647";
    document.body.appendChild(t);
  });
  const probe = shell.win.locator("#clipboard-probe");

  await probe.fill("clipboard-probe-42");
  await probe.press("ControlOrMeta+a");
  await probe.press("ControlOrMeta+c");
  expect(await shell.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("clipboard-probe-42");

  await shell.app.evaluate(({ clipboard }) => clipboard.writeText("clipboard-probe-99"));
  await probe.press("ControlOrMeta+a");
  await probe.press("ControlOrMeta+v");
  await expect(probe).toHaveValue("clipboard-probe-99");

  await shell.win.evaluate(() => document.getElementById("clipboard-probe")?.remove());
});

test("a right-click opens a context menu built from what is under the cursor", async () => {
  // Electron shows no context menu unless main builds one, so the keyboard
  // test above passing says nothing about the mouse: right-click produced
  // nothing until `wireContextMenu` in main.js. `Menu.prototype.popup` is a
  // JS method on the same `Menu` main.js destructured, so swapping it here
  // captures each template the real right-click produces instead of showing
  // it on screen, which Playwright could not read anyway.
  await shell.app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __popups: unknown[]; __origPopup: unknown };
    g.__popups = [];
    g.__origPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (this: { items: Array<{ label: string; role?: string; enabled: boolean }> }) {
      g.__popups.push(this.items.map((i) => ({ label: i.label, role: i.role, enabled: i.enabled })));
    };
  });
  type Item = { label: string; role?: string; enabled: boolean };
  const popups = () => shell.app.evaluate(() => (globalThis as unknown as { __popups: Item[][] }).__popups);

  await shell.win.evaluate(() => {
    const t = document.createElement("textarea");
    t.id = "context-probe";
    t.style.cssText = "position:fixed;top:0;left:0;width:200px;height:60px;z-index:2147483647";
    document.body.appendChild(t);
  });
  const probe = shell.win.locator("#context-probe");
  await probe.fill("context-probe-42");
  await probe.press("ControlOrMeta+a");
  await probe.click({ button: "right" });
  await expect.poll(async () => (await popups()).length).toBe(1);

  // An editable field with a selection: the full edit set, with Copy and Cut
  // enabled. Electron lower-cases a role on the way in, so `selectAll` reads
  // back as "selectall".
  const editable = (await popups())[0];
  const byRole = (role: string) => editable.find((i) => i.role === role);
  expect(editable.map((i) => i.role).filter(Boolean)).toEqual(
    expect.arrayContaining(["cut", "copy", "paste", "selectall", "undo", "redo"])
  );
  expect(byRole("copy")?.enabled).toBe(true);
  expect(byRole("cut")?.enabled).toBe(true);
  expect(byRole("paste")?.enabled).toBe(true);

  // Somewhere with nothing to copy: still a menu, with Copy disabled rather
  // than absent.
  await shell.win.evaluate(() => {
    document.getElementById("context-probe")?.remove();
    window.getSelection()?.removeAllRanges();
  });
  await shell.win.locator("body").click({ button: "right", position: { x: 5, y: 5 } });
  await expect.poll(async () => (await popups()).length).toBe(2);
  const plain = (await popups())[1];
  expect(plain.find((i) => i.role === "copy")?.enabled).toBe(false);
  expect(plain.find((i) => i.role === "paste")).toBeUndefined();

  await shell.app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __origPopup: typeof Menu.prototype.popup };
    Menu.prototype.popup = g.__origPopup;
  });
});

test("external links leave for the real browser instead of navigating the app", async () => {
  // `shell` in main.js is the same object this patches: it destructures the
  // electron module at load, so the method swap is visible to it.
  await shell.app.evaluate(async ({ shell: electronShell }) => {
    const g = globalThis as unknown as { __opened?: string[] };
    g.__opened = [];
    electronShell.openExternal = async (url: string) => {
      g.__opened!.push(url);
    };
  });

  // will-navigate: a top-level navigation off our origin is prevented and handed off.
  await shell.win.evaluate(() => {
    window.location.href = "https://example.com/will-navigate";
  });
  // setWindowOpenHandler: a target=_blank / window.open is denied and handed off.
  await shell.win.evaluate(() => {
    window.open("https://example.com/window-open", "_blank");
  });

  await expect
    .poll(async () =>
      shell.app.evaluate(async () => (globalThis as unknown as { __opened: string[] }).__opened)
    )
    .toEqual(["https://example.com/will-navigate", "https://example.com/window-open"]);

  // And the window never left the app.
  expect(shell.win.url().startsWith(shell.origin)).toBe(true);
});

test("a second launch is refused rather than starting a second server", async () => {
  const { refused, ms } = await launchDuplicate(shell);
  expect(refused, `a second shell launched (after ${ms}ms) instead of being refused`).toBe(true);

  // The first one is untouched: still up, still serving. Without the lock the
  // second shell would have raced this one for the database instead.
  expect(await serverIsUp(shell.origin)).toBe(true);
});
