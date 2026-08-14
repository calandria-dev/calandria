// Scheduling is unit-tested to death; this proves the loop a user actually
// performs — create a schedule on the landing pane, fire it, and watch a real
// task come out the other end.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Schedules ${uid()}`;
// A separate project for the validation test below, kept task-free so that
// test lands straight on ProjectLanding. (It used to be REQUIRED: with a task
// present, useRecaps.ts's landing decision auto-selected it and the Schedules
// card was unreachable at all. That is what PROJECT3 below now covers.)
const PROJECT2 = `Schedules validate ${uid()}`;
// A project WITH a task, which is the ordinary state of any project someone is
// actually working in — and the state the schedules card used to be
// unreachable from.
const PROJECT3 = `Schedules busy ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("schedules") });
  await createProject(request, { name: PROJECT2, repoPath: makeFixtureRepo("schedules-validate") });
  const busy = await createProject(request, { name: PROJECT3, repoPath: makeFixtureRepo("schedules-busy") });
  await createTask(request, { projectId: busy.id, title: "Ordinary work in progress" });
});

test("a schedule can be created, run on demand, and paused", async ({ page }) => {
  await gotoApp(page);
  // Selecting the project with no task selected lands on ProjectLanding, which
  // is where the Schedules card lives.
  await page.getByText(PROJECT).first().click();

  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Name").fill("Morning triage");
  await page.getByLabel("Prompt").fill("say hello");
  await page.getByLabel("Mon", { exact: true }).check();
  await page.getByLabel("Time").fill("08:30");
  await page.getByRole("button", { name: "Create schedule" }).click();

  await expect(page.getByText("Morning triage")).toBeVisible();
  // The preview is the guard against a timezone mistake, so it must render.
  await expect(page.getByText(/next /)).toBeVisible();

  // Run now exercises the entire firing path without waiting until 08:30.
  // No waitForIdle() here — that helper polls a TASK id, and this button
  // doesn't hand the client one (the task is minted server-side inside the
  // firing). It doesn't need to: lib/scheduler.ts's runScheduleNow() calls
  // startRun() (which flips the run to "running") before the fire-and-forget
  // startTurn() ever runs, so the row this click's own reload fetches is
  // already "running" — Playwright's normal retry-until-visible covers the
  // rest.
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText(/\b(ran|running)\b/)).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("paused")).toBeVisible();
});

test("an unverifiable slash prompt warns but does not block saving", async ({ page }) => {
  // The mock agent isn't the Claude CLI, so lib/schedule/commands.ts's
  // listSlashCommands() can't read its command registry and validatePrompt()
  // reports `unchecked` rather than pass/fail. That — and an outright
  // "unknown command" failure, which only a real Claude session can produce —
  // must both leave Save enabled: the check is a typo catcher, not a gate.
  // This is the only piece of that contract the mock-agent e2e suite can
  // exercise; the pass/fail branch is covered by tests/scheduleCommands.test.ts.
  await gotoApp(page);
  await page.getByText(PROJECT2).first().click();

  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Name").fill("Jira triage");
  const promptField = page.getByLabel("Prompt");
  await promptField.fill("/jira-tasks");
  await promptField.blur();

  await expect(page.getByText(/couldn.t reach this project.s command registry/i)).toBeVisible();
  const createBtn = page.getByRole("button", { name: "Create schedule" });
  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  await expect(page.getByText("Jira triage")).toBeVisible();
});

test("the schedules card is reachable from a project that already has a task", async ({ page }) => {
  // The state every real project is in: at least one task, no stored recap,
  // recent activity. useRecaps.ts's landing decision auto-selects the first
  // task the moment none is selected — and because selTask is in that effect's
  // deps, clicking the project-home button (which only cleared selTask) was
  // bounced straight back. So the landing pane, and with it the Schedules card
  // and its Pause control, could not be opened at all: you could create a
  // schedule minting unattended agent runs every morning and then have no way
  // to reach the UI to stop it.
  await gotoApp(page);
  await page.getByText(PROJECT3).first().click();

  // Auto-selection still happens, and is still what we want on arrival: the
  // session view for the project's one task, not the landing pane.
  await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeHidden();

  // The explicit ask for the project home must now win.
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New schedule" })).toBeVisible();

  // And it is an intent, not a mode: picking a task goes back to the session.
  await page.getByText("Ordinary work in progress").first().click();
  await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeHidden();
});
