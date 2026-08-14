// Scheduling is unit-tested to death; this proves the loop a user actually
// performs — create a schedule on the landing pane, fire it, and watch a real
// task come out the other end.

import { expect, test } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Schedules ${uid()}`;
// A separate project for the validation test below: once the first test's
// Run Now mints a real task, useRecaps.ts's landing decision (no recap to
// show yet -> auto-select the project's first task) takes over clicking the
// project row, landing on that task's session instead of ProjectLanding —
// so the Schedules card, and its "New schedule" button, are never reachable
// from a project that already has a task. A fresh, task-free project keeps
// that landing decision resolving to ProjectLanding, same as test one.
const PROJECT2 = `Schedules validate ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("schedules") });
  await createProject(request, { name: PROJECT2, repoPath: makeFixtureRepo("schedules-validate") });
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
