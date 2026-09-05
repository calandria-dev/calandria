/* Auto-update policy for the desktop shell.
 *
 * Pure decisions over plain values, with no Electron or network dependency, so
 * desktop/test-supervisor.js and tests/desktopUpdater.test.ts can `require()`
 * it directly. main.js holds the effects: the `electron-updater` handle, the
 * dialogs, the tray, and asks this file what to do.
 *
 * electron-builder's `github` provider (see electron-builder.cjs) writes
 * latest.yml / latest-mac.yml / latest-linux.yml and the .blockmaps beside
 * every published artifact, and .github/workflows/release-desktop.yml
 * publishes with `--publish always`, so the feed already exists and nothing
 * about the release lane needs to change.
 *
 * An update must never restart the app around the drain. This is a supervisor
 * for long-running agent turns, and `electron-updater`'s default
 * `autoInstallOnAppQuit` installs from an `app.on("quit")` handler, which fires
 * after main.js's `before-quit` has already finished draining and called
 * `app.exit(0)`, so the install would either never run or run over turns that
 * were still settling. main.js sets that default to false and calls
 * `quitAndInstall()` itself as the last thing the drain does; `quitAction()`
 * below is the predicate that decides that.
 */
"use strict";

// Two clocks, both unhurried. The first check waits for boot to settle so a
// launch is not competing with the sidecars for bandwidth on the slow first
// start, and the repeat is long because a desktop supervisor is a thing people
// leave running for weeks.
const FIRST_CHECK_DELAY_MS = 45_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How long the drain's tail waits for the installer to take the process down,
 * by stage, before it gives up and exits. A drained, sidecar-less window left
 * on screen looking alive is bad; an install killed halfway through is worse,
 * and the two failures need different clocks.
 *
 * With `autoInstallOnAppQuit` off (see the header), electron-updater's
 * MacUpdater does not hand the downloaded zip to Squirrel.Mac when its own
 * `update-downloaded` fires. Squirrel does nothing until `quitAndInstall()` is
 * called, inside finishQuit(), after the drain. Only then does Squirrel fetch
 * the zip from electron-updater's local proxy, extract the bundle, verify its
 * signature and stage it, before the app goes down.
 *
 * Stages are what Squirrel.Mac reports through Electron's native `autoUpdater`
 * (which MacUpdater drives but does not re-emit; main.js listens to it
 * directly): `handoff` is quitAndInstall() called and nothing heard yet,
 * `fetching` is Squirrel working (its `checking-for-update` /
 * `update-available`), `staged` is the bundle verified and swapped in
 * (`update-downloaded`, after which MacUpdater calls the native quitAndInstall),
 * `quitting` is Squirrel's `before-quit-for-update`. Windows and the AppImage
 * spawn their installer and exit within the `handoff` window; they never leave
 * it. `fetching` gets a long timeout: the cost of waiting is a "finishing…"
 * title on screen, the cost of not waiting is the update.
 */
const INSTALL_STAGE_TIMEOUT_MS = Object.freeze({
  handoff: 30_000,
  fetching: 10 * 60_000,
  staged: 60_000,
  quitting: 60_000,
});

/** Where a build that cannot update itself is sent instead. */
const RELEASES_URL = "https://github.com/calandria-dev/calandria/releases/latest";

/**
 * The day the release lane (.github/workflows/release-desktop.yml) started
 * signing and notarizing macOS artifacts. Every macOS install older than this,
 * and every locally built one, is ad-hoc signed and can never self-update (see
 * `macDisposition()`); this is the date the unsigned-build message names.
 */
const MAC_SIGNED_SINCE = "2026-08-30";

const OFF_VALUES = new Set(["0", "off", "false", "no", "disabled"]);

/**
 * The opt-out knob. Documented in .env.example next to the other
 * CALANDRIA_DESKTOP_* vars, and read straight off `process.env`, the way the
 * whole desktop shell reads config: it has no lib/config.ts and does not load
 * one (see supervisor.js, which takes an injectable `env` for the same reason).
 *
 * Defaults on, which is safe because "on" only means check and download.
 * Installing is always an explicit choice, so the worst a default can do is
 * spend some bandwidth and light up a tray item.
 */
