// Runbooks are unit-tested at the store, dispatch and route layers; this proves
// the loop a user actually performs — save a recipe on the landing pane,
// dispatch it, and watch a real task with a real turn come out the other end.
//
// It also covers the one thing no unit test can: that the card renders inside
// ProjectLanding at all, above Schedules, in the built bundle.

import { expect, test, type APIRequestContext } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Runbooks ${uid()}`;
const DEST = `Runbooks dest ${uid()}`;
const RECIPE = "Push and babysit CI";

let destId = "";

/** Save a runbook through the API — fixture setup, not the behavior under test. */
async function createRunbook(request: APIRequestContext, projectId: string, name: string, prompt = "say hello") {
  const res = await request.post(`/api/projects/${projectId}/runbooks`, {
    data: { name, description: "Push everything unpushed, then watch the pipeline.", prompt },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

/**
 * Select a project and land on ProjectLanding, where the card lives.
 *
 * The "Project home" click is not optional once the project has a task:
 * useRecaps.ts auto-selects the first task the moment none is selected, so a
 * bare project click lands on the session view instead — and racily, since the
 * landing pane renders for a beat first. Same reason
 * e2e/10-schedules.spec.ts's third case exists.
 */
async function openProjectHome(page: import("@playwright/test").Page, name: string) {
  await page.getByText(name).first().click();
  const home = page.getByRole("button", { name: "Project home" });
  if (await home.isVisible().catch(() => false)) await home.click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("runbooks") });
  const dest = await createProject(request, { name: DEST, repoPath: makeFixtureRepo("runbooks-dest") });
  destId = dest.id;
  // The copy test needs a row to copy; giving it its own fixture keeps it from
  // depending on whether the dispatch test above it passed.
  await createRunbook(request, project.id, RECIPE);
});

test("a runbook can be saved from the card, then dispatched into a live task", async ({ page }) => {
  await gotoApp(page);
  // No task in this project, so selecting it lands on ProjectLanding — where
  // the Runbooks card lives, above Schedules.
  await openProjectHome(page, PROJECT);

  await page.getByRole("button", { name: "New runbook" }).click();
  await page.getByLabel("Name").fill("Nightly sweep");
  await page.getByLabel("Description").fill("Sweep the queue and report.");
  await page.getByLabel("Prompt").fill("say hello");
  await page.getByRole("button", { name: "Create runbook" }).click();

  // Scope to THIS runbook's row: the sidebar carries every project every other
  // spec created, and words like "Run" are far too common for a page-wide
  // getByText to stay unambiguous.
  const row = page.locator(".rb-row").filter({ hasText: "Nightly sweep" });
  await expect(row).toBeVisible();
  await expect(row.getByText("never run")).toBeVisible();

  // Dispatch. The sheet prefills a dated title; the extras box is what makes
  // this run different from the saved recipe. Both the row and the sheet have a
  // "Run" button, so the sheet's is scoped to the modal.
  await row.getByRole("button", { name: "Run", exact: true }).click();
  const sheet = page.locator(".modal");
  await sheet.getByLabel("Task title").fill("Friday sweep");
  await sheet.getByLabel("Instructions for this run").fill("focus on the release branch");
  await sheet.getByRole("button", { name: "Run", exact: true }).click();

  // A real task, selected, whose first user message is the composed prompt —
  // the saved recipe plus this run's extras.
  await expect(page.getByText("focus on the release branch")).toBeVisible();

  // And the card now knows it has run.
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(
    page.locator(".rb-row").filter({ hasText: "Nightly sweep" }).getByRole("button", { name: /^last run / })
  ).toBeVisible();
});

test("a runbook copies into another project as an independent row", async ({ page }) => {
  await gotoApp(page);
  await openProjectHome(page, PROJECT);

  const row = page.locator(".rb-row").filter({ hasText: RECIPE });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Copy to…" }).click();

  const sheet = page.locator(".modal");
  await sheet.getByText(DEST, { exact: true }).click();
  await sheet.getByRole("button", { name: "Copy", exact: true }).click();

  // The original stays put…
  await expect(row).toBeVisible();
  // …and the destination gains its own copy.
  await openProjectHome(page, DEST);
  await expect(page.locator(".rb-row").filter({ hasText: RECIPE })).toBeVisible();
});

test("an unverifiable slash prompt warns but does not block saving", async ({ page }) => {
  // Same contract the schedules form has, and for the same reason: the mock
  // agent isn't the Claude CLI, so validatePrompt() reports `unchecked`. The
  // check is a typo catcher, never a gate.
  await gotoApp(page);
  await openProjectHome(page, DEST);

  await page.getByRole("button", { name: "New runbook" }).click();
  await page.getByLabel("Name").fill("Jira sweep");
  const promptField = page.getByLabel("Prompt");
  await promptField.fill("/jira-tasks");
  await promptField.blur();

  await expect(page.getByText(/couldn.t reach this project.s command registry/i)).toBeVisible();
  const createBtn = page.getByRole("button", { name: "Create runbook" });
  await expect(createBtn).toBeEnabled();
  await createBtn.click();

  await expect(page.locator(".rb-row").filter({ hasText: "Jira sweep" })).toBeVisible();
});

test("deleting a runbook removes it from the card", async ({ page }) => {
  await gotoApp(page);
  await openProjectHome(page, DEST);

  const row = page.locator(".rb-row").filter({ hasText: "Jira sweep" });
  await expect(row).toBeVisible();
  // Nothing links this one, so the confirmation is the plain can't-be-undone
  // one rather than the schedule-detach explanation.
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toBeHidden();
});

// The ⌘K rows are deliberately NOT covered here. The palette lives behind
// `omniSearch`, which DEFAULT_FEATURES ships off (lib/features.ts), so this
// suite's server doesn't render it — and switching the flag on for the whole
// run would test a build nobody gets by default and put an omni-search bar in
// front of every other spec's toolbar. The ranking those rows depend on is
// pinned in tests/runbookPalette.test.ts instead.

test("the dispatched task remembers which project it belongs to", async ({ request }) => {
  // A dispatch mints into the RUNBOOK's project, never the one on screen — the
  // API is the honest place to assert that, since the UI only ever shows one.
  const rb = await createRunbook(request, destId, `Scoped ${uid()}`);
  const res = await request.post(`/api/runbooks/${rb.id}/run`, { data: { start: false } });
  expect(res.status()).toBe(201);
  const { task } = await res.json();
  expect(task.project_id).toBe(destId);
  expect(task.runbook_id).toBe(rb.id);
});
