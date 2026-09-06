// The composer's "/" menu, in the real UI against the mock agent's fixed
// command set (MOCK_COMMANDS in lib/agents/mock/driver.ts). Covers that the
// menu shows what the driver reports, that the filtering policy holds at the
// UI boundary, and that the keyboard path works for a long command list.

import { expect, test } from "@playwright/test";
import {
  createProject,
  createTask,
  ensureOnboarded,
  gotoApp,
  makeFixtureRepo,
  sendMessage,
  uid,
  waitForIdle,
} from "./helpers";

const PROJECT = `Slash ${uid()}`;
const TASK = `Slash menu ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("slash") });
  projectId = project.id;
  // The composer is disabled (and asks for no commands) until the session
  // exists, so run one turn to settle the task into a repliable state.
  const task = await createTask(request, { projectId, title: TASK });
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);
});

// Open the task's session and return its composer textarea.
async function composer(page: import("@playwright/test").Page) {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(TASK).first().click();
  const box = page.getByPlaceholder(/Reply to/);
  await expect(box).toBeVisible({ timeout: 20_000 });
  return box;
}

test("typing / lists the agent's own commands, not just /clear", async ({ page }) => {
  const box = await composer(page);
  await box.fill("/");

  const menu = page.locator(".slash");
  await expect(menu).toBeVisible();
  // Calandria's own command and the driver's both appear.
  await expect(menu.getByText("/clear", { exact: true })).toBeVisible();
  await expect(menu.getByText("/mock-echo", { exact: true })).toBeVisible();
  await expect(menu.getByText("/mock-status", { exact: true })).toBeVisible();
  await expect(menu.getByText("/mock-plugin:mock-deploy", { exact: true })).toBeVisible();
  // The argument hint rides along so the user knows the command takes one.
  await expect(menu.getByText("<text>", { exact: true })).toBeVisible();
});

test("the agent's own /clear and internal commands are filtered out", async ({ page }) => {
  const box = await composer(page);
  await box.fill("/");
  const menu = page.locator(".slash");
  await expect(menu).toBeVisible();
  // Exactly one /clear row: Calandria's, not the agent's duplicate.
  await expect(menu.getByText("/clear", { exact: true })).toHaveCount(1);
  await expect(menu.getByText("/__mock-internal", { exact: true })).toHaveCount(0);
});

test("filtering matches aliases and completes with the keyboard", async ({ page }) => {
  const box = await composer(page);
  // "mock-deploy" is only an alias of mock-plugin:mock-deploy; matching on it
  // keeps a namespaced command findable.
  await box.fill("/mock-deploy");
  const menu = page.locator(".slash");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".slash-item")).toHaveCount(1);

  // Enter completes the highlighted row into the box (canonical name, trailing
  // space for arguments) instead of sending.
  await box.press("Enter");
  await expect(box).toHaveValue("/mock-plugin:mock-deploy ");
  await expect(menu).toBeHidden();
});

test("arrow keys move the highlight and Tab commits it", async ({ page }) => {
  const box = await composer(page);
  await box.fill("/mock-");
  const items = page.locator(".slash .slash-item");
  await expect(items.first()).toHaveClass(/act/);

  await box.press("ArrowDown");
  await expect(items.nth(1)).toHaveClass(/act/);
  await box.press("Tab");
  // Second row of the /mock- matches, completed into the box.
  await expect(box).toHaveValue(/^\/mock-\S+ $/);
});

test("a fully typed command still sends as a message", async ({ page }) => {
  const box = await composer(page);
  // /mock-status takes no arguments and is typed in full, so Enter sends it
  // instead of re-completing, the same behavior /clear has.
  await box.fill("/mock-status");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  // It leaves as an ordinary user message: a slash command reaches the agent
  // by having the CLI expand it on the far side.
  await expect(page.locator(".msg.user", { hasText: "/mock-status" })).toBeVisible({ timeout: 20_000 });
});

// Geometry, here because this file already has a repliable composer on screen.
// Pins that an empty composer's height matches its typed height, since
// autosize's scrollHeight measurement in Chromium counts the placeholder text.
test("the empty composer is one line tall and doesn't snap on the first keystroke", async ({ page }) => {
  const box = await composer(page);
  const height = async () => (await box.boundingBox())!.height;

  const empty = await height();
  await box.fill("h");
  const typed = await height();
  expect(empty).toBe(typed);

  // Growth still works: a message long enough to wrap makes the box taller, and
  // clearing it returns to the same one-line height.
  await box.fill("wrap ".repeat(60));
  expect(await height()).toBeGreaterThan(typed);
  await box.fill("");
  expect(await height()).toBe(empty);
});
