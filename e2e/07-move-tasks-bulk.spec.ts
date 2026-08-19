// Re-filing SEVERAL misfiled tasks in one go: the task list's multi-select and
// the "Move to project…" action bar. The server rules — the skip report, the
// dependency edges that survive when both ends move, the per-task worktree
// acknowledgement, the single tasks_moved event — are pinned by
// tests/taskMoveBulk.test.ts; this spec is about the gesture: tick, shift-click
// a range, move, and see the whole selection land in the other project's tray.
//
// The last test covers the started half, which is the one that can lose
// something: a selection holding a task that has RUN moves it only if that
// row's own checkbox is ticked, with what its worktree holds beside it.

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import {
  createProject,
  createTask,
  ensureOnboarded,
  getTask,
  gotoApp,
  makeFixtureRepo,
  runTaskToCompletion,
  uid,
} from "./helpers";

const FROM = `Bulk from ${uid()}`;
const TO = `Bulk to ${uid()}`;
const TITLES = ["Bulk one", "Bulk two", "Bulk three", "Bulk four"];

// A second pair of projects for the started case, so the range gestures above
// keep the tray they were written against.
const RAN_FROM = `Bulk ran ${uid()}`;
const RAN_TO = `Bulk ran to ${uid()}`;
const RAN_TITLE = "Ran before it was refiled";
const RAN_SIBLING = "Never ran at all";
let ranTaskId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const from = await createProject(request, { name: FROM, repoPath: makeFixtureRepo("bulk-from") });
  await createProject(request, { name: TO, repoPath: makeFixtureRepo("bulk-to") });
  for (const title of TITLES) await createTask(request, { projectId: from.id, title });

  // A real turn: the mock agent commits, so this one lands with a worktree, a
  // branch and a commit main never took — the case worth walking through.
  const ran = await runTaskToCompletion(request, { name: RAN_FROM, title: RAN_TITLE });
  ranTaskId = ran.task.id;
  expect(ran.task.worktree_path).toBeTruthy();
  await createTask(request, { projectId: ran.project.id, title: RAN_SIBLING });
  await createProject(request, { name: RAN_TO, repoPath: makeFixtureRepo("bulk-ran-to") });
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

test("a worktree whose cost can't be read can't be answered for", async ({ page }) => {
  // The preview is what makes the checkbox an acknowledgement rather than a
  // switch. With it unavailable, the row must refuse the answer instead of
  // taking one about a checkout nobody described.
  await page.route("**/api/tasks/move?*", (route) => route.abort());
  await gotoApp(page);
  await page.getByText(RAN_FROM).first().click();
  await pickbox(page, RAN_TITLE).click();
  await page.getByRole("button", { name: "Move to project…" }).click();

  const startedRow = page.locator(".modal .dep-row").filter({ hasText: RAN_TITLE });
  await expect(startedRow).toContainText(/couldn.t read/);
  await expect(startedRow.locator("input[type=checkbox]")).toBeDisabled();
});

test("a started task in the selection moves only if its own box is ticked", async ({ page, request }) => {
  const worktree = (await getTask(request, ranTaskId)).worktree_path;
  expect(fs.existsSync(worktree)).toBe(true);

  await gotoApp(page);
  await page.getByText(RAN_FROM).first().click();
  await pickbox(page, RAN_TITLE).click();
  await pickbox(page, RAN_SIBLING).click();
  await page.getByRole("button", { name: "Move to project…" }).click();
  await page.locator(".modal .dep-row").filter({ hasText: RAN_TO }).click();

  // The started row names what its checkout holds before it is asked for —
  // this one carries a commit the base branch never took.
  const startedRow = page.locator(".modal .dep-row").filter({ hasText: RAN_TITLE });
  await expect(startedRow).toContainText(/not yet in main/);
  // Unticked, it is not part of the move: the button is the plain one.
  await expect(page.getByRole("button", { name: `Move to ${RAN_TO}` })).toBeVisible();

  await startedRow.locator("input[type=checkbox]").check();
  // Two-step once a worktree is going, like the single-task field.
  await page.getByRole("button", { name: /Discard 1 worktree and move/ }).click();
  await page.getByRole("button", { name: /Move and discard 1 worktree/ }).click();

  // Both leave this tray and land together in the destination…
  for (const title of [RAN_TITLE, RAN_SIBLING]) {
    await expect(page.locator(".ttitle").filter({ hasText: title })).toBeHidden();
  }
  await page.getByText(RAN_TO).first().click();
  for (const title of [RAN_TITLE, RAN_SIBLING]) {
    await expect(page.locator(".ttitle").filter({ hasText: title })).toBeVisible();
  }

  // …and the checkout the answer was about is gone from disk and off the row.
  const moved = await getTask(request, ranTaskId);
  expect(moved.worktree_path).toBe("");
  expect(moved.started).toBe(1);
  expect(fs.existsSync(worktree)).toBe(false);
});
