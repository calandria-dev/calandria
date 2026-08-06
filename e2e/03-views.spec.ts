// Task layout views: the list ⇄ board (kanban) toggle, status columns, and
// status-driven placement. Tasks are seeded via the API (creation through the
// UI is covered by 02-core-flow); this spec is about how they render.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Views ${uid()}`;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("views") });
  const a = await createTask(request, { projectId: project.id, title: "Alpha task" });
  const b = await createTask(request, { projectId: project.id, title: "Beta task" });
  await createTask(request, { projectId: project.id, title: "Gamma task" });
  // Distinct statuses so the board has populated columns.
  await request.patch(`/api/tasks/${a.id}`, { data: { status: "in_progress" } });
  await request.patch(`/api/tasks/${b.id}`, { data: { status: "done" } });
});

// A task's title renders in several places at once (list row, board card,
// session header) — scope to the list row title (.ttitle) / board card title
// to stay out of Playwright strict-mode violations.
const listRow = (page: import("@playwright/test").Page, title: string) =>
  page.locator(".ttitle").filter({ hasText: title });

test("list view shows every task grouped by status", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();

  await expect(listRow(page, "Alpha task")).toBeVisible();
  await expect(listRow(page, "Beta task")).toBeVisible();
  await expect(listRow(page, "Gamma task")).toBeVisible();
});

test("board view shows kanban columns with cards in the right places", async ({ page }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("Board view").click();

  // Columns render (`.bcol.k-<key>` per TaskBoard.tsx), cards in the column
  // matching their status.
  await expect(page.locator(".bcol.k-not_started")).toBeVisible();
  await expect(page.locator(".bcol.k-in_progress")).toBeVisible();
  await expect(page.locator(".bcol.k-done")).toBeVisible();
  await expect(page.locator(".bcol.k-in_progress").getByText("Alpha task")).toBeVisible();
  await expect(page.locator(".bcol.k-done").getByText("Beta task")).toBeVisible();
  await expect(page.locator(".bcol.k-not_started").getByText("Gamma task")).toBeVisible();

  // A status change moves the card between columns.
  await page.request.patch(`/api/tasks/${await idOf(page, "Gamma task")}`, { data: { status: "done" } });
  await page.reload();
  await page.getByText(PROJECT).first().click();
  await expect(page.locator(".bcol.k-done").getByText("Gamma task")).toBeVisible();

  // And the toggle goes back to list view — in board layout the switch is the
  // board workspace's own "List"/"Board" segmented control, not the task
  // column's icon toggle (that column is replaced by the full-width board).
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await expect(page.locator(".bcol.k-done")).toBeHidden();
  await expect(listRow(page, "Alpha task")).toBeVisible();
});

async function idOf(page: import("@playwright/test").Page, title: string): Promise<string> {
  const projects = await (await page.request.get("/api/projects")).json();
  const proj = projects.find((p: { name: string }) => p.name === PROJECT);
  const detail = await (await page.request.get(`/api/projects/${proj.id}`)).json();
  return detail.tasks.find((t: { title: string }) => t.title === title).id;
}
