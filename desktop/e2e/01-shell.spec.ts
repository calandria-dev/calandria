/* The shell layer, on one running instance: boot handoff, the native menu, the
 * renderer's hardening, the permission handler, external-link policy and the
 * single-instance lock.
 *
 * Everything here is main-process reach — `app.evaluate()` into `desktop/main.js`
 * — which is the whole reason a desktop suite exists next to the browser one.
 * Nothing the browser suite already asserts is repeated: no onboarding, no
 * project/task flow (02-smoke does exactly one pass of that, to prove the
 * renderer is a working browser), no API surface.
 *
 * One `launchShell()` for the file: each assertion below is a read, not a
 * mutation of the app's lifecycle, so paying for a second Next boot per test
 * would buy nothing. The specs that DO end their instance have their own files.
 */

import { statSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { isDesktopShell } from "@/app/shell/useNotifications";
import { isBootHandoffUrl } from "./bootUrl";
import { attachShellLog, launchDuplicate, launchShell, quitShell, serverIsUp, type Shell } from "./fixtures";

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
  // The window is created on loading.html and only swaps once /api/version
  // answers, so these three facts together ARE the handoff.
  //
  // EITHER SIDE of the swap passes (issue #75). Requiring the boot screen here
  // made the assertion a race the shell could lose by being fast: on macOS the
  // swap sometimes lands before the fixture's first non-empty read, and this
  // failed for the app having come up promptly — reddening packaging and the
  // two steps after it. `isBootHandoffUrl` says what is actually claimed, and
  // `tests/bootUrl.test.ts` pins it on every lane rather than only this one.
  expect(
    isBootHandoffUrl(shell.firstUrl, shell.origin),
    `the window's first URL was neither the boot screen nor the app: ${JSON.stringify(shell.firstUrl)}`
  ).toBe(true);
  // The supervisor really did narrate its start...
  expect(shell.log.join("\n")).toMatch(/\[shell] ready on http:\/\/127\.0\.0\.1:\d+/);
  // ...and those lines reached the boot screen, which is a SEPARATE claim and
  // the one that was false until this suite existed: they get there through
  // `webContents.executeJavaScript`, the only bridge main.js has instead of a
  // preload, and loading.html's `default-src 'none'` CSP silently blocked the
  // page-side half of it.
  expect(shell.bootScreenLog, "the boot screen never received a supervisor log line").toMatch(
    /\[shell] node: /
  );
  expect(shell.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(shell.win.url().startsWith(shell.origin)).toBe(true);

  // The app's own DOM, not a blank frame — the supervisor→window chain end to end.
  await expect(shell.win.locator("body")).not.toBeEmpty();
});

test("the window renders and can be captured", async () => {
  const shot = `${shell.root}/window.png`;
  await shell.win.screenshot({ path: shot });
  // The display underneath differs by lane — Xvfb on the Ubuntu runner, a real
  // window station on the Windows one, the bench VM's session on the bench —
  // and this asserts the part that does not: SwiftShader is the only rendering
  // path on any machine this runs on (no GPU exists on the fleet, and a runner
  // has none either), and a blank or truncated PNG is what a broken one looks
  // like.
  expect(statSync(shot).size).toBeGreaterThan(5000);
});

test("the window carries the app title", async () => {
  const title = await shell.app.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getTitle()
  );
  expect(title).toMatch(/Calandria/);
});

