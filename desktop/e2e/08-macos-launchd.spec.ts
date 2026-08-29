/* The launchd PATH repair, against a real GUI launch.
 *
 * `desktop/test-supervisor.js` already tests `needsPathRepair()` and
 * `loginShellPath()` with a synthetic environment, and that is worth having —
 * but a synthetic stub PATH is a value this suite typed in. The claim the
 * repair actually makes is about the OS: a `.app` opened from Finder, Spotlight
 * or the Dock is started by launchd and inherits `/usr/bin:/bin:/usr/sbin:/sbin`
 * rather than the PATH the same user has in Terminal, so `codex`, `gh`, a
 * Homebrew `git` and an nvm-managed `node` are all invisible to a double-clicked
 * Calandria while working perfectly one window over. No spec can reach that
 * environment from a child-process launch.
 *
 * So this spec `open`s the packaged bundle, which goes through LaunchServices
 * exactly as a double-click does, and reads back what the supervisor said about
 * the PATH launchd handed it. Read the third section below before trusting the
 * word "real" too far: what a hosted runner can produce is a launchd launch,
 * not an un-provisioned user's launchd launch, and the difference turned out to
 * matter.
 *
 * WHY IT IS NOT `electron.launch()`. Every other spec here starts the binary as
 * a child of the test process, which means the app inherits the *runner's*
 * PATH — node from `setup-node`'s tool cache, Homebrew, the lot. That is the
 * environment in which the repair is a no-op, so no `_electron` spec can ever
 * observe it. The price is that Playwright has no CDP connection to the app: the
 * evidence here is the process's stdout (`open --stdout`) and its HTTP surface,
 * not `app.evaluate()`.
 *
 * HOW THE INSTANCE STAYS HERMETIC WITHOUT AN ENV. `open` deliberately does not
 * forward the caller's environment — that is the whole point — so the usual
 * `electron.launch({ env })` route is unavailable. `launchctl setenv` is the
 * matching mechanism: it writes into the user's launchd domain, which is what
 * GUI apps started after it inherit. The full `instanceEnv()` shape goes in and
 * comes back out in `afterAll`, so the app under test gets the same temp
 * directories, ports and mock agent as every other spec in this suite.
 *
 * WHY PATH IS PLANTED RATHER THAN OBSERVED — and what that costs.
 *
 * The first draft of this spec set every key EXCEPT PATH, on the theory that
 * launchd would supply the stub by itself and the run would therefore measure
 * the premise instead of assuming it. On a hosted `macos-latest` runner it does
 * not: run 33195354526 / job 98930976811 booted the bundle all the way and took
 * the *un*-repaired branch, so LaunchServices handed the app a PATH with at
 * least one directory outside `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`.
 * That is a property of GitHub's image — which provisions the runner's launchd
 * domain — and not a regression: `needsPathRepair()` is byte-identical to the
 * version the spike shipped (`f21f174`, the only commit that has ever touched
 * it) and `desktop/test-supervisor.js` pins it returning true for exactly that
 * string. A plain double-click on a real Mac is still the stub.
 *
 * So the environment that triggers the repair is not reproducible here, and
 * this lane asserts the repair itself instead: the stub goes into the launchd
 * user domain alongside the rest of `instanceEnv()`, and the app inherits it
 * through the same LaunchServices → launchd path a Finder launch uses. What
 * that still covers is everything downstream of the trigger — that a real GUI
 * launch reaches `needsPathRepair()` with the PATH launchd gave it, that the
 * login-shell probe can run and answer from inside a GUI process (no
 * controlling terminal, no inherited shell), and that the app then boots all
 * the way with no `node` on PATH at all. What it no longer covers is the
 * premise in
 * `docs/DESKTOP_APP.md` §2 — that launchd hands a double-clicked `.app` the
 * stub unprompted. Nothing on a hosted runner can: it is a claim about an
 * un-provisioned user's login session. It is a documented manual check on a
 * real Mac instead (`docs/DESKTOP_APP.md` §5), and the domain's pre-existing
 * PATH is recorded on every run so the day a runner image stops widening it is
 * visible rather than inferred.
 *
 * Packaged-only. The dev shell is `electron .` with no bundle for LaunchServices
 * to open, and an unpackaged run would also find its server through
 * `CALANDRIA_REPO_ROOT`, which is the crutch this lane exists to remove.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { instanceEnv, instanceRoot, serverIsUp } from "./fixtures";

/** The `.app` bundle, set by the macOS lane after it packages and ad-hoc signs. */
const BUNDLE = process.env.CALANDRIA_TEST_APP_BUNDLE || null;

