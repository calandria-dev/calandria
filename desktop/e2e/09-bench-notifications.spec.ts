/* A turn that needs you raises a REAL OS notification.
 *
 * The browser suite already asserts the half that lives in the page
 * (`e2e/13-notifications.spec.ts` stubs `window.Notification` and checks which
 * payloads reach the constructor), and `desktop/test-supervisor.js` asserts the
 * policy in `notifier.js` (which events count, when a toast is redundant). What
 * neither can say is that anything left the process. That is this file: the
 * shell's `new Notification(...).show()` is captured on the session bus as an
 * `org.freedesktop.Notifications.Notify` method call, and the notification
 * daemon's reply — the id it minted — is captured with it.
 *
 * So the claim is not "we called libnotify". It is "a notification daemon
 * received a notification from Calandria, with this title and this body, and
 * accepted it". Nothing about that is assertable on a runner with no daemon,
 * which is why `fixtures.ts` points every other Linux run at a dead bus and why
 * these specs are gated to the bench (docs/DESKTOP_E2E.md §4).
 *
 * THE WORDING IS THE SERVER'S. `lib/notifications/notify.ts` composes the title
 * and body and publishes them on GET /api/events; the shell subscribes and
 * renders what it is handed (desktop/notifier.js's header explains why). These
 * assertions are written against that server-side wording ON PURPOSE — if the
 * shell ever starts re-deriving its own text from the raw task events, it will
 * be a second, differently-worded notification channel out of the same facts,
 * and this file goes red.
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
  // `test.skip()` above marks every test, but Playwright still runs the hooks
  // of a suite it has skipped — and everything below shells out to tools that
  // exist on one machine. Same guard as 08-macos-launchd.spec.ts.
  if (!BENCH) return;
  // The daemon is the subject; the display is what the shell needs to start
  // at all. Not the status area — this file never touches it, and on this bench
  // it disappears mid-launch (docs/DESKTOP_E2E.md §4).
  assertBenchSession(["x", "notifications"]);
  // BEFORE the launch, deliberately: a monitor started afterwards would miss
  // any notification the boot itself raises, and "nothing was captured" would
  // then be ambiguous between "the shell sent nothing" and "we arrived late".
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
    // The mock agent raises a Bash permission card and parks on it, which is
    // one of the three sites `lib/notifications/dispatcher.ts` turns into an
    // awaiting_input notification. A turn ending mid-task is another, and a
    // question card the third — one is enough here: the subject is the bus,
    // not the emitter's coverage, which `tests/` already pins.
    description: "e2e:permission=npm run lint",
  });
  await sendMessage(shell.origin, task.id);

  const call = await watch!.waitFor((c) => c.summary === "Waiting for input" && c.body.includes(title) && c.daemonId !== null, {
    what: `a "Waiting for input" notification for "${title}", accepted by a daemon`,
    timeoutMs: 90_000,
  });

  // The app name a Linux desktop files the notification under. Electron sends
  // `app.getName()`, which is the package name from a dev run and the
  // productName from a packaged one — the lane runs both, so the assertion is
  // the family rather than either spelling.
  expect(call.appName, "the notification was filed under something other than Calandria").toMatch(/calandria/i);
  // The body is "<task title> · <project name>" — the project is there so a
  // notification is actionable without opening the app first.
  expect(call.body).toContain(PROJECT);
  expect(call.daemonId, "the daemon replied without a notification id").toBeGreaterThan(0);
  // libnotify stamps the calling pid onto every notification, so the toast can
  // be traced to the Electron main process rather than to anything the shell
  // spawned.
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
  // under it. That second line is the whole reason this kind exists — a
  // "Turn failed" with no cause is a notification that makes you open the app
  // to find out whether it mattered.
  expect(call.body).toContain("the mock agent gave up");
  expect(call.body.split("\n").length).toBeGreaterThan(1);
});
