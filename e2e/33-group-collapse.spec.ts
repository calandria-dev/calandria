// Folding a status group in the tasks list. Every group folds, not only the
// terminal ones, and each remembers its own state per project.
//
// Only the built app can prove this: the state lives in localStorage and the
// groups are rendered by the real column, so a reload is the assertion.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Collapse ${uid()}`;
let projectId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("collapse") });
  projectId = project.id;
  // Six tasks: the search field only appears once the list is past
  // SEARCH_MIN, and the last case needs it.
  for (let i = 0; i < 5; i++) await createTask(request, { projectId: project.id, title: `Filler ${i}` });
  await createTask(request, { projectId: project.id, title: "Fold me" });
});

const row = (page: import("@playwright/test").Page, title: string) =>
  page.locator(".col-tasks .task-row").filter({ hasText: title });
const group = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".task-group-h").filter({ hasText: label });

async function openList(page: import("@playwright/test").Page) {
  // Pinned by query string: the suite shares one instance, so which project
  // the shell lands on otherwise depends on the accumulated list.
  await gotoApp(page, `?project=${projectId}`);
  await page.getByTitle("List view").click();
  await expect(group(page, "Not started")).toBeVisible();
}

test("a live group folds, stays folded across a reload, and a search opens it", async ({ page }) => {
  await openList(page);
  await expect(row(page, "Fold me")).toBeVisible();

  await group(page, "Not started").click();
  await expect(group(page, "Not started")).toHaveClass(/is-collapsed/);
  await expect(row(page, "Fold me")).toHaveCount(0);
  // The count stays on the header, so the group still says what it holds.
  await expect(group(page, "Not started")).toContainText("6");

  await page.reload();
  await expect(group(page, "Not started")).toHaveClass(/is-collapsed/);
  await expect(row(page, "Fold me")).toHaveCount(0);

  // A match behind a folded header would read as no match at all.
  await page.locator(".col-tasks .search-input").fill("Fold me");
  await expect(row(page, "Fold me")).toBeVisible();
  await page.locator(".col-tasks .search-clear").click();
  await expect(row(page, "Fold me")).toHaveCount(0);

  await group(page, "Not started").click();
  await expect(row(page, "Fold me")).toBeVisible();
});
