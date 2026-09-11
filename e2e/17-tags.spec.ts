// Tags (docs/FEATURES.md): the chip bar over the list and board, the badges
// on rows/cards/tray/header, the any/all toggle two lit chips get, and the
// Tags field in the edit dialog. Tags are seeded through the same REST routes
// the dialog uses; the agent tools that file tagged plans have their own
// coverage in tests/agentTools.test.ts.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Tags ${uid()}`;
let projectId: string;
let tagId: string;
let secondTagId: string;
const TAG = "Auth migration";
const SECOND = "Mobile PWA";
const bothTitle = `Port login route ${uid()}`;
const suggestedTitle = `Remove legacy middleware ${uid()}`;
const secondOnlyTitle = `Add push permission prompt ${uid()}`;
const looseTitle = `Unrelated chore ${uid()}`;
// A task carrying more tags than TagBadges draws, so the "+N" pill exists.
// Its own tags, none of them TAG or SECOND, so the fractions above stay put.
const MANY = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const manyTitle = `Carries every tag ${uid()}`;

const makeTag = async (request: import("@playwright/test").APIRequestContext, name: string, color?: string) => {
  const res = await request.post(`/api/projects/${projectId}/tags`, { data: { name, ...(color ? { color } : {}) } });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
};

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("tags") });
  projectId = project.id;
  tagId = await makeTag(request, TAG, "#3E7CA8");
  secondTagId = await makeTag(request, SECOND, "#5C8C5A");
  // One task carries both tags, one tray suggestion carries the first, one
  // carries the second only, and one is untagged.
  for (const [title, tags, suggested] of [
    [bothTitle, [tagId, secondTagId], false],
    [suggestedTitle, [tagId], true],
    [secondOnlyTitle, [secondTagId], false],
  ] as const) {
    const res = await request.post("/api/tasks", {
      data: { project_id: projectId, title, priority: "med", agent: "mock", tag_ids: tags, ...(suggested ? { suggested: true } : {}) },
    });
    expect(res.status()).toBe(201);
  }
  await createTask(request, { projectId, title: looseTitle });
  const manyIds: string[] = [];
  for (const name of MANY) manyIds.push(await makeTag(request, name));
  const many = await request.post("/api/tasks", {
    data: { project_id: projectId, title: manyTitle, priority: "med", agent: "mock", tag_ids: manyIds },
  });
  expect(many.status()).toBe(201);
});

const openProject = async (page: Page, view: "List view" | "Board view" = "List view") => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle(view).click();
};

const chip = (page: Page, name: string) => page.locator(".gchip").filter({ has: page.locator(".gc-name", { hasText: name }) });
const row = (page: Page, title: string) => page.locator(".ttitle").filter({ hasText: title });
const badges = (page: Page, title: string) => row(page, title).locator("xpath=..").locator(".gbadge");
const allChip = (page: Page) => page.locator(".gchip", { hasText: "All" });

test("a chip narrows the list and the tray, persists across a reload, and a badge lights it alone", async ({ page }) => {
  await openProject(page);
  // The bar shows each tag with done/of over tasks still counted.
  await expect(chip(page, TAG)).toBeVisible();
  await expect(chip(page, TAG).locator(".gc-frac")).toHaveText("0/2");
  await expect(chip(page, SECOND).locator(".gc-frac")).toHaveText("0/2");
  // Filter off: everything is on screen.
  await expect(row(page, bothTitle)).toBeVisible();
  await expect(row(page, looseTitle)).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: suggestedTitle })).toBeVisible();
  // A task in two tags carries two badges; the untagged one carries none.
  await expect(badges(page, bothTitle)).toHaveText([TAG, SECOND]);
  await expect(badges(page, looseTitle)).toHaveCount(0);

  await chip(page, TAG).click();
  await expect(chip(page, TAG)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, bothTitle)).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: suggestedTitle })).toBeVisible();
  await expect(row(page, secondOnlyTitle)).toHaveCount(0);
  await expect(row(page, looseTitle)).toHaveCount(0);

  // Remembered per project, like the collapsed Done section.
  await page.reload();
  await expect(chip(page, TAG)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, looseTitle)).toHaveCount(0);

  await allChip(page).click();
  await expect(row(page, looseTitle)).toBeVisible();

  // Clicking a badge lights THAT tag alone, without opening the task.
  await badges(page, bothTitle).nth(1).click();
  await expect(chip(page, SECOND)).toHaveAttribute("aria-selected", "true");
  await expect(chip(page, TAG)).toHaveAttribute("aria-selected", "false");
  await expect(row(page, secondOnlyTitle)).toBeVisible();
  await expect(row(page, looseTitle)).toHaveCount(0);
  await allChip(page).click();
});

