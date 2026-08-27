// Tags (docs/superpowers/specs/2026-08-27-tags-design.md): the chip bar over the
// list and board, the badges on rows/cards/tray/header, the any/all toggle two
// lit chips get, and the Tags field in the edit dialog. Tags are seeded through
// the same REST routes the dialog uses; the agent tools that file tagged plans
// have their own coverage in tests/agentTools.test.ts.

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
  // One task in BOTH tags (the whole point of the conversion), one tray
  // suggestion in the first, one in the second only, and one untagged.
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

  // New tag… by name, picked on creation, saved alongside the one already on.
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

  // Taking one off leaves the other alone — the difference from the group era.
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
