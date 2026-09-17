/* One path through the app, inside the window.
 *
 * The only spec here that touches product behavior. The browser suite drives
 * all of it against the same Chromium and the same server, so re-running that
 * inside Electron would double the wall clock to re-prove the same things.
 * What this pass adds is what the browser suite cannot say: that a renderer
 * with `contextIsolation` and `sandbox` on, no preload, and Electron's own
 * network stack still gets an EventSource stream out of the server the shell
 * booted. A transcript that fills in is the assertion.
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

test.describe.configure({ mode: "serial" });

const PROJECT = "Desktop Smoke";
const TASK_TITLE = "Ship a greeting file";

let shell: Shell;

test.beforeAll(async () => {
  shell = await launchShell("smoke");
});

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
});

test("a turn streams into the transcript inside the Electron window", async () => {
  // Setup goes over REST, as e2e/helpers.ts does for the browser suite: the
  // subject here is the renderer, not the wizard.
  await ensureOnboarded(shell.origin);
  const repoPath = makeFixtureRepo("desktop-smoke");
  const project = await createProject(shell.origin, PROJECT, repoPath);
  const task = await createTask(shell.origin, {
    projectId: project.id,
    title: TASK_TITLE,
    description: "Write the greeting. e2e:write=greeting.txt:hello from the desktop shell",
  });

  // Reloads the window onto the app root. This also checks `will-navigate`'s
  // allow branch: the app's own origin must not be handed to the system
  // browser.
  await shell.win.addInitScript(() => {
    localStorage.setItem("calandria_agent_nudge_dismissed", "1");
    localStorage.setItem("calandria:welcomeCoach:dismissed", "1");
  });
  //
  // Selected through the URL (?project=&task=, app/shell/persist.ts) rather
  // than by clicking the two sidebars, because this suite has no viewport of
  // its own: it drives a real OS window, and the hosted macOS and Windows
  // runners clamp it to a 1024x768 virtual display. Below
  // AUTO_COLLAPSE_BELOW the shell sheds the projects column and then the
  // tasks column to a 30px spine (app/shell/types.ts), so `getByText(PROJECT)`
  // would not be in the document there, and expanding both spines back out at
  // 1024 would leave the transcript on its 360px floor. Clicking through the
  // sidebars is covered by the browser suite at a viewport it pins; what is
  // unique here is the renderer and the stream.
  await shell.win.goto(`${shell.origin}/?project=${project.id}&task=${task.id}`);
  await expect(shell.win.getByText(TASK_TITLE).first()).toBeVisible();

  // Start the turn from outside and watch it arrive: the transcript is fed by
  // the SSE tail on GET /api/tasks/[id]/messages, so nothing below can be a
  // local echo of a click.
  await sendMessage(shell.origin, task.id);
  await expect(shell.win.getByText("Mock turn complete").first()).toBeVisible({ timeout: 60_000 });

  // The diff rail read the worktree the turn wrote in.
  await expect(shell.win.getByText("greeting.txt").first()).toBeVisible({ timeout: 30_000 });
});

test("the terminal panel reaches the pty sidecar the shell started", async () => {
  // The second product path this file covers, for the same reason as the
  // first: nothing else asserts it. The browser suite has no terminal
  // coverage, so `/pty` (a WebSocket upgrade proxied by server.js to the
  // second process the supervisor spawned) is otherwise only proven by
  // `test-real-boot.js` starting the sidecar, not by anything talking to it.
  // Inside the shell this exercises three moving parts at once: the port
  // pair `pickPorts()` chose, the sidecar's env from `sidecarEnv()`, and
  // Electron's own network stack carrying the upgrade.
  await shell.win.getByRole("button", { name: "Terminal", exact: true }).click();
  const rows = shell.win.locator(".xterm-rows");
  await expect(rows).toBeVisible({ timeout: 30_000 });

  await shell.win.locator(".xterm").first().click();
  // Quoted mid-word so the assertion cannot pass on the shell's echo of what
  // was typed: `hello-from-electron` unbroken exists only in the output.
  await shell.win.keyboard.type('echo he"llo"-from-electron\n');
  await expect(rows).toContainText("hello-from-electron", { timeout: 30_000 });

  await shell.win.getByTitle("Hide terminal (the shell keeps running)").click();
});

test("the shell announces its updater state to the page", async () => {
  // The page's update pill is driven by an event main pushes with
  // executeJavaScript (desktop/main.js pushUpdateState), the same seam
  // calandria:goto-task uses. There is no preload and no IPC, so this is the
  // only thing that proves the push reaches a real renderer.
  //
  // The push on the FIRST did-finish-load has already happened by the time
  // launchShell() returns, so this installs the listener through
  // addInitScript and then navigates: main re-announces on every
  // did-finish-load of an app URL, and addInitScript runs before the page's
  // own scripts on that new load.
  await shell.win.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as Record<string, unknown>).__calandriaUpdateEvents = seen;
    window.addEventListener("calandria:desktop-update", (e) => seen.push((e as CustomEvent).detail));
  });
  await shell.win.goto(`${shell.origin}/`);

  const version = await shell.app.evaluate(({ app }) => app.getVersion());
  const read = () =>
    shell.win.evaluate(
      () =>
        ((window as unknown as Record<string, unknown>).__calandriaUpdateEvents as {
          shellVersion: string;
          phase: string;
          disposition: { enabled: boolean; code: string; reason: string };
        }[]) || [],
    );
  await expect.poll(async () => (await read()).length, { timeout: 30_000 }).toBeGreaterThan(0);

  const detail = (await read())[0];
  // The shell says which version it is, which is what the page compares
  // against the newest release to decide whether the app itself is behind.
  expect(detail.shellVersion).toBe(version);
  expect(["idle", "checking", "downloading", "ready", "error"]).toContain(detail.phase);
  // Total by construction (desktop/updater.js pageUpdateState), so the page
  // never has to test a field for undefined before rendering.
  expect(typeof detail.disposition.enabled).toBe("boolean");
  expect(typeof detail.disposition.code).toBe("string");
});