test("two lit chips union by default, and the any/all toggle switches to the overlap", async ({ page }) => {
  await openProject(page);
  // Nothing lit: no toggle. It is meaningless with fewer than two chips.
  await expect(page.locator(".gchip.match")).toHaveCount(0);
  await chip(page, TAG).click();
  await expect(page.locator(".gchip.match")).toHaveCount(0);

  await chip(page, SECOND).click();
  const toggle = page.locator(".gchip.match");
  await expect(toggle).toHaveText("any");
  // ANY: everything carrying either tag, the tray suggestion included.
  await expect(row(page, bothTitle)).toBeVisible();
  await expect(row(page, secondOnlyTitle)).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: suggestedTitle })).toBeVisible();
  await expect(row(page, looseTitle)).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveText("all");
  // ALL: only the task carrying both.
  await expect(row(page, bothTitle)).toBeVisible();
  await expect(row(page, secondOnlyTitle)).toHaveCount(0);
  await expect(page.locator(".sg-name").filter({ hasText: suggestedTitle })).toHaveCount(0);

  // Unlighting one chip takes the toggle away again, leaving the other lit.
  await chip(page, SECOND).click();
  await expect(page.locator(".gchip.match")).toHaveCount(0);
  await expect(row(page, bothTitle)).toBeVisible();
  await allChip(page).click();
});

test("the board shares the chip bar and the same selection", async ({ page }) => {
  await openProject(page, "Board view");
  const card = (title: string) => page.locator(".bcard").filter({ has: page.locator(".bc-title", { hasText: title }) });
  await expect(card(looseTitle)).toBeVisible();
  await expect(card(bothTitle).locator(".gbadge")).toHaveText([TAG, SECOND]);
  await chip(page, TAG).click();
  await expect(card(bothTitle)).toBeVisible();
  await expect(card(suggestedTitle)).toBeVisible();
  await expect(card(looseTitle)).toHaveCount(0);
  // The list view picks the selection up unchanged. (The full-width board's
  // toggle is the .bseg tab, not the list column's icon button.)
  await page.getByRole("tab", { name: "List" }).click();
  await expect(chip(page, TAG)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, looseTitle)).toHaveCount(0);
  await allChip(page).click();
});

