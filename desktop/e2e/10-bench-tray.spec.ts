/* The tray icon, read from the status area rather than from our own process.
 *
 * A tray needs an AppIndicator host — a panel implementing
 * `org.kde.StatusNotifierWatcher` and registering itself as a host for it —
 * which is precisely what a real session provides and Xvfb does not. On the CI
 * lane `new Tray(...)` returns an object either way and every Electron-side
 * read of it succeeds, so nothing there can tell a tray icon that appeared
 * from one that went nowhere; `03-quit-drain.spec.ts` even has to warn that a
 * runner whose tray silently failed would fail its FIRST claim for the wrong
 * reason. This file closes that gap by asking the host.
 *
 * There is also no Electron-side read of a tray MENU at all — `Tray` has a
 * setter and no getter — so the labels below can only come from the session, in
 * this case over `com.canonical.dbusmenu`, which is the same interface the
 * panel walks to draw the menu. That makes the third test the interesting one:
 * the "N need you" count reaching a native menu is the whole point of the
 * shell subscribing to /api/events at all, and it is invisible from inside.
 */

import { expect, test } from "@playwright/test";
import { makeFixtureRepo } from "../../e2e/helpers";
import {
  attachShellLog,
  createProject,
  createTask,
  ensureOnboarded,
  launchShell,
  quitShell,
  sendMessage,
  trayIsHosted,
  type Shell,
} from "./fixtures";
import { BENCH, assertBenchSession, benchEnv, poll, trayItemForPid, trayMenuItems, type TrayItem } from "./bench";

test.describe.configure({ mode: "serial" });

test.skip(!BENCH, "bench-only: a tray needs a status-notifier host, which Xvfb has none of");

const PROJECT = "Desktop Bench Tray";

let shell: Shell;
let item: TrayItem | null = null;

test.beforeAll(async () => {
  if (!BENCH) return;
  // The one file that genuinely needs the status area, and the one that is
  // red on the bench today because of it (docs/DESKTOP_E2E.md §4).
  assertBenchSession(["x", "tray"]);
  shell = await launchShell("bench-tray", { env: benchEnv() });
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  if (!BENCH) return;
  await quitShell(shell);
});

test("the tray icon is registered with the session's status-notifier host", async () => {
  // Polled: `createTray()` runs after the server answers, and registering with
  // the watcher is a round trip on the bus after that. Matched by the owning
  // pid rather than by name — see `trayItemForPid()` for why the icon's own Id
  // cannot identify it.
  item = await poll(() => trayItemForPid(shell.proc.pid!), (v) => v !== null, {
    timeoutMs: 30_000,
    label: "the shell's tray icon registering with org.kde.StatusNotifierWatcher",
  });
  expect(item).not.toBeNull();

  // If the tray had failed to construct at all, the shell says so and carries
  // on with no status-area presence — which would also make the close-to-tray
  // behaviour in 11-bench-window.spec.ts quit instead of hide. Named here so a
  // red run points at the session rather than at the window specs.
  expect(shell.log.join("\n")).not.toContain("[shell] no tray available");

  // AND THE SHELL AGREES WITH THE HOST, which is the assertion only this lane
  // can make. `desktop/tray-residency.js` asks the session the same question
  // this test just asked it, and the answer is what decides whether the X
  // button hides or quits; a shell that read this session as trayless would
  // quit on a close with the icon sitting right there, and one that read a
  // trayless session as hosted is the bug that module exists for. Polled for
  // the same reason the item above is: the confirmation is a round trip after
  // `createTray()` returns.
  expect(await trayIsHosted(shell), "the shell did not see the icon this test just found").toBe(true);
});

test("the tray menu carries the shell's actions as the panel would draw them", async () => {
  const labels = trayMenuItems(item!);
  const byLabel = new Map(labels.map((l) => [l.label, l]));

  // The three actions, and the one row that is a read-out rather than an
  // action. Not an exact-set assertion: what matters is that each of these
  // reached the host, not that nothing else ever joins them.
  expect(byLabel.has("Show Calandria"), `tray menu was: ${JSON.stringify(labels)}`).toBe(true);
  expect(byLabel.has("Open in browser")).toBe(true);
  expect(byLabel.has("Quit Calandria")).toBe(true);

  // "Open in browser" is built with `enabled: !!appUrl`, so an enabled one is
  // also evidence the boot got as far as an app URL.
  expect(byLabel.get("Open in browser")!.enabled).toBe(true);
  expect(byLabel.get("Show Calandria")!.enabled).toBe(true);

  // The count row is deliberately not clickable, and dbusmenu is where that is
  // observable — a disabled item is drawn greyed by the panel.
  const count = labels.find((l) => /waiting on you|Nothing is waiting/.test(l.label));
  expect(count, `no count row in ${JSON.stringify(labels)}`).toBeTruthy();
  expect(count!.enabled).toBe(false);
  expect(count!.label).toBe("Nothing is waiting on you");
});

test("the tray menu's count follows the needs-you total", async () => {
  await ensureOnboarded(shell.origin);
  const project = await createProject(shell.origin, PROJECT, makeFixtureRepo("bench-tray"));
  const task = await createTask(shell.origin, {
    projectId: project.id,
    title: "Wants to run a command",
    description: "e2e:permission=npm run lint",
  });
  await sendMessage(shell.origin, task.id);

  // The whole chain in one assertion: the server parks the task, publishes on
  // /api/events, notifier.js's NeedsYou sums the per-project counts, main.js
  // rebuilds the tray menu, and the host sees a new layout. Anything that
  // breaks in there leaves the menu saying "Nothing is waiting on you".
  const label = await poll(
    () => trayMenuItems(item!).find((l) => /waiting on you|Nothing is waiting/.test(l.label))?.label ?? "",
    (v) => v === "1 task waiting on you",
    { timeoutMs: 60_000, label: "the tray menu's count row" }
  );
  expect(label).toBe("1 task waiting on you");
});
