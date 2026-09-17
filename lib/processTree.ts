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
//     so the escalation collapses into a single forced kill. Liveness is
//     still signal 0, which Node documents as the existence test on Windows
//     too; only the kill and the command-line lookup shell out.
//
// The recycled-pid guard follows the same split. A pid persisted by a server
// killed with SIGKILL may belong to something unrelated by the next boot, so
// reaping first checks whether that pid still carries the service's command
// line: `ps` on POSIX, a `Win32_Process` CommandLine lookup on win32. When
// that check can't run (no `ps`, no PowerShell), the answer is treated as no:
// an orphan can be cleaned up later, killing an unrelated process cannot.
//
// That bias is only safe if "could not find out" and "this is not ours" are
// told apart, and on win32 they were not (issue #324). The probe returned a
// bare string, so a transient CIM failure produced empty stdout, which reads
// exactly like a recycled or dead pid: the reap declined, silently, for a
// tree that was demonstrably alive. `probeTreeCommand` is therefore
// tri-state, and the win32 query prints a sentinel so an answer is
// distinguishable from no answer at all. `confirmTreeCommand` retries while
// the answer is `unknown`; only a whole exhausted budget falls back to
// leaving the process alone.
//
// Dependency-free (node:child_process only). Every function takes its
// platform, and the win32 paths that still shell out take their command
// runner, as arguments, so the Windows branches are unit-testable from the
// Linux/macOS suite. Liveness is the exception, and does not need the hook:
// under `platform: "win32"` it runs for real on POSIX too, since the only
// difference left is whether the pid is negated. See docs/WINDOWS.md,
// "Platform behavior".

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
  /** How long a shelled-out probe may take. See {@link EXEC_TIMEOUT_MS}. */
  execTimeoutMs?: number;
}

/**
 * The default budget for one shelled-out win32 command.
 *
 * It is short because `killTree` runs from an `exit` handler and from
 * `stopService`, both of which block something a user is waiting on.
 */
export const EXEC_TIMEOUT_MS = 10_000;

/**
 * The budget for the boot-restore paths, which can afford to wait and have to
 * actually succeed.
 *
 * On a Windows desktop where process creation is slow enough that Defender
 * dominates it, `taskkill /T /F` takes 9.6s, and every way of
 * reading a process's command line took 11-13s (`Get-CimInstance` by filter
 * or by query, `Get-WmiObject`, a DCOM `CimSession`. WMI itself is the cost:
 * PowerShell alone starts in 0.73s and `Get-Process` answers in 0.95s, so
 * there is no faster query to switch to). Both therefore sat AT the 10s
 * default, which is the mechanism behind issue #324: a probe killed by its
 * own timeout returned no answer, which the old boolean read as "not ours",
 * and a `taskkill` killed by its own timeout never delivered the kill. A CI
 * runner under load is the same machine, slower.
 */
export const SLOW_EXEC_TIMEOUT_MS = 30_000;

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
      execFileSync(file, args, {
        encoding: "utf8",
        timeout: opts.execTimeoutMs ?? EXEC_TIMEOUT_MS,
        windowsHide: true,
      }))
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
 * death after a kill, so it has to be cheap: signal 0, no subprocess at all,
 * and none of the command-line lookup below.
 */
export function treeAlive(pid: number, opts: ProcessTreeOptions = {}): boolean {
  if (!usablePid(pid)) return false;
  // Signal 0 on both platforms; the only difference is the target. POSIX
  // negates the pid to ask about the whole group. win32 has no groups, and
  // the pid we hold is the `cmd.exe` root, which is what `taskkill /T` kills
  // last, so asking about it alone is the same question.
  //
  // This used to shell out to `tasklist` on win32, which was measured at
  // 9.5-10.5s per call on a real Windows desktop (process creation there is
  // slow enough that Defender dominates it). Polling for death through a
  // probe that costs ten seconds cannot work: a 5s budget gets one sample,
  // and the 10s budget in tests/waitForTree.ts was getting about seven. Node
  // documents signal 0 as the existence test on Windows too, it needs no
  // subprocess, and it was verified against `tasklist` on that machine to
  // agree on a live root, a never-existed pid, and a process that had exited
  // while its handle was still held.
  const target = hasProcessGroups(opts.platform) ? -pid : pid;
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    // EPERM is a process we may not signal, which is still a process. Only
    // ESRCH (and anything else) means gone.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
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
  return probeTreeCommand(pid, command, opts) === "match";
}

/**
 * What the recycled-pid guard learned.
 *
 *   * `match`:    the tree is alive and carries the service's command line.
 *   * `mismatch`: a definite no. The process is gone, or the pid now belongs
 *                  to something else.
 *   * `unknown`:  the probe could not answer. This is not `mismatch`,
 *                  and conflating the two is issue #324: a Windows runner
 *                  under load returned nothing from the CommandLine lookup,
 *                  which read as "not ours" and abandoned a live orphan.
 */
export type CommandProbe = "match" | "mismatch" | "unknown";

// Markers the win32 query prints so its three outcomes survive a round trip
// through stdout. They carry no double quote and no character PowerShell
// would interpolate (see the argv note below).
const WIN_PROBE_CMD = "CALANDRIA_CMDLINE:";
const WIN_PROBE_GONE = "CALANDRIA_NOPROC";
const WIN_PROBE_FAIL = "CALANDRIA_PROBEFAIL";

