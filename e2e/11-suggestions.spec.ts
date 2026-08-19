// The Suggested-by-agents tray in list view, and the Edit-task dialog it opens:
// expanding a clamped brief, and accepting (or accepting AND starting) a
// suggestion from inside the dialog. Suggestions are seeded through the same
// POST /api/tasks the agent tool uses — 04-turn-behaviors covers a real turn
// filing one; this spec is about what the user can then DO with the row.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, uid, waitForIdle } from "./helpers";

const PROJECT = `Suggestions ${uid()}`;
let projectId: string;

// Long enough that one clamped line can't hold it — the whole point of the
// disclosure triangle.
const BRIEF =
  "The widget factory allocates a fresh pool per request, which shows up as a " +
  "sawtooth in the heap graph under load. Hoist the pool to module scope, gate " +
  "it behind a lazy initializer, and add a regression test that asserts a single " +
  "allocation across two calls.";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("suggestions") });
  projectId = project.id;
});

const openProject = async (page: import("@playwright/test").Page) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();
};

const trayRow = (page: import("@playwright/test").Page, title: string) =>
  page.locator(".sug").filter({ has: page.locator(".sg-name", { hasText: title }) });

test("a suggestion's brief expands and collapses from the tray", async ({ page, request }) => {
  const title = `Pool the widget factory ${uid()}`;
  await createTask(request, { projectId, title, description: BRIEF, suggested: true });

  await openProject(page);
  const row = trayRow(page, title);
  await expect(row).toBeVisible();

  // The brief itself is a second toggle with the same label, so target the
  // triangle by class rather than by accessible name.
  const chevron = row.locator("button.sug-chev");
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  const clamped = (await row.boundingBox())!.height;

  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  // The clamp really came off — not just a class flip.
  expect((await row.boundingBox())!.height).toBeGreaterThan(clamped);
  await expect(row.locator(".sg-why")).toContainText("regression test");

  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  expect((await row.boundingBox())!.height).toBe(clamped);
});

test("a suggestion with no description has no triangle", async ({ page, request }) => {
  const title = `Bare suggestion ${uid()}`;
  await createTask(request, { projectId, title, suggested: true });

  await openProject(page);
  const row = trayRow(page, title);
  await expect(row).toBeVisible();
  await expect(row.locator("button.sug-chev")).toHaveCount(0);
});

test("the edit dialog saves an edited suggestion into the task list", async ({ page, request }) => {
  const title = `Accept me ${uid()}`;
  const task = await createTask(request, { projectId, title, description: BRIEF, suggested: true });
  const edited = `${title} (sharpened)`;

  await openProject(page);
  await trayRow(page, title).getByTitle("Edit title & description").click();

  const dialog = page.locator(".modal");
  await expect(dialog.getByText("Edit task")).toBeVisible();
  await dialog.locator("input[type=text]").first().fill(edited);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  // Out of the tray, into the list, under the new title — and still unstarted.
  await expect(page.locator(".ttitle").filter({ hasText: edited })).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: title })).toHaveCount(0);
  const after = await getTask(request, task.id);
  expect(after.suggested).toBe(0);
  expect(after.title).toBe(edited);
  expect(after.started).toBe(0);
});

test("the edit dialog can accept and start a suggestion in one gesture", async ({ page, request }) => {
  const title = `Start me ${uid()}`;
  const task = await createTask(request, { projectId, title, description: BRIEF, suggested: true });

  await openProject(page);
  await trayRow(page, title).getByTitle("Edit title & description").click();
  await page.locator(".modal").getByRole("button", { name: "Add & start" }).click();

  // Accepted AND launched: the session pane takes over and the row's first turn
  // runs to completion.
  const settled = await waitForIdle(request, task.id);
  expect(settled.suggested).toBe(0);
  expect(settled.started).toBe(1);
});

test("an added but unstarted task can be started from the edit dialog", async ({ page, request }) => {
  const title = `Launch from dialog ${uid()}`;
  const task = await createTask(request, { projectId, title, description: "plain task" });

  await openProject(page);
  // A plain card opens the session pane, not the dialog — an unstarted task's
  // hero is where its Edit button lives.
  await page.locator(".ttitle").filter({ hasText: title }).click();
  await page.getByTitle("Edit title & description before starting").click();
  await page.locator(".modal").getByRole("button", { name: "Save & start" }).click();

  const settled = await waitForIdle(request, task.id);
  expect(settled.started).toBe(1);
});
