/* Attaching the desktop shell to a server it did not start.
 *
 * Phase 1 of docs/superpowers/specs/2026-09-02-remote-instances-design.md. The
 * "remote" here is a SECOND real production server on another port, booted by
 * the same `desktop/supervisor.js` the shell uses for `local` — see
 * `bootRemoteServer` in fixtures.ts. A stub answering `/api/version` would
 * prove the handshake and nothing about the page that loads after it, which is
 * the half that has to work.
 *
 * Three things this pass says that nothing else can:
 *
 *   1. A shell whose active instance is a `url` one never starts a local
 *      server at all. Its window is on the other origin, and the supervisor's
 *      boot lines are absent.
 *   2. The instance switcher is a real radio list in the app menu, and
 *      switching to `local` from it boots the local server on demand and moves
 *      the window — the whole switch path, driven the way a user drives it.
 *   3. The remote instance's window is in its own persistent session
 *      partition, so a Cloudflare Access cookie cannot bleed between
 *      instances. That is a property of the window Playwright can read
 *      directly, and it has no other observable failure mode until somebody is
 *      running two Access-protected instances and getting the wrong one's
 *      assertion.
 */

import { expect, test, type Page } from "@playwright/test";
import {
  attachShellLog,
  bootRemoteServer,
  ensureOnboarded,
  instanceRoot,
  launchShell,
  quitShell,
  writeInstancesFile,
  type RemoteServer,
  type Shell,
} from "./fixtures";

test.describe.configure({ mode: "serial" });

const REMOTE_NAME = "Lab";

let remote: RemoteServer;
let shell: Shell;
let localOrigin = "";

test.beforeAll(async () => {
  remote = await bootRemoteServer("remote-server");
  await ensureOnboarded(remote.origin);

  // The list the shell launches with: `local` present as always, and the
  // second server as the ACTIVE one, so the first thing the shell does on this
  // launch is attach to something it did not spawn.
  const configRoot = instanceRoot("remote-shell-config");
  const instancesFile = writeInstancesFile(configRoot, {
    active: "a1f3",
    instances: [
      { id: "local", kind: "local", name: "This computer" },
      { id: "a1f3", kind: "url", name: REMOTE_NAME, url: remote.origin },
    ],
  });

  shell = await launchShell("remote", {
    env: {
      CALANDRIA_INSTANCES_FILE: instancesFile,
      // The credential for the LOCAL database, present exactly as it would be
      // on a real install. It must not follow the window to the other server;
      // the rule is pinned on the source in desktop/test-supervisor.js, and
      // what this launch adds is that having one set does not break the attach.
      SERVICE_TOKEN: "local-only-token",
    },
  });
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
  await remote?.stop();
});

test("the window attaches to the remote origin, not to a server of its own", async () => {
  expect(shell.win.url().startsWith(remote.origin)).toBeTruthy();
  expect(new URL(shell.win.url()).origin).toBe(remote.origin);

  // The app really rendered, on the other server's bundle.
  await expect(shell.win.locator("body")).toBeVisible();

  // And no local server was started. Asked of the main process rather than of
  // the captured log, because Playwright's stdout capture begins after
  // `electron.launch()` resolves and the Supervisor's own first lines are
  // already flushed by then (see `Shell["log"]` in fixtures.ts) — an absence
  // there would prove nothing. Nothing answering on the port this shell was
  // told to prefer does.
  const localUp = await shell.app.evaluate(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  });
  expect(localUp, "a url instance must not start a local server").toBe(false);

  // The handshake's own confirmation is the title: `attachOrigin` sets it from
  // the instance name only after `probeVersion` answered. NOT read off
  // `shell.log`, which used to be polled for the "attached to" line: the
  // packaged shell reaches that line before `electron.launch()` resolves and
  // the fixture's stdout listener exists, so the captured log begins at the
  // tray and auto-update lines that follow it and the poll timed out on every
  // packaged run (issue #191). The URL assertion above and this one are the
  // same fact read from the main process, which has no capture window.
  await expect
    .poll(() => shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? ""), {
      timeout: 15_000,
    })
    .toBe(`${REMOTE_NAME} · Calandria`);
});