function autoUpdateEnabled(env = {}) {
  const raw = env.CALANDRIA_DESKTOP_AUTO_UPDATE;
  if (raw == null || raw === "") return true;
  return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * Whether this particular install can update itself, and if not, what to tell
 * the user. Called before `require("electron-updater")`; see the note on the
 * linux-package case for why the order matters.
 *
 * `appImage` is `process.env.APPIMAGE`, which the AppImage runtime sets to the
 * path of the running image. It is the only trustworthy runtime answer to "am I
 * an AppImage", and the AppImage is the only Linux artifact that can replace
 * itself.
 *
 * `mac` is `{ bundlePath, signature }` for a packaged macOS build: where the
 * .app is and what `codesign` says about it (see `parseCodesign()`). Only read
 * on darwin, and optional there, because main.js fills it in from a subprocess
 * that can fail; with it absent, the disposition falls through to "try and see".
 */
function updaterDisposition({ env = {}, platform, packaged, appImage = null, mac = null } = {}) {
  if (!autoUpdateEnabled(env)) {
    return {
      enabled: false,
      code: "off",
      reason: "Automatic updates are turned off (CALANDRIA_DESKTOP_AUTO_UPDATE).",
    };
  }
  if (!packaged) {
    return {
      enabled: false,
      code: "unpackaged",
      reason: "This is a development build, which updates by git pull.",
    };
  }
  if (platform === "linux" && !appImage) {
    // On Linux, `electron-updater`'s exported `autoUpdater` is a
    // lazily-constructed singleton whose class is chosen at first property
    // access, from a `resources/package-type` marker electron-builder writes
    // into every deb, rpm and pacman build that has a `publish` config. Touching
    // the getter inside a .deb install produces a DebUpdater, whose install path
    // is `sudo dpkg -i <downloaded>` (falling back to
    // `apt install --allow-unauthenticated`), and there is no
    // `allowUnverifiedLinuxPackages` setting to turn that off. A package
    // installed by the system package manager is the package manager's to
    // replace.
    return {
      enabled: false,
      code: "linux-package",
      reason: "Installed from a system package — updates come from your package manager.",
    };
  }
  if (platform === "darwin" && mac) {
    const verdict = macDisposition(mac);
    if (verdict) return verdict;
  }
  return { enabled: true, code: "ok", reason: "" };
}

/**
 * The three ways a macOS install cannot update itself, decided at boot from
 * facts about the bundle.
 *
 * electron-updater does no signature check of its own on macOS; Squirrel.Mac
 * does, and with `autoInstallOnAppQuit` off, Squirrel only runs inside
 * finishQuit(), after the drain and with the tray gone. Reading `codesign` once
 * at startup puts the answer in the menu before the first check, where a
 * greyed item can say what a failed quit could not.
 *
 * The three:
 * - `mac-dmg`: running from the mounted disk image (`/Volumes/…`), where the
 *   bundle directory is read-only and Squirrel has nowhere to swap the new
 *   bundle in.
 * - `mac-translocated`: Gatekeeper app translocation
 *   (`…/AppTranslocation/<uuid>/d/Calandria.app`), a read-only randomized mount
 *   macOS uses for a quarantined app run from where it was unzipped; the real
 *   bundle is elsewhere and Squirrel would update the wrong path.
 * - `mac-unsigned`: ad-hoc or unsigned. Squirrel.Mac refuses to update an app
 *   whose own signature it cannot read. Every build from before
 *   MAC_SIGNED_SINCE and every local `dist:mac` (desktop/signing.js defaults
 *   to the ad-hoc identity) is in this bucket, and the only way out is a manual
 *   download of a signed one.
 */
function macDisposition({ bundlePath = "", signature = null } = {}) {
  const p = String(bundlePath || "");
  if (/^\/Volumes\//.test(p)) {
    return {
      enabled: false,
      code: "mac-dmg",
      reason: "Calandria is running from its disk image. Drag it to Applications and relaunch to get updates.",
    };
  }
  if (/\/AppTranslocation\//.test(p)) {
    return {
      enabled: false,
      code: "mac-translocated",
      reason:
        "macOS is running this copy from a quarantine location. Move Calandria to Applications and relaunch to get updates.",
    };
  }
  if (signature === "adhoc" || signature === "unsigned") {
    return {
      enabled: false,
      code: "mac-unsigned",
      reason:
        `This build is not signed with a Developer ID, so macOS will not let it update itself. ` +
        `Installs from before ${MAC_SIGNED_SINCE}, and local builds, need a manual download of the latest release.`,
    };
  }
  return null;
}

/**
 * What `codesign -dv --verbose=4 <bundle>` said. Its report goes to STDERR, and
 * an unsigned bundle is exit 1 with one line, so both streams and the exit code
 * are read together.
 *
 * `developer-id` is the only answer Squirrel.Mac will update; `adhoc` and
 * `unsigned` are the two it refuses; `other` is a real certificate that is not
 * Developer ID (an Apple Development cert, say), which is left alone because
 * Squirrel accepts a new bundle whose designated requirement matches the
 * running one, whoever signed them; `unknown` is "codesign said nothing usable"
 * and is also left alone, since a probe that failed must not disable a working
 * updater.
 */
function parseCodesign({ stdout = "", stderr = "" } = {}) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  if (/code object is not signed at all/i.test(text)) return { signature: "unsigned", authority: null };
  if (/^Signature=adhoc\s*$/m.test(text)) return { signature: "adhoc", authority: null };
  const authorities = [...text.matchAll(/^Authority=(.+?)\s*$/gm)].map((m) => m[1]);
  if (authorities.some((a) => /^Developer ID Application\b/i.test(a))) {
    return { signature: "developer-id", authority: authorities[0] };
  }
  if (authorities.length) return { signature: "other", authority: authorities[0] };
  return { signature: "unknown", authority: null };
}

