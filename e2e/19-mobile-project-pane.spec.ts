// The phone's project pane. ProjectLanding is the only mount point for
// Runbooks and Schedules, and on desktop it IS the "project open, no task
// selected" screen — a state a phone never reaches, because there that same
// state shows the task list. So both cards, the Groups card and the recap were
// unreachable from a phone by construction, and the rest of the suite could
// not see it: every other spec runs at the default desktop viewport, where
// ProjectLanding renders exactly where desktop puts it.
//
// This spec runs at a phone viewport and drives the whole loop the report asks
// for: cold load → reach the Runbooks card → dispatch a runbook → the minted
// task opens.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

// Under the app's own 760px breakpoint (app/Orchestrator.tsx MOBILE_QUERY).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const PROJECT = `Mobile ${uid()}`;
const RECIPE = "Linger self-test";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("mobile-project-pane") });
  // A task, because that is the ordinary state of a project someone is working
  // in — and on a phone it is also the state that shows the task list rather
  // than the landing pane, i.e. exactly the one the cards were lost behind.
  await createTask(request, { projectId: project.id, title: "Ordinary work in progress" });
  const res = await request.post(`/api/projects/${project.id}/runbooks`, {
    data: { name: RECIPE, description: "Hold the session open and report.", prompt: "say hello" },
  });
  expect(res.status()).toBe(201);
});

/**
 * Cold load → this project's task list. Boot picks a project on its own
 * (active[0] — the seeded tutorial here), which on a phone lands straight on
 * THAT project's task list, so reaching the projects pane means pressing Back
 * first. The `.or()` is the boot gate: asking `isVisible()` while the skeleton
 * is still up answers "no" and silently skips the Back press.
 */
async function openTaskList(page: Page): Promise<void> {
  await gotoApp(page);
  const back = page.getByRole("button", { name: "Back to projects" });
  const projects = page.locator(".col-projects");
  await expect(back.or(projects).first()).toBeVisible();
  if (await back.isVisible()) await back.click();
  await expect(projects).toBeVisible();
  await page.getByText(PROJECT).first().click();
  await expect(page.getByRole("button", { name: "Project home" })).toBeVisible();
}

test("the Runbooks card is reachable from a phone, and dispatch opens the task", async ({ page }) => {
  await openTaskList(page);

  // The regression itself: on the task list there is no card, and before this
  // pane existed there was nowhere else on a phone to find one.
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeHidden();

  // Tapping the project name is the way in — the same "Project home" control
  // desktop has in this header, which used to be a no-op on a phone.
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();

  const row = page.locator(".rb-row").filter({ hasText: RECIPE });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Run", exact: true }).click();
  const sheet = page.locator(".modal");
  await sheet.getByLabel("Instructions for this run").fill("from a phone");
  await sheet.getByRole("button", { name: "Run", exact: true }).click();

  // The minted task's session opens, carrying the composed prompt.
  await expect(page.getByText("from a phone")).toBeVisible();
});

test("Back walks project home → task list → projects", async ({ page }) => {
  await openTaskList(page);
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();

  // The pane's own back chevron returns to the task list, not to the projects
  // list — the cards are a level BELOW the project, not beside it.
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeHidden();
  await expect(page.getByText("Ordinary work in progress")).toBeVisible();

  // And the device Back button agrees (navHistory's single-trap scheme).
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Ordinary work in progress")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".col-projects")).toBeVisible();
});

test("a refresh on the project pane lands back on it", async ({ page }) => {
  // ?home=1 — the pane is a route, not a transient flag, so reloading (or
  // sharing the URL) doesn't silently drop you onto the task list.
  await openTaskList(page);
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("home")).toBe("1");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
});
