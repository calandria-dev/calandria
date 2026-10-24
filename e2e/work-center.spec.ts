// The Work Center (design release work-center-design-release/1): the two-count
// pill, the desktop popover, the phone Work tab, inline actions, snooze,
// destination anchoring with Back, and the loading / stale / error states. The
// mock agent parks real turns on question and permission cards, and the
// numbers are cross-checked against GET /api/work-center, the one projection
// every surface renders.
//
// WC_SHOTS=<dir> writes one screenshot per viewport and state for design review.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, sendMessage, uid } from "./helpers";

const PROJECT = `WorkCenter ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("work-center") });
  projectId = project.id;
});

const shot = async (page: Page, name: string) => {
  if (process.env.WC_SHOTS) await page.screenshot({ path: `${process.env.WC_SHOTS}/${name}.png` });
};

async function snapshot(request: APIRequestContext) {
  const res = await request.get("/api/work-center");
  expect(res.ok()).toBe(true);
  return res.json();
}

async function parkOn(request: APIRequestContext, title: string, description: string) {
  const task = await createTask(request, { projectId, title, description });
  await sendMessage(request, task.id);
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 1 && t.awaiting_input === 1;
    }, { timeout: 20_000, message: `task ${task.id} never parked` })
    .toBe(true);
  return task;
}

const pill = (page: Page) => page.getByRole("button", { name: /^Work Center:/ });
const popover = (page: Page) => page.getByRole("dialog", { name: "Work Center" });
const rowOf = (page: Page, title: string) => page.locator("[data-wc-row]").filter({ hasText: title });

test("the pill shows both counts and the popover lists a parked question once", async ({ page, request }) => {
  const task = await parkOn(request, "Pill question", "e2e:ask=Target|Where should this go?|Staging,Production");
  await gotoApp(page);
  await expect(pill(page)).toBeVisible();
  const snap = await snapshot(request);
  await expect(pill(page)).toHaveAttribute("aria-label", new RegExp(`\\d+\\+? working, ${snap.summary.visibleNeedsYouTaskCount.value} need you`));

  await pill(page).click();
  await expect(popover(page)).toBeVisible();
  await shot(page, "desktop-popover");
  const row = rowOf(page, "Pill question");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: /^Question:/ })).toBeVisible();
  // Needs-you wins: the parked task is not also listed under Working.
  await expect(row).toHaveAttribute("data-wc-group", "need");
  void task;

  // Esc closes the popover and focus returns to the pill.
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
});

test("Enter on the pill focuses the first Needs-you row", async ({ page, request }) => {
  await parkOn(request, "Keyboard question", "e2e:ask=Pick|Which one?|A,B");
  await gotoApp(page);
  await pill(page).focus();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeVisible();
  await expect(page.locator("[data-wc-row][data-wc-group='need']").first()).toBeFocused();
  // Down moves, S opens the snooze menu on its first entry, Esc closes only the menu.
  await page.keyboard.press("s");
  await expect(page.getByRole("menu", { name: "Snooze task" })).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Snooze task" })).toHaveCount(0);
  await expect(popover(page)).toBeVisible();
});

test("a chip opens the exact card and Back restores the popover on the same row", async ({ page, request }) => {
  const task = await parkOn(request, "Anchor question", "e2e:ask=Mode|Which mode?|Fast,Safe");
  await gotoApp(page);
  await pill(page).click();
  const row = rowOf(page, "Anchor question");
  await row.getByRole("button", { name: /^Question:/ }).click();
  await expect(popover(page)).toHaveCount(0);
  const snap = await snapshot(request);
  const item = snap.tasks.find((r: { taskId: string }) => r.taskId === task.id).attention[0];
  const card = page.locator(`[data-message-id="${item.destination.messageId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();

  await page.goBack();
  await expect(popover(page)).toBeVisible();
  await expect(rowOf(page, "Anchor question")).toBeFocused();
});

test("a permission request is allowed once inline and the turn resumes", async ({ page, request }) => {
  const task = await parkOn(request, "Inline permission", "e2e:permission=npm run lint");
  const snap = await snapshot(request);
  const item = snap.tasks.find((r: { taskId: string }) => r.taskId === task.id).attention[0];
  test.skip(item.inlineDecision !== "allow_once_or_deny", "the mock agent does not offer an inline decision");

  await gotoApp(page);
  await pill(page).click();
  const row = rowOf(page, "Inline permission");
  await row.hover();
  await row.getByRole("button", { name: "Allow once" }).click();
  await expect(row.locator(".wc-out.ok")).toContainText("Allowed once");
  await expect.poll(async () => (await getTask(request, task.id)).awaiting_input).toBe(0);
});

