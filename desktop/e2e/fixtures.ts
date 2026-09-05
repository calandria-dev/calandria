/**
 * Launches the real Electron shell for the desktop e2e suite, through
 * Playwright's `_electron` driver so specs get retrying assertions, a
 * per-test timeout and failure screenshots against a real renderer.
 *
 * Each launch gets its own hermetic Calandria instance (database, worktrees,
 * projects, Electron user-data directory) minted under the browser suite's
 * run root (`e2e/env.ts`), reusing its `SERVER_ENV` with per-instance ports
 * and the deterministic mock agent driver (`CALANDRIA_E2E_MOCK_AGENT=1`), no
 * agent CLI or login required.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { E2E_ROOT, SERVER_ENV } from "../../e2e/env";

const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");

/**
 * Either the dev shell (`electron .`) or a packaged build: set
 * `CALANDRIA_TEST_BIN` to the packaged executable to run the same specs
 * against the artifact a user would download.
 *
 * A packaged run carries no `CALANDRIA_REPO_ROOT` (see `instanceEnv()`), and
 * the artifact must sit outside this checkout, so the specs exercise the
 * payload the installer produced instead of the repo it was built from. See
 * `assertOutsideCheckout()` below.
 */
export const PACKAGED = process.env.CALANDRIA_TEST_BIN || null;

/**
 * A packaged artifact still inside the checkout does not test packaging.
 *
 * `desktop/main.js` resolves its repo root from `process.resourcesPath` when
 * `app.isPackaged`, so a payload missing a file does not fall back to the
 * repo, but code downstream of the payload still can: a stray relative path,
 * a module resolved by walking up to the repo's `node_modules`, a lockfile
 * Next finds two directories above. All of that resolves while the artifact
 * sits at `desktop/dist/linux-unpacked/`, and resolves to nothing on a
 * user's machine. Refusing to run an un-relocated artifact is the assertion:
 * a run from inside the tree would pass without exercising the packaged
 * payload.
 */
function assertOutsideCheckout(bin: string): void {
  const real = fs.realpathSync(bin);
  const repo = fs.realpathSync(REPO_ROOT);
  if (real === repo || real.startsWith(repo + path.sep)) {
    throw new Error(
      `CALANDRIA_TEST_BIN is inside this checkout (${real}).\n` +
        `Move the artifact out of the repo before running the packaged suite — an installed ` +
        `app is never inside a source tree, and testing one that is proves nothing about the ` +
        `payload. e.g.  mv desktop/dist/linux-unpacked "$TMPDIR/calandria-app"  (or install the ` +
        `.deb and point at /opt/Calandria/calandria-desktop). See desktop/README.md.`
    );
  }
}

/**
 * Linux CI only. Chromium's setuid sandbox helper needs the SUID bit, which
 * an unpacked Electron (`node_modules/electron/dist`, or `electron-builder
 * --dir`) does not have, so the suite drops the sandbox to run at all on a
 * runner. An installed `.deb`/AppImage does have the bit, so the lane that
 * tests one sets `CALANDRIA_DESKTOP_SANDBOX=1` to keep this flag from being
 * what makes it pass.
 *
 * Not passed on Windows or macOS: neither has a setuid helper to be missing,
 * and passing it there would weaken what those lanes test. That is distinct
 * from `01-shell.spec.ts`'s `sandbox: true` assertion on the renderer's
 * webPreferences, which is the renderer opting out of Node, not the OS-level
 * process sandbox.
 *
 * Playwright's `electron.launch()` adds `--no-sandbox` to the argument list
 * on Linux by itself unless `chromiumSandbox: true` is passed, so
 * `launchOptions()` below sets both halves from this one switch to keep them
 * in agreement.
 */
const NO_SANDBOX = process.platform === "linux" && process.env.CALANDRIA_DESKTOP_SANDBOX !== "1";

/**
 * Base for the per-instance port pair. Distinct from the browser suite's
 * 4711 so both can run on one box. It is only a preference: `pickPorts()`
 * steps past a busy port, which is why every assertion reads the origin back
 * off the window instead of trusting this constant.
 */
const PORT_BASE = Number(process.env.CALANDRIA_DESKTOP_E2E_PORT || 4741);
let instances = 0;

