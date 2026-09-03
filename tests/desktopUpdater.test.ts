// The desktop auto-update policy.
//
// The feature is small; the way it can go wrong is not. This app supervises
// long-running agent turns, so an update that restarts the process is an update
// that can destroy work in flight. desktop/main.js already drains those turns on
// quit — `before-quit` prevents the default, POSTs /api/instance/drain, stops
// the sidecars, and only then exits — and the entire risk in adding an updater
// is that the restart takes some other route to the same exit.
//
// electron-updater makes that easy to get wrong by default: `autoInstallOnAppQuit`
// is true out of the box and installs from an `app.on("quit")` handler, which
// fires AFTER our `before-quit` has finished draining and called `app.exit(0)`.
// So the shipped default is one that either skips the install silently or runs
// it over turns that were still settling.
//
// Five things are pinned here:
//   1. `quitAction()` — the predicate the drain consults at its very end. An
//      install happens only on an explicit request against a real download.
//   2. desktop/main.js turns `autoInstallOnAppQuit` off, and the ONLY
//      `quitAndInstall` call site in the file is inside the drain's tail.
//   3. A Linux install that is not an AppImage never reaches electron-updater at
//      all, because on that path the module installs with `sudo dpkg -i`.
//   4. `electron-updater` is a production dependency, which is the only reason
//      electron-builder packs it (desktop/electron-builder.cjs's `files` list
//      cannot and does not).
//   5. The user-facing strings — the restart prompt and the menu labels — say
//      what actually happens, including that in-flight turns are STOPPED.
//   6. The drain's tail does not kill the install it just started. With
//      autoInstallOnAppQuit off, MacUpdater hands the zip to Squirrel.Mac only
//      INSIDE quitAndInstall(), so the fetch, extract and signature check all
//      run after the drain — and a fixed 10s exit there (which is what shipped)
//      took the app down mid-install every time. The watchdog is now staged on
//      Squirrel's own progress, and a failure is written down for the next
//      launch to report.
//   7. A macOS install that can never update — ad-hoc signed, running from the
//      DMG, or translocated — is told so at boot from `codesign` and the bundle
//      path, not discovered on the way out of the process.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DESKTOP = path.join(ROOT, "desktop");

// Same trick as tests/desktopSigning.test.ts and tests/desktopPayload.test.ts:
// desktop/ has its own package tree, so this is loaded by absolute path rather
// than through "@/*". desktop/updater.js is deliberately dependency-free,
// Electron-free CommonJS for exactly this reason — it is pure policy, and every
// effect lives in main.js.
const require = createRequire(import.meta.url);

type Env = Record<string, string | undefined>;
type Disposition = { enabled: boolean; code: string; reason: string };
type MenuItem = { label: string; enabled: boolean };

type MacFacts = { bundlePath?: string; signature?: string | null };

const updater = require(path.join(DESKTOP, "updater.js")) as {
  autoUpdateEnabled: (env: Env) => boolean;
  updaterDisposition: (opts: {
    env?: Env;
    platform?: string;
    packaged?: boolean;
    appImage?: string | null;
    mac?: MacFacts | null;
  }) => Disposition;
  macDisposition: (facts: MacFacts) => Disposition | null;
  parseCodesign: (result: { stdout?: string; stderr?: string; code?: number }) => {
    signature: string;
    authority: string | null;
  };
  macBundlePath: (execPath: string | null) => string | null;
  installStageTimeout: (stage: string) => number;
  installStageOf: (nativeEvent: string) => string | null;
  installFailureNotice: (record: {
    version?: string | null;
    stage?: string;
    message?: string;
    logPath?: string;
  }) => { message: string; detail: string };
  INSTALL_STAGE_TIMEOUT_MS: Record<string, number>;
  MAC_SIGNED_SINCE: string;
  RELEASES_URL: string;
  quitAction: (opts: { installRequested?: boolean; phase?: string }) => "install" | "exit";
  updateMenuItem: (state: {
    phase?: string;
    version?: string | null;
    disposition?: Disposition | null;
  }) => MenuItem;
  parseActiveTurns: (text: unknown) => number | null;
  restartNotice: (active: number | null | undefined) => string;
  classifyUpdaterError: (err: unknown) => { message: string; fatal: boolean };
  CHECK_INTERVAL_MS: number;
  FIRST_CHECK_DELAY_MS: number;
};

