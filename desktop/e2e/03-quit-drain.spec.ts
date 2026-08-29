/* Quitting the window drains the in-flight turn and stops the server.
 *
 * This is the whole point of `before-quit` and it has no browser equivalent: a
 * tab cannot stop the process that serves it. The chain under test is
 * `app.quit()` → `before-quit` (preventDefault, hold the quit open) →
 * `supervisor.stop()` → POST `/api/instance/drain` → `drainActiveTurns()`
 * settles every live turn → SIGTERM → exit, with SIGKILL as the backstop.
 *
 * Note what "drained" means: `drainActiveTurns()` ABORTS in-flight turns and
 * persists their interrupted state, the same settlement a Stop press produces.
 * So the assertion is that the row is settled (`running = 0`) in the database
 * AFTER the process is gone — the failure this catches is a bare exit cutting a
 * mid-write turn off, which leaves `running = 1` behind for `recoverFromCrash()`
 * to mop up on the next boot.
 *
 * A THIRD TEST covers the window's own close button, which on a desktop with a
 * working tray no longer quits at all: it hides the window and leaves the
 * server running, and the drain then happens on the explicit quit that follows
 * — with the window brought back for it. That is the tray's doing
 * (docs/DESKTOP_APP.md §5.1). It is skipped nowhere, but it BRANCHES: hiding
 * requires a status area that is really drawing the icon, which is a fact about
 * the session rather than about the platform, and where there is none the close
 * quits and drains directly. The drain assertions are the same either way,
 * which is the point — the Linux lane runs under `xvfb` with no
 * status-notifier host, so it is also the only place the no-tray branch is
 * covered at all.
 *
 * THE `app.quit()` PATH IS TWO TESTS, NOT ONE, AND BOTH HOLD ON EVERY
 * PLATFORM. They used to be split by platform: the drain rode on the SIGTERM that `supervisor.stop()` sent,
 * and Windows has no deliverable one — `child.kill("SIGTERM")` there is a
 * `TerminateProcess`, so `server.js` never reached its handler and the turn
 * was cut off mid-write. The supervisor now makes the drain request itself
 * before killing anything, which takes the signal out of the middle of the
 * chain, so the second test's `test.fail(win32)` annotation came off with that
 * change. The split survives it because the two tests assert different kinds
 * of thing — the first that the quit was held open and the processes are gone,
 * the second that the database says the turn settled — and the second can only
 * be read after the first has finished killing the server.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";
import { makeFixtureRepo } from "../../e2e/helpers";
import {
  attachShellLog,
  createProject,
  createTask,
  ensureOnboarded,
  getTask,
  launchShell,
  quitShell,
  sendMessage,
  serverIsUp,
  trayIsHosted,
  type Shell,
} from "./fixtures";

test.describe.configure({ mode: "serial" });

let shell: Shell;
/** Set by the first test, read by the second — the file runs serial. */
let quitTaskId = "";
let quitMs = 0;

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  // No-op when the test quit it already; the backstop matters when it failed
  // partway and the shell is still holding its ports.
  await quitShell(shell);
});

test("quitting holds the quit open and stops the server", async () => {
  shell = await launchShell("quit-drain", {
    env: {
      // The mock turn below sleeps well inside this, so a clean drain is what
      // the grace is for rather than a race against it. The supervisor waits
      // grace + 4s before reaching for SIGKILL.
      CALANDRIA_SHUTDOWN_GRACE_MS: "15000",
    },
  });

  await ensureOnboarded(shell.origin);
  const repoPath = makeFixtureRepo("desktop-drain");
  const project = await createProject(shell.origin, "Desktop Drain", repoPath);
  const task = await createTask(shell.origin, {
    projectId: project.id,
    title: "Hold a turn open",
    // Long enough that the quit lands mid-turn no matter how slow the runner is.
    description: "Take your time. e2e:sleep=30000",
  });
  await sendMessage(shell.origin, task.id);

  // Only quit once the turn is genuinely live — otherwise this asserts nothing.
  await expect
    .poll(async () => (await getTask(shell.origin, task.id)).running, {
      timeout: 60_000,
      message: "the mock turn never started",
    })
    .toBe(1);

  const origin = shell.origin;
  const started = Date.now();
  await shell.app.evaluate(async ({ app }) => app.quit());
  await shell.app.waitForEvent("close", { timeout: 90_000 });
  quitMs = Date.now() - started;
  quitTaskId = task.id;

  // The quit was held open for the drain rather than returning instantly...
  expect(shell.proc.exitCode ?? shell.proc.signalCode).not.toBeNull();
  // ...and nothing is listening on the origin the window was loaded from, i.e.
  // `supervisor.stop()` reaped the sidecars rather than orphaning them holding
  // the port. True on every platform: this half needs no signal semantics, only
  // that the child died.
  expect(await serverIsUp(origin)).toBe(false);
});

