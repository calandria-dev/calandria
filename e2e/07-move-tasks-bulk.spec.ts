// Re-filing SEVERAL misfiled tasks in one go: the task list's multi-select and
// the "Move to project…" action bar. The server rules — the skip report, the
// dependency edges that survive when both ends move, the single tasks_moved
// event — are pinned by tests/taskMoveBulk.test.ts; this spec is about the
// gesture: tick, shift-click a range, move, and see the whole selection land in
// the other project's tray.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const FROM = `Bulk from ${uid()}`;
const TO = `Bulk to ${uid()}`;
const TITLES = ["Bulk one", "Bulk two", "Bulk three", "Bulk four"];

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const from = await createProject(request, { name: FROM, repoPath: makeFixtureRepo("bulk-from") });
  await createProject(request, { name: TO, repoPath: makeFixtureRepo("bulk-to") });
  for (const title of TITLES) await createTask(request, { projectId: from.id, title });
});

/** The multi-select checkbox on the card carrying `title`. */
const pickbox = (page: import("@playwright/test").Page, title: string) =>
  page.locator(".task-row").filter({ hasText: title }).locator(".pickbox input");

test("a shift-click with nothing selected yet still anchors the next range", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(FROM).first().click();
  await expect(page.locator(".ttitle").filter({ hasText: TITLES[0] })).toBeVisible();

  // No prior plain click, so there's no anchor: this can only select itself…
  await pickbox(page, TITLES[0]).click({ modifiers: ["Shift"] });
  await expect(page.locator(".pick-bar .pb-count")).toHaveText("1 selected");
  // …but it must BECOME the anchor, or every later range gesture degrades to a
  // single toggle and the list is stuck one task at a time.
  await pickbox(page, TITLES[2]).click({ modifiers: ["Shift"] });
  await expect(page.locator(".pick-bar .pb-count")).toHaveText("3 selected");
});

test("a multi-select moves every picked task to another project at once", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(FROM).first().click();
  await expect(page.locator(".ttitle").filter({ hasText: TITLES[0] })).toBeVisible();

  // Tick the first, then shift-click the third: the range takes the one between.
  await pickbox(page, TITLES[0]).click();
  await pickbox(page, TITLES[2]).click({ modifiers: ["Shift"] });
  await expect(page.locator(".pick-bar .pb-count")).toHaveText("3 selected");

  await page.getByRole("button", { name: "Move to project…" }).click();
  await page.locator(".dep-row").filter({ hasText: TO }).click();
  await page.getByRole("button", { name: `Move to ${TO}` }).click();

  // The three leave this tray; the one never picked stays.
  for (const title of TITLES.slice(0, 3)) {
    await expect(page.locator(".ttitle").filter({ hasText: title })).toBeHidden();
  }
  await expect(page.locator(".ttitle").filter({ hasText: TITLES[3] })).toBeVisible();

  // …and all three are waiting in the destination.
  await page.getByText(TO).first().click();
  for (const title of TITLES.slice(0, 3)) {
    await expect(page.locator(".ttitle").filter({ hasText: title })).toBeVisible();
  }
});
