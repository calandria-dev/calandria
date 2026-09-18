// Switching projects while the landing project's task list is still in flight.
// Boot picks a project and loads its tasks; clicking a different one starts a
// second load, and on a loaded machine the two can resolve in either order. The
// older response must be dropped: applied, it leaves `tasksFor` naming a
// project that is no longer selected, which the tasks column reads as "still
// loading" and answers with skeleton cards, permanently, since nothing issues
// another load while the selection stands.
//
// This is the race behind issue #161. On the Windows lane it surfaced as a
// 60s `locator.click` timeout whose call log reads "locator resolved to
// <span class="ttitle">" then "element was detached from the DOM, retrying":
// the row was there, the late response blanked the column, and the click spent
// the rest of the test budget waiting for a row that was never coming back.
// The spec that caught it was arbitrary, which is why every sighting named a
// different one.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const LANDING = `Switch race landing ${uid()}`;
const TARGET = `Switch race target ${uid()}`;
const LANDING_TASK = `Landing project task ${uid()}`;
const TARGET_TASK = `Target project task ${uid()}`;

let landingId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const landing = await createProject(request, { name: LANDING, repoPath: makeFixtureRepo("switch-race-landing") });
  landingId = landing.id;
  await createTask(request, { projectId: landingId, title: LANDING_TASK });
  const target = await createProject(request, { name: TARGET, repoPath: makeFixtureRepo("switch-race-target") });
  await createTask(request, { projectId: target.id, title: TARGET_TASK });
});

test("a landing project's late task list does not blank the project switched to", async ({ page }) => {
  // Hold the landing project's task fetch open so the switch is guaranteed to
  // resolve first. Real runs get this ordering from load alone; pinning it
  // here is the difference between a regression test and another flake.
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/projects/${landingId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await held;
    await route.continue();
  });

  await gotoApp(page, `?project=${landingId}`);
  await page.getByText(TARGET).first().click();

  const row = page.locator(".ttitle").filter({ hasText: TARGET_TASK }).first();
  await expect(row).toBeVisible();

  const late = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${landingId}`) && r.request().method() === "GET");
  release();
  await late;
  // Two frames after the response, React has committed whatever it made of it.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

  // Still the project that was switched to: its row, not the landing project's,
  // and not the skeleton stack the column shows while a load is outstanding.
  await expect(row).toBeVisible();
  await expect(page.locator(".ttitle").filter({ hasText: LANDING_TASK })).toHaveCount(0);
  await expect(page.locator(".task-scroll .task[aria-hidden]")).toHaveCount(0);

  // And the row still opens, which is the assertion the flake actually failed.
  await row.click();
  await expect(page.locator(".sess-head")).toBeVisible();
});
