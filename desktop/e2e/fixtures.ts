/* Launching the real Electron shell for the desktop e2e suite.
 *
 * WHY THIS IS A PLAYWRIGHT SUITE AND NOT PLAIN NODE. `desktop/`'s other two
 * test scripts (`test-supervisor.js`, `test-real-boot.js`) are deliberately
 * dependency-free plain node: they assert process supervision on a box with
 * nothing installed, including inside Electron's own runtime. This suite cannot
 * be that — driving a window means `playwright`'s `_electron` driver either
 * way, and a display either way — so the plain style would buy nothing and cost
 * three things it needs: auto-retrying `expect` against a live renderer (the
 * smoke path streams SSE into the DOM), a per-test timeout so a wedged launch
 * fails one spec instead of hanging the process, and screenshots-on-failure in
 * the same `test-results/` shape the CI lane already uploads for the browser
 * suite. The proof of concept this replaces (`desktop/test-window.js`) had
 * hand-rolled versions of all three.
 *
 * WHAT A "SHELL" IS HERE. One `electron.launch()` against `desktop/`, with its
 * own hermetic Calandria instance underneath: its own database, worktrees,
 * projects and Electron user-data directory, all minted under the browser
 * suite's run root (e2e/env.ts) so `e2e/cleanup-reporter.ts` removes them on a
 * green run and keeps them on a red one. Per-launch rather than per-run because
 * half of what this suite asserts is *fatal* to an instance — the single-
 * instance refusal, the db-lock collision, quit-drains-and-exits.
 *
 * The environment is `e2e/env.ts`'s `SERVER_ENV` with the per-instance paths
 * and ports swapped: `supervisor.js`'s `sidecarEnv()` forwards its own
 * environment to both sidecars, so the shape the browser suite hands `npm
 * start` reaches server.js and pty-server.js unchanged through
 * `electron.launch({ env })` — same temp dirs, same pinned gitconfig, same
 * `CALANDRIA_E2E_MOCK_AGENT=1` deterministic driver, no agent CLI or login.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { E2E_ROOT, SERVER_ENV } from "../../e2e/env";

const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");

/**
 * Either the dev shell (`electron .`) or a packaged build: point
 * `CALANDRIA_TEST_BIN` at the packaged executable to run the same specs against
 * the artifact a user would download.
 */
const PACKAGED = process.env.CALANDRIA_TEST_BIN || null;

/**
 * Linux-only, and CI-only there. Chromium's setuid sandbox helper needs the
 * SUID bit, which an unpacked Electron (`node_modules/electron/dist`, or
 * `electron-builder --dir`) does not have — so the suite drops the sandbox to
 * run at all on a runner. A packaged `.deb`/AppImage installed as a user would
 * install it DOES have it, and the lane that tests that must set
 * `CALANDRIA_DESKTOP_SANDBOX=1` so this flag is not what makes it pass.
 *
 * Not passed on Windows or macOS: neither has a setuid helper to be missing —
 * Chromium sandboxes with a restricted token and a job object there — so the
 * flag would buy nothing and would quietly weaken what those lanes test.
 * `01-shell.spec.ts` asserts `sandbox: true` on the renderer's webPreferences,
 * which is a different (and unaffected) setting: that is the renderer opting
 * out of Node, this is the OS-level process sandbox.
 */
const NO_SANDBOX = process.platform === "linux" && process.env.CALANDRIA_DESKTOP_SANDBOX !== "1";

/**
 * Base for the per-instance port pair. Distinct from the browser suite's 4711
 * so both can run on one box; it is only ever a *preference* — `pickPorts()`
 * steps past a busy one — which is why every assertion reads the origin back
 * off the window rather than trusting this.
 */
const PORT_BASE = Number(process.env.CALANDRIA_DESKTOP_E2E_PORT || 4741);
let instances = 0;

export type Shell = {
  app: ElectronApplication;
  /** The shell's one BrowserWindow. */
  win: Page;
  /** `http://127.0.0.1:<port>` — the origin the shell really bound. */
  origin: string;
  /** Hermetic instance root (db/, worktrees/, projects/, electron-user-data/). */
  root: string;
  dbDir: string;
  /** The URL the window was showing when it first appeared (the boot screen). */
  firstUrl: string;
  /** What the boot screen's `<pre id="log">` had streamed into it before the swap. */
  bootScreenLog: string;
  /**
   * Everything the Electron main process wrote to stdout/stderr from the moment
   * `electron.launch()` resolved. The supervisor's very first lines are already
   * flushed by then — `[shell] ready on …` is the earliest one guaranteed here.
   */
  log: string[];
  /**
   * The Electron process itself, captured at launch: `app.process()` throws
   * once Playwright has torn the connection down, which is exactly when a
   * teardown wants to check whether it exited.
   */
  proc: import("node:child_process").ChildProcess;
};

