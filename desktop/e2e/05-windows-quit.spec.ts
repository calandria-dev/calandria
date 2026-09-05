/* Windows only: what actually happens to the shell and its two node sidecars
 * when something outside the app ends the process.
 *
 * This is separate from 03-quit-drain, which quits through the product's own
 * path (`app.quit()`), the same code on every platform. This file covers the
 * paths a Windows user reaches for instead: `taskkill` and Task Manager's End
 * task, where the answer is decided by Win32 instead of by anything in
 * `main.js`, and where the two spellings differ in a way that leaves
 * processes behind.
 *
 *   `taskkill /pid n`        posts WM_CLOSE to the process's windows. Electron
 *                            turns that into the BrowserWindow's `close` event,
 *                            and `main.js` answers it by hiding into the tray:
 *                            the window goes away, the process does not, and no
 *                            quit lifecycle runs at all. Ending a task is not a
 *                            quit here, and neither is clicking the X.
 *   `taskkill /pid n /F`     is `TerminateProcess`. No window message, no
 *                            handler, no supervisor: the app hears nothing at
 *                            all, which is the fact about Windows asserted
 *                            below. What becomes of the two node sidecars is
 *                            not fixed by that fact: they are in no job
 *                            object, but their stdout and stderr are pipes
 *                            whose read ends die with the parent, so the first
 *                            thing either one logs is an EPIPE it does not
 *                            survive. `/T` walks the tree and is kept for the
 *                            case where a sidecar stays silent long enough to
 *                            outlive that.
 *
 * Close-to-quit was replaced by close-to-tray (`decideClose()` in `main.js`,
 * and the "Close vs quit" note it carries): hiding is gated on a status area
 * that is actually drawing the icon, and on win32 `confirmTrayResidency`
 * answers `hosted: true` unconditionally, because the status area is part of
 * the platform. So the sidecars outliving a plain `taskkill` is not a leak;
 * it is the app still running, exactly as it would be after the user clicked
 * X. Reaping is `app.quit()`'s job, and the test ends by proving it does it.
 *
 * What this file does not cover, and cannot: on a real Windows shutdown or
 * logout, `before-quit` and `will-quit` are not emitted at all. The session
 * ends through WM_QUERYENDSESSION/WM_ENDSESSION, which Electron does not
 * translate into the quit lifecycle. No test here or anywhere else in this
 * suite touches that path, and none should claim to: a shutdown-time drain
 * would need a `session-end` listener that does not exist yet. Read the two
 * tests below as "the app was ended by another process", not "the machine
 * went away".
 *
 * `will-quit` is recorded but not asserted on: `main.js`'s `before-quit`
 * handler ends in `app.exit(0)`, which skips the rest of the lifecycle, so
 * its absence is a property of the app's own handler rather than of Windows.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForTree } from "@/tests/waitForTree";
import { attachShellLog, launchShell, quitShell, serverIsUp, type Shell } from "./fixtures";

test.describe("Windows process termination", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(process.platform !== "win32", "taskkill and WM_CLOSE semantics are win32-only");

  let shell: Shell | null = null;

  test.afterEach(async ({}, testInfo) => {
    await attachShellLog(testInfo, shell);
  });

  test.afterAll(async () => {
    await quitShell(shell);
  });

  test("a plain taskkill is a WM_CLOSE, so the shell hides into the tray and keeps its sidecars", async () => {
    shell = await launchShell("win-taskkill");
    const origin = shell.origin;
    const marker = await quitEventRecorder(shell);
    const electron = await electronPid(shell);
    const sidecars = await bothSidecars(electron);

    expect(sidecars.app, sidecars.why("no server.js child of the Electron process")).toBeTruthy();
    expect(sidecars.pty, sidecars.why("no pty-server.js child of the Electron process")).toBeTruthy();

    // No /F: this is a WM_CLOSE, the request Task Manager's "End task" sends
    // before it offers to force one.
    taskkill(electron);

    await expect
      .poll(() => windowVisible(shell!), { timeout: 60_000, message: "the window never hid" })
      .toBe(false);

    // The claim, stated in all three places it is observable: the process, the
    // lifecycle, and the sidecars it supervises.
    expect(alive(electron), "the shell exited on a WM_CLOSE instead of hiding into the tray").toBe(true);
    expect(fs.readFileSync(marker, "utf8"), "a hide ran the quit lifecycle").toBe("");
    expect(alive(sidecars.app!) && alive(sidecars.pty!), "a hide stopped a sidecar").toBe(true);
    expect(await serverIsUp(origin), "a hide took the server down").toBe(true);

    // Quitting for real is what reaps them, the same `app.quit()` the tray's
    // Quit item reaches, and the only path that drains.
    await quitShell(shell);
    expect(fs.readFileSync(marker, "utf8"), "before-quit did not fire on app.quit()").toContain(
      "before-quit"
    );
    await expect
      .poll(() => alive(sidecars.app!) || alive(sidecars.pty!), {
        timeout: 60_000,
        message: "a sidecar outlived a quit that ran before-quit",
      })
      .toBe(false);
    expect(await serverIsUp(origin)).toBe(false);

    shell = null; // already gone; nothing for afterAll to stop
  });

  test("taskkill /F runs no lifecycle at all, and leaves nothing of the instance behind", async () => {
    shell = await launchShell("win-taskkill-force");
    const origin = shell.origin;
    const marker = await quitEventRecorder(shell);
    const electron = await electronPid(shell);
    const sidecars = await bothSidecars(electron);
    const pids = [sidecars.app, sidecars.pty].filter((p): p is number => !!p);
    expect(pids, sidecars.why("no node sidecars under the Electron process")).toHaveLength(2);

    taskkill(electron, ["/F"]);

    await expect
      .poll(() => alive(electron), { timeout: 60_000, message: "the shell survived taskkill /F" })
      .toBe(false);

    // TerminateProcess delivers nothing the app can hear. This is the claim
    // about Windows this file pins, and it decides product behavior: there
    // is no handler to write, because there is no event. `03-quit-drain`
    // covers the path where there is one.
    expect(fs.readFileSync(marker, "utf8"), "a lifecycle event fired on TerminateProcess").toBe("");

    // What happens to the sidecars is the platform's answer, and it is
    // measured rather than asserted: their only inherited handles are the
    // stdout and stderr pipes whose read ends the dying parent closed, so a
    // sidecar that writes anything at all takes an EPIPE and goes down with
    // it, and both of ours write. Requiring an orphan would require the
    // sidecars to stay silent, which is not a property of this app.
    //
    // The assertion is instead the invariant the next spec file depends on:
    // nothing of this instance is left holding its port or its database
    // lock. The observation is recorded rather than encoded, so if a future
    // runner does leave orphans, `/T` below is what takes them, and the log
    // line says so.
    const orphansAtKill = pids.filter(alive);
    console.log(
      `[spec] taskkill /F left ${orphansAtKill.length} of 2 sidecars running` +
        (orphansAtKill.length ? ` (pids ${orphansAtKill.join(", ")}) — /T is what reaps them` : "")
    );

    // `quitShell`'s backstop, run here as the cleanup it also is: an orphan
    // holds the port and the db lock into the next spec file. Unconditional,
    // since the suite must not depend on the platform having done it, which
    // is why `desktop/e2e/fixtures.ts`'s killTree() keeps `/T`.
    for (const pid of orphansAtKill) taskkill(pid, ["/T", "/F"]);
    // The launch wrapper too (see `electronPid`): `cmd.exe` normally exits with
    // the child it is waiting on, and this is only in case it doesn't.
    taskkill(shell.proc.pid!, ["/T", "/F"]);

    await expect
      .poll(() => pids.filter(alive), { timeout: 30_000, message: "a sidecar outlived taskkill /F and /T" })
      .toEqual([]);
    expect(await serverIsUp(origin), "something is still serving this instance's origin").toBe(false);

    shell = null;
  });
});

/* ---- Win32 process plumbing -------------------------------------------- *
 * Local to this file rather than shared with lib/processTree.ts: that module
 * is the app's own supervision of managed services and is under test
 * elsewhere. A spec asserting what Windows does to a process should not read
 * the answer through the abstraction it is checking.
 */

