/* Quitting the window drains the in-flight turn and stops the server.
 *
 * This is the whole point of `before-quit` and it has no browser equivalent: a
 * tab cannot stop the process that serves it. The chain under test is
 * `app.quit()` → `before-quit` (preventDefault, hold the quit open) →
 * `supervisor.stop()` → SIGTERM → server.js's own handler → POST
 * `/api/instance/drain` → `drainActiveTurns()` settles every live turn → exit.
 *
 * Note what "drained" means: `drainActiveTurns()` ABORTS in-flight turns and
 * persists their interrupted state, the same settlement a Stop press produces.
 * So the assertion is that the row is settled (`running = 0`) in the database
 * AFTER the process is gone — the failure this catches is a bare exit cutting a
 * mid-write turn off, which leaves `running = 1` behind for `recoverFromCrash()`
 * to mop up on the next boot.
 *
 * TWO TESTS, NOT ONE, BECAUSE WINDOWS SPLITS THEM. The chain above has a POSIX
 * signal in the middle of it, and Windows has no deliverable SIGTERM:
 * `child.kill("SIGTERM")` there is a `TerminateProcess`, so `server.js` never
 * runs its handler and the drain is skipped entirely (supervisor.js's `stop()`
 * says so in as many words). Everything on either side of that link still
 * holds — the quit is held open, both sidecars are reaped, the port is
 * released — so those are asserted for every platform in the first test, and
 * the DB settlement gets its own, marked `test.fail()` on win32.
 *
 * `test.fail()` rather than `test.skip()` deliberately: a skip would sit green
 * forever after the shell learns to POST `/api/instance/drain` itself before
 * killing ("Desktop shell: drain in-flight turns on quit under Windows"),
 * whereas an expected failure that starts passing turns the Windows lane RED
 * and forces this annotation to come off in the same change that fixes it.
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
  // See the file header: on Windows the kill IS the termination, so server.js
  // never reaches its drain and this row stays `running = 1` until the next
  // boot's `recoverFromCrash()` clears it. Expected-to-fail, so the day the
  // shell drains before killing, this lane says so.
  test.fail(
    process.platform === "win32",
    "no deliverable SIGTERM on Windows: supervisor.stop() TerminateProcess-es server.js before it can drain " +
      "(fixed by the shell POSTing /api/instance/drain itself — see docs/DESKTOP_E2E.md §4)"
  );

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
