// Tags, the curating half (docs/superpowers/specs/2026-08-27-tags-design.md):
// the selection bar's bulk add/remove, the strip one lit chip expands into, the
// project landing's Tags card, and the palette's tag entries. The chip/badge/
// field gestures are in 17-tags.spec.ts; this file starts where a plan already
// exists and is about navigating and curating it.
//
// The store rules underneath (progress with withdrawn tasks, moveTasks carrying
// vs dropping a tag) are pinned by tests/tags.test.ts.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Strip ${uid()}`;
const TAG = "Auth migration";
const OTHER = "Chores";
const DESC = "Move every route onto AuthService.";
let projectId: string;
let tagId: string;
let otherTagId: string;

// Two tasks tagged up front (one of them a tray suggestion), two loose tasks the
// selection bar will tag by hand, and one that never joins. `outsider` carries
// the second tag from the start, so removing the first one can be seen to leave
// the rest of a task's set alone.
const memberTitle = `Add session table ${uid()}`;
const suggestedTitle = `Port signup route ${uid()}`;
const looseA = `Port login route ${uid()}`;
const looseB = `Remove legacy middleware ${uid()}`;
const outsider = `Unrelated chore ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  projectId = (await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("tag-strip") })).id;
  const t = await request.post(`/api/projects/${projectId}/tags`, { data: { name: TAG, color: "#3E7CA8" } });
  expect(t.status()).toBe(201);
  tagId = (await t.json()).id;
  const o = await request.post(`/api/projects/${projectId}/tags`, { data: { name: OTHER } });
  expect(o.status()).toBe(201);
  otherTagId = (await o.json()).id;
  // The description is what the strip shows; origin_task_id (its "Planned in …"
  // link) is only ever set by the agent that files a tag, which the unit tests
  // cover.
  const patched = await request.patch(`/api/tags/${tagId}`, { data: { description: DESC } });
  expect(patched.ok()).toBeTruthy();
  for (const [title, tags, suggested] of [
    [memberTitle, [tagId], false],
    [suggestedTitle, [tagId], true],
    [outsider, [otherTagId], false],
  ] as const) {
    const res = await request.post("/api/tasks", {
      data: { project_id: projectId, title, priority: "med", agent: "mock", tag_ids: tags, ...(suggested ? { suggested: true } : {}) },
    });
    expect(res.status()).toBe(201);
  }
  for (const title of [looseA, looseB]) await createTask(request, { projectId, title });
});

const openProject = async (page: Page) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();
};
const chip = (page: Page, name = TAG) => page.locator(".gchip").filter({ has: page.locator(".gc-name", { hasText: name }) });
const row = (page: Page, title: string) => page.locator(".ttitle").filter({ hasText: title });
const badges = (page: Page, title: string) => row(page, title).locator("xpath=..").locator(".gbadge");
const pickbox = (page: Page, title: string) => page.locator(".task-row").filter({ hasText: title }).locator(".pickbox input");
const tasksOf = async (request: import("@playwright/test").APIRequestContext) =>
  (await request.get(`/api/projects/${projectId}`).then((r) => r.json())).tasks as { id: string; title: string; tag_ids: string[] }[];

test("the selection bar adds a tag to a whole batch, and removes one without touching the rest", async ({ page, request }) => {
  await openProject(page);
  await expect(row(page, looseA)).toBeVisible();
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/2");

  // Tick two loose rows and hand them to the bulk tag modal.
  await pickbox(page, looseA).click();
  await pickbox(page, looseB).click();
  await expect(page.locator(".pick-bar .pb-count")).toHaveText("2 selected");
  await page.getByRole("button", { name: "Tags…" }).click();
  const dialog = page.locator(".modal");
  await expect(dialog.locator(".dep-row").filter({ hasText: looseA })).toBeVisible();
  await dialog.locator(".tag-field .dep-row").filter({ hasText: TAG }).locator("input").check();
  await dialog.getByRole("button", { name: "Add to 2" }).click();

  // One write: both rows carry the badge and the chip's denominator grew by two.
  await expect(badges(page, looseA)).toHaveText([TAG]);
  await expect(badges(page, looseB)).toHaveText([TAG]);
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/4");
  const tagged = (await tasksOf(request)).filter((t) => t.tag_ids.includes(tagId)).map((t) => t.title);
  expect(tagged.sort()).toEqual([memberTitle, looseA, looseB, suggestedTitle].sort());

  // Now the other direction, over a selection that doesn't all share the tag:
  // Remove takes it off the rows that had it and leaves `outsider`'s own tag be.
  // The bar keeps its selection through a tag write (unlike a move, where the
  // rows leave the project), so start from a clear one rather than toggling.
  await page.locator(".pick-bar").getByRole("button", { name: "Clear" }).click();
  await pickbox(page, looseB).click();
  await pickbox(page, outsider).click();
  await expect(page.locator(".pick-bar .pb-count")).toHaveText("2 selected");
  await page.getByRole("button", { name: "Tags…" }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.locator(".tag-field .dep-row").filter({ hasText: TAG }).locator("input").check();
  // Only one of the two rows actually carries it, and the button says so.
  await dialog.getByRole("button", { name: "Remove from 1" }).click();
  await expect(badges(page, looseB)).toHaveCount(0);
  await expect(badges(page, outsider)).toHaveText([OTHER]);
  await expect(chip(page).locator(".gc-frac")).toHaveText("0/3");
});

test("the strip expands one lit chip into the tag's detail, and stays shut for two", async ({ page }) => {
  await openProject(page);
  const strip = page.locator(".gstrip");
  // Nothing lit: no strip. It is the chip's detail, not a permanent band.
  await expect(strip).toHaveCount(0);

  await chip(page).click();
  await expect(strip).toBeVisible();
  await expect(strip.locator(".gs-name")).toHaveText(TAG);
  await expect(strip.locator(".gs-desc").first()).toHaveText(DESC);
  await expect(strip.locator(".gs-frac")).toHaveText("0 done");
  // Every task carrying the tag, tray suggestions included, numbered in
  // dependency order.
  const members = strip.locator(".gs-member");
  await expect(members).toHaveCount(3);
  await expect(members.filter({ hasText: suggestedTitle }).locator(".gs-tag")).toHaveText("suggested");

  // A second lit chip shuts it: the list now shows two plans, and a band of
  // prose about one of them would misread.
  await chip(page, OTHER).click();
  await expect(strip).toHaveCount(0);
  await chip(page, OTHER).click();
  await expect(strip).toBeVisible();

  // Clicking a task in the strip selects it.
  await members.filter({ hasText: memberTitle }).click();
  await expect(page.locator(".sess-head")).toContainText(memberTitle);
});

test("Refresh tag runs a detached job whose report outlives leaving the tag", async ({ page, request }) => {
  await openProject(page);
  await chip(page).click();
  const strip = page.locator(".gstrip");

  await strip.getByRole("button", { name: "Refresh tag" }).click();
  // The mock driver returns a plan that rewrites the description and rewords
  // the first member, so both halves of "apply" are on screen.
  await expect(strip.locator(".gs-job-sum")).toContainText("description rewritten", { timeout: 30000 });
  await expect(strip.locator(".gs-job-sum")).toContainText("1 task reworded");
  await expect(strip.locator(".gs-desc").first()).toHaveText(`Mock tag refresh for ${PROJECT}.`);

  // The job's state lives on the tag ROW, not in the component: shutting the
  // strip (a second lit chip) and reopening it must not lose the report. This
  // is the same mechanism that lets the run survive a reload or a project
  // switch while it is still going.
  await chip(page, OTHER).click();
  await expect(strip).toHaveCount(0);
  await chip(page, OTHER).click();
  await expect(strip.locator(".gs-job-sum")).toContainText("description rewritten");

  // The reword is a revertable agent edit, which is why the job is allowed to
  // apply rather than propose.
  const member = (await tasksOf(request)).find((t) => t.title === memberTitle)!;
  const edits = await (await request.get(`/api/tasks/${member.id}/agent-edits`)).json();
  expect(edits.edits).toHaveLength(1);
  expect(edits.edits[0].changes[0]).toMatchObject({ field: "description", after: "Mock refreshed brief." });

  // Dismiss clears the report for good — and never the edits it reported on.
  await strip.getByRole("button", { name: "Dismiss" }).click();
  await expect(strip.locator(".gs-job-sum")).toHaveCount(0);
  await chip(page, OTHER).click();
  await chip(page, OTHER).click();
  await expect(strip.locator(".gs-job-sum")).toHaveCount(0);
  const stillEdited = await (await request.get(`/api/tasks/${member.id}`)).json();
  expect(stillEdited.description).toBe("Mock refreshed brief.");
});

test("the strip renames the tag and deletes it without touching its tasks", async ({ page, request }) => {
  await openProject(page);
  await chip(page).click();
  const strip = page.locator(".gstrip");
  const renamed = `Auth migration v2 ${uid()}`;

  await strip.getByRole("button", { name: "Edit" }).click();
  await strip.getByLabel("Tag name").fill(renamed);
  await strip.getByLabel("Tag description").fill("Now with signup.");
  await strip.getByRole("button", { name: "Save" }).click();
  await expect(strip.locator(".gs-name")).toHaveText(renamed);
  await expect(page.locator(".gchip .gc-name", { hasText: renamed })).toBeVisible();

  // Delete is two-step and the confirmation names what survives.
  await strip.getByRole("button", { name: "Delete tag" }).click();
  await strip.getByRole("button", { name: "Delete: 3 tasks stay" }).click();
  // The chip bar falls back to All, and every task that carried it is still
  // here — including `outsider`, which keeps the OTHER tag it also carries.
  await expect(page.locator(".gstrip")).toHaveCount(0);
  await expect(page.locator(".gchip .gc-name", { hasText: renamed })).toHaveCount(0);
  for (const title of [memberTitle, looseA, looseB]) await expect(row(page, title)).toBeVisible();
  await expect(badges(page, outsider)).toHaveText([OTHER]);
  const after = await tasksOf(request);
  expect(after.every((t) => !t.tag_ids.includes(tagId))).toBe(true);
  expect(after.find((t) => t.title === outsider)!.tag_ids).toEqual([otherTagId]);
});

test("the landing card leads back to the chip, and the palette's feed carries tags", async ({ page, request }) => {
  // A fresh tag, since the test above deleted the shared one.
  const name = `Mobile PWA ${uid()}`;
  const made = await request.post(`/api/projects/${projectId}/tags`, { data: { name, description: "Installable + offline." } });
  expect(made.status()).toBe(201);
  const id = (await made.json()).id;
  const target = (await tasksOf(request)).find((t) => t.title === looseA)!;
  const applied = await request.post("/api/tasks/tags", { data: { ids: [target.id], add: [id] } });
  expect(applied.ok()).toBeTruthy();

  await openProject(page);
  // Project home: the Tags card sits between the recap and Runbooks.
  await page.getByTitle(/Project home/).click();
  const card = page.locator(".tags-card");
  await expect(card.locator("h3")).toHaveText("Tags");
  const cardRow = card.locator(".tag-row").filter({ hasText: name });
  await expect(cardRow).toContainText("Installable + offline.");
  await expect(cardRow.locator(".tag-frac")).toHaveText("0/1");
  await cardRow.click();
  // Clicking it lights that tag alone on the task list.
  await expect(page.locator(".gchip.on .gc-name")).toHaveText(name);
  await expect(row(page, looseA)).toBeVisible();
  await expect(row(page, memberTitle)).toHaveCount(0);

  // The ⌘K rows themselves are not driven here, for the reason 12-runbooks
  // states: the palette lives behind `omniSearch`, which DEFAULT_FEATURES ships
  // off, so this suite's server doesn't render it. What IS assertable is the
  // feed it reads — tags as jump targets with their counts, and each session
  // row carrying the badges it should show.
  const feed = await request.get("/api/tasks").then((r) => r.json());
  const palTag = (feed.tags as { id: string; name: string; project_name: string; counts: { total: number; done: number } }[]).find((t) => t.id === id);
  expect(palTag).toBeTruthy();
  expect(palTag!.project_name).toBe(PROJECT);
  expect(palTag!.counts).toMatchObject({ total: 1, done: 0 });
  const rows = feed.tasks as { title: string; tags: { name: string }[] }[];
  expect(rows.find((t) => t.title === looseA)!.tags.map((x) => x.name)).toEqual([name]);
  expect(rows.find((t) => t.title === looseB)!.tags).toEqual([]);
});