test("the edit dialog adds and removes tags, and mints a new one inline", async ({ page, request }) => {
  await openProject(page);
  await row(page, looseTitle).click();
  // The session header shows no badge for an untagged task.
  await expect(page.locator(".sess-head .gbadge")).toHaveCount(0);
  await page.getByTitle("Edit title & description before starting").click();
  const dialog = page.locator(".modal");
  const field = dialog.locator(".tag-field");
  const tick = (name: string) => field.locator(".dep-row").filter({ hasText: name }).locator("input");
  await tick(TAG).check();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const readTask = async (title: string) =>
    (await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks.find((t: { title: string }) => t.title === title);
  expect((await readTask(looseTitle)).tag_ids).toEqual([tagId]);
  // Badge in the header now, and the chip's denominator grew.
  await expect(page.locator(".sess-head .gbadge")).toHaveText([TAG]);
  await expect(chip(page, TAG).locator(".gc-frac")).toHaveText("0/3");

  // A new tag can be typed by name, picked at creation, and saved alongside
  // the one already on the task.
  const fresh = `Flaky tests ${uid()}`;
  await page.getByTitle("Edit title & description before starting").click();
  await field.getByRole("button", { name: /New tag/ }).click();
  await dialog.getByLabel("New tag name").fill(fresh);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".sess-head .gbadge")).toHaveText([TAG, fresh]);
  const tags = (await request.get(`/api/projects/${projectId}/tags`).then((r) => r.json())).tags;
  const made = tags.find((t: { name: string }) => t.name === fresh);
  expect(made).toBeTruthy();
  expect(made.counts.total).toBe(1);
  await expect(page.locator(".gchip .gc-name", { hasText: fresh })).toBeVisible();

  // Taking one off leaves the other alone.
  await page.getByTitle("Edit title & description before starting").click();
  await tick(TAG).uncheck();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".sess-head .gbadge")).toHaveText([fresh]);
  expect((await readTask(looseTitle)).tag_ids).toEqual([made.id]);

  // A duplicate name is refused with the reason, in the dialog.
  await page.getByTitle("Edit title & description before starting").click();
  await field.getByRole("button", { name: /New tag/ }).click();
  await dialog.getByLabel("New tag name").fill(TAG);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.locator(".err-note")).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).first().click();
});

test("tag routes: rename conflicts are 409, a cross-project tag is refused, delete keeps the other tags", async ({ request }) => {
  const other = await createProject(request, { name: `Other ${uid()}`, repoPath: makeFixtureRepo("tags-other") });
  const elsewhere = await (await request.post(`/api/projects/${other.id}/tags`, { data: { name: TAG } })).json();
  // Same name in another project is fine; renaming into a taken name here is not.
  const dup = await request.post(`/api/projects/${projectId}/tags`, { data: { name: TAG } });
  expect(dup.status()).toBe(409);
  const spare = await (await request.post(`/api/projects/${projectId}/tags`, { data: { name: `Spare ${uid()}` } })).json();
  const rename = await request.patch(`/api/tags/${spare.id}`, { data: { name: TAG } });
  expect(rename.status()).toBe(409);
  const bad = await request.patch(`/api/tags/${spare.id}`, { data: { color: "#000000" } });
  expect(bad.status()).toBe(400);
  // A task can't carry a tag from another project, even alongside a valid one.
  const t = await createTask(request, { projectId, title: `Stray ${uid()}` });
  const cross = await request.patch(`/api/tasks/${t.id}`, { data: { tag_ids: [spare.id, elsewhere.id] } });
  expect(cross.status()).toBe(400);
  expect((await getTask(request, t.id)).tag_ids).toEqual([]);
  const ok = await request.patch(`/api/tasks/${t.id}`, { data: { tag_ids: [spare.id, tagId] } });
  expect(ok.ok()).toBeTruthy();
  expect((await getTask(request, t.id)).tag_ids).toEqual([spare.id, tagId]);
  // Delete takes ONE label off, reports how many it touched, and leaves both
  // the task and its other tags alone.
  const del = await request.delete(`/api/tags/${spare.id}`);
  expect(del.ok()).toBeTruthy();
  expect((await del.json()).untagged).toBe(1);
  expect((await getTask(request, t.id)).tag_ids).toEqual([tagId]);
  expect((await request.get(`/api/tags/${spare.id}`)).status()).toBe(404);
});

