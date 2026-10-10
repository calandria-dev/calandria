// Agent-authored runbook changes stay visible and need a revision-bound human
// confirmation before dispatch. Both updates use the same real internal route
// as the stdio bridge; the page exercises the built UI and public run route.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

const PROJECT = `Runbook review ${uid()}`;
let projectId = "";
let callerId = "";

async function createRunbook(request: APIRequestContext, name: string, prompt: string) {
  const response = await request.post(`/api/projects/${projectId}/runbooks`, {
    data: { name, description: "A saved review recipe.", prompt },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

async function editRunbookAsAgent(request: APIRequestContext, runbookId: string, fields: { prompt: string; permission_mode?: string }) {
  return request.post("/api/internal/agent-tools/update-runbook", {
    data: { taskId: callerId, runbook: runbookId, ...fields },
  });
}

async function openProjectHome(page: Page) {
  const project = page.locator("button.proj").filter({ hasText: PROJECT });
  await project.first().click();
  await expect(page.locator("button.proj.sel").filter({ hasText: PROJECT })).toHaveCount(1);
  await page.getByRole("button", { name: "Project home" }).click();
  await expect(page.getByRole("heading", { name: "Runbooks" })).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("runbook-agent-review") });
  projectId = project.id;
  const caller = await createTask(request, { projectId, title: `Runbook editor ${uid()}` });
  callerId = caller.id;
});

test("agent edits show a runbook diff and can be reverted", async ({ page, request }, testInfo) => {
  const runbook = await createRunbook(request, `Review diff ${uid()}`, "Original review prompt.");
  await gotoApp(page);
  await openProjectHome(page);
  const row = page.locator(".rb-row").filter({ hasText: "Review diff" });
  await expect(row).toBeVisible();

  const update = await editRunbookAsAgent(request, runbook.id, { prompt: "Agent-written review prompt.", permission_mode: "plan" });
  expect(update.status()).toBe(200);
  await expect(row.getByRole("button", { name: /Changed by agent/ })).toBeVisible({ timeout: 15_000 });

  await row.getByRole("button", { name: /Changed by agent/ }).click();
  const modal = page.locator(".modal");
  await expect(modal.locator(".m-title")).toHaveText("Changes by agent");
  const edit = modal.locator(".ae-edit").first();
  const prompt = edit.locator(".ae-row").filter({ has: page.locator(".ae-field", { hasText: "Prompt" }) });
  await expect(prompt.locator(".ae-before")).toHaveText("Original review prompt.");
  await expect(prompt.locator(".ae-after")).toHaveText("Agent-written review prompt.");
  const mode = edit.locator(".ae-row").filter({ has: page.locator(".ae-field", { hasText: "Permission mode" }) });
  await expect(mode.locator(".ae-after")).toHaveText("plan");

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(modal).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("runbook-diff-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  // The shell switches to its phone pane at this width and remounts the
  // project surface, so reopen the leaf modal after the responsive transition.
  await expect(row.getByRole("button", { name: /Changed by agent/ })).toBeVisible();
  await row.getByRole("button", { name: /Changed by agent/ }).click();
  await expect(modal).toBeVisible();
  const mobileModal = await modal.boundingBox();
  expect(mobileModal).toBeTruthy();
  expect(mobileModal!.x).toBeGreaterThanOrEqual(0);
  expect(mobileModal!.x + mobileModal!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("runbook-diff-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(row.getByRole("button", { name: /Changed by agent/ })).toBeVisible();
  await row.getByRole("button", { name: /Changed by agent/ }).click();
  await expect(modal).toBeVisible();

  await edit.getByRole("button", { name: "Revert" }).click();
  await expect(edit.locator(".ae-reverted-note")).toBeVisible();
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(row.getByRole("button", { name: /Changed by agent/ })).toHaveCount(0);

  const current = await request.get(`/api/runbooks/${runbook.id}`);
  expect((await current.json()).runbook.prompt).toBe("Original review prompt.");
});

test("run confirmation resets when the recipe changes and submits the current revision", async ({ page, request }) => {
  const runbook = await createRunbook(request, `Confirm run ${uid()}`, "First agent prompt.");
  const firstEdit = await editRunbookAsAgent(request, runbook.id, { prompt: "First agent prompt.", permission_mode: "plan" });
  expect(firstEdit.status()).toBe(200);

  await gotoApp(page);
  await openProjectHome(page);
  const row = page.locator(".rb-row").filter({ hasText: "Confirm run" });
  await row.getByRole("button", { name: "Run", exact: true }).click();
  const sheet = page.locator(".modal");
  const consent = sheet.getByRole("checkbox", { name: /I reviewed this agent-edited runbook/ });
  await expect(consent).not.toBeChecked();
  await expect(sheet.getByRole("button", { name: "Run", exact: true })).toBeDisabled();

  await consent.check();
  await expect(sheet.getByRole("button", { name: "Run", exact: true })).toBeEnabled();

  // Change the recipe after consent. The live runbooks event refreshes the
  // open sheet, and the checkbox must be cleared for the new recipe revision.
  const changed = await editRunbookAsAgent(request, runbook.id, { prompt: "Newer agent prompt." });
  expect(changed.status()).toBe(200);
  await expect(sheet.locator(".rb-preview")).toHaveText("Newer agent prompt.", { timeout: 15_000 });
  await expect(consent).not.toBeChecked();

  const listed = await request.get(`/api/projects/${projectId}/runbooks`);
  const latest = (await listed.json()).runbooks.find((item: { id: string }) => item.id === runbook.id);
  expect(latest).toBeTruthy();

  // The stale token is refused at the real route. The successful UI request
  // below must carry the revision the user actually reviewed.
  const stale = await request.post(`/api/runbooks/${runbook.id}/run`, {
    data: { start: false, confirmed_recipe_revision: latest.recipe_revision - 1 },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).requires_confirmation).toBe(true);

  await consent.check();
  await sheet.getByLabel("Start session immediately").uncheck();
  const runRequest = page.waitForRequest((candidate) =>
    candidate.url().includes(`/api/runbooks/${runbook.id}/run`) && candidate.method() === "POST"
  );
  await sheet.getByRole("button", { name: "Run", exact: true }).click();
  const sent = await runRequest;
  expect(sent.postDataJSON()).toMatchObject({ start: false, confirmed_recipe_revision: latest.recipe_revision });

  await expect(sheet).toHaveCount(0);
  const refreshed = await request.get(`/api/runbooks/${runbook.id}`);
  expect((await refreshed.json()).runbook.reviewed_agent_edit_revision).toBe(latest.agent_edit_revision);
});