test.describe.configure({ mode: "serial" });

test.skip(
  process.platform !== "darwin" || !BUNDLE,
  "macOS + packaged only: set CALANDRIA_TEST_APP_BUNDLE to the .app bundle"
);

/**
 * Clear of the `_electron` specs' pool. Those start at
 * CALANDRIA_DESKTOP_E2E_PORT (4741) and step by 10 per instance; +200 leaves
 * room for twenty of them, and this app is launched by the OS rather than by
 * `launchShell()`, so it cannot take its port from the shared counter.
 */
const PORT = Number(process.env.CALANDRIA_DESKTOP_E2E_PORT || 4741) + 200;

/** What launchd hands a GUI app when nothing has widened it. */
const STUB_PATH_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"]);

/**
 * The value launchd gives a GUI process with no PATH override in its domain —
 * `supervisor.js`'s `LAUNCHD_PATH_DIRS` minus `/usr/local/bin`, which that set
 * tolerates but launchd does not actually supply. Planted rather than awaited;
 * see the header.
 */
const STUB_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

let root = "";
let logFile = "";
let env: Record<string, string> = {};
/** The domain's own PATH override before this spec planted the stub, restored in `afterAll`. */
let priorDomainPath: string | null = null;

function launchctl(args: string[]): void {
  execFileSync("launchctl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

/** The launchd user domain's PATH override, or null when it has none. */
function domainPath(): string | null {
  try {
    const out = execFileSync("launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readLog(): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}

/**
 * `test.skip()` above marks every test in the file, and Playwright does not run
 * a suite's hooks when it has skipped the whole suite — but these hooks shell
 * out to `launchctl` and `open`, which exist on exactly one platform, so they
 * check for themselves rather than trusting that.
 */
const ACTIVE = process.platform === "darwin" && !!BUNDLE;

test.beforeAll(() => {
  if (!ACTIVE) return;
  root = instanceRoot("macos-launchd");
  logFile = path.join(root, "open.log");
  env = { ...instanceEnv(root, PORT) };
  // Belt and braces: `instanceEnv()` already omits this for a packaged run, and
  // planting it in the launchd domain would outlive the test and point a
  // developer's own Calandria at this checkout.
  delete env.CALANDRIA_REPO_ROOT;

  for (const [k, v] of Object.entries(env)) launchctl(["setenv", k, v]);

  // PATH last, and on its own: it is the subject rather than part of the
  // instance, it has to be put back exactly as found rather than unset, and the
  // value it displaces is evidence — the only thing on this machine that says
  // whether a real double-click here would have been handed the stub.
  priorDomainPath = domainPath();
  launchctl(["setenv", "PATH", STUB_PATH]);

  // `-n`: a fresh instance even if a Calandria is already running (the
  // single-instance lock is 01-shell's subject, not this file's).
  // `--stdout`/`--stderr`: the supervisor narrates its own PATH decision on
  // stdout, and with no CDP connection that narration is the entire evidence.
  execFileSync("open", ["-n", "-a", BUNDLE!, "--stdout", logFile, "--stderr", logFile], {
    stdio: ["ignore", "ignore", "pipe"],
  });
});

test.afterAll(async () => {
  if (!ACTIVE) return;
  // Ask nicely first: `before-quit` is what runs `supervisor.stop()`, so a
  // SIGKILL here would orphan the two sidecars on their pinned ports and the
  // next run on this box would collide with them.
  try {
    execFileSync("osascript", ["-e", 'quit app id "dev.calandria.desktop"'], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
  } catch {
    /* fall through to the kill below */
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await serverIsUp(`http://127.0.0.1:${PORT}`))) {
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    execFileSync("pkill", ["-f", BUNDLE!], { stdio: "ignore" });
  } catch {
    /* nothing left to kill is the expected case */
  }

  // The launchd domain is the user's, not this process's: leaving these set
  // would follow every GUI app the session starts afterwards.
  for (const k of Object.keys(env)) {
    try {
      launchctl(["unsetenv", k]);
    } catch {
      /* best effort — the session is ephemeral anyway */
    }
  }
  // PATH is RESTORED, not unset: on a machine whose domain carried an override
  // (every hosted runner so far) unsetting it would leave every GUI app started
  // afterwards narrower than this spec found things.
  try {
    launchctl(priorDomainPath ? ["setenv", "PATH", priorDomainPath] : ["unsetenv", "PATH"]);
  } catch {
    /* best effort — the session is ephemeral anyway */
  }
});

test("a GUI-launched .app boots, and the supervisor repairs launchd's stub PATH", async ({}, testInfo) => {
  // Everything below is read off one boot, so it is one test rather than four:
  // a second `open` would be a second app fighting this one for the lock.
  await expect
    .poll(() => serverIsUp(`http://127.0.0.1:${PORT}`), { timeout: 150_000, intervals: [1000] })
    .toBe(true);

  const log = readLog();
  await testInfo.attach("open.log", { body: log, contentType: "text/plain" });

  // Recorded before the assertions, because it is the one fact that decides how
  // to read a red run here: if the domain carried no override, this machine
  // would have produced the stub on its own and the plant was redundant.
  await testInfo.attach("launchd-domain-path.txt", {
    body:
      `launchd user-domain PATH override before this spec planted the stub:\n` +
      `${priorDomainPath ?? "(none — a GUI launch on this machine gets launchd's stub unprompted)"}\n\n` +
      `planted for the app under test: ${STUB_PATH}\n`,
    contentType: "text/plain",
  });

  // (1) A GUI-launched app really does reach `needsPathRepair()` with the PATH
  // launchd gave it, and that function still recognises the stub. The
  // supervisor logs this line only on that branch, so its presence IS the
  // measurement. Failing here means one of two things, and open.log now
  // distinguishes them: a `PATH is not launchd's stub` line means the planted
  // value did not survive LaunchServices, anything else means the supervisor
  // never got as far as the decision.
  //
  // What this does NOT prove is that launchd would have supplied the stub by
  // itself — see the header; that premise is a manual check on a real Mac.
  expect(
    log,
    "the supervisor did not report a stub PATH. Either the planted launchd PATH did not reach the app (read open.log for the 'PATH is not' line), or needsPathRepair() no longer recognises it."
  ).toContain("PATH looked like launchd's stub");

  // (2) …and the probe succeeded rather than falling through to the warning.
  // Both branches log; only one of them means the app can see `gh` and `codex`.
  expect(
    log,
    "the login-shell probe failed under a GUI launch, so the app is running with launchd's short PATH"
  ).not.toContain("the login-shell probe failed");

  // (3) How much the repair actually recovered on this machine — RECORDED, not
  // asserted. A bare GitHub runner's login shell may have nothing beyond
  // macOS's own /etc/paths, every entry of which is already in the stub set, in
  // which case the repair is a correct no-op rather than a failure; a
  // developer's Mac with nvm and Homebrew is where it earns its keep. Failing
  // on the first would red the lane for a property of the runner image. What
  // (1) and (2) assert — that the stub was detected and the login shell
  // answered — holds either way, so this is context for whoever reads the run,
  // and the number to compare against if the repair is ever suspected of
  // recovering the wrong thing.
  //
  // Read from the TEST's shell, not the app's: the app's own login shell ran
  // inside a GUI process and its answer is only visible as the effect asserted
  // above. Same user, same rc files, so it is the right order of magnitude.
  const loginPath = execFileSync(process.env.SHELL || "/bin/zsh", [
    "-ilc",
    'printf "%s" "$PATH"',
  ]).toString();
  const widened = loginPath.split(path.delimiter).filter((p) => p && !STUB_PATH_DIRS.has(p));
  await testInfo.attach("login-shell-path.txt", {
    body: `${loginPath}\n\nbeyond launchd's stub: ${widened.length ? widened.join(", ") : "(nothing — the repair was a no-op here)"}\n`,
    contentType: "text/plain",
  });

  // (4) It booted all the way, from an environment with no `node` on PATH at
  // all: `resolveNode()` fell back to the Node the bundle ships in
  // `Contents/Resources/node`. On a hosted runner the toolcache node is exactly
  // what a child-process launch would have leaked in, and it is absent here.
  expect(log).toMatch(/\[shell] node: .*Resources\/node\//);
  expect(log).toMatch(/\[shell] ready on http:\/\/127\.0\.0\.1:\d+/);

  // (5) And the thing that answered is the app, not the pty sidecar next door.
  const version = await fetch(`http://127.0.0.1:${PORT}/api/version`).then((r) => r.json());
  expect(typeof version.version).toBe("string");
});