/** The tri-state form of {@link treeMatchesCommand}; see {@link CommandProbe}. */
export function probeTreeCommand(
  pid: number,
  command: string,
  opts: ProcessTreeOptions = {}
): CommandProbe {
  if (!usablePid(pid)) return "mismatch";
  const needle = command.trim();
  if (!needle) return "mismatch"; // no command to match against is a definite no

  if (hasProcessGroups(opts.platform)) {
    if (!treeAlive(pid, opts)) return "mismatch";
    try {
      const out = runner(opts)("ps", ["-A", "-o", "pgid=,command="]);
      for (const line of out.split("\n")) {
        const t = line.trim();
        const sp = t.indexOf(" ");
        if (sp < 1 || Number(t.slice(0, sp)) !== pid) continue;
        if (t.slice(sp + 1).includes(needle)) return "match";
      }
      return "mismatch"; // `ps` listed every process and none of them was ours
    } catch {
      return "unknown"; // no `ps`, so the question went unanswered
    }
  }

  // Same short-circuit as the POSIX branch above, and now worth as much: a
  // pid that is already gone is a definite no, answered for free, instead of
  // a CIM query measured at 10.4-11.8s on a real Windows desktop. Boot
  // restore asks this once per managed service.
  if (!treeAlive(pid, opts)) return "mismatch";

  let out: string;
  try {
    // Single-quoted strings and an interpolated integer: no double quote ever
    // reaches the argument, which is the one thing Node's win32 argument
    // escaping and PowerShell's own re-parsing disagree about.
    out = runner(opts)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; ` +
        `if ($p) { '${WIN_PROBE_CMD}' + $p.CommandLine } else { '${WIN_PROBE_GONE}' } } ` +
        `catch { '${WIN_PROBE_FAIL}' }`,
    ]);
  } catch {
    return "unknown"; // no PowerShell, or it was killed by the exec timeout
  }

  // PowerShell hard-wraps string output at the host width when stdout is a
  // pipe, so a long command line can come back split across lines. The needle
  // never contains a newline, so flattening restores what was written.
  const flat = out.replace(/[\r\n]+/g, "");
  if (flat.includes(WIN_PROBE_FAIL)) return "unknown";
  if (flat.includes(WIN_PROBE_GONE)) return "mismatch";
  const at = flat.indexOf(WIN_PROBE_CMD);
  if (at < 0) return "unknown"; // no marker: the query never ran to completion
  const line = flat.slice(at + WIN_PROBE_CMD.length).trim();
  // The process exists but would not show its CommandLine (another user's, or
  // a protected one). That is not evidence the pid was recycled.
  if (!line) return "unknown";
  return line.includes(needle) ? "match" : "mismatch";
}

/**
 * {@link probeTreeCommand}, retried while it cannot answer.
 *
 * A `mismatch` is returned the moment it is seen: a recycled pid does not
 * become ours by asking again. Only `unknown` is retried, because the Windows
 * failures it stands for (a CIM hiccup, a PowerShell start that outran the
 * exec timeout on a loaded runner) are transient, while the cost of giving up
 * on the first stumble is a live orphan holding the port the respawn needs.
 * An exhausted budget still answers `unknown`, and the caller still declines
 * to kill: the safety bias is unchanged, it just no longer fires on noise.
 */
export async function confirmTreeCommand(
  pid: number,
  command: string,
  opts: ProcessTreeOptions & { attempts?: number; retryDelayMs?: number; budgetMs?: number } = {}
): Promise<CommandProbe> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  // Two bounds, because they cap different failures. `attempts` caps a probe
  // that answers "unknown" instantly and would otherwise spin; `budgetMs`
  // caps one that answers by timing out, where three attempts at the slow
  // timeout would hold boot restore for a minute and a half.
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const execTimeoutMs = opts.execTimeoutMs ?? SLOW_EXEC_TIMEOUT_MS;
  let answer: CommandProbe = "unknown";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 250));
    }
    answer = probeTreeCommand(pid, command, { ...opts, execTimeoutMs });
    if (answer !== "unknown") return answer;
  }
  return answer;
}

/**
 * Kill `pid`'s tree and wait for it to actually be gone, up to `timeoutMs`.
 * Returns whether the tree is confirmed dead.
 *
 * `killTree` reports that a kill was ISSUED, which on win32 is the weaker
 * claim: `taskkill /T /F` returns once it has asked, and the tree can outlive
 * the call. A caller that is about to spawn a replacement onto the same port
 * needs the stronger one. `killTree`'s own return value is not consulted
 * here. A refusal usually means the pid was already gone, and the
 * liveness poll below answers that better than the exit code does.
 *
 * The poll never re-kills, so a pid recycled inside the window can at worst
 * make this report `false` for a tree that really did die. That is the
 * pessimistic direction: the caller logs a warning it can act on, rather than
 * shooting at whatever inherited the pid.
 */
export async function killTreeAndWait(
  pid: number,
  signal: TreeSignal,
  opts: ProcessTreeOptions & { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  if (!usablePid(pid)) return true; // nothing to kill is nothing to wait for
  // The kill gets the slow budget: `taskkill` was measured at 9.6s on a real
  // Windows desktop, and one killed by its own 10s timeout does not deliver
  // the kill at all, which reads downstream as a tree that ignored it.
  killTree(pid, signal, { ...opts, execTimeoutMs: opts.execTimeoutMs ?? SLOW_EXEC_TIMEOUT_MS });
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    if (!treeAlive(pid, opts)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
}