export type Shell = {
  app: ElectronApplication;
  /** The shell's one BrowserWindow. */
  win: Page;
  /** `http://127.0.0.1:<port>`: the origin the shell actually bound. */
  origin: string;
  /** Hermetic instance root (db/, worktrees/, projects/, electron-user-data/). */
  root: string;
  dbDir: string;
  /** The URL the window was showing when it first appeared (the boot screen). */
  firstUrl: string;
  /**
   * What the boot screen's `<pre id="log">` had streamed into it before the
   * swap. The pane is off screen (the boot screen shows a spinner) but is
   * still written, and is the only place the supervisor's first lines survive.
   */
  bootScreenLog: string;
  /**
   * What the boot screen actually showed while it was up: the spinner, and
   * how wide the log pane rendered (`-1` if it was already gone).
   */
  bootScreen: { spinner: boolean; logWidth: number };
  /**
   * Everything the Electron main process wrote to stdout/stderr from the
   * moment `electron.launch()` resolved. The supervisor's first lines are
   * already flushed by then; `[shell] ready on …` is the earliest one
   * guaranteed here.
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
 * Linux only. Electron's default permission check grants notifications, so
 * `Notification.permission` reads "granted" in the shell with nothing asked,
 * and the app posts a native notification on every turn event
 * (app/shell/useNotifications.ts). On Linux that goes through libnotify on
 * the main thread: with a session bus present but no notification daemon
 * owning `org.freedesktop.Notifications` (true of every headless box and
 * every GitHub runner), each call blocks the whole Electron main process for
 * GDBus's 25 s call timeout. Pointing libnotify at a socket that does not
 * exist makes it fail immediately instead.
 *
 * Windows and macOS post notifications through the OS API directly, with no
 * bus to misconfigure, so the variable is absent there instead of set to
 * something inert: a `DBUS_SESSION_BUS_ADDRESS` in a Windows process's
 * environment would be inherited by the sidecars incorrectly.
 *
 * The bench-VM specs that assert notifications reach the bus override this
 * and run under a real session with a daemon (dunst).
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
    // Unpackaged, the shell launches whatever repo this is; it does not
    // resolve the parent of an installed app bundle.
    //
    // Packaged, this variable is absent: setting it would point a downloaded
    // app back at a working checkout, masking a missing payload. Without it,
    // main.js must resolve resources/app-payload, so the artifact carries
    // everything itself.
    ...(PACKAGED ? {} : { CALANDRIA_REPO_ROOT: REPO_ROOT }),
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
  /** Reuse another shell's Electron user-data dir: this is its single-instance lock. */
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

/**
 * `chromiumSandbox` is the half of the sandbox decision that lives in
 * Playwright's own launch option instead of the argument list; see
 * `NO_SANDBOX`. Kept beside `launchArgs()` so the two stay in agreement.
 */
function launchOptions(): { chromiumSandbox: boolean } {
  return { chromiumSandbox: !NO_SANDBOX };
}

function launchEnv(root: string, port: number, opts: LaunchOptions): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) inherited[k] = v;
  // The whole environment is inherited (PATH matters: resolveNode() needs a
  // real `node` on it for the sidecars), so a developer who exports
  // CALANDRIA_REPO_ROOT in their own shell would reintroduce the crutch
  // instanceEnv() removes. The key is deleted here, since the test needs
  // the variable to be absent, not merely empty.
  if (PACKAGED) delete inherited.CALANDRIA_REPO_ROOT;
  return { ...inherited, ...instanceEnv(root, port), ...(opts.env ?? {}) };
}

/**
 * Launches the shell against a fresh hermetic instance and waits for the
 * window.
 *
 * The boot screen is captured on the way past: `main.js` opens the window on
 * `loading.html` and swaps to the app once `/api/version` answers, so the
 * URL at `firstWindow()` and the log lines the supervisor pushed into
 * `<pre id="log">` are the only evidence the handoff happened at all. Both
 * are gone the moment `loadURL(appUrl)` lands.
 */