/** One hermetic Calandria instance, under the run root the browser suite owns. */
export function instanceRoot(name: string): string {
  const root = path.join(E2E_ROOT, `shell-${String(++instances).padStart(2, "0")}-${name}`);
  for (const d of ["db", "worktrees", "projects", "electron-user-data"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}

/**
 * Linux-only, and load-bearing rather than tidy-up. Electron's default
 * permission CHECK grants notifications, so `Notification.permission` reads
 * "granted" in the shell with nothing asked, and the app posts a real native
 * notification on every turn event (app/shell/useNotifications.ts). On Linux
 * that is libnotify on the main thread: with a session bus present but NO
 * notification daemon owning org.freedesktop.Notifications — which is every
 * headless box and every GitHub runner — each one blocks the entire Electron
 * main process for GDBus's 25 s call timeout. Measured: the quit-drain spec's
 * shutdown went from >90 s (main process wedged, not even answering
 * `app.evaluate`) to 0.2 s with this set. Pointing libnotify at a socket that
 * is not there makes it fail immediately instead.
 *
 * Windows and macOS post notifications through the OS API directly, with no bus
 * to misconfigure and no measured stall, so the variable is simply absent there
 * rather than set to something inert — a `DBUS_SESSION_BUS_ADDRESS` in a
 * Windows process's environment is a lie the sidecars would inherit.
 *
 * The bench-VM specs that assert notifications actually reach the bus must
 * override this and run under a real session with a daemon (dunst) —
 * docs/DESKTOP_E2E.md §1.
 */
const NO_NOTIFICATION_BUS: Record<string, string> =
  process.platform === "linux"
    ? { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/calandria-desktop-e2e-no-bus" }
    : {};

/** `SERVER_ENV`'s shape, repointed at one instance's own directories and ports. */
export function instanceEnv(root: string, port: number): Record<string, string> {
  return {
    ...SERVER_ENV,
    PORT: String(port),
    PTY_PORT: String(port + 1),
    CALANDRIA_SERVICE_PORT_BASE: String(port + 100),
    CALANDRIA_DB_DIR: path.join(root, "db"),
    CALANDRIA_WORKTREES_DIR: path.join(root, "worktrees"),
    CALANDRIA_PROJECTS_DIR: path.join(root, "projects"),
    // The shell launches whatever repo this is, not the parent of some
    // installed app bundle.
    CALANDRIA_REPO_ROOT: REPO_ROOT,
    // Nothing here tests the ticker, and an unattended sweep inside a suite
    // that kills servers mid-run is only a source of noise.
    CALANDRIA_SCHEDULER: "off",
    ...NO_NOTIFICATION_BUS,
  };
}

export type LaunchOptions = {
  /** Extra/overriding environment for this instance. */
  env?: Record<string, string>;
  /**
   * Wait for the window to swap from the boot screen to the app's own origin.
   * `false` for the specs whose subject is a boot that never gets there.
   */
  waitForApp?: boolean;
  /** Reuse another shell's Electron user-data dir — i.e. its single-instance lock. */
  userDataDir?: string;
};

export function userDataDir(root: string): string {
  return path.join(root, "electron-user-data");
}

function launchArgs(root: string, opts: LaunchOptions): string[] {
  const args: string[] = PACKAGED ? [] : [DESKTOP_DIR];
  // Keeps the single-instance lock (and everything else Electron persists)
  // inside the run root: without it a developer's own installed Calandria
  // desktop app shares the lock with the suite, and each would refuse the other.
  args.push(`--user-data-dir=${opts.userDataDir ?? userDataDir(root)}`);
  if (NO_SANDBOX) args.push("--no-sandbox");
  return args;
}

function launchEnv(root: string, port: number, opts: LaunchOptions): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) inherited[k] = v;
  // PATH matters: resolveNode() has to find a real `node` for the sidecars.
  return { ...inherited, ...instanceEnv(root, port), ...(opts.env ?? {}) };
}

/**
 * Launch the shell against a fresh hermetic instance and wait for the window.
 *
 * The boot screen is captured on the way past: `main.js` opens the window on
 * `loading.html` and only swaps to the app once `/api/version` answers, so the
 * URL at `firstWindow()` and the log lines the supervisor pushed into
 * `<pre id="log">` are the only evidence the handoff happened at all — both are
 * gone the moment `loadURL(appUrl)` lands.
 */
export async function launchShell(name: string, opts: LaunchOptions = {}): Promise<Shell> {
  const root = instanceRoot(name);
  const port = PORT_BASE + instances * 10;
  const env = launchEnv(root, port, opts);

  const app = await electron.launch({
    ...(PACKAGED ? { executablePath: PACKAGED } : { executablePath: electronBinary() }),
    args: launchArgs(root, opts),
    env,
    timeout: 120_000,
  });

  const log: string[] = [];
  const proc = app.process();
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on("data", (d: Buffer) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) log.push(line);
    });
  }

  const win = await app.firstWindow({ timeout: 120_000 });
  const firstUrl = win.url();

  // Read the boot screen while it still exists. `main.js` pushes each sidecar
  // log line into `<pre id="log">` with `executeJavaScript`, and the whole page
  // is replaced the moment the server answers /api/version (~2 s), so this is a
  // hand-rolled loop rather than `expect.poll`: the moment the swap lands the
  // locator stops resolving, and a retrying matcher would sit on its own
  // timeout waiting for an element that is never coming back. Short per-read
  // timeouts, and the last non-empty read wins.
  let bootScreenLog = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !win.url().startsWith("http://")) {
    bootScreenLog =
      (await win
        .locator("#log")
        .innerText({ timeout: 500 })
        .catch(() => "")) || bootScreenLog;
    if (bootScreenLog.trim()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  let origin = "";
  if (opts.waitForApp !== false) {
    await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 120_000 });
    origin = new URL(win.url()).origin;
    await win.waitForLoadState("domcontentloaded");
  }

  return { app, win, origin, root, dbDir: path.join(root, "db"), firstUrl, bootScreenLog, log, proc };
}

