// First-run onboarding, driven through the UI against the untouched fresh
// instance. This file must run first; see playwright.config.ts. The wizard's
// two steps run against the mock agent: "Connect Mock Agent account" resolves
// instantly, since the mock's startLogin succeeds without a browser hop, and
// Verify runs a real one-shot turn through the driver seam.

import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("fresh instance shows the setup wizard and completes it with the mock agent", async ({ page }) => {
  await page.goto("/");

  // The wizard blocks the app on a fresh DB.
  await expect(page.getByText("Let's get you set up")).toBeVisible();
  await expect(page.getByText("Connect a coding agent")).toBeVisible();

  // Step 1: pick the mock agent tab and connect. The mock's login completes
  // immediately, then the card auto-verifies and reports the signed-in account.
  await page.getByRole("button", { name: /Mock Agent/ }).click();
  await page.getByRole("button", { name: "Connect Mock Agent account" }).click();
  await expect(page.getByText("e2e@example.com").first()).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: verify runs a one-shot test turn and reports success.
  await expect(page.getByText("Verify the connection")).toBeVisible();
  await expect(page.getByText("The test turn completed")).toBeVisible();

  await page.getByRole("button", { name: "Start the tutorial" }).click();

  // Wizard gone, main UI up, with the seeded Welcome tutorial project.
  await expect(page.getByText("Let's get you set up")).toBeHidden();
  await expect(page.getByText("Welcome").first()).toBeVisible();
});

test("onboarding is complete server-side and the mock agent is connected", async ({ request }) => {
  const onb = await (await request.get("/api/onboarding")).json();
  expect(onb.complete).toBe(true);

  const agents = await (await request.get("/api/agents")).json();
  const mock = agents.agents.find((a: { id: string }) => a.id === "mock");
  expect(mock?.connected).toBe(true);
  expect(mock?.authenticated).toBe(true);
  // With Claude never connected, finishing adopted the mock as the app default.
  expect(agents.default).toBe("mock");
});

test("reload lands on the app, not the wizard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Welcome").first()).toBeVisible();
  await expect(page.getByText("Let's get you set up")).toBeHidden();
});