export async function launchShell(name: string, opts: LaunchOptions = {}): Promise<Shell> {
  const root = instanceRoot(name);
  const port = PORT_BASE + instances * 10;
  const env = launchEnv(root, port, opts);

  const app = await electron.launch({
    executablePath: shellBinary(),
    args: launchArgs(root, opts),
    ...launchOptions(),
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

  // The first NON-EMPTY url, not the first one. `firstWindow()` resolves as
  // soon as the BrowserWindow object exists, which can be before
  // `main.js`'s `loadURL(loading.html)` has landed a navigation, so
  // `win.url()` can read "" and fail 01-shell's boot-screen assertion on a
  // race rather than on anything real.
  //
  // The loop is tight and short. The value being recorded is replaced by
  // the app url within a second or two of the server answering
  // /api/version, so a generous poll would trade one wrong answer for
  // another. Staying "" past the deadline is a real failure and still
  // fails.
  //
  // The first non-empty value is not always `loading.html` (or
  // `about:blank`): on a fast macOS boot the swap can land before the first
  // read, so the first value seen is already the app (#75). The consumer's
  // predicate is `isBootHandoffUrl` in ./bootUrl, which accepts either side
  // of that race.
  let firstUrl = win.url();
  const firstUrlDeadline = Date.now() + 5_000;
  while (firstUrl === "" && Date.now() < firstUrlDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    firstUrl = win.url();
  }

  // Read the boot screen while it still exists. `main.js` pushes each
  // sidecar log line into `<pre id="log">` with `executeJavaScript`, and the
  // whole page is replaced the moment the server answers /api/version
  // (~2 s). This loop is hand-rolled instead of `expect.poll`: once the
  // swap lands the locator stops resolving, and a retrying matcher would
  // run out its own timeout waiting on an element that will not return.
  // Short per-read timeouts; the last non-empty read wins.
  let bootScreenLog = "";
  let bootScreen: Shell["bootScreen"] = { spinner: false, logWidth: -1 };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !win.url().startsWith("http://")) {
    bootScreenLog =
      (await win
        .locator("#log")
        .innerText({ timeout: 500 })
        .catch(() => "")) || bootScreenLog;
    // Read here, in the same window of opportunity, instead of a second
    // loop. A rect, not `isVisible()`: the log pane is clipped to 1×1
    // instead of set to `display: none` (it must stay rendered for
    // `innerText` above), and Playwright treats a 1×1 element as visible.
    bootScreen = await win
      .evaluate(() => {
        const log = document.getElementById("log");
        return {
          spinner: !!document.querySelector(".spinner"),
          logWidth: log ? log.getBoundingClientRect().width : -1,
        };
      })
      .catch(() => bootScreen);
    if (bootScreenLog.trim()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  let origin = "";
  if (opts.waitForApp !== false) {
    await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 120_000 });
    origin = new URL(win.url()).origin;
    await win.waitForLoadState("domcontentloaded");
  }

  return {
    app,
    win,
    origin,
    root,
    dbDir: path.join(root, "db"),
    firstUrl,
    bootScreenLog,
    bootScreen,
    log,
    proc,
  };
}

/**
 * The executable every launch in this file goes through: the packaged
 * artifact when `CALANDRIA_TEST_BIN` names one, the unpacked dev Electron
 * otherwise.
 *
 * The relocation check runs here, not at module load, so it reports as a
 * failing test with the rest of the launch context, and a spec that never
 * launches (the win32-only file, on Linux) does not fail on it.
 */
export function shellBinary(): string {
  if (!PACKAGED) return electronBinary();
  assertOutsideCheckout(PACKAGED);
  return PACKAGED;
}

/**
 * The unpacked Electron this suite launches, spelled out per platform.
 *
 * `electron`'s `index.js` exports this exact path, but requiring it would
 * resolve a module out of `desktop/node_modules` from a file compiled
 * against the repo root's, so the three spellings are written out instead.
 * They are stable across Electron majors, and each one is what
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
 * Launches a second shell against a live one's Electron user-data directory
 * (its single-instance lock) and reports whether it was refused.
 *
 * Same binary, same args, same instance env as the original: the only
 * difference is that one is already running. `requestSingleInstanceLock()`
 * fails, `main.js` calls `app.exit(0)` before any Supervisor exists, and
 * Playwright never gets a CDP socket, so a rejected launch is what the
 * refusal looks like from the test's side.
 */
export async function launchDuplicate(shell: Shell): Promise<{ refused: boolean; ms: number }> {
  const started = Date.now();
  const port = Number(new URL(shell.origin || `http://127.0.0.1:${PORT_BASE}`).port);
  const opts: LaunchOptions = { userDataDir: userDataDir(shell.root) };
  try {
    const second = await electron.launch({
      executablePath: shellBinary(),
      args: launchArgs(shell.root, opts),
      ...launchOptions(),
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
 * Quits through the product's own path: `app.quit()` → `before-quit` →
 * `supervisor.stop()` → SIGTERM → drain. Killing the process directly would
 * leave the sidecars orphaned holding a port and the db lock instead of
 * reaped.
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
 * Kills the shell and everything under it. A backstop only, never the path a
 * spec asserts on.
 *
 * The two branches are not interchangeable. On win32, `child.kill("SIGKILL")`
 * is a `TerminateProcess` of that pid alone: the supervisor spawns its
 * sidecars without `detached` (there, that would open a new console window),
 * and Node puts them in no job object, so killing the Electron process
 * leaves `server.js` and `pty-server.js` running, orphaned, holding the
 * instance's ports and database lock, inherited by the runner's session
 * instead of reaped. The next spec then fails on a collision unrelated to
 * it. `taskkill /T` walks the tree to close that gap (the same call
 * `lib/processTree.ts` makes for managed services).
 *
 * POSIX uses the plain signal instead of `lib/processTree.ts`'s
 * `killTree()`: that function's POSIX branch is `process.kill(-pid)`, and
 * Playwright does not spawn Electron `detached`, so a negative pid there
 * would name the test runner's own process group.
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
 * Attaches the shell's captured output to a failing test.
 *
 * Most failures here originate in a process this suite does not own, such
 * as a sidecar that would not start or a drain that never finished, and the
 * supervisor's log is the only account of it. The attachment lands in
 * `test-results/`, which the CI lane already uploads on failure.
 */
export async function attachShellLog(testInfo: TestInfo, shell: Shell | null | undefined): Promise<void> {
  if (!shell || testInfo.status === testInfo.expectedStatus) return;
  // Written into the instance root as well as attached: a red run keeps that
  // root (e2e/cleanup-reporter.ts), so the log ends up beside the database
  // and worktrees it explains. Attaching by path keeps the whole file
  // instead of the couple of lines a console reporter would print.
  const file = path.join(shell.root, "shell.log");
  fs.writeFileSync(file, [...shell.log, await geometryLine(shell)].join("\n"));
  await testInfo.attach("shell.log", { path: file, contentType: "text/plain" });
  await attachScreenshot(testInfo, shell);
}

/**
 * A picture of the window a spec failed against.
 *
 * `use.screenshot: "only-on-failure"` does not cover this suite: Playwright
 * captures the `page` fixture, and every page here comes from
 * `electron.launch()` instead, so that config setting is inert and a red
 * desktop run uploads no image. This function takes its own screenshot to
 * cover that gap.
 *
 * Same best-effort contract as `geometryLine`: the window may already be
 * destroyed, and failing to capture a failure must not replace it.
 */
async function attachScreenshot(testInfo: TestInfo, shell: Shell): Promise<void> {
  const file = path.join(shell.root, "failure.png");
  try {
    await shell.win.screenshot({ path: file, timeout: 5_000 });
  } catch {
    return;
  }
  await testInfo.attach("failure.png", { path: file, contentType: "image/png" });
}

/**
 * The window's measurements, appended to the log a failed spec attaches.
 *
 * This suite pins no viewport, since the subject is a real OS window, so
 * the size the renderer lays out at is the runner's, and runners disagree:
 * a hosted macOS or Windows runner's virtual display is 1024x768 and the OS
 * clamps `main.js`'s requested 1440x900 to fit it, while the ubuntu lane's
 * Xvfb screen is larger with no window manager to clamp anything. A layout
 * assertion that fails on two lanes and passes on the third is a size
 * question until something rules it out, and a Playwright failure alone
 * does not say so.
 *
 * Best effort by construction: in `afterEach` the app may already be gone
 * (03-quit-drain and 04-db-lock end it on purpose), and a hung `evaluate`
 * against a dying process must not replace the failure it was meant to
 * explain, hence the race below.
 */
async function geometryLine(shell: Shell): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  // Rejection is handled here, not by wrapping the race in a try/catch: a
  // dead app can reject after the timeout has already won, and that would
  // surface as an unhandled rejection in the reporter after the spec that
  // caused it has finished.
  const read = shell.app
    .evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const c = w ? w.getContentBounds() : null;
      const d = screen.getPrimaryDisplay();
      return (
        `content=${c ? `${c.width}x${c.height}` : "(no window)"} ` +
        `display=${d.size.width}x${d.size.height} ` +
        `workArea=${d.workArea.width}x${d.workArea.height} scale=${d.scaleFactor}`
      );
    })
    .catch(() => "unavailable (the app was no longer running)");
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("unavailable (the app did not answer in 5s)"), 5_000);
  });
  try {
    return `[e2e] window ${await Promise.race([read, timeout])}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether this session is actually drawing the shell's tray icon, which
 * decides the close button's behavior. It depends on the desktop the shell
 * launched on, not on the platform or the runner.
 *
 * Read from the shell's own log instead of from D-Bus, for two reasons: it
 * is the only form of the answer available on every lane (CI runners have
 * no session bus to ask, and `bench.ts`'s reads are bench-only), and what
 * the close specs need is which branch the shell will take. The session and
 * the shell agreeing about that is `10-bench-tray.spec.ts`'s assertion, on
 * the lane that can make it.
 *
 * Polled because `createTray()` confirms asynchronously: registering an
 * item and a panel picking it up are round trips on the session bus after
 * the constructor returns.
 */
export async function trayIsHosted(shell: Shell, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The latest verdict, not the first: `main.js` logs again whenever the
    // answer changes, and a session whose panel came back mid-run has said
    // both things. Read backwards so the newest one wins, matching the
    // shell's own flag.
    for (let i = shell.log.length - 1; i >= 0; i--) {
      const line = shell.log[i];
      if (line.includes("[shell] tray icon confirmed in the status area")) return true;
      if (line.includes("[shell] tray icon is not in any status area")) return false;
      // Two ways to have no answer at all, both treated as no for the same
      // reason the shell treats them as one: nothing has confirmed an icon,
      // so there is nothing to report as hosted.
      if (line.includes("[shell] no tray available")) return false;
      if (line.includes("[shell] could not confirm the tray icon")) return false;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the shell never reported whether its tray icon is hosted within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Is the origin still answering? The post-quit half of "the server exited". */
export async function serverIsUp(origin: string): Promise<boolean> {
  if (!origin) return false;
  return fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
}

/* ---- A second server, for the remote-instance specs --------------------- *
 *
 * `desktop/supervisor.js`, driven directly from the test process instead of
 * from a shell: the same class `main.js` uses for `local`, so the "remote"
 * server in 12-remote-instance.spec.ts is a real production `node server.js`
 * with a real pty sidecar, on its own port, over its own hermetic instance.
 * A stub answering /api/version would prove only the handshake, not the
 * page load that follows it.
 *
 * `require`, not `import`: supervisor.js is plain CommonJS with no types,
 * and Playwright compiles this file to CommonJS anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Supervisor } = require("../supervisor");

export type RemoteServer = {
  /** `http://127.0.0.1:<port>`: the origin the shell will be told to attach to. */
  origin: string;
  root: string;
  log: string[];
  stop(): Promise<void>;
};

