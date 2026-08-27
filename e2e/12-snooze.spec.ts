// Snoozing a task: park it out of sight until a deadline, then get it back in
// the category it came from.
//
// The unit suite (tests/snooze.test.ts) owns the derivation and the SQL. This
// spec owns the thing only the BUILT app can prove: that the derived category
// actually appears in both layouts, that the wake control returns the card to
// the status group it never really left, and that the "was snoozed" marker is
// on it when it lands.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Snooze ${uid()}`;
let targetId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("snooze") });
  // Created LAST on purpose: the shell auto-selects a project's TOP task when
  // nothing is selected (useRecaps), the tray is ordered most-recently-active
  // first, and selecting the target would clear the was-snoozed marker this
  // spec needs to see — that marker is an unread flag, and opening the task is
  // what acknowledges it. So the decoy has to be the newer of the two.
  targetId = (await createTask(request, { projectId: project.id, title: "Snooze me" })).id;
  await createTask(request, { projectId: project.id, title: "Decoy task" });
});

const row = (page: import("@playwright/test").Page, title: string) =>
  page.locator(".task-row").filter({ hasText: title });
const group = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".task-group-h").filter({ hasText: label });

async function openProject(page: import("@playwright/test").Page) {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
}

test("a list row snoozes into the Snoozed group and wakes back into its own", async ({ page }) => {
  await openProject(page);
  await page.getByTitle("List view").click();
  await expect(group(page, "Not started")).toBeVisible();
  await expect(group(page, "Snoozed")).toHaveCount(0);

  // The moon button in the row's right gutter, then a one-click preset.
  // Selected by data-preset, NOT by text: each row also renders its wake time,
  // so after ~21:00 local the "3 hours" row's sub-label reads "tomorrow at
  // 12:07 AM" and a hasText:"Tomorrow" filter matches two rows (Playwright's
  // hasText is case-insensitive substring). That made this test pass all
  // afternoon and fail in CI at 21:07 UTC.
  await row(page, "Snooze me").locator(".snz-set").click();
  await page.locator('.popover .pop-item[data-preset="tomorrow"]').click();

  // It left Not started for Snoozed, and says when it comes back.
  await expect(group(page, "Snoozed")).toBeVisible();
  await expect(row(page, "Snooze me")).toContainText("wakes tomorrow at");
  await expect(row(page, "Snooze me")).toHaveClass(/snoozed/);
  // Decoy stayed put — snoozing is per task, not per group.
  await expect(row(page, "Decoy task")).not.toHaveClass(/snoozed/);

  // Waking it by hand. Deliberately NOT via the card (that would select the
  // task and clear the marker we're about to assert).
  await row(page, "Snooze me").locator(".snz-wake").click();

  // Back in the category it never actually left, wearing the marker that says
  // why it reappeared.
  await expect(group(page, "Snoozed")).toHaveCount(0);
  await expect(group(page, "Not started")).toBeVisible();
  await expect(row(page, "Snooze me").locator(".snz-chip.was")).toContainText("Was snoozed");
});

test("the board grows a Snoozed column and drops the card back on wake", async ({ page }) => {
  // Snoozed straight through the API — this test is about the board's columns,
  // and the menu is covered above.
  await page.request.patch(`/api/tasks/${targetId}`, { data: { snoozed_until: Date.now() + 6 * 3_600_000 } });
  await openProject(page);
  await page.getByTitle("Board view").click();

  // The column only exists when something is in it (like On hold / Cancelled) —
  // a permanently empty Snoozed column would be board bloat.
  await expect(page.locator(".bcol.k-snoozed")).toBeVisible();
  await expect(page.locator(".bcol.k-snoozed").getByText("Snooze me")).toBeVisible();
  await expect(page.locator(".bcol.k-not_started").getByText("Snooze me")).toHaveCount(0);

  await page.locator(".bcol.k-snoozed .bcard").filter({ hasText: "Snooze me" }).locator(".snz-wake").click();

  await expect(page.locator(".bcol.k-not_started").getByText("Snooze me")).toBeVisible();
  await expect(page.locator(".bcol.k-snoozed")).toHaveCount(0);
});
