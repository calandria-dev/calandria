// Task groups, phase 3 (docs/superpowers/specs/2026-08-24-task-grouping-design.md):
// the selection bar's bulk assign, the strip a selected chip expands into, the
// project landing's Groups card, and the palette's group entries. Phase 1's
// chip/badge/field gestures are in 17-groups.spec.ts; this file starts where a
// plan already exists and is about navigating and curating it.
//
// The store rules underneath (progress with withdrawn members, moveTasks
// clearing vs carrying the group) are pinned by tests/groups.test.ts.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Strip ${uid()}`;
const GROUP = "Auth migration";
const DESC = "Move every route onto AuthService.";
let projectId: string;
let groupId: string;

// Two members filed with the group (one of them a tray suggestion), two loose
// tasks the selection bar will group by hand, and one task that never joins.
const memberTitle = `Add session table ${uid()}`;
const suggestedTitle = `Port signup route ${uid()}`;
const looseA = `Port login route ${uid()}`;
const looseB = `Remove legacy middleware ${uid()}`;
const outsider = `Unrelated chore ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  projectId = (await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("group-strip") })).id;
  const g = await request.post(`/api/projects/${projectId}/groups`, { data: { name: GROUP, color: "#3E7CA8" } });
  expect(g.status()).toBe(201);
  groupId = (await g.json()).id;
  // The description is what the strip shows; origin_task_id (its "Planned in …"
  // link) is only ever set by the agent that files a group, which is phase 2.
  const patched = await request.patch(`/api/groups/${groupId}`, { data: { description: DESC } });
  expect(patched.ok()).toBeTruthy();
  for (const [title, suggested] of [[memberTitle, false], [suggestedTitle, true]] as const) {
    const res = await request.post("/api/tasks", {
      data: { project_id: projectId, title, priority: "med", agent: "mock", group_id: groupId, ...(suggested ? { suggested: true } : {}) },
    });
    expect(res.status()).toBe(201);
  }
  for (const title of [looseA, looseB, outsider]) await createTask(request, { projectId, title });
});

const openProject = async (page: Page) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();
};
const chip = (page: Page) => page.locator(".gchip").filter({ has: page.locator(".gc-name", { hasText: GROUP }) });
const row = (page: Page, title: string) => page.locator(".ttitle").filter({ hasText: title });
const pickbox = (page: Page, title: string) => page.locator(".task-row").filter({ hasText: title }).locator(".pickbox input");

test("the selection bar puts a whole batch in one group", async ({ page, request }) => {
  await openProject(page);
  await expect(row(page, looseA)).toBeVisible();
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/2");

  // Tick two loose rows and hand them to the group combobox.
  await pickbox(page, looseA).click();
  await pickbox(page, looseB).click();
  await expect(page.locator(".pick-bar .pb-count")).toHaveText("2 selected");
  await page.getByRole("button", { name: "Group…" }).click();
  const dialog = page.locator(".modal");
  await expect(dialog.locator(".dep-row")).toHaveCount(2);
  await dialog.locator(".group-field select").selectOption(groupId);
  await dialog.getByRole("button", { name: `Add 2 to ${GROUP}` }).click();

  // One write: both rows carry the badge and the chip's denominator grew by two.
  await expect(row(page, looseA).locator("xpath=..").locator(".gbadge")).toHaveText(GROUP);
  await expect(row(page, looseB).locator("xpath=..").locator(".gbadge")).toHaveText(GROUP);
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/4");
  const tasks = (await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks as { title: string; group_id: string | null }[];
  expect(tasks.filter((t) => t.group_id === groupId).map((t) => t.title).sort()).toEqual([memberTitle, looseA, looseB, suggestedTitle].sort());
  expect(tasks.find((t) => t.title === outsider)!.group_id).toBeNull();
});

test("the strip expands the selected chip into the group's detail", async ({ page }) => {
  await openProject(page);
  const strip = page.locator(".gstrip");
  // Nothing selected: no strip. It is the chip's detail, not a permanent band.
  await expect(strip).toHaveCount(0);

  await chip(page).click();
  await expect(strip).toBeVisible();
  await expect(strip.locator(".gs-name")).toHaveText(GROUP);
  await expect(strip.locator(".gs-desc").first()).toHaveText(DESC);
  await expect(strip.locator(".gs-frac")).toHaveText("0 done");
  // Every member, tray suggestions included, numbered in dependency order.
  const members = strip.locator(".gs-member");
  await expect(members).toHaveCount(4);
  await expect(members.filter({ hasText: suggestedTitle }).locator(".gs-tag")).toHaveText("suggested");
  // Clicking a member selects that task.
  await members.filter({ hasText: memberTitle }).click();
  await expect(page.locator(".sess-head")).toContainText(memberTitle);
});

test("the strip renames the group and deletes it without touching its tasks", async ({ page, request }) => {
  await openProject(page);
  await chip(page).click();
  const strip = page.locator(".gstrip");
  const renamed = `Auth migration v2 ${uid()}`;

  await strip.getByRole("button", { name: "Edit" }).click();
  await strip.getByLabel("Group name").fill(renamed);
  await strip.getByLabel("Group description").fill("Now with signup.");
  await strip.getByRole("button", { name: "Save" }).click();
  await expect(strip.locator(".gs-name")).toHaveText(renamed);
  await expect(page.locator(".gchip .gc-name", { hasText: renamed })).toBeVisible();

  // Delete is two-step and the confirmation names what survives.
  await strip.getByRole("button", { name: "Delete group" }).click();
  await strip.getByRole("button", { name: "Delete — 4 tasks stay" }).click();
  // The chip bar falls back to All, and every former member is still here.
  await expect(page.locator(".gstrip")).toHaveCount(0);
  await expect(page.locator(".gchip .gc-name", { hasText: renamed })).toHaveCount(0);
  for (const title of [memberTitle, looseA, looseB]) await expect(row(page, title)).toBeVisible();
  const after = (await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks as { group_id: string | null }[];
  expect(after.every((t) => t.group_id === null)).toBe(true);
});

test("the landing card leads back to the chip, and the palette's feed carries groups", async ({ page, request }) => {
  // A fresh group, since the test above deleted the shared one.
  const name = `Mobile PWA ${uid()}`;
  const made = await request.post(`/api/projects/${projectId}/groups`, { data: { name, description: "Installable + offline." } });
  expect(made.status()).toBe(201);
  const id = (await made.json()).id;
  const applied = await request.post("/api/tasks/group", { data: { ids: [(await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks.find((t: { title: string }) => t.title === looseA).id], group_id: id } });
  expect(applied.ok()).toBeTruthy();

  await openProject(page);
  // Project home: the Groups card sits between the recap and Runbooks.
  await page.getByTitle(/Project home/).click();
  const card = page.locator(".grp-card");
  await expect(card.locator("h3")).toHaveText("Groups");
  const cardRow = card.locator(".grp-row").filter({ hasText: name });
  await expect(cardRow).toContainText("Installable + offline.");
  await expect(cardRow.locator(".grp-frac")).toHaveText("0/1");
  await cardRow.click();
  // Clicking it narrows the list to that group.
  await expect(page.locator(".gchip.on .gc-name")).toHaveText(name);
  await expect(row(page, looseA)).toBeVisible();
  await expect(row(page, outsider)).toHaveCount(0);

  // The ⌘K rows themselves are not driven here, for the reason 12-runbooks
  // states: the palette lives behind `omniSearch`, which DEFAULT_FEATURES ships
  // off, so this suite's server doesn't render it. What IS assertable is the
  // feed it reads — groups as jump targets with their counts, and each session
  // row carrying the badge it should show.
  const feed = await request.get("/api/tasks").then((r) => r.json());
  const palGroup = (feed.groups as { id: string; name: string; project_name: string; counts: { total: number; done: number } }[]).find((g) => g.id === id);
  expect(palGroup).toBeTruthy();
  expect(palGroup!.project_name).toBe(PROJECT);
  expect(palGroup!.counts).toMatchObject({ total: 1, done: 0 });
  const palTask = (feed.tasks as { title: string; group_name: string | null }[]).find((t) => t.title === looseA);
  expect(palTask!.group_name).toBe(name);
  expect((feed.tasks as { title: string; group_name: string | null }[]).find((t) => t.title === outsider)!.group_name).toBeNull();
});
