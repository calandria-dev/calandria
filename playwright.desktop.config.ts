import { defineConfig } from "@playwright/test";

// The DESKTOP end-to-end suite: Playwright's Electron driver (`_electron`)
// against the real shell in `desktop/`, under a virtual display. Run it with
// `npm run test:desktop:window` (or `npm run test:desktop` for the whole
// desktop lane); on a headless box it needs `xvfb-run -a` in front — Electron's
// own `--headless` dies with SIGTRAP before the CDP socket settles
// (docs/DESKTOP_E2E.md §1).
//
// **A separate config, not a project in `playwright.config.ts`.** That config's
// `webServer` boots `npm start` and points every spec at it; the whole subject
// of this suite is that the *shell* boots the server itself, from
// `before-quit` back to `supervisor.stop()`. Sharing a config would mean a
// second server on the same database, and the browser suite's `baseURL` is
// meaningless here — each spec learns its origin from the window the shell
// actually loaded.
//
// Serial and single-worker for a harder reason than the browser suite's: two
// shells at once would fight over `requestSingleInstanceLock()` and the
// database lock, which are two of the things being asserted.
//
// The reporter is shared with the browser suite on purpose: `cleanup-reporter`
// deletes the run root only on a green run, and every desktop instance is
// minted underneath that same root (see desktop/e2e/fixtures.ts), so a failure
// keeps the DB, worktrees and screenshots to read.
export default defineConfig({
  testDir: "./desktop/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A spec here pays for a full Electron start plus a production Next boot, and
  // 03-quit-drain deliberately waits out a drain — generous where the browser
  // suite's 60s is not.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["./e2e/cleanup-reporter.ts"]],
  use: {
    // No baseURL/browser fixtures: every page in this suite comes from
    // `electron.launch()`, not from a Playwright browser.
    screenshot: "only-on-failure",
    // Traces are unreliable against a packaged Electron app
    // (microsoft/playwright#13180) and the packaged lane runs this same config,
    // so the suite standardises on screenshots + the captured shell log.
    trace: "off",
  },
});
