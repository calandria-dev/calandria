import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ensureOnboarded, gotoApp } from "./helpers";

/**
 * The update indicator, end to end against the releases fixture
 * (e2e/releases-server.mjs, wired in through CALANDRIA_UPDATE_FEED_URL in
 * e2e/env.ts). Nothing here reaches github.com.
 *
 * The check's own ticker waits a minute for its first ask, which is longer
 * than the suite's patience, so every test here triggers it with
 * POST /api/updates/check and asserts on the answer.
 */

type UpdateState = {
  current: { version: string; installMethod: "container" | "source" | "bundled" };
  latest: { version: string } | null;
  available: boolean;
  releases: { version: string }[];
  enabled: boolean;
};

async function check(request: APIRequestContext): Promise<UpdateState> {
  const res = await request.post("/api/updates/check");
  expect(res.status()).toBe(200);
  return res.json();
}

/** Reset the two settings this spec writes, so the rest of the suite is unchanged. */
async function resetUpdateSettings(request: APIRequestContext) {
  await request.patch("/api/settings", { data: { update_check: null, update_dismissed: null } });
}

/**
 * The app-settings nav item. Exact, since 22-settings-drift leaves a project
 * called "Settings drift" in the shared instance and this spec runs after it.
 */
function settingsButton(page: Page) {
  return page.getByRole("button", { name: "Settings", exact: true });
}

async function openPill(page: Page) {
  await page.locator(".update-pill").click();
  await expect(page.locator(".update-menu")).toBeVisible();
}

let state: UpdateState;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  await resetUpdateSettings(request);
  state = await check(request);
});

test.afterAll(async ({ request }) => {
  await resetUpdateSettings(request);
});

test("the fixture feed puts a newer release in front of the running one", async () => {
  expect(state.enabled).toBe(true);
  expect(state.available).toBe(true);
  expect(state.latest).not.toBeNull();
  // Three stable releases, with the draft and the pre-release dropped.
  expect(state.releases).toHaveLength(3);
});

test("the titlebar pill opens the release notes and the steps for this install", async ({ page }) => {
  await gotoApp(page);
  const pill = page.locator(".update-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("aria-label", `Calandria ${state.latest!.version} is available`);

  await openPill(page);
  await expect(page.locator(".um-title")).toHaveText(`Calandria ${state.latest!.version}`);

  // A container and a source checkout each get commands; nothing else does.
  // Which one this is depends on where the suite runs, so read it off the
  // state the server reported.
  if (state.current.installMethod === "bundled") {
    await expect(page.locator(".update-menu").getByText("How to update")).toBeHidden();
  } else {
    await page.locator(".update-menu").getByText("How to update").click();
    const commands = page.locator(".um-cmds pre");
    await expect(commands).toContainText("npm run backup");
    await expect(commands).toContainText(
      state.current.installMethod === "container" ? "docker compose pull" : "git pull",
    );
  }

  // The notes are the release-please section with the installer table cut off.
  await expect(page.locator(".um-note")).toHaveCount(3);
  await expect(page.locator(".um-notes")).toContainText("a titlebar pill");
  await expect(page.locator(".um-notes")).not.toContainText("Installer");

  await expect(page.getByRole("link", { name: "Release page" })).toHaveAttribute("target", "_blank");
});

test("skipping a version hides the pill, and Settings brings it back", async ({ page, request }) => {
  await gotoApp(page);
  await openPill(page);
  await page.getByRole("button", { name: "Skip this version" }).click();
  await expect(page.locator(".update-pill")).toBeHidden();

  await settingsButton(page).click();
  await expect(page.getByText(`${state.latest!.version} is skipped.`)).toBeVisible();

  await page.getByRole("button", { name: "Show again" }).click();
  await expect(page.getByText(`${state.latest!.version} is skipped.`)).toBeHidden();
  await expect(page.locator(".update-pill")).toBeVisible();

  await resetUpdateSettings(request);
});

test("the switch in Settings stops the check and hides the pill", async ({ page, request }) => {
  await gotoApp(page);
  await settingsButton(page).click();
  await page.getByRole("switch", { name: "Check for updates" }).click();

  const off = await check(request);
  expect(off.enabled).toBe(false);

  await gotoApp(page);
  await expect(page.locator(".update-pill")).toBeHidden();

  await resetUpdateSettings(request);
});

test.describe("on a narrow window", () => {
  // Under the app's own 760px breakpoint (app/Shell.tsx MOBILE_QUERY).
  test.use({ viewport: { width: 390, height: 844 } });

  test("an icon with a dot replaces the pill and opens the same popover", async ({ page }) => {
    await gotoApp(page);
    const icon = page.locator(".tb-icon .upd-dot");
    await expect(icon).toBeVisible();
    await expect(page.locator(".update-pill")).toHaveCount(0);

    await page.locator(".tb-icon", { has: page.locator(".upd-dot") }).click();
    await expect(page.locator(".um-title")).toHaveText(`Calandria ${state.latest!.version}`);
  });
});
