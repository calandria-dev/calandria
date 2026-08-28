/* Windows only: what actually happens to the shell and its two node sidecars
 * when something outside the app ends the process.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM 03-quit-drain. That spec quits through
 * the product's own path (`app.quit()`), which is the same code on every
 * platform. This one is about the paths a Windows user reaches for INSTEAD —
 * `taskkill`, Task Manager's End task — where the answer is decided by Win32
 * rather than by anything in `main.js`, and where the two spellings differ in a
 * way that leaves processes behind.
 *
 *   `taskkill /pid n`        posts WM_CLOSE to the process's windows. Electron
 *                            closes the BrowserWindow, `window-all-closed`
 *                            fires `app.quit()`, and `before-quit` runs — so
 *                            the supervisor stops the sidecars on the way out.
 *   `taskkill /pid n /F`     is `TerminateProcess`. No window message, no
 *                            handler, no supervisor. The sidecars are not in a
 *                            job object and were spawned without `detached`
 *                            (which on Windows would mean a new console
 *                            window), so nothing reaps them: they survive,
 *                            holding the instance's ports and its database
 *                            lock. `/T` is what walks the tree.
 *
 * WHAT THIS FILE DOES NOT COVER, AND CANNOT. On a real Windows shutdown or
 * logout, `before-quit` and `will-quit` are **not emitted at all** — the
 * session ends through WM_QUERYENDSESSION/WM_ENDSESSION, which Electron does
 * not translate into the quit lifecycle. No test here or anywhere else in this
 * suite touches that path, and none should claim to: a shutdown-time drain
 * would need a `session-end` listener that does not exist yet. Read the two
 * tests below as "the app was ended by another process", not "the machine went
 * away".
 *
 * `will-quit` is deliberately recorded but not asserted on: `main.js`'s
 * `before-quit` handler ends in `app.exit(0)`, which skips the rest of the
 * lifecycle, so its absence is a property of our own handler rather than of
 * Windows.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
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

  test("a plain taskkill runs before-quit, so the sidecars are reaped with the shell", async () => {
    shell = await launchShell("win-taskkill");
    const origin = shell.origin;
    const marker = await quitEventRecorder(shell);
    const sidecars = sidecarPids(shell.proc.pid!);

    expect(sidecars.app, "no server.js child of the Electron process").toBeTruthy();
    expect(sidecars.pty, "no pty-server.js child of the Electron process").toBeTruthy();

    // No /F: this is a WM_CLOSE, i.e. the polite request Task Manager's
    // "End task" sends before it offers to force one.
    taskkill(shell.proc.pid!);

    await expect
      .poll(() => alive(shell!.proc.pid!), { timeout: 90_000, message: "the shell never exited" })
      .toBe(false);

    // The lifecycle really ran — this is the claim, and the sidecar reaping
    // below is its consequence rather than a separate fact.
    expect(fs.readFileSync(marker, "utf8"), "before-quit did not fire on a plain taskkill").toContain(
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

  test("taskkill /F without /T orphans the sidecars, and /T is what reaps them", async () => {
    shell = await launchShell("win-taskkill-force");
    const marker = await quitEventRecorder(shell);
    const sidecars = sidecarPids(shell.proc.pid!);
    const pids = [sidecars.app, sidecars.pty].filter((p): p is number => !!p);
    expect(pids, "no node sidecars under the Electron process").toHaveLength(2);

    taskkill(shell.proc.pid!, ["/F"]);

    await expect
      .poll(() => alive(shell!.proc.pid!), { timeout: 60_000, message: "the shell survived taskkill /F" })
      .toBe(false);

    // TerminateProcess delivers nothing the app can hear.
    expect(fs.readFileSync(marker, "utf8"), "a lifecycle event fired on TerminateProcess").toBe("");

    // The hazard, stated as the weakest true form of it: at least one sidecar is
    // still running with its parent gone. Both normally are — the reason this is
    // not `expect(both).toBe(true)` is that a sidecar that happens to log in this
    // window writes into a pipe whose read end just closed, and an EPIPE would
    // take that one process down for a reason unrelated to what is being tested.
    const orphans = pids.filter(alive);
    expect(
      orphans.length,
      "taskkill /F reaped the sidecars on its own — if that is now true, desktop/e2e/fixtures.ts's " +
        "killTree() no longer needs /T and this test should say so instead"
    ).toBeGreaterThan(0);

    // ...and this is why `quitShell`'s backstop uses /T. Doubles as the cleanup:
    // an orphan here holds the port and the db lock into the next spec file.
    for (const pid of orphans) taskkill(pid, ["/T", "/F"]);
    await expect
      .poll(() => pids.some(alive), { timeout: 30_000, message: "taskkill /T left a sidecar running" })
      .toBe(false);

    shell = null;
  });
});

/* ---- Win32 process plumbing -------------------------------------------- *
 * Deliberately local to this file rather than shared with lib/processTree.ts:
 * that module is the app's own supervision of managed services and is under
 * test elsewhere. A spec asserting what Windows does to a process should not
 * be reading the answer through the abstraction it is checking.
 */

