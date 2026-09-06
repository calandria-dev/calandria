/* Asserts that a turn needing input raises a real OS notification.
 *
 * The browser suite asserts the half that lives in the page
 * (`e2e/13-notifications.spec.ts` stubs `window.Notification` and checks which
 * payloads reach the constructor), and `desktop/test-supervisor.js` asserts the
 * policy in `notifier.js` (which events count, when a toast is redundant).
 * Neither can confirm that anything left the process. This file does: the
 * shell's `new Notification(...).show()` is captured on the session bus as an
 * `org.freedesktop.Notifications.Notify` method call, along with the
 * notification daemon's reply, the id it minted.
 *
 * The claim is that a notification daemon received a notification from
 * Calandria, with a given title and body, and accepted it. That is not
 * assertable on a runner with no daemon, which is why `fixtures.ts` points
 * every other Linux run at a dead bus and why these specs are gated to the
 * bench (docs/DESKTOP_E2E.md §4).
 *
 * The wording asserted here is the server's. `lib/notifications/notify.ts`
 * composes the title and body and publishes them on GET /api/events; the shell
 * subscribes and renders what it is handed (desktop/notifier.js's header
 * explains why). If the shell starts re-deriving its own text from the raw
 * task events instead of the server's wording, it becomes a second,
 * differently-worded notification channel over the same facts, and this file
 * goes red.
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
  type Shell,
} from "./fixtures";
import { BENCH, NotifyWatch, assertBenchSession, benchEnv } from "./bench";

test.describe.configure({ mode: "serial" });

test.skip(!BENCH, "bench-only: set CALANDRIA_DESKTOP_BENCH=1 on a session with a notification daemon");

const PROJECT = "Desktop Bench Notifications";

let shell: Shell;
let watch: NotifyWatch | null = null;
let projectId = "";

test.beforeAll(async () => {
  // test.skip() above marks every test, but Playwright still runs the hooks of
  // a suite it has skipped, and everything below shells out to tools that exist
  // on one machine. Same guard as 08-macos-launchd.spec.ts.
  if (!BENCH) return;
  // The daemon is the subject; the display is what the shell needs to start at
  // all, not the status area. This file never touches the status area, which
  // disappears mid-launch on this bench (docs/DESKTOP_E2E.md §4).
  assertBenchSession(["x", "notifications"]);
  // Started before the launch: a monitor started afterward would miss any
  // notification the boot itself raises, leaving "nothing was captured"
  // ambiguous between "the shell sent nothing" and "we arrived late".
  watch = await NotifyWatch.start();
  shell = await launchShell("bench-notify", { env: benchEnv() });
  await ensureOnboarded(shell.origin);
  const project = await createProject(shell.origin, PROJECT, makeFixtureRepo("bench-notify"));
  projectId = project.id;
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  if (!BENCH) return;
  watch?.stop();
  await quitShell(shell);
});

test("a task parking on a permission card reaches the notification daemon", async () => {
  const title = "Wants to run a command";
  const task = await createTask(shell.origin, {
    projectId,
    title,
    // The mock agent raises a Bash permission card and parks on it, one of the
    // three sites `lib/notifications/dispatcher.ts` turns into an
    // awaiting_input notification (a turn ending mid-task and a question card
    // are the other two). One is enough here since the subject is the bus, not
    // the emitter's coverage, which `tests/` already pins.
    description: "e2e:permission=npm run lint",
  });
  await sendMessage(shell.origin, task.id);

  const call = await watch!.waitFor((c) => c.summary === "Waiting for input" && c.body.includes(title) && c.daemonId !== null, {
    what: `a "Waiting for input" notification for "${title}", accepted by a daemon`,
    timeoutMs: 90_000,
  });

  // The app name a Linux desktop files the notification under. Electron sends
  // `app.getName()`, which is the package name from a dev run and the
  // productName from a packaged one. The lane runs both, so the assertion
  // matches the family instead of either spelling.
  expect(call.appName, "the notification was filed under something other than Calandria").toMatch(/calandria/i);
  // The body is "<task title> · <project name>". The project is included so a
  // notification is actionable without opening the app first.
  expect(call.body).toContain(PROJECT);
  expect(call.daemonId, "the daemon replied without a notification id").toBeGreaterThan(0);
  // libnotify stamps the calling pid onto every notification, so the toast
  // traces to the Electron main process and not to anything the shell spawned.
  expect(call.senderPid).toBe(shell.proc.pid);
});

test("a failed turn notifies with the error the server put in the body", async () => {
  const title = "Falls over";
  const task = await createTask(shell.origin, {
    projectId,
    title,
    description: "e2e:fail=the mock agent gave up",
  });
  await sendMessage(shell.origin, task.id);

  const call = await watch!.waitFor((c) => c.summary === "Turn failed" && c.body.includes(title) && c.daemonId !== null, {
    what: `a "Turn failed" notification for "${title}", accepted by a daemon`,
    timeoutMs: 90_000,
  });

  // Two lines: the task and project on the first, the failure's first line
  // under it. The second line carries the cause: a "Turn failed" notification
  // with no cause would force opening the app to find out whether it mattered.
  expect(call.body).toContain("the mock agent gave up");
  expect(call.body.split("\n").length).toBeGreaterThan(1);
});
