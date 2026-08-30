/* Auto-update policy for the desktop shell.
 *
 * Electron-free on purpose, the same rule notifier.js follows: everything here
 * is a pure decision over plain values, so desktop/test-supervisor.js and
 * tests/desktopUpdater.test.ts can `require()` it with no display, no Electron
 * and no network. main.js holds the effects — the `electron-updater` handle,
 * the dialogs, the tray — and asks this file what to do.
 *
 * The feed already exists. electron-builder's `github` provider (see
 * electron-builder.cjs) writes latest.yml / latest-mac.yml / latest-linux.yml
 * and the .blockmaps beside every published artifact, and
 * .github/workflows/release-desktop.yml publishes with `--publish always`
 * rather than hand-rolling `gh release upload`, which would produce downloads
 * with no feed. So this is a purely client-side addition: nothing about the
 * release lane changes to make it work.
 *
 * THE ONE RULE. An update must never restart the app around the drain. This is
 * a supervisor for long-running agent turns, and `electron-updater`'s default
 * `autoInstallOnAppQuit` installs from an `app.on("quit")` handler, which fires
 * AFTER main.js's `before-quit` has already finished draining and called
 * `app.exit(0)` — so the install would either never run or run over the top of
 * turns that were still settling. main.js therefore sets that default to false
 * and calls `quitAndInstall()` itself as the last thing the drain does;
 * `quitAction()` below is the predicate that decides that, and it is tested.
 */
"use strict";

// Two clocks, both deliberately unhurried. The first check waits for boot to
// settle so a launch is never competing with the sidecars for bandwidth on the
// slow first start, and the repeat is long because a desktop supervisor is a
// thing people leave running for weeks, not a thing they relaunch hourly.
const FIRST_CHECK_DELAY_MS = 45_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// If the installer hands back instead of taking the process down, do not leave
// a drained, sidecar-less window sitting there looking alive.
const INSTALL_FALLBACK_MS = 10_000;

const OFF_VALUES = new Set(["0", "off", "false", "no", "disabled"]);

/**
 * The opt-out knob. Documented in .env.example next to the other
 * CALANDRIA_DESKTOP_* vars, and read straight off `process.env` because that is
 * how the whole desktop shell reads config — it has no lib/config.ts and
 * deliberately does not load one (see supervisor.js, which takes an injectable
 * `env` for the same reason this takes one).
 *
 * Default ON. That is safe to default because "on" here only ever means CHECK
 * and DOWNLOAD: installing is always an explicit choice, so the worst a default
 * can do is spend some bandwidth and light up a tray item.
 */
function autoUpdateEnabled(env = {}) {
  const raw = env.CALANDRIA_DESKTOP_AUTO_UPDATE;
  if (raw == null || raw === "") return true;
  return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * Whether this particular install can update itself, and if not, what to tell
 * the user. Called BEFORE `require("electron-updater")` — see the note on the
 * linux-package case, which is the reason the order matters.
 *
 * `appImage` is `process.env.APPIMAGE`, which the AppImage runtime sets to the
 * path of the running image. It is the only trustworthy runtime answer to "am I
 * an AppImage", and the AppImage is the only Linux artifact that can replace
 * itself.
 */
function updaterDisposition({ env = {}, platform, packaged, appImage = null } = {}) {
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
    // NOT a warning, and not something to attempt and let fail. On Linux
    // `electron-updater`'s exported `autoUpdater` is a lazily-constructed
    // singleton whose class is chosen at FIRST PROPERTY ACCESS, from a
    // `resources/package-type` marker electron-builder writes into every deb,
    // rpm and pacman build that has a `publish` config — which ours does. Touch
    // the getter inside a .deb install and you get a DebUpdater, whose install
    // path is `sudo dpkg -i <downloaded>` (falling back to
    // `apt install --allow-unauthenticated`). There is no
    // `allowUnverifiedLinuxPackages` setting to turn that off: it was checked
    // against electron-builder 26.15.3 and electron-updater 6.8.9 and exists in
    // neither, so the only way to make the unverified-package install
    // deliberate is to decide not to be on that path at all. Which is the right
    // answer regardless — a package installed by the system package manager is
    // the package manager's to replace, and an app that raises a sudo prompt to
    // update itself is one nobody should trust.
    return {
      enabled: false,
      code: "linux-package",
      reason: "Installed from a system package — updates come from your package manager.",
    };
  }
  return { enabled: true, code: "ok", reason: "" };
}

/**
 * What the drain does when it reaches the end.
 *
 * "install" only when the user explicitly asked for it AND there is something
 * downloaded to install. Both halves matter: a stale request against nothing
 * downloaded would hand `quitAndInstall()` an empty installer path and hang the
 * quit, and a download with no request is just a tray item waiting to be
 * clicked — a quit is not consent to be upgraded.
 */
function quitAction({ installRequested = false, phase = "idle" } = {}) {
  return installRequested && phase === "ready" ? "install" : "exit";
}

/**
 * The tray/menu entry. One function so the two menus cannot disagree, and pure
 * so the disabled-with-a-reason cases are testable.
 *
 * When the shell cannot update itself the item stays VISIBLE and disabled with
 * the reason as its label, rather than disappearing. A missing menu item reads
 * as "this app has no updates"; a greyed "Updates are managed by your package
 * manager" reads as what it is.
 */
function updateMenuItem(state = {}) {
  const { phase = "idle", version = null, disposition = null } = state;
  // No disposition yet means boot has not reached startUpdater(), so there is
  // genuinely nothing to check against — the application menu is built before
  // the server is up. Present, greyed, rather than absent and then appearing.
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
    case "off":
    default:
      return "Automatic updates are off";
  }
}

/**
 * `calandria_turns_active` out of GET /api/instance/metrics, which is
 * Prometheus text rather than JSON. Read-only and side-effect free, unlike
 * POST /api/instance/drain, which is the other thing that knows this number and
 * answers it by aborting them.
 *
 * Returns null rather than 0 when the number is not in the response, because
 * "the server did not tell me" and "nothing is running" lead to different
 * sentences in the restart prompt.
 */
function parseActiveTurns(metricsText) {
  if (typeof metricsText !== "string") return null;
  const match = /^calandria_turns_active[ \t]+(\d+(?:\.\d+)?)\s*$/m.exec(metricsText);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

/**
 * What the restart prompt says about the cost. The drain ABORTS in-flight turns
 * (lib/runner.ts's drainActiveTurns over lib/abort.ts's registry) — it does not
 * wait for the model to finish — so the wording says stopped, not finished. An
 * update prompt that undersells what it is about to interrupt is how a
 * supervisor loses someone an hour of work.
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
 * this session could ever help.
 *
 * `fatal` exists for exactly one case that matters: Squirrel.Mac refuses to
 * update an app whose code signature it cannot read, so an unsigned or ad-hoc
 * macOS build can never update, and re-checking every six hours would only fill
 * the log. That is on/off, not a transient.
 */
function classifyUpdaterError(err) {
  const text = String(err?.message || err || "");
  if (/code signature|not signed|codesign/i.test(text)) {
    return {
      message: "This build is not signed, so macOS will not install updates into it. Download a new version instead.",
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
  INSTALL_FALLBACK_MS,
  autoUpdateEnabled,
  classifyUpdaterError,
  parseActiveTurns,
  quitAction,
  restartNotice,
  updateMenuItem,
  updaterDisposition,
};
