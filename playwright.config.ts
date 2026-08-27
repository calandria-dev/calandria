import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, SERVER_ENV } from "./e2e/env";

// End-to-end suite: boots the REAL production server (server.js + pty sidecar,
// same `npm start` a self-hoster runs) against a fresh temp instance (see
// e2e/env.ts) with the deterministic mock agent registered, then drives the UI
// with Playwright. Run with `npm run test:e2e` (builds first); see e2e/README.md.
//
// Serial on purpose: the specs share one app instance and one SQLite database,
// and 01-onboarding must observe the untouched first-run state before anything
// else writes to it. Later specs are self-contained (each creates its own
// project via e2e/helpers.ts and calls ensureOnboarded), so they can also be
// run individually with `npx playwright test e2e/03-views.spec.ts`.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The second reporter deletes the temp run root — but only when the run
  // passed, so a failure keeps its DB and worktrees to be read. It's a reporter
  // rather than a `globalTeardown` because global teardown runs BEFORE
  // Playwright stops the webServer above (it would delete the tree under a live
  // server) and isn't told whether the run passed. See e2e/cleanup-reporter.ts.
  reporter: [["list"], ["./e2e/cleanup-reporter.ts"]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm start",
    url: E2E_BASE_URL,
    env: SERVER_ENV,
    // A leftover dev server on this port would have the wrong DB (and a
    // completed onboarding) — always demand our own fresh instance.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
