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

const updater = require(path.join(DESKTOP, "updater.js")) as {
  autoUpdateEnabled: (env: Env) => boolean;
  updaterDisposition: (opts: {
    env?: Env;
    platform?: string;
    packaged?: boolean;
    appImage?: string | null;
  }) => Disposition;
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
  INSTALL_FALLBACK_MS: number;
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

describe("electron-updater has to actually be in the package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));

  // app-builder-lib collects production dependencies through a mechanism
  // entirely separate from the `files` globs, and splices `!**/node_modules/**`
  // into those globs unconditionally — so naming it in `files` would do nothing
  // and moving it to devDependencies would ship a shell that throws on the
  // require the moment a packaged build reaches startUpdater().
  it("is a production dependency, not a dev one", () => {
    expect(pkg.dependencies?.["electron-updater"]).toBeTruthy();
    expect(pkg.devDependencies?.["electron-updater"]).toBeUndefined();
  });

  it("is pinned in desktop/package-lock.json as a non-dev package", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package-lock.json"), "utf8"));
    const entry = lock.packages?.["node_modules/electron-updater"];
    expect(entry).toBeTruthy();
    expect(entry.dev).toBeFalsy();
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
    expect(updater.INSTALL_FALLBACK_MS).toBeGreaterThan(0);
  });
});
