/* Asserts that the dock badge counts every instance, not just the one on screen.
 *
 * `desktop/test-supervisor.js` pins the policy: the badge is a sum over live
 * subscribers, and a toast names the instance that raised it. That policy only
 * holds if the shell really does hold two `/api/events` streams open against
 * two servers at once. A shell that kept only one subscriber would pass every
 * headless test and look normal in use, with the badge never mentioning the
 * other machine.
 *
 * Two real production servers, each with its own database and its own
 * hermetic instance, one task parked on a permission card on each, and the
 * number Electron is holding for the dock read back out of the main process.
 *
 * The window never leaves the local instance until the last test, so the
 * count for the remote arrives while nothing is looking at it.
 */

import { expect, test, type Page } from "@playwright/test";
import { makeFixtureRepo } from "../../e2e/helpers";
import {
  attachShellLog,
  bootRemoteServer,
  createProject,
  createTask,
  ensureOnboarded,
  instanceRoot,
  launchShell,
  quitShell,
  sendMessage,
  writeInstancesFile,
  type RemoteServer,
  type Shell,
} from "./fixtures";

test.describe.configure({ mode: "serial" });

// Windows has no numeric badge: `applyBadge` paints a pre-rendered overlay
// PNG there instead (notifier.js `overlayIconName`, covered by
// test-supervisor.js), and `app.getBadgeCount()` stays 0 however many tasks are
// waiting. The sum being asserted here is platform-independent; only its
// rendering is not.
test.skip(process.platform === "win32", "the taskbar badge is an image on Windows, not a count");

const REMOTE_ID = "b2c4";
/** What the remote server is told to call itself (CALANDRIA_INSTANCE_NAME). */
const REMOTE_INSTANCE_NAME = "Bench Annexe";

let remote: RemoteServer;
let shell: Shell;
let localProjectId = "";
let remoteProjectId = "";

/** The number Electron is holding for the dock, straight out of the main process. */
async function badge(): Promise<number> {
  return shell.app.evaluate(({ app }) => app.getBadgeCount());
}

/**
 * A turn parks on a permission card, which is one of the sites
 * `lib/notifications/dispatcher.ts` turns into `awaiting_input`, and
 * `awaiting_input` is what the project's `awaiting_count` counts, which is what
 * the badge sums. The mock agent raises the card from the description
 * (`e2e/README.md`).
 */
async function parkOneTask(origin: string, projectId: string, title: string): Promise<void> {
  const task = await createTask(origin, { projectId, title, description: "e2e:permission=npm run lint" });
  await sendMessage(origin, task.id);
}

/** How many tasks a server itself says are waiting. The badge has to agree. */
async function awaitingOn(origin: string): Promise<number> {
  const res = await fetch(`${origin}/api/projects`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return -1;
  const projects = (await res.json()) as { awaiting_count?: number; deprecated?: number }[];
  return projects.filter((p) => !p.deprecated).reduce((n, p) => n + (Number(p.awaiting_count) || 0), 0);
}

test.beforeAll(async () => {
  // The remote names itself, so the last test can watch the shell adopt it.
  remote = await bootRemoteServer("badge-remote", { CALANDRIA_INSTANCE_NAME: REMOTE_INSTANCE_NAME });
  await ensureOnboarded(remote.origin);

  const configRoot = instanceRoot("badge-shell-config");
  const instancesFile = writeInstancesFile(configRoot, {
    // Active is local. The remote is a saved instance nobody is looking at,
    // which is what this file tests.
    active: "local",
    instances: [
      { id: "local", kind: "local", name: "This computer" },
      // Named as `addUrlInstance` would name it with the dialog's name field
      // left blank: the host, i.e. the address again, so the adoption in the
      // last test has something to replace.
      { id: REMOTE_ID, kind: "url", name: new URL(remote.origin).host, url: remote.origin },
    ],
  });

  shell = await launchShell("badge", { env: { CALANDRIA_INSTANCES_FILE: instancesFile } });
  await ensureOnboarded(shell.origin);
  localProjectId = (await createProject(shell.origin, "Badge Local", makeFixtureRepo("badge-local"))).id;
  remoteProjectId = (await createProject(remote.origin, "Badge Remote", makeFixtureRepo("badge-remote"))).id;
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
  await remote?.stop();
});

test("a task waiting on the instance nobody is looking at still badges the dock", async () => {
  // The window is on the local instance and has never loaded a page from the
  // remote, so anything the badge picks up below came from a subscriber the
  // shell is holding open against a server nobody is looking at.
  //
  // Asserted through the badge instead of through the `[shell] watching …`
  // log line, which is real but useless here: the first reconcile runs inside
  // `attach()`, before the supervisor has started, and Playwright only begins
  // capturing stdout once `electron.launch()` has resolved. That line is
  // already gone by the time a spec can read it.
  expect(new URL(shell.win.url()).origin).toBe(shell.origin);
  expect(await badge()).toBe(0);

  await parkOneTask(remote.origin, remoteProjectId, "Remote wants a command");
  await expect.poll(() => awaitingOn(remote.origin), { timeout: 120_000 }).toBe(1);

  await expect
    .poll(badge, { timeout: 60_000, message: "the badge never picked up the unattended instance" })
    .toBe(1);
  // Still on local, so this count came entirely from the other server.
  expect(new URL(shell.win.url()).origin).toBe(shell.origin);
  expect(await awaitingOn(shell.origin)).toBe(0);
});

test("the badge is the SUM of both instances' awaiting counts", async () => {
  await parkOneTask(shell.origin, localProjectId, "Local wants a command");
  await expect.poll(() => awaitingOn(shell.origin), { timeout: 120_000 }).toBe(1);

  await expect
    .poll(badge, { timeout: 60_000, message: "the badge is showing one instance rather than the sum" })
    .toBe(2);

  // The claim stated the other way round, so a badge that happened to be 2 for
  // some unrelated reason does not pass: each server contributes exactly one,
  // and the dock shows what they add up to.
  expect(await awaitingOn(shell.origin)).toBe(1);
  expect(await awaitingOn(remote.origin)).toBe(1);
});

test("switching to the remote adopts the name its server reports, and keeps the sum", async () => {
  const opened = shell.app.waitForEvent("window", { timeout: 60_000 });
  await shell.app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no ${itemId} menu item`);
    item.click();
  }, `instance-${REMOTE_ID}`);
  const win: Page = await opened;
  shell.win = win;
  await win.waitForURL(`${remote.origin}/**`, { timeout: 120_000 });

  // CALANDRIA_INSTANCE_NAME, off the /api/version handshake the attach already
  // makes, over a name that was only ever the host.
  await expect
    .poll(
      () => shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? ""),
      { timeout: 30_000 },
    )
    .toBe(`${REMOTE_INSTANCE_NAME} · Calandria`);

  // The instance being left behind keeps its subscriber: switching is not a
  // reason to stop counting for the machine you were just on.
  await expect.poll(badge, { timeout: 30_000 }).toBe(2);
});
