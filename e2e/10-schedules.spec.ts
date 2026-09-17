// Scheduling logic is unit-tested; this covers the loop a user actually
// performs: create a schedule on the landing pane, fire it, and watch a real
// task come out the other end.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Schedules ${uid()}`;
// A separate project for the validation test below, kept task-free so that
// test lands straight on ProjectLanding.
const PROJECT2 = `Schedules validate ${uid()}`;
// A project with a task, the ordinary state of any project someone is
// actually working in.
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

  // Everything below asserts against this schedule's own row, not the page:
  // the sidebar lists every project every other spec in the suite created, so
  // a page-wide getByText for a status word can resolve to more than one
  // element and fail strict mode. Scope to the element that carries the status.
  const row = page.locator(".sched-row").filter({ hasText: "Morning triage" });
  await expect(row).toBeVisible();
  // The preview guards against a timezone mistake, so it must render.
  await expect(row.locator(".sched-next")).toHaveText(/^next /);

  // Run now exercises the entire firing path without waiting until 08:30.
  // No waitForIdle() here: that helper polls a task id, and this button
  // doesn't hand the client one, since the task is minted server-side inside
  // the firing. startRun() flips the run to "running" before the
  // fire-and-forget startTurn() runs, so the row this click's own reload
  // fetches is already "running"; Playwright's normal retrying covers the
  // rest. Either label is a pass, since a mock turn can settle to "ran"
  // before the reload lands.
  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row.locator(".sched-badge")).toHaveText(/^(ran|running)$/);

  await row.getByRole("button", { name: "Pause" }).click();
  // Same span as the "next …" preview above: pausing replaces one with the
  // other, so asserting on the span proves the swap, not just that the word
  // appears somewhere on screen.
  await expect(row.locator(".sched-next")).toHaveText("paused");
});

test("an unverifiable slash prompt warns but does not block saving", async ({ page }) => {
  // The mock agent isn't the Claude CLI, so listSlashCommands() can't read
  // its command registry and validatePrompt() reports `unchecked` instead of
  // pass/fail. That result, like an outright "unknown command" failure that
  // only a real Claude session can produce, must leave Save enabled: the
  // check is a typo catcher, not a gate. This is the only piece of that
  // contract the mock-agent e2e suite can exercise; the pass/fail branch is
  // covered by tests/scheduleCommands.test.ts.
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
  // recent activity. The Schedules card and its Pause control must stay
  // reachable even when auto-selection would otherwise land on the project's
  // one task.
  await gotoApp(page);
  await page.getByText(PROJECT3).first().click();

  // Auto-selection puts the session view for the project's one task on
  // screen, not the landing pane.
  await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeHidden();

  // The explicit ask for the project home must win.
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New schedule" })).toBeVisible();

  // It is an intent, not a mode: picking a task goes back to the session.
  await page.getByText("Ordinary work in progress").first().click();
  await expect(page.getByRole("button", { name: "Start session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeHidden();
});