/**
 * The unpacked Electron this suite launches, spelled for the platform.
 *
 * `electron`'s own `index.js` exports exactly this path, but requiring it would
 * mean resolving a module out of `desktop/node_modules` from a file compiled
 * against the repo root's — so the three spellings are written out instead.
 * They are stable across Electron majors and each one is what
 * `electron-builder` unpacks too:
 *
 *   linux   dist/electron
 *   win32   dist/electron.exe
 *   darwin  dist/Electron.app/Contents/MacOS/Electron  (a .app, not a bare file)
 */
function electronBinary(): string {
  const dist = path.join(DESKTOP_DIR, "node_modules", "electron", "dist");
  const bin =
    process.platform === "win32"
      ? path.join(dist, "electron.exe")
      : process.platform === "darwin"
        ? path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
        : path.join(dist, "electron");
  if (!fs.existsSync(bin)) {
    throw new Error(
      `Electron is not installed at ${bin}. Run \`npm run desktop:install\` from the repo root ` +
        `(Electron is a devDependency of desktop/package.json, so an install under NODE_ENV=production ` +
        `reports "up to date" and fetches nothing — see desktop/README.md).`
    );
  }
  return bin;
}

/**
 * Launch a SECOND shell against a live one's Electron user-data directory —
 * i.e. its single-instance lock — and report whether it was refused.
 *
 * Same binary, same args, same instance env as the original: the only thing
 * being varied is that one is already running. `requestSingleInstanceLock()`
 * fails, `main.js` calls `app.exit(0)` before any Supervisor exists, and
 * Playwright never gets a CDP socket — a rejected launch is what the refusal
 * looks like from out here.
 */
export async function launchDuplicate(shell: Shell): Promise<{ refused: boolean; ms: number }> {
  const started = Date.now();
  const port = Number(new URL(shell.origin || `http://127.0.0.1:${PORT_BASE}`).port);
  const opts: LaunchOptions = { userDataDir: userDataDir(shell.root) };
  try {
    const second = await electron.launch({
      ...(PACKAGED ? { executablePath: PACKAGED } : { executablePath: electronBinary() }),
      args: launchArgs(shell.root, opts),
      env: launchEnv(shell.root, port, opts),
      timeout: 25_000,
    });
    await second.close().catch(() => {});
    return { refused: false, ms: Date.now() - started };
  } catch {
    return { refused: true, ms: Date.now() - started };
  }
}

