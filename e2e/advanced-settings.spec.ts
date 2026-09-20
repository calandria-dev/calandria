import { expect, test } from "@playwright/test";
import { ensureOnboarded, gotoApp, uid } from "./helpers";
import { E2E_BASE_URL } from "./env";

// The mutation routes require same-origin Fetch Metadata (lib/advanced-env/browserAuth.ts);
// the bare `request` fixture sends neither header by default, so API-level
// setup/teardown in this file adds them to look like a same-origin browser fetch.
const SAME_ORIGIN_HEADERS = { Origin: E2E_BASE_URL, "Sec-Fetch-Site": "same-origin" };

const APP_NAME = `E2E_APP_${uid().replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}`;
const AGENT_NAME = `E2E_AGENT_${uid().replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}`;
const SECRET_NAME = `E2E_SECRET_${uid().replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}`;
const SECRET_VALUE = `sk-synthetic-${uid()}`;

type EnvListResponse = {
  rows: { id: string; scope: string; name: string | null; value: string | null; secret: boolean }[];
  revision: number;
};

test.describe.serial("advanced settings", () => {
  test.beforeAll(async ({ request }) => {
    await ensureOnboarded(request);
  });

  test.afterAll(async ({ request }) => {
    // Best-effort cleanup: this instance is shared across the whole suite
    // (workers: 1), so leftover synthetic rows must not linger for later specs.
    // Every delete bumps the store revision, so each one sends the revision
    // the previous delete returned; a single stale revision would make every
    // delete after the first a 409 and leave the rows behind.
    const list = (await (await request.get("/api/settings/environment")).json()) as EnvListResponse;
    let revision = list.revision;
    for (const row of list.rows) {
      if (row.name?.startsWith(APP_NAME) || row.name?.startsWith(AGENT_NAME) || row.secret) {
        const res = await request.delete(`/api/settings/environment/${row.id}`, { headers: SAME_ORIGIN_HEADERS, data: { expectedRevision: revision } }).catch(() => null);
        if (res?.ok()) revision = ((await res.json()) as { revision: number }).revision;
      }
    }
  });

  async function openAdvanced(page: import("@playwright/test").Page): Promise<void> {
    await gotoApp(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-nav .nav-item", { hasText: "Advanced" }).click();
    await expect(page.getByRole("heading", { name: "App" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agent sessions" })).toBeVisible();
  }

  test("adds, edits and deletes a custom app variable", async ({ page }) => {
    await openAdvanced(page);

    await page.getByTestId("env-add-app").click();
    await page.getByTestId("env-catalog-custom").click();
    await page.getByTestId("env-name-input").fill(APP_NAME);
    await page.getByTestId("env-value-input").fill("first-value");
    await page.getByTestId("env-save").click();

    const row = page.getByTestId(new RegExp("^env-row-")).filter({ hasText: APP_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText("first-value");
    await expect(row).toContainText("Restart required");

    // Edit: change the value.
    await row.getByRole("button", { name: /^Edit/ }).click();
    const valueInput = page.getByTestId("env-value-input");
    await expect(valueInput).toHaveValue("first-value");
    await valueInput.fill("second-value");
    await page.getByTestId("env-save").click();
    await expect(row).toContainText("second-value");
    await expect(row).not.toContainText("first-value");

    // Delete: first click arms confirmation, second click removes the row.
    await row.getByRole("button", { name: /^Delete/ }).click();
    await row.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByText(APP_NAME)).toHaveCount(0);
  });

  test("adds a custom agent variable and shows scope-specific timing", async ({ page }) => {
    await openAdvanced(page);

    await page.getByTestId("env-add-agent").click();
    await page.getByTestId("env-catalog-custom").click();
    await page.getByTestId("env-name-input").fill(AGENT_NAME);
    await page.getByTestId("env-value-input").fill("hello world");
    await page.getByTestId("env-save").click();

    const row = page.getByTestId(new RegExp("^env-row-")).filter({ hasText: AGENT_NAME });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Applies on next turn");
  });

  test("searches the catalog and hides an already-added entry", async ({ page }) => {
    await openAdvanced(page);
    await page.getByTestId("env-add-app").click();

    await page.getByTestId("env-catalog-search").fill("permission card waits");
    const item = page.getByTestId("env-catalog-item-CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS");
    await expect(item).toBeVisible();
    await item.click();

    // The form step locks the catalog name and shows its description.
    await expect(page.locator(".modal")).toContainText("CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS");
    await page.getByTestId("env-value-input").fill("60000");
    await page.getByTestId("env-save").click();

    const row = page.getByTestId(new RegExp("^env-row-")).filter({ hasText: "CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS" });
    await expect(row).toBeVisible();

    // Adding again must not offer the same descriptor a second time.
    await page.getByTestId("env-add-app").click();
    await expect(page.getByTestId("env-catalog-item-CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel" }).click();

    await row.getByRole("button", { name: /^Delete/ }).click();
    await row.getByRole("button", { name: "Confirm delete" }).click();
  });

  test("hides a secret row's name and value in the DOM and in fetched list JSON", async ({ page, request }) => {
    await openAdvanced(page);

    await page.getByTestId("env-add-agent").click();
    await page.getByTestId("env-catalog-custom").click();
    await page.getByTestId("env-name-input").fill(SECRET_NAME);
    await page.getByTestId("env-secret-checkbox").check();
    await page.getByTestId("env-value-input").fill(SECRET_VALUE);
    await page.getByTestId("env-save").click();

    // The row never shows the real name or value, only an opaque label.
    await expect(page.getByText(SECRET_NAME)).toHaveCount(0);
    await expect(page.getByText(SECRET_VALUE)).toHaveCount(0);
    const secretRow = page.locator(".adv-row").filter({ hasText: "Secret variable ·" }).first();
    await expect(secretRow).toBeVisible();
    await expect(secretRow).toContainText("Hidden");

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain(SECRET_NAME);
    expect(bodyText).not.toContain(SECRET_VALUE);

    const list = (await (await request.get("/api/settings/environment")).json()) as EnvListResponse;
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(SECRET_NAME);
    expect(raw).not.toContain(SECRET_VALUE);
    const secretRowData = list.rows.find((r) => r.secret && r.scope === "agent");
    expect(secretRowData?.name).toBeNull();
    expect(secretRowData?.value).toBeNull();

    // Editing offers Keep vs Replace instead of showing the old value.
    await secretRow.getByRole("button", { name: /^Edit/ }).click();
    await expect(page.getByRole("button", { name: "Keep stored value" })).toBeVisible();
    await expect(page.getByTestId("env-value-input")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("recovers from a stale revision on save", async ({ page, request }) => {
    await openAdvanced(page);

    await page.getByTestId("env-add-app").click();
    await page.getByTestId("env-catalog-custom").click();
    await page.getByTestId("env-name-input").fill(`${APP_NAME}_CONFLICT`);
    await page.getByTestId("env-value-input").fill("original");
    await page.getByTestId("env-save").click();

    const row = page.getByTestId(new RegExp("^env-row-")).filter({ hasText: `${APP_NAME}_CONFLICT` });
    await row.getByRole("button", { name: /^Edit/ }).click();
    const valueInput = page.getByTestId("env-value-input");
    await valueInput.fill("edited-in-dialog");

    // Bump the store's revision from outside the open dialog.
    const before = (await (await request.get("/api/settings/environment")).json()) as EnvListResponse;
    const bumpRes = await request.post("/api/settings/environment", {
      headers: SAME_ORIGIN_HEADERS,
      data: { scope: "app", name: `${APP_NAME}_BUMP`, value: "x", secret: false, expectedRevision: before.revision },
    });
    expect(bumpRes.ok()).toBe(true);

    await page.getByTestId("env-save").click();
    await expect(page.getByText(/changed elsewhere|refreshed/)).toBeVisible();
    // The draft survives the conflict; the user only has to press Save again.
    await expect(valueInput).toHaveValue("edited-in-dialog");
    await page.getByTestId("env-save").click();
    await expect(row).toContainText("edited-in-dialog");

    const after = (await (await request.get("/api/settings/environment")).json()) as EnvListResponse;
    const bump = after.rows.find((r) => r.name === `${APP_NAME}_BUMP`);
    if (bump) await request.delete(`/api/settings/environment/${bump.id}`, { headers: SAME_ORIGIN_HEADERS, data: { expectedRevision: after.revision } });
    await row.getByRole("button", { name: /^Delete/ }).click();
    await row.getByRole("button", { name: "Confirm delete" }).click();
  });

  test.describe("mobile width", () => {
    test.use({ viewport: { width: 390, height: 800 } });

    test("Advanced is reachable and stays within the phone rail", async ({ page }) => {
      await gotoApp(page);
      await expect(page.locator(".mtabbar")).toBeVisible();
      const backToProjects = page.getByRole("button", { name: "Back to projects" });
      if (await backToProjects.isVisible()) await backToProjects.click();
      await page.getByTitle("App settings").click();
      await page.locator(".settings-nav .nav-item", { hasText: "Advanced" }).click();
      await expect(page.getByRole("heading", { name: "App" })).toBeVisible();

      await page.getByTestId("env-add-app").click();
      await page.getByTestId("env-catalog-custom").click();
      await expect(page.getByTestId("env-name-input")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();

      const box = await page.locator(".settings-body").boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(390);
    });
  });
});