export async function bootRemoteServer(name: string, extraEnv: Record<string, string> = {}): Promise<RemoteServer> {
  const root = instanceRoot(name);
  const port = PORT_BASE + instances * 10;
  const log: string[] = [];
  const env = { ...process.env, ...instanceEnv(root, port), ...extraEnv };
  const sup = new Supervisor({
    repoRoot: REPO_ROOT,
    port,
    ptyPort: port + 1,
    env,
    onLog: (line: string) => log.push(line),
  });
  const { url } = await sup.start();
  return {
    origin: url,
    root,
    log,
    stop: () => sup.stop().catch(() => {}),
  };
}

/**
 * Writes an instance list for a shell to launch against, and returns the
 * path to point `CALANDRIA_INSTANCES_FILE` at.
 *
 * Written inside the run root instead of the real `~/.config/calandria`:
 * `main.js` reads that variable so a suite editing a developer's own
 * instance list would be unrunnable on the machine that needs it most.
 */
export function writeInstancesFile(root: string, state: unknown): string {
  const file = path.join(root, "instances.json");
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

/* ---- Driving the instance over its own REST API ------------------------- *
 * Plain `fetch`, not Playwright's `request` fixture: this suite has no
 * browser context to hang one off, and every call is a bare loopback JSON
 * POST.
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
