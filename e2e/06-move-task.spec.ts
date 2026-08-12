// Moving a misfiled task to another project, through the UI affordance in the
// Edit-task modal. The server rules (position renumbering, dropped dependency
// edges, inherited settings, the started-task refusal) are pinned by
// tests/taskMove.test.ts; this spec is about the wiring — picking a destination
// lands the row in that project's tray and takes it out of this one.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const FROM = `Move from ${uid()}`;
const TO = `Move to ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const from = await createProject(request, { name: FROM, repoPath: makeFixtureRepo("move-from") });
  await createProject(request, { name: TO, repoPath: makeFixtureRepo("move-to") });
  await createTask(request, { projectId: from.id, title: "Misfiled task" });
});

test("an unstarted task moves to another project from the Edit modal", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(FROM).first().click();
  await page.locator(".ttitle").filter({ hasText: "Misfiled task" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  await page.locator(".dep-row").filter({ hasText: TO }).click();
  await page.getByRole("button", { name: `Move to ${TO}` }).click();

  // The row leaves this project's tray…
  await expect(page.locator(".ttitle").filter({ hasText: "Misfiled task" })).toBeHidden();
  // …and is waiting in the destination, description and all.
  await page.getByText(TO).first().click();
  await expect(page.locator(".ttitle").filter({ hasText: "Misfiled task" })).toBeVisible();
});
