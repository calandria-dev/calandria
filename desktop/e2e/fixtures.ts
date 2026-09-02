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
 *
 * The packaged run is not the dev run with a different binary — see
 * `instanceEnv()` and `assertOutsideCheckout()` below. It carries no
 * `CALANDRIA_REPO_ROOT`, and the artifact must sit outside this checkout, so
 * that what is exercised is the payload the installer laid down rather than the
 * repo it happened to be built in.
 */
export const PACKAGED = process.env.CALANDRIA_TEST_BIN || null;

/**
 * A packaged artifact still standing inside the checkout is not a packaged
 * test.
 *
 * `desktop/main.js` resolves its repo root from `process.resourcesPath` when
 * `app.isPackaged`, so a payload with a hole in it does not fall back to the
 * repo — but everything *downstream* of the payload can: a stray relative path,
 * a module resolved by walking up to the repo's `node_modules`, a lockfile Next
 * finds two directories above. All of that is satisfied for free while the
 * artifact lives at `desktop/dist/linux-unpacked/`, and satisfied by nothing on
 * a user's machine. Relocating the artifact is what makes the difference
 * observable, so refusing to run un-relocated is the assertion — a green run
 * from inside the tree would be the exact false pass this lane exists to catch.
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
 *
 * PASSING THE FLAG IS NOT THE ONLY WAY IT GETS THERE, and this cost a
 * measurement to find: on Linux `_electron.launch()` UNSHIFTS `--no-sandbox`
 * onto the argument list itself unless `chromiumSandbox: true` is given
 * (playwright-core 1.61.1, `Electron.launch`; the option is documented as
 * "Enable Chromium sandboxing. Defaults to false."). So an installed .deb
 * driven by this suite ran unsandboxed no matter what the fixture omitted —
 * `app.commandLine.hasSwitch("no-sandbox")` read true against a launch that
 * passed no such flag. `launchOptions()` below sets both halves from the one
 * switch, so the flag is present exactly when the lane means it to be.
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
    // Unpackaged, the shell launches whatever repo this is, not the parent of
    // some installed app bundle.
    //
    // PACKAGED, this variable is deliberately ABSENT — it is the one piece of
    // env that would hide the failure this lane exists to find. Setting it
    // points a downloaded app back at a working checkout, which is how the
    // research spike's packaged shell passed while still leaning on the repo:
    // every assertion held, and a real download would have died on a missing
    // payload. Without it `main.js` must resolve `resources/app-payload` and
    // the artifact has to carry everything itself.
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

/**
 * `chromiumSandbox` is the half of the sandbox decision that lives in
 * Playwright rather than in our arguments — see `NO_SANDBOX`. Kept beside
 * `launchArgs()` so the two can never disagree.
 */
function launchOptions(): { chromiumSandbox: boolean } {
  return { chromiumSandbox: !NO_SANDBOX };
}

function launchEnv(root: string, port: number, opts: LaunchOptions): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) inherited[k] = v;
  // The whole environment is inherited (PATH matters: resolveNode() has to find
  // a real `node` for the sidecars), so a developer who exports
  // CALANDRIA_REPO_ROOT for their own shell would otherwise re-introduce
  // exactly the crutch instanceEnv() drops. Deleted rather than overwritten:
  // "absent" is the state under test.
  if (PACKAGED) delete inherited.CALANDRIA_REPO_ROOT;
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

  // The FIRST NON-EMPTY url, not the first one. `firstWindow()` resolves as soon
  // as the BrowserWindow object exists, which can be before `main.js`'s
  // `loadURL(loading.html)` has landed a navigation — `win.url()` then reads ""
  // and 01-shell's boot-screen assertion fails on a race rather than on
  // anything real. Measured flaky on both the macOS and the Windows lane
  // (2026-08-29 and 2026-08-30, three occurrences interleaved with passes on
  // unrelated branches).
  //
  // The loop is deliberately tight, and short. What we are recording is
  // replaced by the app url within a second or two of the server answering
  // /api/version, so a generous poll would trade one wrong answer for another.
  // Staying "" past the deadline is a real failure and still fails.
  //
  // This used to add that the first non-empty value "can only ever be
  // loading.html (or `about:blank`) and never the app". That was wrong, and
  // #75 is the counterexample: on a fast macOS boot the swap lands before the
  // first read, and the first thing this sees is already the app. The
  // consumer's predicate is `isBootHandoffUrl` in ./bootUrl, which accepts
  // either side of that race.
  let firstUrl = win.url();
  const firstUrlDeadline = Date.now() + 5_000;
  while (firstUrl === "" && Date.now() < firstUrlDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    firstUrl = win.url();
  }

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
 * The executable every launch in this file goes through: the packaged artifact
 * when `CALANDRIA_TEST_BIN` names one, the unpacked dev Electron otherwise.
 *
 * The relocation check lives here rather than at module load so it reports as a
 * failing test with the rest of the launch context, and so a spec that never
 * launches (the win32-only file, on Linux) does not fail on it.
 */
