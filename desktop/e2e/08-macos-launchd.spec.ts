/* The launchd PATH repair, against a real GUI launch.
 *
 * `desktop/test-supervisor.js` already tests `needsPathRepair()` and
 * `loginShellPath()` against a synthetic environment, but the claim the
 * repair makes is about the OS: a `.app` opened from Finder, Spotlight or the
 * Dock is started by launchd and inherits `/usr/bin:/bin:/usr/sbin:/sbin`
 * instead of the PATH the same user has in Terminal, so `codex`, `gh`, a
 * Homebrew `git` and an nvm-managed `node` are all invisible to a
 * double-clicked Calandria while working from a window over. No spec can
 * reach that environment from a child-process launch.
 *
 * So this spec `open`s the packaged bundle, which goes through
 * LaunchServices exactly as a double-click does, and reads back what the
 * supervisor said about the PATH launchd handed it. What a hosted runner can
 * produce is a launchd launch, not an un-provisioned user's launchd launch,
 * so this does not prove that launchd hands a double-clicked `.app` the stub
 * unprompted; that premise stays a manual check on a real Mac.
 *
 * Why not `electron.launch()`: every other spec here starts the binary as a
 * child of the test process, so the app inherits the runner's own PATH
 * (node from `setup-node`'s tool cache, Homebrew, the lot), the environment
 * in which the repair is a no-op. The price of using `open` instead is that
 * Playwright has no CDP connection to the app: the evidence here is the
 * process's stdout (`open --stdout`) and its HTTP surface, not
 * `app.evaluate()`.
 *
 * How the instance stays hermetic, and why `open` runs with no PATH:
 *
 * `electron.launch({ env })` is unavailable here, so the instance goes into
 * the user's launchd domain with `launchctl setenv`, the domain GUI apps
 * started afterwards inherit from. The full `instanceEnv()` shape goes in
 * and comes back out in `afterAll`, so the app under test gets the same temp
 * directories, ports and mock agent as every other spec in this suite.
 *
 * `open(1)` states that opened applications inherit environment variables as
 * if launched directly through their full path, so the app's environment is
 * the launchd domain overlaid with `open`'s own, and for any key both hold,
 * the caller wins. PATH is therefore removed from the environment handed to
 * `open`: with no PATH in the caller's environment there is nothing to
 * overlay, so the domain's planted stub is what the app is handed. That
 * keeps LaunchServices in the launch while making launchd the sole origin of
 * the variable under test. `CALANDRIA_REPO_ROOT` is deleted from both the
 * domain and `open`'s environment for the same reason: it would let a
 * packaged app find its server through the checkout, the crutch this lane
 * exists to remove.
 *
 * The domain's own pre-existing PATH is read before the plant and attached
 * to every run: since it comes from `launchctl getenv` rather than from a
 * launch, it is not shadowed the way a reading taken from inside an `open`
 * launch would be, and it is the evidence for whether the plant changed
 * anything on this machine.
 *
 * Packaged-only. The dev shell is `electron .` with no bundle for
 * LaunchServices to open, and an unpackaged run would also find its server
 * through `CALANDRIA_REPO_ROOT`, the crutch this lane exists to remove.
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
 * The value launchd gives a GUI process with no PATH override in its domain:
 * `supervisor.js`'s `LAUNCHD_PATH_DIRS` minus `/usr/local/bin`, which that
 * set tolerates but launchd does not actually supply. Planted rather than
 * observed; see the header.
 */
const STUB_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

let root = "";
let logFile = "";
let env: Record<string, string> = {};
/** The domain's own PATH override before this spec planted the stub, restored in `afterAll`. */
let priorDomainPath: string | null = null;
/** Whether the process that ran `open` had a PATH of its own to withhold. Recorded, not asserted. */
let callerHadPath = false;

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
 * `test.skip()` above marks every test in the file, and Playwright does not
 * run a suite's hooks when it has skipped the whole suite. These hooks shell
 * out to `launchctl` and `open`, which exist on exactly one platform, so
 * they check for themselves rather than trusting that.
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
  // instance, it has to be put back exactly as found rather than unset, and
  // the value it displaces is evidence: the only thing on this machine that
  // says whether a real double-click here would have been handed the stub.
  priorDomainPath = domainPath();
  launchctl(["setenv", "PATH", STUB_PATH]);

  // The environment handed to `open`, which is also most of the environment
  // handed to the app: see the header. PATH is removed rather than set,
  // because a value here would shadow the domain's and this spec would be
  // back to measuring what it typed in. Removing it leaves launchd as the
  // only source the app has for the one variable under test.
  //
  // `CALANDRIA_REPO_ROOT` goes for the reason the planted copy does: it
  // would let a packaged app find its server through the checkout, the
  // crutch this lane exists to remove. It is not normally set in a CI shell;
  // deleting it costs nothing and closes the path by which a developer
  // running this suite locally would weaken it without noticing.
  const openEnv: NodeJS.ProcessEnv = { ...process.env };
  callerHadPath = typeof openEnv.PATH === "string" && openEnv.PATH.length > 0;
  delete openEnv.PATH;
  delete openEnv.CALANDRIA_REPO_ROOT;

  // `/usr/bin/open`, by absolute path: the environment above has no PATH to
  // resolve a bare `open` with.
  // `-n`: a fresh instance even if a Calandria is already running (the
  // single-instance lock is 01-shell's subject, not this file's).
  // `--stdout`/`--stderr`: the supervisor narrates its own PATH decision on
  // stdout, and with no CDP connection that narration is the entire evidence.
  execFileSync("/usr/bin/open", ["-n", "-a", BUNDLE!, "--stdout", logFile, "--stderr", logFile], {
    stdio: ["ignore", "ignore", "pipe"],
    env: openEnv,
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
      /* best effort: the session is ephemeral anyway */
    }
  }
  // PATH is restored, not unset: on a machine whose domain carries an
  // override, unsetting it would leave every GUI app started afterwards
  // narrower than this spec found things.
  try {
    launchctl(priorDomainPath ? ["setenv", "PATH", priorDomainPath] : ["unsetenv", "PATH"]);
  } catch {
    /* best effort: the session is ephemeral anyway */
  }
});