/**
 * The bundle a running macOS binary belongs to: `Calandria.app/Contents/MacOS/
 * Calandria` → `Calandria.app`. Pure string work so it can be tested off-Mac.
 */
function macBundlePath(execPath) {
  if (!execPath) return null;
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath));
  return m ? m[1] : null;
}

/**
 * The watchdog the drain's tail arms after `quitAndInstall()`: how long to wait
 * at this stage before deciding the installer is not going to take the process
 * down. See INSTALL_STAGE_TIMEOUT_MS for the stages and why they differ.
 */
function installStageTimeout(stage) {
  return INSTALL_STAGE_TIMEOUT_MS[stage] ?? INSTALL_STAGE_TIMEOUT_MS.handoff;
}

/**
 * Which stage a native Squirrel.Mac event moves the install to, or null for one
 * that says nothing about progress. `update-not-available` is null because
 * Squirrel answering "nothing to install" to a feed electron-updater built from
 * the file it just downloaded is not progress; it is a failure the `error`
 * event will not report, and the `handoff` clock is the right one to keep
 * running.
 */
function installStageOf(nativeEvent) {
  switch (nativeEvent) {
    case "checking-for-update":
    case "update-available":
      return "fetching";
    case "update-downloaded":
      return "staged";
    case "before-quit-for-update":
      return "quitting";
    default:
      return null;
  }
}

/**
 * What the next launch says about an install that did not happen.
 *
 * The failure lands after the drain, when the tray is gone and the window is on
 * its way out, so it cannot be shown where it happens. main.js writes a record
 * and exits; the next boot reads it and shows this. `stage` is where the
 * watchdog was when it gave up (or "error" for an installer error), and the
 * log path is named because the updater's own trace is in it and that trace is
 * the thing a bug report needs.
 */
function installFailureNotice({ version = null, stage = "handoff", message = "", logPath = "" } = {}) {
  const what = version ? `Calandria ${version}` : "The update";
  const why =
    stage === "error"
      ? message || "The installer reported an error."
      : `The installer did not finish (gave up while ${stage}). The app you are running is unchanged.`;
  const detail = [why, logPath ? `Details are in ${logPath}.` : "", `You can download it from ${RELEASES_URL}.`]
    .filter(Boolean)
    .join("\n\n");
  return { message: `${what} did not install`, detail };
}

/**
 * What the drain does when it reaches the end.
 *
 * "install" only when the user explicitly asked for it and there is something
 * downloaded to install. Both halves matter: a stale request against nothing
 * downloaded would hand `quitAndInstall()` an empty installer path and hang the
 * quit, and a download with no request is just a tray item waiting to be
 * clicked. A quit is not consent to be upgraded.
 */
function quitAction({ installRequested = false, phase = "idle" } = {}) {
  return installRequested && phase === "ready" ? "install" : "exit";
}