export function shellBinary(): string {
  if (!PACKAGED) return electronBinary();
  assertOutsideCheckout(PACKAGED);
  return PACKAGED;
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
  fs.writeFileSync(file, [...shell.log, await geometryLine(shell)].join("\n"));
  await testInfo.attach("shell.log", { path: file, contentType: "text/plain" });
  await attachScreenshot(testInfo, shell);
}

/**
 * A picture of the window a spec failed against.
 *
 * `use.screenshot: "only-on-failure"` does NOT cover this suite: Playwright
 * captures the `page` FIXTURE, and every page here comes from
 * `electron.launch()` instead — so the config's setting is inert and a red
 * desktop run uploaded no image at all. That absence read as evidence on PR #54
 * (a window producing no frames), when it only ever meant nobody had asked for
 * one; the actual failure was a layout collapsed to zero width, which one
 * screenshot would have shown at a glance. So the suite takes its own.
 *
 * Same best-effort contract as `geometryLine`: the window may already be
 * destroyed, and failing to photograph a failure must not replace it.
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
 * The window's measurements, appended to the log a FAILED spec attaches.
 *
 * This suite pins no viewport — the whole point is a real OS window — so the
 * size the renderer lays out at is the runner's, and the runners disagree: a
 * hosted macOS or Windows runner's virtual display is 1024x768 and the OS
 * clamps `main.js`'s requested 1440x900 down to fit it, while the ubuntu lane's
 * Xvfb screen is larger and has no window manager to clamp anything. A layout
 * assertion that fails on two lanes and passes on the third is a size question
 * until something rules it out, and nothing in a Playwright failure says so.
 *
 * Best effort by construction. In `afterEach` the app may already be gone —
 * 03-quit-drain and 04-db-lock end it on purpose — and a hung `evaluate`
 * against a dying process must not replace the failure it was meant to explain,
 * hence the race.
 */
async function geometryLine(shell: Shell): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  // The rejection is handled HERE rather than by a try/catch around the race:
  // a dead app can reject after the timeout has already won, and that would
  // land as an unhandled rejection in the reporter long after the spec that
  // caused it finished.
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
 * Whether this session is actually DRAWING the shell's tray icon — which is
 * what decides the close button's behaviour, and is not a property of the
 * platform or of the runner but of the desktop the shell happened to launch on.
 *
 * Read from the shell's own log rather than from D-Bus, for two reasons. It is
 * the only form of the answer available on every lane (the CI runners have no
 * session bus to ask, and `bench.ts`'s reads are bench-only), and what the
 * close specs need to know is which branch the shell WILL take — the session
 * and the shell agreeing about that is `10-bench-tray.spec.ts`'s assertion, on
 * the one lane that can make it.
 *
 * Polled because `createTray()` confirms asynchronously: registering an item
 * and a panel picking it up are round trips on the session bus after the
 * constructor returns.
 */
export async function trayIsHosted(shell: Shell, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The LATEST verdict, not the first: `main.js` logs again whenever the
    // answer changes, and a session whose panel came back mid-run has said both
    // things. Read backwards so the newest one wins, the way the shell's own
    // flag does.
    for (let i = shell.log.length - 1; i >= 0; i--) {
      const line = shell.log[i];
      if (line.includes("[shell] tray icon confirmed in the status area")) return true;
      if (line.includes("[shell] tray icon is not in any status area")) return false;
      // Two ways to have no answer at all, and both are a no for the same
      // reason they are one in the shell: nothing has ever confirmed an icon,
      // so nothing may hide into one.
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
