// Kills a spawned command and everything it started, on POSIX and win32.
//
// A managed service (lib/services.ts) is spawned with `shell: true`, so the
// held pid is a shell wrapper (`/bin/sh -c <cmd>` on POSIX, `cmd.exe /d /s /c
// <cmd>` on Windows) with the real server one or two processes below it.
// Killing only that pid orphans the server and leaves its port held.
//
//   * POSIX: the child leads its own process group (`detached: true`), so a
//     negative pid signals every descendant at once, and SIGTERM-then-SIGKILL
//     gives the server a chance to shut down cleanly first.
//   * win32: there are no process groups (`detached: true` there means "new
//     console", so it is not set), and no graceful tree signal exists.
//     `taskkill /T /F` walks the parent/child chain and terminates each one,
//     so the escalation collapses into a single forced kill.
//
// The recycled-pid guard follows the same split. A pid persisted by a server
// killed with SIGKILL may belong to something unrelated by the next boot, so
// reaping first checks whether that pid still carries the service's command
// line: `ps` on POSIX, a `Win32_Process` CommandLine lookup on win32. When
// that check can't run (no `ps`, no PowerShell), the answer is treated as no:
// an orphan can be cleaned up later, killing an unrelated process cannot.
//
// Dependency-free (node:child_process only). Every function takes its
// platform, and the win32 paths their command runner, as arguments, so the
// Windows branches are unit-testable from the Linux/macOS suite. See
// docs/WINDOWS.md §2.

import { execFileSync } from "node:child_process";

/** What a tree kill can be asked for. On win32 both mean `taskkill /T /F`. */
export type TreeSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTreeOptions {
  /** Defaults to the running platform; pass "win32" to exercise the Windows rules. */
  platform?: NodeJS.Platform;
  /**
   * Runs a command and returns its stdout; throws on a nonzero exit. Injected
   * by tests. Only the win32 branches use it; POSIX signals directly.
   */
  exec?: (file: string, args: string[]) => string;
}

const isWin = (platform?: NodeJS.Platform) => (platform ?? process.platform) === "win32";

/**
 * Whether this platform has POSIX process groups. Three things follow from it,
 * and they're the same fact: whether `spawn` should ask for its own group
 * (`detached`), whether a negative pid is a meaningful signal target, and
 * whether a graceful SIGTERM can be escalated to SIGKILL (win32's only tree
 * kill is already forced, so there is nothing to escalate to).
 */
export function hasProcessGroups(platform?: NodeJS.Platform): boolean {
  return !isWin(platform);
}

// The Windows-only helpers below run at boot or at stop time, never per
// request, so a blocking call is fine. The exit hook that calls killTree also
// can't await anything, since 'exit' handlers are sync by contract.
function runner(opts: ProcessTreeOptions): (file: string, args: string[]) => string {
  return (
    opts.exec ??
    ((file, args) =>
      execFileSync(file, args, { encoding: "utf8", timeout: 10_000, windowsHide: true }))
  );
}

/** A pid we're willing to hand to a kill command. Guards `taskkill /pid 0`. */
function usablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Signal `pid`'s whole tree. Returns true when the kill was issued, false when
 * it wasn't (already gone, or the platform's tool refused) so callers can fall
 * back to killing the direct child.
 *
 * `signal` is honored on POSIX and ignored on win32, where the only tree kill
 * is forced.
 */
export function killTree(pid: number, signal: TreeSignal, opts: ProcessTreeOptions = {}): boolean {
  if (!usablePid(pid)) return false;
  if (hasProcessGroups(opts.platform)) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false; // group already gone
    }
  }
  try {
    // /T targets the process and its descendants. /F forces the kill via
    // TerminateProcess: nothing in this tree runs a message loop to handle
    // WM_CLOSE.
    runner(opts)("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return true;
  } catch {
    return false; // exit 128 = no such pid, or taskkill itself is missing
  }
}

/**
 * Reports whether anything in `pid`'s tree is still running. Used to poll for
 * death after a kill, so it stays cheap: `tasklist` filtered to the single
 * pid, without the command-line lookup below.
 */
export function treeAlive(pid: number, opts: ProcessTreeOptions = {}): boolean {
  if (!usablePid(pid)) return false;
  if (hasProcessGroups(opts.platform)) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    // tasklist exits 0 even with no match ("INFO: No tasks are running..."),
    // so the match is read from the output text. A csv row starts
    // "image","pid",...; the quoted pid can't collide with a memory figure.
    const out = runner(opts)("tasklist", ["/fi", `PID eq ${pid}`, "/nh", "/fo", "csv"]);
    return out.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

/**
 * Reports whether `pid` still leads a live tree that looks like the spawned
 * service. This is the recycled-pid guard: after a crash the pid could belong
 * to something unrelated, and killing that would be worse than leaving an
 * orphan, so both conditions must hold: the tree is alive, and some process
 * in it still carries the configured command line.
 *
 * POSIX asks `ps` for every process's group and command (`shell: true` spawns
 * `sh -c <command>`, and every descendant shares the group). win32 has no
 * `ps` and no groups, but needs no membership scan either: the persisted pid
 * is the `cmd.exe /d /s /c "<command>"` wrapper itself, so its own command
 * line contains the service's command verbatim. PowerShell reads it and
 * still works on Windows builds that removed `wmic`.
 */
export function treeMatchesCommand(pid: number, command: string, opts: ProcessTreeOptions = {}): boolean {
  if (!usablePid(pid)) return false;
  const needle = command.trim();
  if (!needle) return false;

  if (hasProcessGroups(opts.platform)) {
    if (!treeAlive(pid, opts)) return false;
    try {
      const out = runner(opts)("ps", ["-A", "-o", "pgid=,command="]);
      for (const line of out.split("\n")) {
        const t = line.trim();
        const sp = t.indexOf(" ");
        if (sp < 1 || Number(t.slice(0, sp)) !== pid) continue;
        if (t.slice(sp + 1).includes(needle)) return true;
      }
    } catch { /* no ps → refuse to kill on a guess */ }
    return false;
  }

  try {
    // Single-quoted filter and an interpolated integer: no double quote ever
    // reaches the argument, which is the one thing Node's win32 argument
    // escaping and PowerShell's own re-parsing disagree about.
    const out = runner(opts)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
    ]);
    return out.includes(needle); // empty output (dead pid, or no CommandLine) can't match
  } catch {
    return false; // no PowerShell → same answer as no ps
  }
}
