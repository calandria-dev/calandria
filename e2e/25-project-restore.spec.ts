// Restarting the client returns to the project you had open, not the first one
// in the list. The precedence itself is pinned by tests/persist.test.ts; what
// only the built app can show is the ordering between the persist effect,
// which fires the moment prefs hydrate, and the project fetch resolving:
// the still-null selection must not overwrite localStorage before boot reads
// it back.

import { expect, test } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const FIRST = `Restore A ${uid()}`;
const LAST = `Restore B ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  // Ordered by position/created_at, so A sorts above B, and both sort below
  // the projects earlier specs made, so projects[0] is a wrong answer that
  // looks nothing like the right one.
  await createProject(request, { name: FIRST, repoPath: makeFixtureRepo("restore-a") });
  await createProject(request, { name: LAST, repoPath: makeFixtureRepo("restore-b") });
});

test("a reload with no ?project= returns to the last project open", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(LAST).first().click();
  await expect(page.locator(".proj.sel")).toContainText(LAST);

  // Bare URL: no query string to fall back on, so localStorage is the only
  // thing that can carry the selection across, as happens on the desktop
  // app's cold start and on any reopen from a bookmarked root.
  await page.goto("/");

  await expect(page.locator(".proj.sel")).toContainText(LAST);
  // It is genuinely remembered, not defaulted into: the list does not begin
  // with it.
  await expect(page.locator(".proj").first()).not.toContainText(LAST);
});

test("a project that has since gone away falls back to the first one", async ({ page, request }) => {
  const doomed = await createProject(request, { name: `Restore C ${uid()}`, repoPath: makeFixtureRepo("restore-c") });
  await gotoApp(page);
  await page.getByText(doomed.name).first().click();
  await expect(page.locator(".proj.sel")).toContainText(doomed.name);

  await request.delete(`/api/projects/${doomed.id}`);
  await page.goto("/");

  // Not stuck on a project that no longer exists, and not left with nothing.
  await expect(page.locator(".proj.sel")).toHaveCount(1);
  await expect(page.locator(".proj.sel")).not.toContainText(doomed.name);
});
