// Per-task effort in the New task and Edit task dialogs. The e2e mock supplies
// onboarding only; the browser marks Codex and Gemini connected so their real
// capability descriptors drive the controls without launching a real turn.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Task effort ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("task-effort") });
  projectId = project.id;
  const update = await request.patch(`/api/projects/${projectId}`, { data: { default_agent: "codex" } });
  expect(update.ok()).toBeTruthy();
});

async function withConnectedAgents(page: Page): Promise<void> {
  await page.route("**/api/agents", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { agents: Array<Record<string, unknown>> };
    for (const id of ["codex", "gemini"]) {
      const agent = body.agents.find((candidate) => candidate.id === id)!;
      agent.connected = true;
      agent.authenticated = true;
      agent.status = "connected";
    }
    await route.fulfill({ response, json: body });
  });
}

async function openProject(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
}

test("new Codex task persists its selected effort and starts inherited", async ({ page, request }, testInfo) => {
  await withConnectedAgents(page);
  await openProject(page);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  const dialog = page.locator(".modal");
  const effort = dialog.getByRole("group", { name: "Effort" });
  await expect(effort).toBeVisible();
  await expect(effort.getByRole("button", { name: "Inherit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await effort.scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: testInfo.outputPath("desktop-effort.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(effort).toBeVisible();
  await effort.scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: testInfo.outputPath("mobile-effort.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await effort.getByRole("button", { name: "high", exact: true }).click();
  const title = `Create effort ${uid()}`;
  await dialog.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill(title);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect.poll(async () => {
    const project = await request.get(`/api/projects/${projectId}`);
    const body = await project.json() as { tasks: Array<{ title: string; reasoning: string | null }> };
    return body.tasks.find((task) => task.title === title)?.reasoning;
  }).toBe("think_hard");
});

test("edit task clears effort on agent switch, hides it for Gemini, and saves inherit", async ({ page, request }) => {
  const task = await createTask(request, { projectId, title: `Edit effort ${uid()}` });
  const seed = await request.patch(`/api/tasks/${task.id}`, { data: { agent: "codex", reasoning: "think_hard" } });
  expect(seed.ok()).toBeTruthy();
  await withConnectedAgents(page);

  await openProject(page);
  await page.locator(".ttitle").filter({ hasText: task.title }).click();
  await page.getByTitle("Edit title & description before starting").click();
  const dialog = page.locator(".modal");
  const effort = dialog.getByRole("group", { name: "Effort" });
  await expect(effort.getByRole("button", { name: "high", exact: true })).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Antigravity", exact: true }).click();
  await expect(dialog.getByRole("group", { name: "Effort" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(effort.getByRole("button", { name: "Inherit", exact: true })).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await getTask(request, task.id)).reasoning).toBeNull();

  // A real save after selecting an effort persists it. Reopening and clearing
  // it verifies null remains the task-level instruction to inherit the app
  // default.
  await page.getByTitle("Edit title & description before starting").click();
  const reopened = page.locator(".modal").getByRole("group", { name: "Effort" });
  await reopened.getByRole("button", { name: "high", exact: true }).click();
  await page.locator(".modal").getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await getTask(request, task.id)).reasoning).toBe("think_hard");

  await page.getByTitle("Edit title & description before starting").click();
  const clearing = page.locator(".modal").getByRole("group", { name: "Effort" });
  await expect(clearing.getByRole("button", { name: "high", exact: true })).toHaveAttribute("aria-pressed", "true");
  await clearing.getByRole("button", { name: "Inherit", exact: true }).click();
  await page.locator(".modal").getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await getTask(request, task.id)).reasoning).toBeNull();
});
