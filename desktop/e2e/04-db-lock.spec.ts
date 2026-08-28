/* A database already claimed by another Calandria reads as a refusal, not a crash.
 *
 * `server.js` catches `DbLockHeldError`, prints who holds it and exits 1. The
 * shell's job is to say the right thing about that: `supervisor.js`'s
 * `spawnChild` classifies an app-sidecar exit(1) whose log names the holder as
 * `dbLockHeld`, and `main.js`'s `onExit` turns that into "Another Calandria
 * instance is already running against this database" rather than "the app
 * crashed (code 1)" plus twenty lines of log tail.
 *
 * TWO MAIN-PROCESS CALLS ARE REPLACED WITH RECORDERS, and both replacements buy
 * something the assertion needs:
 *
 *   `dialog.showErrorBox` is MODAL and synchronous. Under Xvfb there is no
 *   window manager to dismiss it, so leaving it in place would block the main
 *   process forever and this spec would only ever report a timeout.
 *
 *   `app.exit` is what runs immediately after. Recording it instead of taking
 *   it lets the spec read the exit code the shell chose AND then shut the
 *   instance down through `app.quit()` — otherwise `app.exit(1)` orphans the
 *   pty sidecar, which outlives the run holding a port.
 *
 * The patches are installed right after `electron.launch()` resolves, which is
 * at Electron process start; the collision cannot happen until the sidecar has
 * booted Node, loaded the app and waited out `CALANDRIA_DB_LOCK_WAIT_MS`. The
 * margin is seconds against a round trip of milliseconds.
 */

import { expect, test } from "@playwright/test";
import { attachShellLog, instanceRoot, launchShell, quitShell, type Shell } from "./fixtures";

test.describe.configure({ mode: "serial" });

let shell: Shell | null = null;
let release: (() => void) | null = null;

test.afterEach(async ({}, testInfo) => {
  await attachShellLog(testInfo, shell);
});

test.afterAll(async () => {
  await quitShell(shell);
  release?.();
});

test('a held database reads as "another Calandria is already running"', async () => {
  // Claim the lock the way any other Calandria process would — the same
  // `lib/db-lock.mjs` mutex server.js takes at boot, on a database nothing else
  // has ever opened.
  const root = instanceRoot("db-lock");
  const dbDir = `${root}/db`;
  const dbLock = await import("../../lib/db-lock.mjs");
  await dbLock.acquireDbLock({ dir: dbDir });
  release = () => dbLock.releaseDbLock();

  shell = await launchShell("db-lock-shell", {
    // Point the shell at the already-claimed database, and don't wait for an
    // app URL that will never load.
    env: {
      CALANDRIA_DB_DIR: dbDir,
      // The sidecar's own patience for a predecessor still shutting down. 3s is
      // long enough to be a real wait and short enough to keep the spec quick.
      CALANDRIA_DB_LOCK_WAIT_MS: "3000",
    },
    waitForApp: false,
  });

  await shell.app.evaluate(async ({ app, dialog }) => {
    const g = globalThis as unknown as {
      __dialogs: Array<{ title: string; detail: string }>;
      __exit: number | null;
      __realExit: (code?: number) => void;
    };
    g.__dialogs = [];
    g.__exit = null;
    g.__realExit = app.exit.bind(app);
    dialog.showErrorBox = (title: string, detail: string) => {
      g.__dialogs.push({ title, detail });
    };
    app.exit = (code?: number) => {
      g.__exit = code ?? 0;
    };
  });

  await expect
    .poll(
      async () =>
        shell!.app.evaluate(async () => {
          const g = globalThis as unknown as {
            __dialogs: Array<{ title: string; detail: string }>;
            __exit: number | null;
          };
          return { dialogs: g.__dialogs, exit: g.__exit };
        }),
      { timeout: 90_000, message: "the shell never reported the db-lock collision" }
    )
    .toMatchObject({ exit: 1 });

  const { dialogs } = await shell.app.evaluate(async () => ({
    dialogs: (globalThis as unknown as { __dialogs: Array<{ title: string; detail: string }> }).__dialogs,
  }));

  expect(dialogs).toHaveLength(1);
  // "Calandria stopped", not "Calandria could not start": the shell classified
  // this as a sidecar that exited on purpose, which is what makes the wording
  // below reachable at all.
  expect(dialogs[0].title).toBe("Calandria stopped");
  expect(dialogs[0].detail).toMatch(/[Aa]nother Calandria (instance )?is already running/);
  // The crash wording, and the log tail that goes with it, must NOT be what the
  // user sees here.
  expect(dialogs[0].detail).not.toMatch(/exited unexpectedly/);

  // Hand `app.exit` back before quitting, or `before-quit`'s own `app.exit(0)`
  // lands in the recorder and the process never goes away.
  await shell.app.evaluate(async ({ app }) => {
    app.exit = (globalThis as unknown as { __realExit: (code?: number) => void }).__realExit;
  });
});
