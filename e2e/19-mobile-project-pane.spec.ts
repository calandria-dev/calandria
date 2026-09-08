// The phone's project pane. ProjectLanding is the only mount point for
// Runbooks and Schedules, and on desktop it is the "project open, no task
// selected" screen, a state a phone never reaches because that same state
// shows the task list there instead. The rest of the suite runs at the
// default desktop viewport, where ProjectLanding renders exactly where
// desktop puts it, so a phone needs its own coverage of reaching those cards.
//
// This spec runs at a phone viewport and drives the whole loop: cold load,
// reach the Runbooks card, dispatch a runbook, and confirm the minted task
// opens.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

// Under the app's own 760px breakpoint (app/Shell.tsx MOBILE_QUERY).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const PROJECT = `Mobile ${uid()}`;
const RECIPE = "Linger self-test";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("mobile-project-pane") });
  // A task, because that is the ordinary state of a project someone is working
  // in, and on a phone that state shows the task list instead of the landing
  // pane, which is where the Runbooks/Schedules cards must still be reachable.
  await createTask(request, { projectId: project.id, title: "Ordinary work in progress" });
  const res = await request.post(`/api/projects/${project.id}/runbooks`, {
    data: { name: RECIPE, description: "Hold the session open and report.", prompt: "say hello" },
  });
  expect(res.status()).toBe(201);
});

/**
 * Cold load to this project's task list. Boot picks a project on its own
 * (active[0], the seeded tutorial here), which on a phone lands straight on
 * that project's task list, so reaching the projects pane means pressing Back
 * first.
 *
 * The gate is the Back button, nothing else (#104): the boot skeleton also
 * draws a `.col-projects`, so waiting on that element instead of the Back
 * button can match the skeleton on a slow runner. A fresh context has no
 * remembered task, so boot always lands on a task list and the button is
 * always coming.
 */
async function openTaskList(page: Page): Promise<void> {
  await gotoApp(page);
  const back = page.getByRole("button", { name: "Back to projects" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.locator(".col-projects")).toBeVisible();
  await page.getByText(PROJECT).first().click();
  await expect(page.getByRole("button", { name: "Project home" })).toBeVisible();
}

test("the Runbooks card is reachable from a phone, and dispatch opens the task", async ({ page }) => {
  await openTaskList(page);

  // On the task list there is no Runbooks card.
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeHidden();

  // Tapping the project name is the way in: the same "Project home" control
  // desktop has in this header.
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
  // list: the cards are a level below the project, not beside it.
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
  // ?home=1: the pane is a route, not a transient flag, so reloading (or
  // sharing the URL) doesn't drop back onto the task list.
  await openTaskList(page);
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("home")).toBe("1");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
});