/** What `powershell.exe` said, including the halves a bare stdout read drops. */
type PsResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  /** A one-line account of why this run produced nothing usable, or null. */
  failure: string | null;
};

/**
 * Run a PowerShell one-liner and keep all of its output.
 *
 * `stdout` alone is not enough: a query that errors out and a query that
 * genuinely finds nothing would otherwise be the same empty string, and the
 * assertion above could only ever say "null". Whatever goes wrong in here
 * has to reach the report, because the report is the only thing a Windows CI
 * lane hands back.
 */
function ps(script: string): PsResult {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 }
  );
  const stdout = r.stdout || "";
  const stderr = (r.stderr || "").trim();
  const failure = r.error
    ? `powershell.exe did not run: ${r.error.message}`
    : r.status !== 0
      ? `powershell.exe exited ${r.status ?? "on a signal"}`
      : stderr
        ? "powershell.exe exited 0 but wrote to stderr"
        : null;
  return { stdout, stderr, status: r.status, failure };
}

/** `taskkill` with no output capture. Exit 128 (no such pid) is not an error here. */
function taskkill(pid: number, flags: string[] = []): void {
  spawnSync("taskkill", ["/pid", String(pid), ...flags], { stdio: "ignore", windowsHide: true });
}

/**
 * Is this exact pid running? `tasklist` exits 0 with "INFO: No tasks…" on no
 * match, so the output answers rather than the exit code; a csv row opens
 * `"image","pid",…`, and the quoted pid cannot collide with a memory figure.
 */
