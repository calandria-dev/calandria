import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";
import { INITIAL_OLLAMA_MODELS, OllamaStub, REFRESHED_OLLAMA_MODELS } from "./provider-stub";

const PROJECT = `Picker ${uid()}`;

async function createOllama(request: APIRequestContext, baseUrl: string, label: string, disabled: string[]) {
  const res = await request.post("/api/providers", {
    data: {
      type: "ollama", label, config: { base_url: baseUrl },
      model_policy: { mode: "deny", ids: disabled, known: INITIAL_OLLAMA_MODELS, unavailable: [] },
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).provider as { id: string };
}

test.describe.serial("model picker", () => {
  let stub: OllamaStub;
  let project: { id: string };
  let provider: { id: string };

  test.beforeAll(async ({ request }) => {
    await ensureOnboarded(request);
    const existing = await (await request.get("/api/providers")).json();
    for (const row of existing.providers as Array<{ id: string; label: string }>) {
      if (row.label.startsWith("Picker Ollama ") || row.label.startsWith("Picker backup ")) {
        await request.delete(`/api/providers/${row.id}`);
      }
    }
    project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("picker") });
    stub = new OllamaStub();
    await stub.start();
    provider = await createOllama(request, stub.baseUrl, `Picker Ollama ${uid()}`, [INITIAL_OLLAMA_MODELS[0]]);
    await createOllama(
      request,
      stub.baseUrl,
      `Picker backup ${uid()}`,
      [INITIAL_OLLAMA_MODELS[0], INITIAL_OLLAMA_MODELS[1]],
    );
    const patch = await request.patch(`/api/projects/${project.id}`, { data: { default_provider_id: provider.id } });
    expect(patch.ok()).toBeTruthy();
  });

  test.afterAll(async () => { await stub?.close(); });

  async function openProject(page: Page): Promise<void> {
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
  }

  test("drills through providers, persists a schedule choice, and shows Recent", async ({ page, request }) => {
    await openProject(page);
    await page.getByRole("button", { name: "Task", exact: true }).click();
    await expect(page.locator(".modal").getByText("New task", { exact: true })).toBeVisible();
    await expect(page.getByText(/Mock Agent|Mock environment/i).first()).toBeVisible();
    await page.locator(".model-field button").click();
    const picker = page.locator(".mpick").last();
    await expect(picker.getByPlaceholder("Filter models")).toBeVisible();
    await expect(picker).toContainText("Runs in Mock Agent");
    await expect(picker.getByText("All models", { exact: true })).toBeVisible();
    await expect(picker.getByText("Recent", { exact: true })).toHaveCount(0);

    const filter = picker.getByPlaceholder("Filter models");
    // The project list and live session panes scroll independently of this
    // modal. Their scroll events must not close an anchored picker.
    await page.locator(".col-projects > .scroll").evaluate((el) => el.dispatchEvent(new Event("scroll")));
    await expect(filter).toBeVisible();
    await filter.fill(INITIAL_OLLAMA_MODELS[0]);
    await expect(picker.getByText(/No models match/)).toBeVisible();
    await filter.fill("");
    const qwenFamily = picker.getByRole("option").filter({ hasText: /Qwen/i }).first();
    await expect(qwenFamily).toBeVisible();
    await qwenFamily.click();
    await picker.locator('.mpick-pane[aria-hidden="false"]').getByRole("option", { name: /Qwen2\.5 7B/i }).click();
    await expect(page.locator(".model-field button")).toContainText(/Qwen/i);
    await page.getByPlaceholder("e.g. Add rate-limiting to auth endpoints").fill("Picker task");
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByRole("button", { name: /Qwen.*via Picker Ollama/ })).toBeVisible();

    await page.getByRole("button", { name: "Project home" }).click();
    await page.getByRole("button", { name: "New schedule" }).click();
    await page.getByLabel("Name").fill("Picker schedule");
    await page.getByLabel("Prompt").fill("say hello");
    await page.getByLabel("Mon", { exact: true }).check();
    await page.getByLabel("Time").fill("08:30");
    const schedulePicker = page.locator(".mpick").last();
    await schedulePicker.getByRole("option").filter({ hasText: /Qwen/i }).first().click();
    await schedulePicker.locator('.mpick-pane[aria-hidden="false"]').getByRole("option", { name: /Qwen2\.5 7B/i }).click();
    await page.getByRole("button", { name: "Create schedule" }).click();
    const schedules = await (await request.get(`/api/projects/${project.id}/schedules`)).json();
    const saved = schedules.schedules.find((s: { name: string }) => s.name === "Picker schedule");
    expect(saved?.provider_id).toBe(provider.id);
    expect(saved?.model).toBe("qwen2.5:7b");

    await page.getByRole("button", { name: "Task", exact: true }).click();
    await page.locator(".model-field button").click();
    const recentPicker = page.locator(".mpick").last();
    await expect(recentPicker.getByText("Recent", { exact: true })).toBeVisible();
    await expect(recentPicker.getByRole("option").filter({ hasText: /Qwen.*Picker Ollama/i }).first()).toBeVisible();
  });

  test("refreshes a provider and exposes a newly added model in the picker", async ({ page, request }) => {
    const staleTree = await (await request.get("/api/models?agent=mock")).json();
    let releaseStaleResponse!: () => void;
    let markStaleRequestStarted!: () => void;
    let markStaleResponseSettled!: () => void;
    const staleResponseGate = new Promise<void>((resolve) => { releaseStaleResponse = resolve; });
    const staleRequestStarted = new Promise<void>((resolve) => { markStaleRequestStarted = resolve; });
    const staleResponseSettled = new Promise<void>((resolve) => { markStaleResponseSettled = resolve; });
    let holdNextTreeRequest = true;
    let staleRequestDidStart = false;
    const treeRoute = async (route: Route) => {
      if (!holdNextTreeRequest) {
        await route.continue();
        return;
      }
      holdNextTreeRequest = false;
      staleRequestDidStart = true;
      markStaleRequestStarted();
      await staleResponseGate;
      try {
        await route.fulfill({ json: staleTree });
      } finally {
        markStaleResponseSettled();
      }
    };
    await page.route("**/api/models?agent=mock", treeRoute);

    try {
      // Leave an old tree response in flight while Settings refreshes the
      // provider. It must not overwrite the replacement fetched afterward.
      await openProject(page);
      await page.getByRole("button", { name: "Task", exact: true }).click();
      await page.locator(".model-field button").click();
      await staleRequestStarted;
      await page.getByRole("button", { name: "Cancel" }).click();

      await stub.restart(REFRESHED_OLLAMA_MODELS);
      await page.route("**/api/providers/detect", async (route) => { await route.continue(); });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Models", exact: true }).click();
      await page.getByRole("button", { name: /Picker Ollama .* details/ }).click();
      await page.getByRole("tab", { name: "Models" }).click();
      await page.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByRole("switch", { name: "gemma3:4b" })).toBeChecked();
      const models = await (await request.get(`/api/providers/${provider.id}/models`)).json();
      expect(models.models.find((m: { id: string }) => m.id === "gemma3:4b")?.on).toBe(true);

      await page.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Back to workspace" }).click();
      await page.getByText(PROJECT, { exact: true }).first().click();
      await page.getByRole("button", { name: "Task", exact: true }).click();
      await page.locator(".model-field button").click();
      const refreshedPicker = page.locator(".mpick").last();
      await refreshedPicker.getByPlaceholder("Filter models").fill("gemma3:4b");
      await expect(refreshedPicker.getByRole("option").filter({ hasText: "gemma3:4b" }).first()).toBeVisible();
      releaseStaleResponse();
      await staleResponseSettled;
      await expect(refreshedPicker.getByRole("option").filter({ hasText: "gemma3:4b" }).first()).toBeVisible();
    } finally {
      releaseStaleResponse();
      if (staleRequestDidStart && !page.isClosed()) await staleResponseSettled;
      if (!page.isClosed()) await page.unroute("**/api/models?agent=mock", treeRoute);
    }
  });
});