// The structural assertions below read main.js as text, so they have to read
// the CODE and not the prose around it — desktop/main.js is heavily commented,
// and several of those comments name the very calls being counted ("never
// `updater.quitAndInstall()` directly", "`app.quit()`, never `app.exit()`").
// Block comments and whole-line `//` comments go; a `//` mid-line is left alone
// so the `http://127.0.0.1` in a template literal survives intact.
const mainSource = fs
  .readFileSync(path.join(DESKTOP, "main.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const packaged = (env: Env = {}, platform = "darwin", appImage: string | null = null) =>
  updater.updaterDisposition({ env, platform, packaged: true, appImage });

describe("the install is something the drain does, not something that races it", () => {
  it("installs only when the user asked AND there is a download to install", () => {
    expect(updater.quitAction({ installRequested: true, phase: "ready" })).toBe("install");
  });

  // Both halves matter independently. A quit is not consent to be upgraded, so
  // a finished download on its own must never install; and a stale request
  // against nothing downloaded would hand quitAndInstall() an empty installer
  // path, which hangs the quit rather than failing it.
  it("does not install on an ordinary quit, however ready the update is", () => {
    expect(updater.quitAction({ installRequested: false, phase: "ready" })).toBe("exit");
  });

  it("does not install on a request that has nothing downloaded behind it", () => {
    for (const phase of ["idle", "checking", "downloading", "none", "error"]) {
      expect(updater.quitAction({ installRequested: true, phase })).toBe("exit");
    }
  });

  it("defaults to exiting", () => {
    expect(updater.quitAction({})).toBe("exit");
  });
});

describe("desktop/main.js routes the restart through the drain", () => {
  // The default installs from `app.on("quit")`, which fires after our
  // before-quit handler has already drained and exited. Leaving it on is the
  // single change that would make every other rule here decorative.
  it("turns electron-updater's install-on-quit default off", () => {
    expect(mainSource).toMatch(/autoInstallOnAppQuit\s*=\s*false/);
    expect(mainSource).not.toMatch(/autoInstallOnAppQuit\s*=\s*true/);
  });

  // One call site, and it is in finishQuit() — which the before-quit handler
  // calls from its `finally`, after `await supervisor.stop()`. If a second
  // appears, it is by definition a path that skipped the drain.
  it("has exactly one quitAndInstall call site, inside the drain's tail", () => {
    const callSites = mainSource.match(/\.quitAndInstall\(/g) ?? [];
    expect(callSites).toHaveLength(1);

    const finishQuit = mainSource.slice(
      mainSource.indexOf("function finishQuit()"),
      mainSource.indexOf("function messageBox("),
    );
    expect(finishQuit).not.toHaveLength(0);
    expect(finishQuit).toContain(".quitAndInstall(");
  });

  it("drains before it installs: the before-quit handler ends in finishQuit()", () => {
    const handler = mainSource.slice(
      mainSource.indexOf('app.on("before-quit"'),
      mainSource.indexOf("app.whenReady()"),
    );
    expect(handler).toContain("await supervisor.stop()");
    expect(handler).toContain("finishQuit()");
    // The old unconditional exit is gone from this handler. finishQuit() still
    // exits — it is the "exit" arm of quitAction — but it is now the one place
    // that decides.
    expect(handler).not.toMatch(/app\.exit\(0\)/);
  });

  // The user-facing "yes, update" button. app.quit() re-enters before-quit and
  // gets the drain; app.exit() would not.
  it("asks for the restart with app.quit(), never app.exit()", () => {
    const requestInstall = mainSource.slice(
      mainSource.indexOf("async function requestInstall()"),
      mainSource.indexOf("async function activeTurnCount()"),
    );
    expect(requestInstall).not.toHaveLength(0);
    expect(requestInstall).toContain("app.quit()");
    expect(requestInstall).not.toContain("app.exit(");
    expect(requestInstall).not.toContain("quitAndInstall");
  });

  // The gate has to run before the require, not after: on Linux the module's
  // `autoUpdater` export picks its implementation on first property access.
  it("requires electron-updater lazily, after the disposition gate", () => {
    const startUpdater = mainSource.slice(
      mainSource.indexOf("function startUpdater()"),
      mainSource.indexOf("function trayUpdateItem()"),
    );
    const gate = startUpdater.indexOf("if (!updateDisposition.enabled)");
    const load = startUpdater.indexOf('require("electron-updater")');
    expect(gate).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(gate);
    // And nowhere else in the file, least of all at the top.
    expect(startUpdater.match(/require\("electron-updater"\)/g) ?? []).toHaveLength(1);
    expect(mainSource.match(/require\("electron-updater"\)/g) ?? []).toHaveLength(1);
  });
});

describe("the drain's tail waits for the install it started", () => {
  const finishQuit = mainSource.slice(
    mainSource.indexOf("function finishQuit()"),
    mainSource.indexOf("function armInstallWatchdog("),
  );

  // The shipped bug. MacUpdater.quitAndInstall() (electron-updater 6.8.9) is
  // where Squirrel.Mac is FIRST told to fetch the zip when autoInstallOnAppQuit
  // is off — electron-updater's own "update-downloaded" only means the zip is
  // in its cache and a local proxy is up. So after quitAndInstall() the whole
  // fetch + extract + signature verification of a ~200 MB bundle still lies
  // ahead, and a 10s app.exit(0) landed in the middle of it: the app quit and
  // relaunched unchanged, exactly as reported, signed build or not.
  it("does not arm a fixed short exit around quitAndInstall", () => {
    expect(finishQuit).not.toHaveLength(0);
    expect(finishQuit).not.toMatch(/INSTALL_FALLBACK_MS/);
    expect(finishQuit).not.toMatch(/setTimeout\([^)]*\b\d{4,5}\b/);
    expect(finishQuit).toContain('armInstallWatchdog("handoff")');
  });

  // Squirrel reports progress on Electron's native autoUpdater, which
  // MacUpdater drives but does not re-emit; the drain listens to it directly.
  it("re-arms the watchdog from Squirrel.Mac's own progress events", () => {
    expect(finishQuit).toContain('require("electron").autoUpdater');
    for (const event of ["checking-for-update", "update-available", "update-downloaded", "before-quit-for-update"]) {
      expect(finishQuit).toContain(`"${event}"`);
    }
    // And it never calls the native install itself — MacUpdater does that when
    // Squirrel is done. A second call site here would be the drain racing it.
    expect((mainSource.match(/\.quitAndInstall\(/g) ?? []).length).toBe(1);
  });

  it("gives a working Squirrel minutes and a silent one seconds", () => {
    const t = updater.INSTALL_STAGE_TIMEOUT_MS;
    expect(t.fetching).toBeGreaterThanOrEqual(5 * 60_000);
    expect(t.handoff).toBeGreaterThanOrEqual(10_000);
    expect(t.handoff).toBeLessThan(t.fetching);
    expect(t.staged).toBeLessThan(t.fetching);
    // The clock the tail arms first is the short one; an unknown stage gets it
    // too rather than the long one, so a typo cannot buy ten minutes.
    expect(updater.installStageTimeout("handoff")).toBe(t.handoff);
    expect(updater.installStageTimeout("nonsense")).toBe(t.handoff);
  });

  it("maps Squirrel's events onto stages, and 'nothing to install' onto none", () => {
    expect(updater.installStageOf("checking-for-update")).toBe("fetching");
    expect(updater.installStageOf("update-available")).toBe("fetching");
    expect(updater.installStageOf("update-downloaded")).toBe("staged");
    expect(updater.installStageOf("before-quit-for-update")).toBe("quitting");
    expect(updater.installStageOf("update-not-available")).toBe(null);
    expect(updater.installStageOf("error")).toBe(null);
  });

  // The failure lands after the tray is gone and the window is on its way out,
  // so it is written down and the next launch says it — naming the log,
  // because the updater's own trace is the thing a bug report needs.
  it("writes a failed install down and reports it on the next launch", () => {
    expect(finishQuit).toContain("recordInstallFailure(");
    // `afterAttach()` is what boot became when the shell learned to attach to
    // instances other than the local one (docs/DESKTOP_APP.md §8): it is the
    // tail every attach runs once a server has answered, and the updater is
    // armed there — once per process, since it updates the SHELL rather than
    // whichever server is on screen.
    const attached = mainSource.slice(
      mainSource.indexOf("async function afterAttach("),
      mainSource.indexOf("async function attachUrl(")
    );
    expect(attached).toContain("await startUpdater()");
    expect(attached).toContain("await reportLastInstallFailure()");

    const notice = updater.installFailureNotice({
      version: "0.7.0",
      stage: "fetching",
      logPath: "/Users/me/Library/Logs/Calandria/main.log",
    });
    expect(notice.message).toBe("Calandria 0.7.0 did not install");
    expect(notice.detail).toContain("unchanged");
    expect(notice.detail).toContain("/Users/me/Library/Logs/Calandria/main.log");
    expect(notice.detail).toContain(updater.RELEASES_URL);

    const errored = updater.installFailureNotice({ stage: "error", message: "Could not get code signature" });
    expect(errored.message).toBe("The update did not install");
    expect(errored.detail).toContain("Could not get code signature");
  });
});

describe("a macOS install that can never update is told so at boot", () => {
  const mac = (facts: MacFacts, env: Env = {}) =>
    updater.updaterDisposition({ env, platform: "darwin", packaged: true, mac: facts });

  // `codesign -dv --verbose=4` reports on stderr; an unsigned bundle is exit 1
  // with a single line. These are the shapes the real tool produces.
  it("reads what codesign said", () => {
    expect(
      updater.parseCodesign({
        stderr: [
          "Executable=/Applications/Calandria.app/Contents/MacOS/Calandria",
          "Identifier=dev.calandria.desktop",
          "CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded",
          "Authority=Developer ID Application: Calandria Contributors (ABCDE12345)",
          "Authority=Developer ID Certification Authority",
          "Authority=Apple Root CA",
          "Timestamp=30 Aug 2026 at 10:00:00",
        ].join("\n"),
      }),
    ).toEqual({
      signature: "developer-id",
      authority: "Developer ID Application: Calandria Contributors (ABCDE12345)",
    });
    expect(updater.parseCodesign({ stderr: "Signature=adhoc\nInfo.plist entries=30\n" })).toEqual({
      signature: "adhoc",
      authority: null,
    });
    expect(
      updater.parseCodesign({ stderr: "/Applications/Calandria.app: code object is not signed at all\n", code: 1 }),
    ).toEqual({ signature: "unsigned", authority: null });
    expect(updater.parseCodesign({ stderr: "Authority=Apple Development: Someone (XYZ)\n" }).signature).toBe("other");
    expect(updater.parseCodesign({})).toEqual({ signature: "unknown", authority: null });
  });

  it("finds the bundle from the running binary", () => {
    expect(updater.macBundlePath("/Applications/Calandria.app/Contents/MacOS/Calandria")).toBe(
      "/Applications/Calandria.app",
    );
    expect(updater.macBundlePath("/usr/local/bin/node")).toBe(null);
    expect(updater.macBundlePath(null)).toBe(null);
  });

  // Squirrel.Mac refuses an app whose signature it cannot read, and with
  // autoInstallOnAppQuit off it first looks inside quitAndInstall() — after the
  // drain, where nothing can show the refusal. Every build from before the lane
  // signed (and every local dist:mac, which defaults to ad-hoc) is one of these,
  // and the message says which and what to do instead.
  it("refuses an ad-hoc or unsigned build, naming the date and the way out", () => {
    for (const signature of ["adhoc", "unsigned"]) {
      const d = mac({ bundlePath: "/Applications/Calandria.app", signature });
      expect(d.enabled).toBe(false);
      expect(d.code).toBe("mac-unsigned");
      expect(d.reason).toContain(updater.MAC_SIGNED_SINCE);
      expect(d.reason).toMatch(/manual download/i);
    }
    expect(updater.MAC_SIGNED_SINCE).toBe("2026-08-30");
  });

  it("refuses a bundle running from the mounted disk image or a translocated path", () => {
    expect(mac({ bundlePath: "/Volumes/Calandria 0.6.2/Calandria.app", signature: "developer-id" })).toMatchObject({
      enabled: false,
      code: "mac-dmg",
    });
    expect(
      mac({
        bundlePath: "/private/var/folders/ab/T/AppTranslocation/1234-5678/d/Calandria.app",
        signature: "developer-id",
      }),
    ).toMatchObject({ enabled: false, code: "mac-translocated" });
  });

  it("updates a Developer ID build in /Applications, and leaves a failed probe alone", () => {
    expect(mac({ bundlePath: "/Applications/Calandria.app", signature: "developer-id" })).toMatchObject({
      enabled: true,
      code: "ok",
    });
    // A probe that said nothing usable must not disable a working updater.
    expect(mac({ bundlePath: "/Applications/Calandria.app", signature: "unknown" }).enabled).toBe(true);
    expect(mac({ bundlePath: "/Applications/Calandria.app", signature: "other" }).enabled).toBe(true);
    expect(updater.updaterDisposition({ env: {}, platform: "darwin", packaged: true, mac: null }).enabled).toBe(true);
  });

  // Off and dev-build come first, as everywhere; and the mac facts are only
  // ever consulted on darwin.
  it("is outranked by the off switch, and ignored off macOS", () => {
    expect(mac({ bundlePath: "/Applications/Calandria.app", signature: "adhoc" }, { CALANDRIA_DESKTOP_AUTO_UPDATE: "off" }).code).toBe("off");
    expect(
      updater.updaterDisposition({
        env: {},
        platform: "win32",
        packaged: true,
        mac: { bundlePath: "/Volumes/x/Calandria.app", signature: "adhoc" },
      }),
    ).toMatchObject({ enabled: true, code: "ok" });
  });

  it("greys the menu item with a reason that says what to do", () => {
    const unsigned = updater.updateMenuItem({
      disposition: mac({ bundlePath: "/Applications/Calandria.app", signature: "adhoc" }),
    });
    expect(unsigned.enabled).toBe(false);
    expect(unsigned.label).toMatch(/manual download/i);
    const dmg = updater.updateMenuItem({
      disposition: mac({ bundlePath: "/Volumes/Calandria/Calandria.app", signature: "developer-id" }),
    });
    expect(dmg.enabled).toBe(false);
    expect(dmg.label).toMatch(/Applications/);
  });

  // The probe is a subprocess that can fail, so it runs before the require and
  // its answer is the only mac-specific input the policy takes.
  it("is probed in main.js with codesign, before the updater is required", () => {
    const startUpdater = mainSource.slice(
      mainSource.indexOf("async function startUpdater()"),
      mainSource.indexOf("function trayUpdateItem()"),
    );
    expect(startUpdater).toContain("mac: await macBundleFacts()");
    expect(startUpdater).toContain('"/usr/bin/codesign"');
    expect(startUpdater.indexOf("macBundleFacts()")).toBeLessThan(startUpdater.indexOf('require("electron-updater")'));
  });
});

describe("which installs may update themselves", () => {
  it("updates a packaged macOS or Windows build by default", () => {
    expect(packaged({}, "darwin")).toMatchObject({ enabled: true, code: "ok" });
    expect(packaged({}, "win32")).toMatchObject({ enabled: true, code: "ok" });
  });

  // The AppImage is the only Linux artifact that can replace itself, and
  // process.env.APPIMAGE is the only runtime evidence that it is one.
  it("updates a Linux AppImage", () => {
    expect(packaged({}, "linux", "/opt/Calandria.AppImage")).toMatchObject({
      enabled: true,
      code: "ok",
    });
  });

  // The one that matters most. With a `publish` config present, the .deb
  // carries a resources/package-type marker, and electron-updater's autoUpdater
  // getter answers that marker with a DebUpdater whose install path is
  // `sudo dpkg -i`, falling back to `apt install --allow-unauthenticated`.
  // There is no allowUnverifiedLinuxPackages setting to turn that off (checked
  // against electron-builder 26.15.3 and electron-updater 6.8.9 — it exists in
  // neither), so the only way to make it deliberate is to stay off that path.
  it("refuses to update a Linux install that is not an AppImage", () => {
    const d = packaged({}, "linux", null);
    expect(d.enabled).toBe(false);
    expect(d.code).toBe("linux-package");
    expect(d.reason).toMatch(/package manager/i);
  });

  it("does not update a development build", () => {
    expect(updater.updaterDisposition({ env: {}, platform: "darwin", packaged: false })).toMatchObject({
      enabled: false,
      code: "unpackaged",
    });
  });

  // Env-driven, per the repo convention, and documented in .env.example.
  // Default on is safe only because "on" means check and download — never
  // install.
  it("is on unless CALANDRIA_DESKTOP_AUTO_UPDATE turns it off", () => {
    expect(updater.autoUpdateEnabled({})).toBe(true);
    expect(updater.autoUpdateEnabled({ CALANDRIA_DESKTOP_AUTO_UPDATE: "" })).toBe(true);
    expect(updater.autoUpdateEnabled({ CALANDRIA_DESKTOP_AUTO_UPDATE: "on" })).toBe(true);
    for (const off of ["0", "off", "OFF", "false", "no", " off "]) {
      expect(updater.autoUpdateEnabled({ CALANDRIA_DESKTOP_AUTO_UPDATE: off })).toBe(false);
    }
    expect(packaged({ CALANDRIA_DESKTOP_AUTO_UPDATE: "0" }, "win32")).toMatchObject({
      enabled: false,
      code: "off",
    });
  });

  // Checked before packaging and before the platform, so the escape hatch works
  // on the one platform whose updater cannot be talked out of anything.
  it("honours the off switch even on Linux and in development", () => {
    const env = { CALANDRIA_DESKTOP_AUTO_UPDATE: "off" };
    expect(packaged(env, "linux", "/opt/x.AppImage").code).toBe("off");
    expect(updater.updaterDisposition({ env, platform: "darwin", packaged: false }).code).toBe("off");
  });
});

describe("the menu item is the affordance that survives a hidden window", () => {
  const enabled: Disposition = { enabled: true, code: "ok", reason: "" };

  it("offers a manual check when idle", () => {
    expect(updater.updateMenuItem({ phase: "idle", disposition: enabled })).toEqual({
      label: "Check for updates…",
      enabled: true,
    });
  });

  it("names the version to restart into once one is downloaded", () => {
    expect(updater.updateMenuItem({ phase: "ready", version: "0.5.0", disposition: enabled })).toEqual({
      label: "Restart to update to 0.5.0",
      enabled: true,
    });
  });

  it("cannot be pressed while a check or download is in flight", () => {
    expect(updater.updateMenuItem({ phase: "checking", disposition: enabled }).enabled).toBe(false);
    expect(updater.updateMenuItem({ phase: "downloading", version: "0.5.0", disposition: enabled })).toEqual({
      label: "Downloading 0.5.0…",
      enabled: false,
    });
  });

  // Present and greyed with the reason, rather than absent. A missing item
  // reads as "this app has no updates"; this reads as what it is.
  it("stays visible and explains itself when the install cannot update", () => {
    const deb = updater.updateMenuItem({ disposition: packaged({}, "linux", null) });
    expect(deb.enabled).toBe(false);
    expect(deb.label).toMatch(/package manager/i);

    const dev = updater.updateMenuItem({
      disposition: updater.updaterDisposition({ env: {}, platform: "darwin", packaged: false }),
    });
    expect(dev).toEqual({ label: "Updates are off in a development build", enabled: false });
  });

  // The application menu is built in whenReady(), before boot() has reached
  // startUpdater(), so there is a real window in which there is nothing to
  // check against yet.
  it("is greyed before boot has decided anything", () => {
    expect(updater.updateMenuItem({})).toEqual({ label: "Check for updates…", enabled: false });
  });
});

describe("what the restart prompt tells the user it will cost", () => {
  it("reads the active turn count out of the Prometheus metrics text", () => {
    const metrics = [
      "# HELP calandria_turns_active Turns currently running",
      "# TYPE calandria_turns_active gauge",
      "calandria_turns_active 3",
      "calandria_tasks_total 41",
    ].join("\n");
    expect(updater.parseActiveTurns(metrics)).toBe(3);
    expect(updater.parseActiveTurns("calandria_turns_active 0\n")).toBe(0);
  });

  // "the server did not say" and "nothing is running" produce different
  // sentences, so they must not collapse to the same value.
  it("returns null rather than 0 when the number is not there", () => {
    expect(updater.parseActiveTurns("calandria_tasks_total 41\n")).toBe(null);
    expect(updater.parseActiveTurns("")).toBe(null);
    expect(updater.parseActiveTurns(undefined)).toBe(null);
    // A metric whose NAME merely starts the same must not be mistaken for it.
    expect(updater.parseActiveTurns("calandria_turns_active_total 7\n")).toBe(null);
  });

  // The drain aborts in-flight turns (lib/runner.ts's drainActiveTurns over
  // lib/abort.ts's registry); it does not wait for the model to finish. Saying
  // "finished" here would be how a supervisor loses someone an hour of work.
  it("says the turns are stopped, not finished", () => {
    expect(updater.restartNotice(2)).toBe(
      "2 turns are running. They will be stopped and settled before the update installs.",
    );
    expect(updater.restartNotice(1)).toMatch(/^1 turn is running\./);
    expect(updater.restartNotice(2)).not.toMatch(/finish/i);
    expect(updater.restartNotice(null)).not.toMatch(/finish/i);
  });

  it("says so plainly when nothing is running", () => {
    expect(updater.restartNotice(0)).toMatch(/clean restart/i);
  });
});

describe("update errors", () => {
  // Squirrel.Mac verifies the signature of the downloaded bundle and refuses an
  // app whose own signature it cannot read, so an unsigned or ad-hoc macOS
  // build can never auto-update. That is a property of the build, not a
  // transient — main.js stops the six-hourly retry on a fatal verdict.
  it("treats an unreadable code signature as fatal for the session", () => {
    const v = updater.classifyUpdaterError(new Error("Could not get code signature for running application"));
    expect(v.fatal).toBe(true);
    expect(v.message).toMatch(/not signed/i);
    expect(v.message).toContain(updater.RELEASES_URL);
  });

  // A fatal verdict on an AUTOMATIC check used to be a console.log line, in a
  // terminal no packaged app was launched from. It is now an OS notification.
  it("is announced by main.js on an automatic check, not only a manual one", () => {
    const startUpdater = mainSource.slice(
      mainSource.indexOf("async function startUpdater()"),
      mainSource.indexOf("async function macBundleFacts()"),
    );
    const onError = startUpdater.slice(startUpdater.indexOf('updater.on("error"'));
    expect(onError).toContain("if (!fatal) return;");
    expect(onError).toMatch(/new Notification\(\{ title: "Calandria cannot update itself"/);
  });

  it("treats a missing release and a dead network as retryable", () => {
    expect(updater.classifyUpdaterError(new Error("404 Not Found: latest-mac.yml")).fatal).toBe(false);
    expect(updater.classifyUpdaterError(new Error("getaddrinfo ENOTFOUND github.com"))).toMatchObject({
      fatal: false,
    });
  });

  it("passes an unrecognised message through rather than swallowing it", () => {
    expect(updater.classifyUpdaterError(new Error("something odd"))).toEqual({
      message: "something odd",
      fatal: false,
    });
  });
});

describe("electron-updater and electron-log have to actually be in the package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package-lock.json"), "utf8"));

  // app-builder-lib collects production dependencies through a mechanism
  // entirely separate from the `files` globs, and splices `!**/node_modules/**`
  // into those globs unconditionally — so naming it in `files` would do nothing
  // and moving it to devDependencies would ship a shell that throws on the
  // require the moment a packaged build reaches startUpdater() — or, for
  // electron-log, on the require at the top of main.js, before the window.
  it.each(["electron-updater", "electron-log"])("%s is a production dependency, not a dev one", (name) => {
    expect(pkg.dependencies?.[name]).toBeTruthy();
    expect(pkg.devDependencies?.[name]).toBeUndefined();
  });

  it.each(["electron-updater", "electron-log"])("%s is pinned in desktop/package-lock.json as a non-dev package", (name) => {
    const entry = lock.packages?.[`node_modules/${name}`];
    expect(entry).toBeTruthy();
    expect(entry.dev).toBeFalsy();
  });

  // The log file is the whole point of the dependency: the one place an
  // install that fails on the way out of the process leaves a trace. stdout
  // has to stay as it was, because desktop/e2e reads `[shell] …` lines off it
  // with startsWith.
  it("routes console output into the log file without changing stdout", () => {
    expect(mainSource).toContain('require("electron-log/main")');
    expect(mainSource).toContain("Object.assign(console, log.functions)");
    expect(mainSource).toMatch(/log\.transports\.console\.format\s*=\s*"\{text\}"/);
    expect(mainSource).toMatch(/updater\.logger\s*=\s*log\.scope\("updater"\)/);
  });

  // The feed the client reads is produced by the release lane's `--publish`,
  // not by any code here. If this block ever goes, the updater silently finds
  // nothing forever — which is why tests/desktopRelease.test.ts pins it too,
  // and why it is worth restating from the consumer's side.
  it("has a publish provider to read a feed from", () => {
    const configPath = path.join(DESKTOP, "electron-builder.cjs");
    delete require.cache[configPath];
    const config = require(configPath) as { publish?: unknown };
    expect(config.publish).toEqual([
      // `releaseType` belongs to this test too: the feed files are skipped by
      // the same refusal that skips the installers, so a draft-typed publish
      // leaves the updater with nothing to read even when downloads exist.
      // tests/desktopRelease.test.ts carries the full account.
      { provider: "github", owner: "calandria-dev", repo: "calandria", releaseType: "release" },
    ]);
  });
});

describe("the clocks", () => {
  // A desktop supervisor is something people leave running for weeks. The
  // first check waits for boot to settle rather than competing with the
  // sidecars for bandwidth on a slow first start.
  it("checks well after launch, and rarely after that", () => {
    expect(updater.FIRST_CHECK_DELAY_MS).toBeGreaterThanOrEqual(30_000);
    expect(updater.CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});