test("the window title names the instance", async () => {
  const title = await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? "");
  expect(title).toBe(`${REMOTE_NAME} · Calandria`);
});

test("the remote instance gets its own persistent session partition", async () => {
  const partition = await shell.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.session.storagePath ?? null
  );
  // A partition has its own storage directory; the default session's is the
  // user-data root. Naming is what proves the isolation, so assert on it.
  expect(partition, "a url instance must not sit on the default session").toContain("instance-a1f3");
});

test("both menus carry the instance list as a radio group", async () => {
  // `electron`'s own types are only installed under desktop/node_modules, so
  // the main-process argument arrives as `any` — hence the annotations, the
  // same way 01-shell.spec.ts reads the menu.
  type Item = { id: string; label: string; type: string; checked: boolean };
  const items: Item[] = await shell.app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const instance = (menu?.items ?? []).find((i: any) => i.label === "Instance");
    return ((instance as any)?.submenu?.items ?? []).map((i: any) => ({
      id: i.id,
      label: i.label,
      type: i.type,
      checked: i.checked,
    }));
  });
  expect(items.filter((i) => i.type !== "separator").map((i) => i.id)).toEqual([
    "instance-local",
    "instance-a1f3",
    "instance-add",
    "instance-manage",
  ]);
  expect(items[0].type).toBe("radio");
  expect(items[0].checked).toBe(false);
  expect(items[1].type).toBe("radio");
  expect(items[1].checked).toBe(true);
  expect(items[1].label).toContain(REMOTE_NAME);
});

/**
 * Click an instance in the app menu and hand back the window that results.
 *
 * A switch between instances with different partitions REBUILDS the window —
 * Electron fixes a BrowserWindow's session at construction — so the Page handle
 * a spec is holding is destroyed by the click. Waiting on the `window` event
 * before issuing it is the only way to catch the replacement without racing
 * `app.windows()`, and `shell.win` is repointed so the failure hooks photograph
 * the window that is actually on screen.
 */
/**
 * The window's origin, or "" while it has none.
 *
 * A window rebuilt by a switch reports `url() === ""` for the moment before its
 * first navigation commits, and `new URL("")` throws — which `expect.poll`
 * treats as a failure rather than a retry, so the poll this exists for would
 * never get to its second attempt.
 */
function originOf(page: Page): string {
  try {
    return new URL(page.url()).origin;
  } catch {
    return "";
  }
}

async function switchInstance(id: string): Promise<Page> {
  const opened = shell.app.waitForEvent("window", { timeout: 60_000 });
  await shell.app.evaluate(({ Menu }, itemId) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.getMenuItemById(itemId);
    if (!item) {
      const seen = (menu?.items ?? []).map((m: any) => m.label).join(" | ");
      throw new Error(`no ${itemId} menu item; the menu was: ${menu ? seen : "null"}`);
    }
    item.click();
  }, `instance-${id}`);
  const win = await opened;
  shell.win = win;
  return win;
}

test("switching to This computer boots the local server and moves the window", async () => {
  const win = await switchInstance("local");

  // The local server has to come up from cold here, which is a Next boot.
  await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 120_000 });
  await expect.poll(() => originOf(win), { timeout: 120_000 }).not.toBe(remote.origin);
  localOrigin = originOf(win);
  expect(shell.log.some((l) => l.startsWith("[shell] payload:"))).toBeTruthy();

  const title = await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? "");
  expect(title).toBe("This computer · Calandria");

  // Back on the default session, where the local instance belongs.
  const partition = await shell.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.session.storagePath ?? null
  );
  expect(partition).not.toContain("instance-");
});