function alive(pid: number): boolean {
  const r = spawnSync("tasklist", ["/fi", `PID eq ${pid}`, "/nh", "/fo", "csv"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return (r.stdout || "").includes(`"${pid}"`);
}

/**
 * The Electron main process's own pid.
 *
 * Not `shell.proc.pid`: on win32 `_electron.launch()` folds the binary and
 * its arguments into a single quoted command line and spawns it with
 * `shell: true` (playwright-core's `Electron.launch`:
 * `if (process.platform === 'win32') { shell = true; command = [command,
 * ...electronArguments].map(...).join(' ') }`), so the child Node hands
 * back, and therefore what `app.process()` returns, is the
 * `cmd.exe /d /s /c "…"` wrapper. `electron.exe` is that wrapper's only
 * child, and the two sidecars are its grandchildren, so a Win32_Process
 * query for `ParentProcessId = <wrapper>` finds exactly one row,
 * `electron.exe`, and neither sidecar; the pid is one generation too high.
 * That wrapper is win32-only, which is why other specs in this suite read
 * `shell.proc.pid` as the Electron pid and are right to.
 *
 * Asking the main process for its own `process.pid` is preferred over
 * walking the tree looking for something named `electron.exe`: it is the
 * very process `supervisor.spawnChild` runs in, so "a child of this
 * process" here means the same thing it means in `desktop/supervisor.js`,
 * with no name matching in between to drift. It does require a live CDP
 * connection, so every caller takes the pid before it kills anything.
 */
async function electronPid(shell: Shell): Promise<number> {
  return await shell.app.evaluate(() => process.pid);
}

/** Is the shell's one window on screen? `win.hide()` leaves it in place, so this is not `win === null`. */
async function windowVisible(shell: Shell): Promise<boolean> {
  return await shell.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
  );
}

type Sidecars = {
  app: number | null;
  pty: number | null;
  /**
   * `claim`, followed by everything the query saw. The assertion messages go
   * through this rather than stating a bare claim, so a red run reports
   * whether the lookup failed or merely found nothing; the two are
   * otherwise the same `null` from out here.
   */
  why: (claim: string) => string;
};

/**
 * The two node sidecars, found by command line among the Electron process's
 * children.
 *
 * Matched by parent and command line, because Electron's own renderer, GPU
 * and utility processes are children too. The `-server.js` vs `\server.js`
 * distinction matters: "pty-server.js" contains "server.js".
 *
 * Direct children only, the correct depth rather than a shortcut:
 * `supervisor.spawnChild` is a plain `spawn(node, [script])` with no shell
 * wrapper, running in the process `electronPid()` names. The single-quoted
 * WQL filter matches lib/processTree.ts's spelling for the reason that file
 * gives: no double quote ever reaches the argument, the one thing Node's
 * win32 argument escaping and PowerShell's own re-parsing disagree about.
 */
function sidecarPids(electronPid: number): Sidecars {
  const r = ps(
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${electronPid}' | ` +
      `Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  );
  const raw = r.stdout.trim();
  type Row = { ProcessId?: number; Name?: string | null; CommandLine?: string | null };
  let rows: Row[] = [];
  let parseError: string | null = null;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // ConvertTo-Json emits a bare object for a single row and an array otherwise.
      rows = (Array.isArray(parsed) ? parsed : [parsed]) as Row[];
    } catch (err) {
      parseError = `the query ran but its stdout was not JSON: ${(err as Error).message}`;
    }
  }

  let app: number | null = null;
  let pty: number | null = null;
  for (const row of rows) {
    const cmd = row.CommandLine || "";
    if (!row.ProcessId) continue;
    if (/pty-server\.js/i.test(cmd)) pty = row.ProcessId;
    else if (/[\\/]server\.js/i.test(cmd)) app = row.ProcessId;
  }

  const why = (claim: string) =>
    [
      claim,
      `queried: child processes of pid ${electronPid}`,
      r.failure ??
        parseError ??
        `the query ran clean and returned ${rows.length} child process(es)`,
      r.stderr ? `stderr: ${r.stderr}` : null,
      raw ? `stdout: ${raw.slice(0, 2000)}` : "stdout: (empty)",
      ...rows.map(
        (row) => `  child ${row.ProcessId} ${row.Name ?? "?"} — ${row.CommandLine ?? "(no command line)"}`
      ),
    ]
      .filter((line): line is string => !!line)
      .join("\n");

  return { app, pty, why };
}

/**
 * `sidecarPids`, waited on until both children are discoverable.
 *
 * `supervisor.spawnChild` returns as soon as the spawn is requested, and on
 * win32 a new process takes a moment to show up in `Win32_Process`, so
 * asking once, right after launch, risks asking before the OS has finished
 * publishing the tree.
 *
 * The last sample is returned even on timeout, unsettled, because it
 * carries `why()`: every child process the query saw, plus whatever
 * PowerShell said going wrong. The assertions at the call sites are
 * unchanged and are still what fails; a shell that never brings its
 * sidecars up still reddens this file, with the same report it always gave.
 */
async function bothSidecars(electronPid: number): Promise<Sidecars> {
  return waitForTree(
    () => sidecarPids(electronPid),
    (s) => !!s.app && !!s.pty,
    { timeoutMs: 60_000, intervalMs: 250 }
  );
}

/**
 * Record `before-quit`/`will-quit` into a file in the instance root.
 *
 * A file rather than a variable in the main process, because every
 * observation this file makes happens after that process is gone, and
 * there is nothing left to `app.evaluate()` against. `appendFileSync` for
 * the same reason: a buffered write would not survive the `app.exit(0)`
 * that follows.
 */
async function quitEventRecorder(shell: Shell): Promise<string> {
  const file = path.join(shell.root, "quit-events.log");
  fs.writeFileSync(file, "");
  // Awaited: the listeners have to be installed before anything kills the
  // process, and a floating evaluate would race the taskkill below.
  await shell.app.evaluate(async ({ app }, target) => {
    // `require` is not in scope here. Playwright serializes this function
    // and evaluates its body in the main process, where it gets no CommonJS
    // module wrapper, and `require` is a per-module parameter Node injects
    // rather than a global. The main process entry is CommonJS, so its own
    // module's require is reachable through `process.mainModule`, the same
    // escape hatch 03-quit-drain.spec.ts uses.
    const nodeFs = process.mainModule!.require("node:fs") as typeof import("node:fs");
    app.on("before-quit", () => nodeFs.appendFileSync(target, "before-quit\n"));
    app.on("will-quit", () => nodeFs.appendFileSync(target, "will-quit\n"));
  }, file);
  return file;
}
