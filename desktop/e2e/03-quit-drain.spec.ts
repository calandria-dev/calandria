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
 * TWO TESTS, NOT ONE, AND BOTH HOLD ON EVERY PLATFORM. They used to be split
 * by platform: the drain rode on the SIGTERM that `supervisor.stop()` sent,
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

/**
 * `calandria.db` today; the app keeps a pre-rename `orchestrator.db` in place
 * rather than moving it (lib/storage.mjs), so resolve rather than hardcode.
 */
function dbFile(dbDir: string): string {
  const found = fs.readdirSync(dbDir).filter((f) => f.endsWith(".db") && !f.includes(".lock."));
  expect(found, `no database under ${dbDir}`).not.toHaveLength(0);
  return path.join(dbDir, found.includes("calandria.db") ? "calandria.db" : found[0]);
}