test("switching back leaves the local server running", async () => {
  const win = await switchInstance("a1f3");
  await expect.poll(() => originOf(win), { timeout: 60_000 }).toBe(remote.origin);

  // The whole point of switching being cheap: the server this window left is
  // still up, still holding its turns, exactly as it is when the window hides
  // to the tray.
  const res = await fetch(`${localOrigin}/api/version`, { signal: AbortSignal.timeout(5000) });
  expect(res.ok, "the local server must keep running after the window leaves it").toBeTruthy();
});

/**
 * The Add-instance dialog, driven the way a user drives it.
 *
 * This is the only way an instance gets onto the list at all, and it is a
 * surface with no other test: a static page whose CSP forbids its own scripts,
 * with the behaviour injected from the main process. If that injection ever
 * stops resolving, the dialog opens and does nothing, and every assertion above
 * still passes because they all run against a list written by the fixture.
 *
 * The second instance points at the SAME server as the first, which is what
 * makes the assertions cheap: what is being tested is the dialog, the URL
 * normalization behind it, and that the new instance gets a partition of its
 * own — not a second server.
 */
test("adding an instance from the dialog attaches to it", async () => {
  const dialogOpened = shell.app.waitForEvent("window", { timeout: 30_000 });
  await shell.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("instance-add");
    if (!item) throw new Error("no instance-add menu item");
    item.click();
  });
  const dialog = await dialogOpened;
  await dialog.waitForSelector("#save", { timeout: 15_000 });

  await dialog.fill("#name", "Lab Two");
  // No scheme: the dialog is where `normalizeInstanceUrl`'s https default would
  // bite, so give it one the remote really answers on instead.
  await dialog.fill("#url", remote.origin);

  // Clicking Add closes this very page, and Playwright's post-click settle can
  // lose the race with that teardown under load — it did, in the full-suite run
  // but not in the isolated one. A closed target here means the click landed;
  // anything else is a real failure and is re-raised. The poll below is the
  // assertion either way.
  await dialog.click("#save").catch((err: unknown) => {
    if (!/Target (page, context or browser has been closed|closed)/.test(String(err))) throw err;
  });

  // Settle on the TITLE, and only once one window is left.
  //
  // Both instances point at the same server, so the old window and its
  // replacement are on the same origin for the moment they coexist — the
  // rebuild puts the new one up before destroying the old (main.js's
  // applyActiveInstance), so identifying the new one by origin would match
  // either. The title is the one thing that tells them apart.
  await expect
    .poll(
      () =>
        shell.app.evaluate(({ BrowserWindow }) => {
          const open = BrowserWindow.getAllWindows();
          return open.length === 1 ? (open[0]?.getTitle() ?? "") : "";
        }),
      { timeout: 60_000 }
    )
    .toBe("Lab Two · Calandria");

  let win: Page | undefined;
  await expect
    .poll(
      () => {
        win = shell.app.windows().find((p) => p !== dialog && originOf(p) === remote.origin);
        return !!win;
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  shell.win = win!;

  // Its own partition, not the first Lab's — two entries pointing at one server
  // are still two instances, and a shared cookie jar would be the bug the
  // partition exists to prevent.
  const partition: string | null = await shell.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.session.storagePath ?? null
  );
  expect(partition).toContain("instance-");
  expect(partition).not.toContain("instance-a1f3");

  // And it is on the list, checked, beside the two that were already there.
  const labels: string[] = await shell.app.evaluate(({ Menu }) => {
    const instance = (Menu.getApplicationMenu()?.items ?? []).find((i: any) => i.label === "Instance");
    return ((instance as any)?.submenu?.items ?? [])
      .filter((i: any) => i.type === "radio")
      .map((i: any) => `${i.label}${i.checked ? " *" : ""}`);
  });
  expect(labels).toHaveLength(3);
  expect(labels[2]).toMatch(/^Lab Two — .* \*$/);
});
