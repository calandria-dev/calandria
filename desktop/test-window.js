/* PROOF OF CONCEPT — Playwright driving the real Electron shell under a virtual
 * display. `xvfb-run -a node desktop/test-window.js` (needs a repo-root build,
 * `npm install` in desktop/, and playwright resolvable from the repo root).
 *
 * This is the measurement behind docs/DESKTOP_E2E.md: it answers whether the
 * window layer — which docs/DESKTOP_APP.md §4 lists as entirely unverified —
 * can be driven headlessly by the same tool the browser suite already uses.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..");

// Either the dev shell (`electron .`) or a packaged build: point
// CALANDRIA_TEST_BIN at the packaged executable to run the same assertions
// against the artifact a user would download.
const PACKAGED = process.env.CALANDRIA_TEST_BIN || null;
const LAUNCH = PACKAGED
  ? { executablePath: PACKAGED, args: ["--no-sandbox"] }
  : {
      executablePath: path.join(__dirname, "node_modules", "electron", "dist", "electron"),
      args: [__dirname, "--no-sandbox"],
    };

let failures = 0;
const check = (name, fn) => {
  try {
    const r = fn();
    console.log(`ok   ${name}`);
    return r;
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err?.message || err}`);
  }
};

(async () => {
  // Hermetic instance, the same shape e2e/env.ts builds for the browser suite.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-window-"));
  for (const d of ["db", "worktrees", "projects", "claude-config"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, "gitconfig"),
    "[user]\n\tname = Desktop E2E\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\thooksPath = /dev/null\n"
  );
  const env = {
    ...process.env,
    CALANDRIA_REPO_ROOT: REPO_ROOT,
    PORT: "4830",
    PTY_PORT: "4831",
    ORCH_DB_DIR: path.join(root, "db"),
    ORCH_WORKTREES_DIR: path.join(root, "worktrees"),
    ORCH_PROJECTS_DIR: path.join(root, "projects"),
    ORCH_SERVICE_PORT_BASE: "4930",
    ORCH_E2E_MOCK_AGENT: "1",
    ORCH_SCHEDULER: "off",
    CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };

  const t0 = Date.now();
  const app = await electron.launch({ ...LAUNCH, env, timeout: 120_000 });
  const win = await app.firstWindow({ timeout: 120_000 });
  console.log(`first window in ${Date.now() - t0}ms`);

  // The window opens on loading.html and swaps to the app once the server
  // answers /api/version. Waiting for the app's own DOM is what proves the
  // whole chain — supervisor → node sidecars → BrowserWindow.loadURL.
  await win.waitForURL(/127\.0\.0\.1:\d+/, { timeout: 120_000 });
  const bootMs = Date.now() - t0;
  console.log(`app URL loaded in ${bootMs}ms: ${win.url()}`);

  check("window loaded the app's own origin, not the boot screen", () =>
    assert.match(win.url(), /^http:\/\/127\.0\.0\.1:\d+/));

  await win.waitForLoadState("domcontentloaded");
  const body = await win.locator("body").innerText().catch(() => "");
  check("app UI rendered inside the window", () => assert.ok(body.length > 0, "empty body"));
  console.log(`   first 120 chars: ${JSON.stringify(body.slice(0, 120))}`);

  const title = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());
  check("window carries the app title", () => assert.match(String(title), /Calandria/));

  // Main-process reach: this is what a browser-only harness cannot do.
  const menu = await app.evaluate(async ({ Menu }) =>
    (Menu.getApplicationMenu()?.items || []).map((i) => i.label || i.role));
  check("application menu is installed (Cmd+C/V on macOS depend on it)", () =>
    assert.ok(menu.length >= 4, `menu: ${JSON.stringify(menu)}`));
  console.log(`   menu: ${JSON.stringify(menu)}`);

  const hardened = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences() || {};
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, preload: p.preload || null };
  });
  check("renderer stayed a hardened browser tab", () => {
    assert.equal(hardened.nodeIntegration, false);
    assert.notEqual(hardened.contextIsolation, false);
    assert.equal(hardened.preload, null);
  });
  console.log(`   webPreferences: ${JSON.stringify(hardened)}`);

  const shot = path.join(root, "window.png");
  await win.screenshot({ path: shot });
  check("screenshot captured under the virtual display", () =>
    assert.ok(fs.statSync(shot).size > 5000, `screenshot only ${fs.statSync(shot).size} bytes`));
  console.log(`   screenshot: ${shot} (${fs.statSync(shot).size} bytes)`);

  // Single-instance lock: a second launch must exit rather than fight for the db.
  const t1 = Date.now();
  let secondExited = false;
  try {
    const second = await electron.launch({ ...LAUNCH, env, timeout: 20_000 });
    await second.close().catch(() => {});
  } catch (err) {
    secondExited = true;
    console.log(`   second launch rejected after ${Date.now() - t1}ms: ${String(err?.message).slice(0, 120)}`);
  }
  console.log(`   second-instance probe took ${Date.now() - t1}ms (rejected: ${secondExited})`);

  // Quit path: app.quit() → before-quit → supervisor.stop() → SIGTERM → drain.
  const t2 = Date.now();
  await app.evaluate(async ({ app: a }) => a.quit());
  await app.waitForEvent("close", { timeout: 30_000 }).catch(() => {});
  console.log(`quit settled in ${Date.now() - t2}ms`);

  const stillUp = await fetch("http://127.0.0.1:4830/api/version").then(() => true).catch(() => false);
  check("server sidecar is gone after quit", () => assert.equal(stillUp, false));

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(2);
});