function ps(script: string): string {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 }
  );
  return r.stdout || "";
}

/** `taskkill` with no output capture — exit 128 (no such pid) is not an error here. */
function taskkill(pid: number, flags: string[] = []): void {
  spawnSync("taskkill", ["/pid", String(pid), ...flags], { stdio: "ignore", windowsHide: true });
}

/**
 * Is this exact pid running? `tasklist` exits 0 with "INFO: No tasks…" on no
 * match, so the OUTPUT answers rather than the exit code; a csv row opens
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
 * The two node sidecars, found by command line among the Electron process's
 * children.
 *
 * By parent AND command line, because Electron's own renderer, GPU and utility
 * processes are children too. The `-server.js` vs `\server.js` distinction is
 * load-bearing: "pty-server.js" contains "server.js".
 */
function sidecarPids(electronPid: number): { app: number | null; pty: number | null } {
  const raw = ps(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${electronPid}" | ` +
      `Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
  ).trim();
  if (!raw) return { app: null, pty: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { app: null, pty: null };
  }
  // ConvertTo-Json emits a bare object for a single row and an array otherwise.
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    ProcessId?: number;
    CommandLine?: string | null;
  }>;
  let app: number | null = null;
  let pty: number | null = null;
  for (const row of rows) {
    const cmd = row.CommandLine || "";
    if (!row.ProcessId) continue;
    if (/pty-server\.js/i.test(cmd)) pty = row.ProcessId;
    else if (/[\\/]server\.js/i.test(cmd)) app = row.ProcessId;
  }
  return { app, pty };
}

/**
 * Record `before-quit`/`will-quit` into a file in the instance root.
 *
 * A file rather than a variable in the main process, because every observation
 * this file makes happens AFTER that process is gone — there is nothing left to
 * `app.evaluate()` against. `appendFileSync` for the same reason: a buffered
 * write would not survive the `app.exit(0)` that follows.
 */
async function quitEventRecorder(shell: Shell): Promise<string> {
  const file = path.join(shell.root, "quit-events.log");
  fs.writeFileSync(file, "");
  // Awaited: the listeners have to be installed before anything kills the
  // process, and a floating evaluate would race the taskkill below.
  await shell.app.evaluate(async ({ app }, target) => {
    // `require` is NOT in scope here. Playwright serialises this function and
    // evaluates its body in the main process, where it gets no CommonJS module
    // wrapper, and `require` is a per-module parameter Node injects rather than
    // a global. The main process entry IS CommonJS, so its own module's require
    // is reachable through `process.mainModule` — the same escape hatch
    // 03-quit-drain.spec.ts uses.
    const nodeFs = process.mainModule!.require("node:fs") as typeof import("node:fs");
    app.on("before-quit", () => nodeFs.appendFileSync(target, "before-quit\n"));
    app.on("will-quit", () => nodeFs.appendFileSync(target, "will-quit\n"));
  }, file);
  return file;
}
