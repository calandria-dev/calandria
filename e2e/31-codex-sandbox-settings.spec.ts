import { expect, test } from "@playwright/test";
import { createProject, ensureOnboarded, gotoApp, makeFixtureRepo, uid } from "./helpers";

test.describe.serial("Codex sandbox settings", () => {
  const projectName = `Codex sandbox ${uid()}`;
  let project: { id: string };
  let task: { id: string };

  test.beforeAll(async ({ request }) => {
    await ensureOnboarded(request);
    project = await createProject(request, { name: projectName, repoPath: makeFixtureRepo("codex-sandbox") });
    const res = await request.post("/api/tasks", {
      data: { project_id: project.id, title: `Idle Codex ${uid()}`, description: "", priority: "med", agent: "codex" },
    });
    expect(res.ok()).toBeTruthy();
    task = await res.json();
  });

  test.afterAll(async ({ request }) => {
    await request.patch("/api/settings", { data: { "default_sandbox_mode:codex": null } });
  });

  test("persists the Codex Settings default and task override", async ({ page, request }) => {
    await gotoApp(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Run defaults", exact: true }).click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    const sandbox = page.locator(".field").filter({ hasText: "Default Codex sandbox" });
    await sandbox.getByRole("button", { name: "Workspace write", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/settings")).json())["default_sandbox_mode:codex"]).toBe("workspace-write");
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Run defaults", exact: true }).click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await expect(page.locator(".field").filter({ hasText: "Default Codex sandbox" }).getByRole("button", { name: "Workspace write", exact: true })).toHaveClass(/on/);

    await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
    await page.getByText(projectName, { exact: true }).first().click();
    await page.getByText(/Idle Codex/).first().click();
    await page.getByTitle("Reasoning level & permission mode for this task", { exact: true }).click();
    await page.getByText("Sandbox", { exact: true }).locator("..").getByText("Full access", { exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).sandbox_mode).toBe("danger-full-access");

    await page.reload();
    await page.getByText(projectName, { exact: true }).first().click();
    await page.getByText(/Idle Codex/).first().click();
    await page.getByTitle("Reasoning level & permission mode for this task", { exact: true }).click();
    const fullAccess = page.locator(".pop-item").filter({ hasText: "Full access" });
    await expect(fullAccess.locator(".pi-check")).toBeVisible();
    await page.locator(".pop-item").filter({ hasText: "Inherit default" }).click();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).sandbox_mode).toBeNull();
  });
});
