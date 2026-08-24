// PWA installability surface: the manifest route, the icons it points at, and
// the credentialed <link> in the document head. The link assertion is the
// load-bearing one — the manifest fetch only carries cookies when the link says
// use-credentials, and middleware gates every route, so losing that attribute
// (e.g. by switching to the app/manifest.ts convention, whose auto-injected
// link can't be told to say it) silently breaks install behind Cloudflare
// Access while local-mode testing stays green.

import { expect, test } from "@playwright/test";
import { ensureOnboarded } from "./helpers";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
});

test("manifest is served with the installability fields and resolvable icons", async ({ request }) => {
  const res = await request.get("/site.webmanifest");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("application/manifest+json");

  const manifest = await res.json();
  expect(manifest.name).toBe("Calandria");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");

  // Chrome's install criteria want a 192 and a 512; the maskable pair is what
  // Android launchers actually shape. Every advertised icon must resolve.
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons) {
    const iconRes = await request.get(icon.src);
    expect(iconRes.ok()).toBeTruthy();
    expect(iconRes.headers()["content-type"]).toContain("image/png");
  }
});

test("document head links the manifest with use-credentials", async ({ page }) => {
  await page.goto("/");
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", "/site.webmanifest");
  await expect(link).toHaveAttribute("crossorigin", "use-credentials");
});