test("Snooze hides the task from the list and from every count", async ({ page, request }) => {
  await parkOn(request, "Snooze me", "e2e:ask=Snooze|Which?|One,Two");
  await gotoApp(page);
  const before = (await snapshot(request)).summary.visibleNeedsYouTaskCount.value as number;
  await pill(page).click();
  const row = rowOf(page, "Snooze me");
  await row.hover();
  await row.getByRole("button", { name: "Snooze" }).click();
  const menu = page.getByRole("menu", { name: "Snooze task" });
  await expect(menu.getByRole("menuitem")).toHaveText([/1 hour/, /Until tomorrow/, /Until Monday/]);
  await shot(page, "desktop-snooze-menu");
  await menu.getByRole("menuitem", { name: /1 hour/ }).click();
  await expect(rowOf(page, "Snooze me")).toHaveCount(0);
  await expect.poll(async () => (await snapshot(request)).summary.visibleNeedsYouTaskCount.value).toBe(before - 1);
  await expect(pill(page)).toHaveAttribute("aria-label", new RegExp(`${before - 1} need you`));
  await expect(page.locator(".wc-note.err")).toHaveCount(0);
});

test("loading shows the dash, and a failed fetch never shows a trustworthy zero", async ({ page }) => {
  await page.route("**/api/work-center**", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "x", message: "boom", retryable: true } }) });
  });
  await gotoApp(page);
  await expect(pill(page)).toHaveAttribute("aria-label", /\u2014 working, \u2014 need you/);
  await pill(page).click();
  await expect(popover(page).locator(".wc-sk").first()).toBeVisible();
  await shot(page, "desktop-loading");
  await expect(popover(page).locator(".wc-note.err")).toContainText("Couldn't refresh");
  await expect(pill(page)).toHaveAttribute("aria-label", /\u2014 working, \u2014 need you/);
  await shot(page, "desktop-error");
});

test("a null total draws known+ and the dashed unknown treatment", async ({ page, request }) => {
  await parkOn(request, "Partial question", "e2e:ask=P|Partial?|Y,N");
  const real = await snapshot(request);
  const partial = {
    ...real,
    summary: { ...real.summary, visibleNeedsYouTaskCount: { value: null, known: 2 }, visibleAttentionItemCount: { value: null, known: 2 } },
    coverage: [...real.coverage, { source: "ci", taskId: null, state: "unavailable", reason: "rate limited" }],
  };
  await page.route("**/api/work-center**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(partial) }));
  await gotoApp(page);
  await expect(pill(page)).toHaveAttribute("aria-label", /2\+ need you \(total unknown\)/);
  await pill(page).click();
  await expect(popover(page).locator(".wc-k.need")).toContainText("2+");
  await expect(popover(page).locator(".wc-k.need")).toContainText("total unknown");
  await expect(popover(page).locator(".wc-note.warn")).toContainText("Partial");
  await shot(page, "desktop-partial");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test("the Work tab is the fourth of five, carries the badge, and opens the list", async ({ page, request }) => {
    await parkOn(request, "Phone question", "e2e:ask=Phone|Which?|A,B");
    await gotoApp(page);
    const tabs = page.locator(".mtabbar-item");
    await expect(tabs).toHaveText([/Board/, /Services/, /Terminals/, /Work/, /Insights/]);
    const need = (await snapshot(request)).summary.visibleNeedsYouTaskCount.value as number;
    await expect(tabs.nth(3).locator(".wc-tab-badge")).toHaveText(String(need));
    await tabs.nth(3).click();
    await expect(page.getByRole("region", { name: "Work Center" })).toBeVisible();
    await shot(page, "phone-work");

    // Phone rows show no inline buttons; the kebab opens the action sheet.
    const row = rowOf(page, "Phone question");
    await expect(row.locator(".wc-acts")).toHaveCount(0);
    await row.getByRole("button", { name: /^Actions for/ }).click();
    const sheet = page.getByRole("dialog", { name: "Actions" });
    await expect(sheet).toBeVisible();
    await shot(page, "phone-sheet");
    await sheet.getByRole("button", { name: /^Snooze/ }).click();
    await expect(sheet.getByRole("button")).toHaveText([/1 hour/, /Until tomorrow/, /Until Monday/]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("Back from a destination returns to the Work tab with the row selected", async ({ page, request }) => {
    await parkOn(request, "Phone back", "e2e:ask=Back|Which?|A,B");
    await gotoApp(page);
    await page.locator(".mtabbar-item").nth(3).click();
    const row = rowOf(page, "Phone back");
    await row.getByRole("button", { name: /^Question:/ }).click();
    await expect(page.locator(".ask").first()).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("region", { name: "Work Center" })).toBeVisible();
    await expect(rowOf(page, "Phone back")).toHaveClass(/\bon\b/);
  });
});

test.describe("narrow window", () => {
  test.use({ viewport: { width: 820, height: 800 } });

  test("the popover keeps its width and stays inside the window", async ({ page, request }) => {
    await parkOn(request, "Narrow question", "e2e:ask=N|Narrow?|A,B");
    await gotoApp(page);
    await pill(page).click();
    const box = await popover(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(480);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(820);
    await shot(page, "narrow-popover");
  });
});
