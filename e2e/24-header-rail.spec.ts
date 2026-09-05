// The session header's control rail (app/shell/useOverflowRail.ts).
//
// This can only be tested here. The rail decides what to show by measuring
// itself (scrollWidth against clientWidth, in a real layout, against real
// fonts), so there is nothing a unit test could assert that wouldn't just be
// asserting the arithmetic back at itself. A unit test also can't see the
// case this guards against: a chip painted past the edge of a pane that
// stopped being wide enough.
//
// Every case below checks the same invariant, "nothing on the rail is out of
// reach", at several widths, plus that what left the rail is still one click
// away.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

const PROJECT = `Header rail ${uid()}`;
const TITLE = `A task with a deliberately long name so the header has to make choices ${uid()}`;
let projectId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("header-rail") });
  projectId = project.id;
  const res = await request.post(`/api/projects/${projectId}/tags`, { data: { name: "Bugs — Miscellaneous", color: "#C2603C" } });
  expect(res.status()).toBe(201);
  const tagId = (await res.json()).id as string;
  const task = await createTask(request, { projectId, title: TITLE });
  await request.patch(`/api/tasks/${task.id}`, { data: { tag_ids: [tagId] } });
  // A task that has RUN carries the fullest header there is: Edit and /clear
  // appear only after the first session, and the usage chip only once a turn
  // has spent something.
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);
});

const openTask = async (page: Page) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.locator(".ttitle").filter({ hasText: TITLE }).first().click();
  await expect(page.locator(".sess-head")).toBeVisible();
};

/**
 * The invariant: nothing on the rail is painted somewhere unreachable.
 * Overflowing is only a bug when it is also clipped: on a pane too narrow for
 * even the pinned controls the rail becomes a scroller instead, and that
 * scrolling floor is not itself a failure.
 */
const clipped = (page: Page) =>
  page.locator(".sh-tools").evaluate((el) => {
    const over = el.scrollWidth - el.clientWidth > 1;
    return over && !/auto|scroll/.test(getComputedStyle(el).overflowX);
  });

const rail = (page: Page) => page.locator(".sh-tools");
/** Everything currently ON the rail, "More" included. */
const items = (page: Page) => page.locator(".sh-tools > *");

test("the rail fits at every pane width, collapsing into More rather than overflowing", async ({ page }) => {
  await openTask(page);

  // Wide enough for everything: no overflow, and nothing has been taken away.
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect.poll(() => clipped(page)).toBe(false);
  await expect(rail(page).getByRole("button", { name: "/clear" })).toBeVisible();

  // Narrow the window in steps. At each one the rail must still fit: the
  // failure this guards is a chip painted past the pane's edge.
  for (const width of [1400, 1150, 950, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => clipped(page), { message: `rail is clipped at ${width}px` }).toBe(false);
  }

  // Something had to give at 800px, and it is offered instead of lost. Which
  // items went is not asserted: that falls out of the measurement, so it moves
  // with the fonts, the chips this task happens to carry, and the width of
  // the columns beside it. The rail must say it is holding something back,
  // and pressing More must produce all of it.
  const more = rail(page).getByRole("button", { name: "More" });
  await expect(more).toBeVisible();
  const collapsed = await items(page).count();
  await more.click();
  await expect(rail(page).getByRole("button", { name: "/clear" })).toBeVisible();
  expect(await items(page).count()).toBeGreaterThan(collapsed);

  // Collapsing again puts the rail back exactly as it was: the toggle is a
  // view of one rail, not a second one.
  await rail(page).getByRole("button", { name: "Less" }).click();
  await expect.poll(() => items(page).count()).toBe(collapsed);
  await expect.poll(() => clipped(page)).toBe(false);

  // And widening gives the full set back without the toggle: the collapse is a
  // measurement, not a latch.
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect(rail(page).getByRole("button", { name: "/clear" })).toBeVisible();
});

test("the status is the one control the rail never drops", async ({ page }) => {
  await openTask(page);
  await page.setViewportSize({ width: 760, height: 900 });
  await expect.poll(() => clipped(page)).toBe(false);
  await expect(rail(page).locator(".status-ctl .cv").first()).toBeVisible();
});

test("tags sit on the breadcrumb and the agent on the title, neither on the rail", async ({ page }) => {
  await openTask(page);
  // Both are identity, not controls, so neither belongs on the rail, where a
  // narrow pane would push them off with everything else.
  await expect(page.locator(".sess-head .crumb .gbadge")).toHaveCount(1);
  await expect(page.locator(".sh-tools .gbadge")).toHaveCount(0);
  await expect(page.locator(".sh-tools .agent-badge")).toHaveCount(0);
  // The agent badge sits on the title too, not the crumb: as a mark it costs
  // the title a glyph instead of a word, so it qualifies the title instead of
  // clipping beside the tags.
  await expect(page.locator(".sess-head .crumb .agent-badge")).toHaveCount(0);
  await expect(page.locator(".sess-head .sh-title .agent-badge")).toHaveCount(1);
});