test("the application menu is installed with the roles the OS shortcuts need", async () => {
  // `electron`'s own types are only installed under desktop/node_modules, so
  // the main-process argument arrives here as `any` — hence the annotations.
  const menu: Array<{ label: string; role?: string }> = await shell.app.evaluate(async ({ Menu }) =>
    (Menu.getApplicationMenu()?.items || []).map((i: any) => ({ label: i.label, role: i.role }))
  );

  // Without an Edit menu macOS has no Cmd+C/V/A at all — the roles are what
  // wire the system shortcuts, so this asserts roles rather than cosmetics.
  // Electron lower-cases a role on the way in, so `{ role: "fileMenu" }` reads
  // back as "filemenu"; the custom View submenu has no role at all.
  expect(menu.map((i) => i.role)).toEqual(
    expect.arrayContaining(
      process.platform === "darwin"
        ? ["appmenu", "filemenu", "editmenu", "windowmenu"]
        : ["filemenu", "editmenu", "windowmenu"]
    )
  );
  expect(menu.map((i) => i.label)).toContain("View");

  // The two items the shell owns rather than inherits from a role.
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
  // main.js's one piece of policy: no bridge, so an XSS in the transcript
  // renderer cannot reach the Node API.
  expect(prefs.nodeIntegration).toBe(false);
  expect(prefs.contextIsolation).not.toBe(false);
  expect(prefs.sandbox).toBe(true);
  expect(prefs.preload).toBeNull();
});

test("the permission handler denies everything, notifications included", async () => {
  // Notifications used to be the ONE grant here, and the reason for the
  // handler's existence: turn-finished pings are the point of a desktop shell.
  // They still are — they just come from the main process now (`new
  // Notification` in main.js, fed by the same GET /api/events payload the
  // renderer would have used). Granting the renderer as well would give the
  // user two toasts for every event, so the page's channel is switched off at
  // the source: `notificationPermission()` in app/shell/useNotifications.ts
  // returns something that isn't `granted` and the hook returns before
  // constructing anything. (It returns `desktop_shell` rather than `denied`,
  // off the user-agent token asserted below — same standing down, better copy
  // in Settings. The raw `denied` this test reads is what that is built on.)
  //
  // BOTH readings are asserted because they are answered by different handlers
  // and only the second one is on the path that matters: the hook checks
  // `Notification.permission`, which is a permission CHECK, and Electron
  // answers those with a hardcoded "granted" unless a check handler says
  // otherwise — so a shell that only denied the REQUEST would still have shown
  // the duplicate toast.
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

  // Denied — and geolocation is the one that can PROVE denial rather than
  // merely fail. Its error code discriminates: 1 is PERMISSION_DENIED (the
  // handler said no), 2 is POSITION_UNAVAILABLE (permitted, but nothing could
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

  // The camera is the one the handler is written for, but a headless runner has
  // no capture device, and Chromium answers `NotFoundError` from device
  // enumeration before the permission handler is ever consulted. So this asserts
  // what it can — no stream comes back — and geolocation above is what asserts
  // the default-deny policy itself.
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
  // The other half of the denial above. Because the check handler makes
  // `Notification.permission` read "denied" on a perfectly good 127.0.0.1
  // origin, Settings → Notifications would tell the user they had blocked
  // notifications for this site — while OS toasts were arriving the whole time
  // from a channel the page cannot see. `announceShell()` appends this token so
  // `isDesktopShell()` can say "handled by the desktop app" instead.
  //
  // Asserted against the app's own matcher rather than by re-spelling the
  // regex, so a change to either end fails here rather than drifting apart.
  const ua = await shell.win.evaluate(() => navigator.userAgent);
  expect(ua, "announceShell() must run before the first load").toContain("Calandria-Desktop/");
  expect(isDesktopShell(ua)).toBe(true);
  // Appended, not replacing: the app may reasonably branch on Chrome's version.
  expect(ua).toContain("Chrome/");
});

test("copy and paste reach the system clipboard", async () => {
  // The menu test above asserts the Edit roles EXIST. This asserts they do
  // something: a keystroke in the renderer ends up on the OS clipboard and
  // comes back. It is the one shell behaviour a user notices instantly when it
  // is missing, and on macOS the roles are literally where Cmd+C comes from —
  // an application menu without `{ role: "editMenu" }` leaves the app unable to
  // copy at all, with no error anywhere to say so.
  //
  // A textarea injected into the app's own page rather than a product surface:
  // the subject is the shell's editing pipeline, and depending on the composer
  // would make this fail for reasons that have nothing to do with it.
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

test("external links leave for the real browser instead of navigating the app", async () => {
  // `shell` in main.js is the same object this patches — it destructures the
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