/**
 * The tray/menu entry. One function so the two menus cannot disagree, and pure
 * so the disabled-with-a-reason cases are testable.
 *
 * When the shell cannot update itself, the item stays visible and disabled
 * with the reason as its label. A missing menu item reads as "this app has no
 * updates"; a greyed "Updates are managed by your package manager" reads as
 * what it is.
 */
function updateMenuItem(state = {}) {
  const { phase = "idle", version = null, disposition = null } = state;
  // No disposition yet means boot has not reached startUpdater(), so there is
  // nothing to check against yet; the application menu is built before the
  // server is up. The item is present and greyed from the start.
  if (!disposition) return { label: "Check for updates…", enabled: false };
  if (!disposition.enabled) {
    return { label: disabledLabel(disposition.code), enabled: false };
  }
  switch (phase) {
    case "checking":
      return { label: "Checking for updates…", enabled: false };
    case "downloading":
      return { label: version ? `Downloading ${version}…` : "Downloading update…", enabled: false };
    case "ready":
      return { label: version ? `Restart to update to ${version}` : "Restart to update", enabled: true };
    default:
      return { label: "Check for updates…", enabled: true };
  }
}

function disabledLabel(code) {
  switch (code) {
    case "linux-package":
      return "Updates come from your package manager";
    case "unpackaged":
      return "Updates are off in a development build";
    case "mac-dmg":
    case "mac-translocated":
      return "Move Calandria to Applications to get updates";
    case "mac-unsigned":
      return "Updates need a manual download (unsigned build)";
    case "off":
    default:
      return "Automatic updates are off";
  }
}

/**
 * `calandria_turns_active` out of GET /api/instance/metrics, served as
 * Prometheus text. Read-only and side-effect free, unlike POST
 * /api/instance/drain, which reads the same number and answers it by aborting
 * the turns.
 *
 * Returns null when the number is not in the response, since "the server did
 * not answer" and "nothing is running" produce different sentences in the
 * restart prompt.
 */
function parseActiveTurns(metricsText) {
  if (typeof metricsText !== "string") return null;
  const match = /^calandria_turns_active[ \t]+(\d+(?:\.\d+)?)\s*$/m.exec(metricsText);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

/**
 * What the restart prompt says about the cost. The drain aborts in-flight
 * turns (lib/runner.ts's drainActiveTurns over lib/abort.ts's registry); it
 * does not wait for the model to finish, so the wording says the turns were
 * stopped. Understating what an update interrupts risks losing someone an hour
 * of work.
 */
function restartNotice(activeTurns) {
  const settle = "in-flight turns are stopped and settled before the update installs";
  if (activeTurns == null) return `Any ${settle}.`;
  if (activeTurns === 0) return "Nothing is running right now, so this is a clean restart.";
  const subject = activeTurns === 1 ? "1 turn is running" : `${activeTurns} turns are running`;
  return `${subject}. They will be stopped and settled before the update installs.`;
}

/**
 * Turn an updater error into something worth showing, and say whether retrying
 * this session could help.
 *
 * `fatal` covers the case where Squirrel.Mac refuses to update an app whose
 * code signature it cannot read: an unsigned or ad-hoc macOS build can never
 * update, and re-checking every six hours would only fill the log. That
 * verdict is a fixed property of the build, so it never becomes retryable.
 */
function classifyUpdaterError(err) {
  const text = String(err?.message || err || "");
  if (/code signature|not signed|codesign/i.test(text)) {
    return {
      message:
        `This build is not signed, so macOS will not install updates into it. ` +
        `Download the latest release instead: ${RELEASES_URL}`,
      fatal: true,
    };
  }
  if (/404|no published versions|cannot find .*\.yml|latest(-mac|-linux)?\.yml/i.test(text)) {
    return { message: "There is no published release to update from yet.", fatal: false };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|socket hang up|timed? ?out/i.test(text)) {
    return { message: "Could not reach the update server. Check your connection and try again.", fatal: false };
  }
  return { message: text || "The update check failed.", fatal: false };
}

module.exports = {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  INSTALL_STAGE_TIMEOUT_MS,
  MAC_SIGNED_SINCE,
  RELEASES_URL,
  autoUpdateEnabled,
  classifyUpdaterError,
  installFailureNotice,
  installStageOf,
  installStageTimeout,
  macBundlePath,
  macDisposition,
  parseActiveTurns,
  parseCodesign,
  quitAction,
  restartNotice,
  updateMenuItem,
  updaterDisposition,
};
