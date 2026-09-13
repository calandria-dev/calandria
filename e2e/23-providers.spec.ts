import { expect, test } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";
import { INITIAL_OLLAMA_MODELS, OllamaStub } from "./provider-stub";

const PROJECT = `Providers ${uid()}`;

test.describe.serial("model providers", () => {
  let stub: OllamaStub;
  let project: { id: string };

  test.beforeAll(async ({ request }) => {
    await ensureOnboarded(request);
    const existing = await (await request.get("/api/providers")).json();
    for (const provider of existing.providers as Array<{ id: string; label: string; type: string }>) {
      if (provider.type === "ollama" && ["Ollama", "Ollama test endpoint"].includes(provider.label)) {
        await request.delete(`/api/providers/${provider.id}`);
      }
    }
    project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("providers") });
    stub = new OllamaStub();
    await stub.start();
  });

  test.afterAll(async () => { await stub?.close(); });

  async function openModels(page: import("@playwright/test").Page): Promise<void> {
    await gotoApp(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  }

  test("detects, adds, edits, uses and removes an Ollama provider", async ({ page, request }) => {
    await page.route("**/api/providers/detect", async (route) => {
      await route.fulfill({ json: { servers: [{ type: "ollama", base_url: stub.baseUrl, model_count: INITIAL_OLLAMA_MODELS.length }] } });
    });
    await openModels(page);

    await expect(page.getByText(/Ollama is running at/)).toBeVisible();
    await page.getByRole("button", { name: "Add as provider" }).click();
    await expect(page.getByRole("heading", { name: /Ollama/ })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /Ollama details/ })).toBeVisible();

    // Remove the detected seed so the one-page add flow is covered independently.
    await page.getByRole("button", { name: /Ollama details/ }).click();
    await page.getByRole("tab", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Remove provider" }).click();
    await page.getByRole("button", { name: "Click again to remove" }).click();
    await expect(page.getByRole("button", { name: /Ollama details/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Add provider" }).click();
    await page.getByRole("radio", { name: "Ollama" }).click();
    const form = page.locator(".mv-form").first();
    await form.locator("input").nth(1).fill(stub.baseUrl);
    const add = page.locator(".modal").getByRole("button", { name: "Add provider", exact: true });
    await expect(add).toBeDisabled();
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText(/Reached in .*3 models listed/)).toBeVisible();
    await expect(add).toBeEnabled();
    await page.getByRole("switch", { name: INITIAL_OLLAMA_MODELS[0] }).click();
    await add.click();
    await expect(page.locator(".modal").getByText(/2 models on/)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    const row = page.getByRole("button", { name: /Ollama details/ });
    await expect(row).toContainText("2 models");

    const providerRows = await (await request.get("/api/providers")).json();
    const addedProvider = providerRows.providers.find((p: { id: string; label: string }) => p.label === "Ollama") as
      | { id: string; label: string }
      | undefined;
    expect(addedProvider).toBeTruthy();
    if (!addedProvider) throw new Error("new Ollama provider was not returned by GET /api/providers");

    await row.click();
    await expect(page.getByRole("tab", { name: "Connection" })).toBeVisible();
    const detailForm = page.locator(".mv-form").first();
    await detailForm.locator("input").first().fill("Ollama test endpoint");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /Ollama test endpoint details/ })).toBeVisible();

    // Set the project default through the project context editor.
    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await page.getByRole("button", { name: /E2E fixture project\. Context/ }).click();
    await page.getByText("Default model", { exact: true }).scrollIntoViewIfNeeded();
    const picker = page.locator(".mpick").last();
    await picker.getByRole("option", { name: /Qwen2\.5 7B/i }).last().click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => {
      const savedProject = await (await request.get(`/api/projects/${project.id}`)).json();
      return savedProject.default_provider_id;
    }).toBe(addedProvider.id);

    await openModels(page);
    await page.getByRole("button", { name: /Ollama test endpoint details/ }).click();
    await page.getByRole("tab", { name: "Remove" }).click();
    await expect(page.getByText(/Currently used by 1 project default/)).toBeVisible();
    await page.getByRole("button", { name: "Remove provider" }).click();
    await page.getByRole("button", { name: "Click again to remove" }).click();
    await expect(page.getByRole("button", { name: /Ollama test endpoint details/ })).toHaveCount(0);
    const fallback = await (await request.get(`/api/projects/${project.id}`)).json();
    expect(fallback.default_provider_id).toBeNull();

    await gotoApp(page);
    await page.getByText(PROJECT).first().click();
    await page.getByRole("button", { name: /E2E fixture project\. Context/ }).click();
    const fallbackPicker = page.locator(".mpick").last();
    await expect(fallbackPicker.getByRole("option").filter({ hasText: "App default" }).first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // Regression for the utility_agent default not re-resolving live: setAppDefault
  // used to write the setting and never re-fetch /api/agents, so the "Running on"
  // line and the model picker below it stayed pinned to the previous resolution
  // until a reload. useShell's setAppDefault now re-fetches whenever utility_agent
  // or default_agent changes, so this line must update in place.
  test("re-resolves the effective utility agent after a change, without a reload", async ({ page, request }) => {
    await gotoApp(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-nav .nav-item", { hasText: "Background jobs" }).click();
    const utilityField = page.locator(".field").filter({ has: page.getByText("Utility agent", { exact: true }) });
    const effective = utilityField.locator(".hlp").filter({ hasText: "Running on" });
    await expect(effective).toContainText("Running on Mock Agent");
    await expect(effective).not.toContainText(/fallback:/);

    await utilityField.getByRole("button", { name: /Claude Code/ }).click();
    await expect(effective).toContainText(/fallback: Claude Code isn.t connected/);

    // Reset so this global app default doesn't leak into later specs (workers: 1,
    // one shared instance for the whole suite).
    await request.patch("/api/settings", { data: { utility_agent: null } });
  });
});