test("a GUI-launched .app boots, and the supervisor repairs launchd's stub PATH", async ({}, testInfo) => {
  // Everything below is read off one boot, so it is one test rather than four:
  // a second `open` would be a second app fighting this one for the lock.
  await expect
    .poll(() => serverIsUp(`http://127.0.0.1:${PORT}`), { timeout: 150_000, intervals: [1000] })
    .toBe(true);

  // The server answering is not the same as the log having been written, and
  // the gap between them is a race this test can lose. `serverIsUp()` and
  // the supervisor's own readiness poll ask `/api/version` the same question
  // independently, so ours can be answered a tick before the supervisor
  // writes `[shell] ready on ...`, and `open --stdout` buffers on top of
  // that. Sampling open.log once at that instant can read a boot still
  // mid-narration, so waiting for the final line is what makes the snapshot
  // below a whole one; a truncated log would pass the negative assertion in
  // (2) vacuously.
  await expect
    .poll(() => readLog(), { timeout: 30_000, intervals: [250] })
    .toMatch(/\[shell] ready on http:\/\/127\.0\.0\.1:\d+/);

  const log = readLog();
  await testInfo.attach("open.log", { body: log, contentType: "text/plain" });

  // Recorded before the assertions, because it is the one fact that decides
  // how to read a red run here: if the domain carried no override, this
  // machine would have produced the stub on its own and the plant was
  // redundant.
  //
  // Written to stdout as well as to an attachment, since the lane uploads
  // `test-results/` with `if-no-files-found: ignore`, and a green run leaves
  // nothing there. On exactly the runs where this reading is trustworthy,
  // the attachment is never uploaded, so the job log is kept as a second
  // copy of the evidence.
  console.log(
    `[08-macos-launchd] launchd user-domain PATH before the plant: ${priorDomainPath ?? "(none)"}`
  );
  await testInfo.attach("launchd-domain-path.txt", {
    body:
      `launchd user-domain PATH override before this spec planted the stub:\n` +
      `${priorDomainPath ?? "(none — a GUI launch on this machine gets launchd's stub unprompted)"}\n\n` +
      `planted for the app under test: ${STUB_PATH}\n` +
      `PATH withheld from open(1)'s environment: ${callerHadPath ? "yes" : "no — the caller had none to withhold"}\n\n` +
      `Read the first line as the premise check docs/DESKTOP_APP.md §2 asks for:\n` +
      `"none" means this machine would have handed a double-clicked .app the\n` +
      `stub on its own and the plant was redundant. Any other value means the\n` +
      `plant is what put the app in the state the assertions below measure.\n`,
    contentType: "text/plain",
  });

  // (1) A GUI-launched app reaches `needsPathRepair()` with the PATH launchd
  // gave it, and that function recognises the stub. The supervisor logs this
  // line only on that branch, so its presence is the measurement. Failing
  // here means one of three things, and open.log distinguishes them: a
  // `PATH is not launchd's stub` line whose value is this job's own PATH
  // means `open` forwarded a caller environment (check that the launch below
  // still deletes PATH); one carrying some other wide value means the
  // launchd domain, not the plant, is what the app read; anything else means
  // the supervisor never got as far as the decision.
  //
  // What this does not prove is that launchd would supply the stub on its
  // own; that premise is a manual check on a real Mac.
  expect(
    log,
    "the supervisor did not report a stub PATH. Read open.log for the 'PATH is not launchd's stub, using it as-is:' line — the value it prints names which environment reached the app."
  ).toContain("PATH looked like launchd's stub");

  // (2) …and the probe succeeded rather than falling through to the warning.
  // Both branches log; only one of them means the app can see `gh` and `codex`.
  expect(
    log,
    "the login-shell probe failed under a GUI launch, so the app is running with launchd's short PATH"
  ).not.toContain("the login-shell probe failed");

  // (3) How much the repair actually recovered on this machine, recorded
  // and not asserted. A bare GitHub runner's login shell may have nothing
  // beyond macOS's own /etc/paths, every entry of which is already in the
  // stub set, in which case the repair is a correct no-op rather than a
  // failure; a developer's Mac with nvm and Homebrew is where it earns its
  // keep. Failing on the first would red the lane for a property of the
  // runner image. What (1) and (2) assert, that the stub was detected and
  // the login shell answered, holds either way, so this is context for
  // whoever reads the run, and the number to compare against if the repair
  // is ever suspected of recovering the wrong thing.
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
