/* ONE path through the app, inside the window.
 *
 * Deliberately the only spec here that touches product behaviour. The browser
 * suite drives all of it against the same Chromium and the same server, so
 * re-running any of that inside Electron would double the wall clock to
 * re-prove the same things (docs/DESKTOP_E2E.md §3). What this pass adds is the
 * one thing the browser suite cannot say: that a renderer with
 * `contextIsolation` + `sandbox` on, no preload, and Electron's own network
 * stack still gets an EventSource stream out of the server the shell booted.
 * A transcript that fills in is the whole assertion.
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
  // Setup over REST, exactly as e2e/helpers.ts does for the browser suite: the
  // subject here is the renderer, not the wizard.
  await ensureOnboarded(shell.origin);
  const repoPath = makeFixtureRepo("desktop-smoke");
  const project = await createProject(shell.origin, PROJECT, repoPath);
  const task = await createTask(shell.origin, {
    projectId: project.id,
    title: TASK_TITLE,
    description: "Write the greeting. e2e:write=greeting.txt:hello from the desktop shell",
  });

  // Reload the window onto the app root. This is also a live check of
  // `will-navigate`'s allow branch — our own origin must NOT be handed to the
  // system browser.
  await shell.win.addInitScript(() => {
    localStorage.setItem("calandria_agent_nudge_dismissed", "1");
    localStorage.setItem("calandria:welcomeCoach:dismissed", "1");
  });
  await shell.win.goto(`${shell.origin}/`);
  await expect(shell.win.getByText(PROJECT).first()).toBeVisible();

  await shell.win.getByText(PROJECT).first().click();
  await shell.win.getByText(TASK_TITLE).first().click();

  // Start the turn from outside and watch it arrive: the transcript is fed by
  // the SSE tail on GET /api/tasks/[id]/messages, so nothing below can be a
  // local echo of a click.
  await sendMessage(shell.origin, task.id);
  await expect(shell.win.getByText("Mock turn complete").first()).toBeVisible({ timeout: 60_000 });

  // The diff rail read the worktree the turn wrote in.
  await expect(shell.win.getByText("greeting.txt").first()).toBeVisible({ timeout: 30_000 });
});