test("the in-flight turn was settled rather than cut off mid-write", async () => {
  // Read the DB directly: there is no server left to ask.
  const db = new Database(dbFile(shell.dbDir), { readonly: true });
  try {
    const row = db.prepare("SELECT started, running FROM tasks WHERE id = ?").get(quitTaskId) as
      | { started: number; running: number }
      | undefined;
    expect(row, "the task row is missing from the database").toBeTruthy();
    expect(row!.started).toBe(1);
    expect(
      row!.running,
      `the turn was still marked running after the shell exited (quit took ${quitMs}ms) — ` +
        "before-quit returned before server.js finished draining"
    ).toBe(0);
  } finally {
    db.close();
  }
});

test("closing the window hides it where there is a tray, quits where there is not — and drains either way", async () => {
  // TWO CLAIMS, ONE INSTANCE, because the second only means anything after the
  // first: closing the window no longer quits (the server keeps running with
  // the turn in flight), and quitting afterwards puts the window back on screen
  // to carry the drain.
  //
  // The X button used to BE the quit on Windows and Linux, and this test used
  // to assert that chain. It changed with the tray: a shell that can be present
  // without a window can afford to treat close as "put it away", and on a
  // window whose job is supervising long agent turns that is the better default
  // — an absent-minded X should not settle work in flight, however cleanly.
  // See "Close vs quit" in docs/DESKTOP_APP.md §5.1. What did NOT change is the
  // reason the old test existed: whenever a drain does run, the window has to
  // be in front of the user for it, or a shutdown that takes up to
  // CALANDRIA_SHUTDOWN_GRACE_MS + 4 s reads as a hang — and now that quit can
  // be asked for from the tray with nothing on screen, `showDraining()` has to
  // un-hide the window first.
  //
  // Runs on macOS too, unlike the version before it: hiding on close is now one
  // rule on all three platforms (it also keeps the SPA's state, which a real
  // close throws away), so there is nothing platform-specific left to skip.
  //
  // IT IS CONDITIONAL ON ONE THING, AND THAT IS WHY THIS TEST BRANCHES rather
  // than asserting the hide outright: hiding happens only where a status area
  // is really drawing the tray icon, since hiding into a session with no status
  // area is how a user loses the app. That is not a property of the platform,
  // so it cannot be a `test.skip` — it is a property of the desktop the shell
  // launched on, and both answers are correct behaviour. The runners split
  // cleanly: `windows-desktop` and `macos-desktop` have a status area by
  // construction, while the Linux lane runs under `xvfb` with no
  // status-notifier host at all and therefore takes the QUIT branch — which is
  // the only coverage the no-tray branch has anywhere in this suite.
  //
  // The shell used to gate this on `new Tray()` not throwing, which on Linux
  // succeeds whether or not an icon ever appears; `desktop/tray-residency.js`
  // now asks the session, and `trayIsHosted()` reads the verdict the shell
  // logged. The two branches meet again immediately: whichever one runs, the
  // drain assertions below are the same, because a close that quits still
  // quits through `before-quit`.
  //
  // Its own instance: the shell above is gone, and this one ends too.
  shell = await launchShell("close-drain", { env: { CALANDRIA_SHUTDOWN_GRACE_MS: "15000" } });
  await ensureOnboarded(shell.origin);
  const repoPath = makeFixtureRepo("desktop-close");
  const project = await createProject(shell.origin, "Desktop Close", repoPath);
  const task = await createTask(shell.origin, {
    projectId: project.id,
    title: "Hold a turn open",
    description: "Take your time. e2e:sleep=30000",
  });
  await sendMessage(shell.origin, task.id);
  await expect
    .poll(async () => (await getTask(shell.origin, task.id)).running, {
      timeout: 60_000,
      message: "the mock turn never started",
    })
    .toBe(1);

  // Registered BEFORE the close: `app.waitForEvent("close")` only sees events
  // that arrive after it is called, and this drain can be over in ~200 ms.
  let exited = false;
  shell.proc.once("exit", () => {
    exited = true;
  });

  // The drain state is READ FROM INSIDE the main process, at the moment
  // `before-quit` runs, and left on disk to be read after the exit. Sampling it
  // from out here would be a race the shell wins: settling one aborted mock
  // turn takes ~200 ms end to end, the same order as a CDP round trip, so a
  // spec that polled the live window would go green or red on runner speed.
  // This listener is registered after main.js's, so it runs while that one is
  // awaiting `supervisor.stop()` with the quit already prevented.
  const statePath = path.join(shell.root, "drain-state.json");
  await shell.app.evaluate(async ({ app, BrowserWindow }, file) => {
    app.on("before-quit", async () => {
      const w = BrowserWindow.getAllWindows()[0];
      const state = {
        windows: BrowserWindow.getAllWindows().length,
        visible: w?.isVisible() ?? false,
        title: w?.getTitle() ?? "",
        overlay: "",
      };
      // The title is set synchronously; the overlay lands an IPC hop later and
      // the un-hide is a round trip to the window manager, so poll for both
      // rather than record a half-applied state.
      for (let i = 0; i < 40 && !(state.overlay && state.visible); i++) {
        state.visible = w?.isVisible() ?? false;
        state.overlay = await (w?.webContents
          .executeJavaScript("document.getElementById('calandria-draining')?.innerText || ''")
          .catch(() => "") ?? Promise.resolve(""));
        if (!(state.overlay && state.visible)) await new Promise((r) => setTimeout(r, 50));
      }
      // `require` is not in scope for a Playwright-evaluated function (measured:
      // undefined), but the main process is a CommonJS entry, so its module's
      // own require is.
      process.mainModule!.require("node:fs").writeFileSync(file, JSON.stringify(state));
    });
  }, statePath);

  const origin = shell.origin;
  // Asked BEFORE the close, so the expectation is set by the session rather
  // than fitted to whatever happened.
  const hosted = await trayIsHosted(shell);
  await shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());

  if (hosted) {
    // CLAIM ONE. The window goes away, the window OBJECT does not, and neither
    // does the server: a hidden Calandria is a running Calandria. Polled rather
    // than read once — `hide()` is an async trip to the window manager, and on
    // Linux a compositor can take a frame or two to unmap.
    await expect
      .poll(
        async () =>
          shell.app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            return { windows: BrowserWindow.getAllWindows().length, visible: w?.isVisible() ?? false };
          }),
        { timeout: 15_000, message: "the window never hid" }
      )
      .toEqual({ windows: 1, visible: false });
    expect(await serverIsUp(origin), "closing the window took the server down with it").toBe(true);
    expect((await getTask(origin, task.id)).running, "closing the window settled the in-flight turn").toBe(1);
    expect(exited, "closing the window quit the app").toBe(false);

    // CLAIM TWO. Now quit for real, from where the tray's Quit item goes.
    await shell.app.evaluate(({ app }) => app.quit());
  } else {
    // CLAIM ONE, the other way round: with no tray to hide into, the close IS
    // the quit — and it goes through `app.quit()` rather than letting the
    // window be destroyed, which is what keeps the drain below in the chain at
    // all. A close that merely fell through to `window-all-closed` would take
    // the same route; one that let the window close and the app exit would not,
    // and the drain assertions after this branch are what tell them apart.
    //
    // Nothing else is asserted here, deliberately: everything worth saying
    // about this branch is that the drain still ran, which is the shared tail.
    expect(shell.log.join("\n"), "the shell hid into a status area it never confirmed").toContain(
      "closing the window will quit"
    );
  }

  await expect
    .poll(() => fs.existsSync(statePath), { timeout: 90_000, message: "before-quit never ran" })
    .toBe(true);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    windows: number;
    visible: boolean;
    title: string;
    overlay: string;
  };
  // Both halves matter, and they show in different places: the title is what a
  // window manager renders (and on a desktop that draws no title bar, nothing
  // does), the overlay is on the page, where the user is actually looking.
  expect(state.windows, "the window was gone while the drain was still running").toBe(1);
  expect(state.visible).toBe(true);
  expect(state.title).toContain("finishing in-flight turns");
  expect(state.overlay).toContain("Finishing in-flight turns");

  // ...and it is a shutdown, not a hang: the process goes, the port goes with
  // it, and the turn is settled rather than cut off — the same three facts the
  // `app.quit()` path is held to above.
  await expect.poll(() => exited, { timeout: 90_000, message: "the shell never exited" }).toBe(true);
  expect(await serverIsUp(origin)).toBe(false);
  const db = new Database(dbFile(shell.dbDir), { readonly: true });
  try {
    const row = db.prepare("SELECT running FROM tasks WHERE id = ?").get(task.id) as { running: number } | undefined;
    expect(row?.running, "the turn was still marked running after the quit").toBe(0);
  } finally {
    db.close();
  }
});

/**
 * `calandria.db` today; the app keeps a pre-rename `orchestrator.db` in place
 * rather than moving it (lib/storage.mjs), so resolve rather than hardcode.
 */
function dbFile(dbDir: string): string {
  const found = fs.readdirSync(dbDir).filter((f) => f.endsWith(".db") && !f.includes(".lock."));
  expect(found, `no database under ${dbDir}`).not.toHaveLength(0);
  return path.join(dbDir, found.includes("calandria.db") ? "calandria.db" : found[0]);
}
