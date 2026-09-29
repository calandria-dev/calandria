// Single-key task navigation (app/shell/taskKeys.ts): j/k walk the rendered
// cards, enter opens, t opens the terminal, d the diff, n a new task.
//
// The unit test covers which keydowns count; this proves the shell's wiring
// against the real DOM order in both the list and the board.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

const PROJECT = `Keys ${uid()}`;
let projectId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("keys") });
  projectId = project.id;
  for (const t of ["Key one", "Key two", "Key three"]) await createTask(request, { projectId: project.id, title: t });
  // The DIFF/CONTEXT rail only exists once a task has a session.
  const started = await createTask(request, { projectId: project.id, title: "Key started" });
  await sendMessage(request, started.id);
  await waitForIdle(request, started.id);
});

// Landing on a project can put focus in the composer, where the keys do
// nothing. Blurring returns focus to the page, as a click elsewhere would.
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const cardIds = (page: Page, scope: string) =>
  page.locator(`${scope} [data-task-id]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.taskId!));

test("j/k select through the list, d, t and n open their surfaces", async ({ page }) => {
  await gotoApp(page, `?project=${projectId}`);
  await page.getByTitle("List view").click();
  await expect(page.locator(".col-tasks .task-row")).toHaveCount(4);
  const ids = await cardIds(page, ".col-tasks");
  const selected = page.locator(".col-tasks .task.sel");

  // k clamps at the top, whatever the landing auto-selected.
  await blur(page);
  for (let i = 0; i < 4; i++) await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-task-id", ids[0]);
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-task-id", ids[1]);
  await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-task-id", ids[0]);
  // A modifier makes it someone else's shortcut.
  await page.keyboard.press("Alt+j");
  await expect(selected).toHaveAttribute("data-task-id", ids[0]);

  await page.locator(".col-tasks .task-row").filter({ hasText: "Key started" }).click();
  await page.locator(".rail-tab", { hasText: "CONTEXT" }).click();
  await blur(page);
  await page.keyboard.press("d");
  await expect(page.locator(".rail-tab.on")).toHaveText("DIFF");

  await page.keyboard.press("t");
  await expect(page.locator(".term-drawer").first()).not.toHaveClass(/collapsed/);

  await blur(page);
  await page.keyboard.press("n");
  await expect(page.locator(".modal .m-title", { hasText: "New task" })).toBeVisible();
  // Typing in the dialog must not move the selection underneath it.
  await page.keyboard.press("j");
  await expect(selected).toContainText("Key started");
});

test("on the board, j focuses a card without opening it and enter opens it", async ({ page }) => {
  await gotoApp(page, `?project=${projectId}`);
  await page.getByTitle("Board view").click();
  await expect(page.locator(".bcard")).toHaveCount(4);
  const ids = await cardIds(page, "body");

  await blur(page);
  for (let i = 0; i < 4; i++) await page.keyboard.press("k");
  await expect(page.locator(`.bcard[data-task-id="${ids[0]}"]`)).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator(`.bcard[data-task-id="${ids[1]}"]`)).toBeFocused();
  await expect(page.locator(".bp-hint")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".bp-hint")).toBeVisible();
});
