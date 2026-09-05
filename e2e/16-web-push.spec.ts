// Web Push surface against the built server: the push-only service worker is
// served and installs in a real browser, and the subscription endpoints behave
// as same-origin credentialed calls (the same gate every /api route sits
// behind). There is no push service in the loop here, so the protocol is
// pinned by tests/webpush.test.ts against the RFC vector instead; this spec
// covers what only the real server and browser show.

import { expect, test } from "@playwright/test";
import { ensureOnboarded, gotoApp } from "./helpers";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
});

test("the service worker is served as script and has no fetch handler", async ({ request }) => {
  const res = await request.get("/sw.js");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("javascript");
  const body = await res.text();
  expect(body).toContain('addEventListener("push"');
  expect(body).not.toMatch(/addEventListener\(\s*["']fetch["']/);
});

test("the service worker installs and activates in the browser", async ({ page }) => {
  await gotoApp(page);
  // localhost is a secure context, so registration is real: parse errors or a
  // failing install handler would reject here, which the unit pin can't see.
  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const active = reg.active?.state ?? null;
    await reg.unregister();
    return active;
  });
  // `ready` resolves once the worker is activating (its activate handler's
  // clients.claim() may still be in flight); either state means it parsed,
  // installed and was accepted.
  expect(["activating", "activated"]).toContain(state);
});

test("subscriptions register, list, and unregister through the API", async ({ request }) => {
  const key = await (await request.get("/api/notifications/push")).json();
  expect(typeof key.publicKey).toBe("string");
  expect(Buffer.from(key.publicKey, "base64url")).toHaveLength(65);

  const endpoint = `https://push.example.test/e2e/${Date.now()}`;
  const posted = await request.post("/api/notifications/push", {
    data: { subscription: { endpoint, expirationTime: null, keys: { p256dh: "k", auth: "a" } }, label: "Playwright · Chromium" },
  });
  expect(posted.ok()).toBeTruthy();
  const { device } = await posted.json();
  expect(device.label).toBe("Playwright · Chromium");
  expect(device.service).toBe("push.example.test");
  expect(device).not.toHaveProperty("endpoint");

  const listed = await (await request.get("/api/notifications/push")).json();
  expect(listed.subscriptions.some((d: { id: string }) => d.id === device.id)).toBe(true);

  const bad = await request.post("/api/notifications/push", { data: { subscription: { endpoint: "http://plain/x", keys: { p256dh: "k", auth: "a" } } } });
  expect(bad.status()).toBe(400);

  const removed = await request.delete("/api/notifications/push", { data: { endpoint } });
  expect(await removed.json()).toEqual({ ok: true, removed: true });
  const after = await (await request.get("/api/notifications/push")).json();
  expect(after.subscriptions.some((d: { id: string }) => d.id === device.id)).toBe(false);
});

test("Settings → Notifications offers push on this device", async ({ page }) => {
  await gotoApp(page);
  await page.getByTitle("App settings").click();
  await page.locator(".settings-nav .nav-item", { hasText: "Notifications" }).click();
  await expect(page.getByText("Push notifications", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Enable push on this device/ })).toBeVisible();
});
