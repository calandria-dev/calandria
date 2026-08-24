// Task groups, phase 1 (docs/superpowers/specs/2026-08-24-task-grouping-design.md):
// the chip bar over the list and board, the badge on rows/cards/tray/header,
// and the Group field in the edit dialog. Groups are seeded through the same
// REST routes the dialog uses; the agent tools that file grouped plans are a
// later phase and get their own spec.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Groups ${uid()}`;
let projectId: string;
let groupId: string;
const GROUP = "Auth migration";
const inGroupTitle = `Port login route ${uid()}`;
const suggestedTitle = `Remove legacy middleware ${uid()}`;
const looseTitle = `Unrelated chore ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("groups") });
  projectId = project.id;
  const g = await request.post(`/api/projects/${projectId}/groups`, { data: { name: GROUP, color: "#3E7CA8" } });
  expect(g.status()).toBe(201);
  groupId = (await g.json()).id;
  // Two members — one in the list, one still in the Suggested tray — and one
  // task outside the group.
  for (const [title, suggested] of [[inGroupTitle, false], [suggestedTitle, true]] as const) {
    const res = await request.post("/api/tasks", {
      data: { project_id: projectId, title, priority: "med", agent: "mock", group_id: groupId, ...(suggested ? { suggested: true } : {}) },
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).group_id).toBe(groupId);
  }
  await createTask(request, { projectId, title: looseTitle });
});

const openProject = async (page: Page, view: "List view" | "Board view" = "List view") => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle(view).click();
};

const chip = (page: Page) => page.locator(".gchip").filter({ has: page.locator(".gc-name", { hasText: GROUP }) });
const row = (page: Page, title: string) => page.locator(".ttitle").filter({ hasText: title });

test("the chip narrows the list and the tray, persists across a reload, and a badge selects it", async ({ page }) => {
  await openProject(page);
  // The bar shows the group with done/of over members still counted.
  await expect(chip(page)).toBeVisible();
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/2");
  // Filter off: everything is on screen.
  await expect(row(page, inGroupTitle)).toBeVisible();
  await expect(row(page, looseTitle)).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: suggestedTitle })).toBeVisible();
  // Members carry the badge; the loose task doesn't.
  await expect(row(page, inGroupTitle).locator("xpath=..").locator(".gbadge")).toHaveText(GROUP);
  await expect(row(page, looseTitle).locator("xpath=..").locator(".gbadge")).toHaveCount(0);

  await chip(page).click();
  await expect(chip(page)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, inGroupTitle)).toBeVisible();
  await expect(page.locator(".sg-name").filter({ hasText: suggestedTitle })).toBeVisible();
  await expect(row(page, looseTitle)).toHaveCount(0);

  // Remembered per project, like the collapsed Done section.
  await page.reload();
  await expect(chip(page)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, looseTitle)).toHaveCount(0);

  await page.locator(".gchip", { hasText: "All" }).click();
  await expect(row(page, looseTitle)).toBeVisible();

  // Clicking a member's badge selects its chip without opening the task.
  await row(page, inGroupTitle).locator("xpath=..").locator("button.gbadge").click();
  await expect(chip(page)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, looseTitle)).toHaveCount(0);
  await page.locator(".gchip", { hasText: "All" }).click();
});

test("the board shares the chip bar and the same selection", async ({ page }) => {
  await openProject(page, "Board view");
  const card = (title: string) => page.locator(".bcard").filter({ has: page.locator(".bc-title", { hasText: title }) });
  await expect(card(looseTitle)).toBeVisible();
  await expect(card(inGroupTitle).locator(".gbadge")).toHaveText(GROUP);
  await chip(page).click();
  await expect(card(inGroupTitle)).toBeVisible();
  await expect(card(suggestedTitle)).toBeVisible();
  await expect(card(looseTitle)).toHaveCount(0);
  // The list view picks the selection up unchanged. (The full-width board's
  // toggle is the .bseg tab, not the list column's icon button.)
  await page.getByRole("tab", { name: "List" }).click();
  await expect(chip(page)).toHaveAttribute("aria-selected", "true");
  await expect(row(page, looseTitle)).toHaveCount(0);
  await page.locator(".gchip", { hasText: "All" }).click();
});

test("the edit dialog assigns a group, and mints a new one inline", async ({ page, request }) => {
  await openProject(page);
  await row(page, looseTitle).click();
  // The session header shows no badge for an ungrouped task.
  await expect(page.locator(".sess-head .gbadge")).toHaveCount(0);
  await page.getByTitle("Edit title & description before starting").click();
  const dialog = page.locator(".modal");
  await dialog.locator(".group-field select").selectOption(groupId);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const loose = (await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks.find((t: { title: string }) => t.title === looseTitle);
  expect(loose.group_id).toBe(groupId);
  // Badge in the header now, and the chip's denominator grew.
  await expect(page.locator(".sess-head .gbadge")).toHaveText(GROUP);
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/3");

  // New group… by name, selected on creation, saved with the task.
  const fresh = `Mobile PWA ${uid()}`;
  await page.getByTitle("Edit title & description before starting").click();
  await dialog.locator(".group-field select").selectOption("__new__");
  await dialog.getByLabel("New group name").fill(fresh);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.locator(".group-field select")).not.toHaveValue("__new__");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".sess-head .gbadge")).toHaveText(fresh);
  const groups = (await request.get(`/api/projects/${projectId}/groups`).then((r) => r.json())).groups;
  const made = groups.find((g: { name: string }) => g.name === fresh);
  expect(made).toBeTruthy();
  expect(made.counts.total).toBe(1);
  // Both chips on the bar now.
  await expect(page.locator(".gchip .gc-name", { hasText: fresh })).toBeVisible();

  // A duplicate name is refused with the reason, in the dialog.
  await page.getByTitle("Edit title & description before starting").click();
  await dialog.locator(".group-field select").selectOption("__new__");
  await dialog.getByLabel("New group name").fill(GROUP);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.locator(".err-note")).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).first().click();
});

test("group routes: rename conflicts are 409, cross-project assignment is refused, delete ungroups", async ({ request }) => {
  const other = await createProject(request, { name: `Other ${uid()}`, repoPath: makeFixtureRepo("groups-other") });
  const g2 = await (await request.post(`/api/projects/${other.id}/groups`, { data: { name: GROUP } })).json();
  // Same name in another project is fine; renaming into a taken name here is not.
  const dup = await request.post(`/api/projects/${projectId}/groups`, { data: { name: GROUP } });
  expect(dup.status()).toBe(409);
  const spare = await (await request.post(`/api/projects/${projectId}/groups`, { data: { name: `Spare ${uid()}` } })).json();
  const rename = await request.patch(`/api/groups/${spare.id}`, { data: { name: GROUP } });
  expect(rename.status()).toBe(409);
  const bad = await request.patch(`/api/groups/${spare.id}`, { data: { color: "#000000" } });
  expect(bad.status()).toBe(400);
  // A task can't join a group from another project.
  const t = await createTask(request, { projectId, title: `Stray ${uid()}` });
  const cross = await request.patch(`/api/tasks/${t.id}`, { data: { group_id: g2.id } });
  expect(cross.status()).toBe(400);
  const ok = await request.patch(`/api/tasks/${t.id}`, { data: { group_id: spare.id } });
  expect(ok.ok()).toBeTruthy();
  expect((await ok.json()).group_id).toBe(spare.id);
  // Delete ungroups, reports how many, and leaves the task alone.
  const del = await request.delete(`/api/groups/${spare.id}`);
  expect(del.ok()).toBeTruthy();
  expect((await del.json()).ungrouped).toBe(1);
  expect((await getTask(request, t.id)).group_id).toBeNull();
  expect((await request.get(`/api/groups/${spare.id}`)).status()).toBe(404);
});