// TagBadges caps what it draws at three, and the "+N" pill used to name the
// rest only in a `title` tooltip. A phone has no hover, so on a task carrying
// four or more tags the extra ones were unreachable. The pill is a button now
// and opens them in a popover; this runs at a phone viewport because that is
// the surface where the tooltip was no affordance at all.
test.describe("mobile: the +N pill", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  // A phone boots into the first project's task pane with no projects column
  // beside it, so step back out before picking the fixture (03-views.spec.ts).
  const openOnPhone = async (page: Page, view: "List view" | "Board view") => {
    await gotoApp(page);
    const back = page.getByRole("button", { name: "Back to projects" });
    await expect(back).toBeVisible();
    await back.click();
    await page.getByText(PROJECT).first().click();
    await page.getByTitle(view).click();
  };

  const texts = (loc: ReturnType<Page["locator"]>) => loc.allTextContents();

  test("tapping it names the cropped tags, and one of them filters", async ({ page }) => {
    await openOnPhone(page, "List view");
    const line = row(page, manyTitle).locator("xpath=..");
    // Three drawn, two behind the pill, and the pill is reachable by tap.
    await expect(line.locator(".gbadge:not(.more)")).toHaveCount(3);
    const more = line.getByTestId("tag-more");
    await expect(more).toHaveText("+2");
    await expect(more).toHaveAttribute("aria-expanded", "false");

    await more.tap();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const popped = page.getByTestId("tag-more-list").locator(".gbadge");
    await expect(popped).toHaveCount(2);
    // Between them the row and the popover name every tag, none twice.
    const seen = [...(await texts(line.locator(".gbadge:not(.more)"))), ...(await texts(popped))];
    expect(seen.sort()).toEqual([...MANY].sort());

    // A popped badge is the same way into the filter a drawn one is, and
    // choosing shuts the popover rather than leaving it over the list.
    const chosen = (await texts(popped))[0];
    await popped.first().tap();
    await expect(page.getByTestId("tag-more-list")).toHaveCount(0);
    await expect(chip(page, chosen)).toHaveAttribute("aria-selected", "true");
    await expect(row(page, manyTitle)).toBeVisible();
    await expect(row(page, looseTitle)).toHaveCount(0);
    await allChip(page).click();

    // Tapping the pill again puts it away: the only affordance is not one-way.
    await more.tap();
    await expect(page.getByTestId("tag-more-list")).toBeVisible();
    await more.tap();
    await expect(page.getByTestId("tag-more-list")).toHaveCount(0);
  });

  test("the board card's pill works the same, at the card's smaller badge size", async ({ page }) => {
    await openOnPhone(page, "Board view");
    const card = page.locator(".bcard").filter({ has: page.locator(".bc-title", { hasText: manyTitle }) });
    const more = card.getByTestId("tag-more");
    await expect(more).toHaveText("+2");
    await more.tap();
    await expect(page.getByTestId("tag-more-list").locator(".gbadge")).toHaveCount(2);
    // The popover is portalled to the body precisely so a card, a row or the
    // session breadcrumb can't clip it; check it is actually on screen.
    const box = (await page.getByTestId("tag-more-list").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  });
});

test("starring a tag in the Tags field makes it the one the row and the session lead with", async ({ page, request }) => {
  const readTask = async (title: string) =>
    (await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks.find((t: { title: string }) => t.title === title);

  await openProject(page);
  await row(page, bothTitle).click();
  // bothTitle was seeded with tagId first, so TAG leads SECOND.
  await expect(badges(page, bothTitle)).toHaveText([TAG, SECOND]);

  await page.getByTitle("Edit title & description before starting").click();
  const dialog = page.locator(".modal");
  const field = dialog.locator(".tag-field");
  const starFor = (name: string) => field.locator(".tagf-row").filter({ hasText: name }).locator(".tagf-star");
  await expect(starFor(TAG)).toHaveAttribute("aria-pressed", "true");
  await expect(starFor(SECOND)).toHaveAttribute("aria-pressed", "false");

  // Starring SECOND hoists it to the front of the field's own value, live,
  // before Save is even clicked.
  await starFor(SECOND).click();
  await expect(starFor(SECOND)).toHaveAttribute("aria-pressed", "true");
  await expect(starFor(TAG)).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "Save changes" }).click();

  // The row's badges and the persisted tag_ids both reflect the new order.
  await expect(badges(page, bothTitle)).toHaveText([SECOND, TAG]);
  expect((await readTask(bothTitle)).tag_ids).toEqual([secondTagId, tagId]);

  // The order survives a fresh render, not just the in-memory update.
  await openProject(page);
  await expect(badges(page, bothTitle)).toHaveText([SECOND, TAG]);
});
