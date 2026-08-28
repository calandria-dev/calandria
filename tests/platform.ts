/* Platform facts the suite itself needs, so no test file has to guess.
 *
 * Two rules, both from docs/WINDOWS.md §7, and the split matters:
 *
 *   * A test that merely USES a POSIX construct on its way to the thing it is
 *     actually about (a shell to hand the pty sidecar, a way to kill what it
 *     spawned, the null device) gets a portable spelling from here.
 *   * A test that is ABOUT POSIX semantics — the executable bit, `$SHELL`,
 *     delivering SIGINT to another process — is skipped on win32 with a comment
 *     rather than ported into something that pins nothing.
 *
 * `outputLines` is a third kind and the one that bit us: not a spelling a test
 * chooses, but a fact about what a native Windows tool writes back. It lives
 * here for the same reason as the rest — so the next test to shell out doesn't
 * re-derive it, and get it wrong the same way (issue #53).
 *
 * Nothing here changes what runs on Linux/macOS: every value below resolves to
 * exactly the literal the suite used before on those platforms.
 */
import type { ChildProcess } from "node:child_process";
import { it } from "vitest";
import { hasProcessGroups, killTree } from "../lib/processTree";

export const IS_WIN = process.platform === "win32";

/** `it`, skipped on Windows — for a case that pins POSIX-only semantics. */
export const onPosix = IS_WIN ? it.skip : it;

/**
 * The bit bucket, as a path git will accept. `/dev/null` doesn't exist on
 * Windows; `NUL` is the DOS device that stands in for it, and git for Windows
 * accepts it wherever a config file path is wanted.
 */
export const NULL_DEVICE = IS_WIN ? "NUL" : "/dev/null";

/**
 * A shell the pty sidecar can actually spawn here, for tests that need a
 * terminal but don't care which one. Passed as `CALANDRIA_PTY_SHELL` (the knob
 * pty-server.js consults first) rather than `SHELL`, which is a POSIX
 * convention the sidecar only honors as a fallback.
 *
 * `/bin/sh` is the POSIX answer for the same reason it always was: it is the
 * one shell every Unix has. `%COMSPEC%` is the Windows equivalent — always set,
 * always `cmd.exe`, and unlike PowerShell it needs no execution-policy blessing.
 */
export const TEST_SHELL = IS_WIN ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";

/**
 * A subprocess's stdout, as lines.
 *
 * Split on `/\r?\n/` rather than `"\n"`, because a NATIVE Windows binary writes
 * its stdout in text mode and terminates every line with CRLF. Splitting on the
 * bare newline leaves a trailing `\r` on each entry, and no `toBe`/`toContain`/
 * `$`-anchored assertion can then match — while on Linux the identical code is
 * correct, so the failure is invisible everywhere but the Windows lanes. That is
 * exactly how it reached main: `tar -tzf` in `tests/backup.test.ts` (issue #53).
 *
 * Only native binaries do this. Git for Windows is an MSYS build and keeps its
 * pipes in binary mode, so `git log` / `git worktree list` emit LF on every
 * platform, which is why the suite's many git callers were never affected.
 *
 * A trailing blank line is dropped, since a final newline terminates the last
 * line rather than starting an empty one. Blank lines in the middle are kept —
 * `filter(Boolean)` at a call site would also have swallowed the lone `\r` that
 * made the original failure read as a phantom entry.
 */
export function outputLines(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * `detached` for a child whose whole tree the test will need to kill. On POSIX
 * that gives the child its own process group, which is what makes a negative
 * pid mean "everything it started"; on win32 it means "new console" and buys
 * nothing (see lib/processTree.ts), so it stays off there.
 */
export const DETACHED = hasProcessGroups();

/**
 * Kill a spawned child AND anything it started — a pty sidecar's shells, a
 * service's server. Falls back to killing the one process we hold when the
 * tree kill can't report success, so a teardown never leaves the child alive
 * just because the group was already gone.
 */
export function killChildTree(child: ChildProcess | null | undefined): void {
  if (!child?.pid) return;
  if (killTree(child.pid, "SIGKILL")) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