/**
 * Quit through the product's own path — `app.quit()` → `before-quit` →
 * `supervisor.stop()` → SIGTERM → drain — rather than killing the process, so
 * the sidecars are reaped instead of orphaned holding a port and the db lock.
 */
export async function quitShell(shell: Shell | null | undefined): Promise<void> {
  if (!shell) return;
  await shell.app.evaluate(async ({ app }) => app.quit()).catch(() => {});
  await shell.app.waitForEvent("close", { timeout: 60_000 }).catch(() => {});
  // Backstop: a shell that ignored the quit would hold its ports into the next
  // spec, which reads as an unrelated failure there.
  if (shell.proc.exitCode === null && shell.proc.signalCode === null) killTree(shell.proc.pid);
}

/**
 * Kill the shell and everything under it — the backstop only, never the path a
 * spec asserts on.
 *
 * The two branches are not interchangeable, and the Windows one is why this
 * exists at all. `child.kill("SIGKILL")` on win32 is a `TerminateProcess` of
 * that pid ALONE: the supervisor deliberately spawns its sidecars without
 * `detached` (there, that would mean a new console window) and Node puts them
 * in no job object, so killing the Electron process leaves `server.js` and
 * `pty-server.js` running — orphaned, still holding the instance's ports and
 * its database lock, and inherited by the runner's session rather than reaped.
 * The next spec then fails on a collision that has nothing to do with it.
 * `taskkill /T` is the tree walk that closes that gap (the same call
 * lib/processTree.ts makes for managed services).
 *
 * POSIX keeps the plain signal rather than borrowing `killTree()`: that
 * function's POSIX branch is `process.kill(-pid)`, and Playwright does not
 * spawn Electron `detached`, so the negative pid names the TEST RUNNER's own
 * process group.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already reaped */
  }
}

/**
 * Attach the shell's captured output to a failing test.
 *
 * Almost everything that goes wrong here goes wrong in a process this suite
 * does not own — a sidecar that would not start, a drain that never finished —
 * and the supervisor's log is the only account of it. The attachment lands in
 * `test-results/`, which the CI lane already uploads on failure.
 */
export async function attachShellLog(testInfo: TestInfo, shell: Shell | null | undefined): Promise<void> {
  if (!shell || testInfo.status === testInfo.expectedStatus) return;
  // Written into the instance root as well as attached: a red run keeps that
  // root (e2e/cleanup-reporter.ts), so the log ends up beside the database and
  // worktrees it explains, and attaching by path keeps the whole thing rather
  // than the two lines a console reporter would print.
  const file = path.join(shell.root, "shell.log");
  fs.writeFileSync(file, shell.log.join("\n"));
  await testInfo.attach("shell.log", { path: file, contentType: "text/plain" });
}

/** Is the origin still answering? The post-quit half of "the server exited". */
export async function serverIsUp(origin: string): Promise<boolean> {
  if (!origin) return false;
  return fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
}

/* ---- Driving the instance over its own REST API ------------------------- *
 * Plain `fetch` rather than Playwright's `request` fixture: this suite has no
 * browser context to hang one off, and every call is a bare loopback JSON POST.
 */

async function api<T>(origin: string, method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${origin}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

/** Past first run: the mock agent verified and adopted as the app's default. */
export async function ensureOnboarded(origin: string): Promise<void> {
  await api(origin, "POST", "/api/agents/mock/verify");
  await api(origin, "POST", "/api/onboarding");
}

export async function createProject(origin: string, name: string, repoPath: string): Promise<{ id: string }> {
  return api(origin, "POST", "/api/projects", {
    name,
    sub: "desktop-e2e",
    context: "Desktop e2e fixture project.",
    repo_path: repoPath,
    branch: "main",
  });
}

export async function createTask(
  origin: string,
  opts: { projectId: string; title: string; description?: string }
): Promise<{ id: string }> {
  return api(origin, "POST", "/api/tasks", {
    project_id: opts.projectId,
    title: opts.title,
    description: opts.description ?? "",
    priority: "med",
    agent: "mock",
  });
}

export async function sendMessage(origin: string, taskId: string, text = "go"): Promise<void> {
  await api(origin, "POST", `/api/tasks/${taskId}/messages`, { text });
}

export async function getTask(origin: string, taskId: string): Promise<Record<string, unknown>> {
  return api(origin, "GET", `/api/tasks/${taskId}`);
}
