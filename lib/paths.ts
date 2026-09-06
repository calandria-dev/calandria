// Filesystem-identity and teardown helpers whose correct answer differs by
// platform. Everything here uses only `fs` and `path`, no DB, no agent SDK, no
// subprocesses, so it can sit under lib/git.ts and lib/repoLock.ts both.
//
// `process.platform` is read at call time, never captured at module load, so a
// test can mock it.

import fs from "node:fs";
import path from "node:path";

const isWindows = () => process.platform === "win32";

/**
 * Canonical identity for a filesystem path: the string two spellings of the
 * SAME directory must agree on.
 *
 * Three steps:
 *   1. `realpathSync` resolves symlinks (macOS `/tmp` -> `/private/tmp`,
 *      `/var` -> `/private/var`, a user's `~/code` -> an external volume), and
 *      falls back to `path.resolve` when the path doesn't exist yet or can't
 *      be read, so an unreadable path still gets a stable answer.
 *   2. `path.normalize` collapses `.`/`..` and, on win32, rewrites `/` to `\`.
 *      That win32 rewrite matters here: `git worktree list --porcelain`
 *      prints `C:/Users/...` while `path.join(WORKTREES_DIR, taskId)` produces
 *      `C:\Users\...`, and those are the two sides `isLinkedWorktree` compares.
 *   3. On win32 ONLY, lower-case it. NTFS is case-INSENSITIVE but
 *      case-PRESERVING, and `realpathSync` preserves the original case instead
 *      of canonicalizing it, so `C:\Users\Foo` and `c:\users\foo` are one
 *      directory that compares unequal as strings. POSIX filesystems are
 *      case-sensitive (a case-insensitive macOS volume notwithstanding:
 *      folding there would merge two paths that can differ on Linux, and the
 *      app's identity must not change per volume), so this step is win32-only.
 */
export function canonicalPath(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  const normalized = path.normalize(resolved);
  return isWindows() ? normalized.toLowerCase() : normalized;
}

/**
 * Whether two paths name the same directory or file, by the identity above.
 *
 * Used wherever a MISMATCH authorizes something destructive or expensive:
 * `isLinkedWorktree` deletes a directory it decides isn't a registered
 * worktree, and `repoLockKey` hands two "different" repos two different locks.
 */
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

// Windows refuses to unlink a file that any process holds a handle on; POSIX
// lets an open-but-unlinked file disappear. `EBUSY`/`EPERM`/`ENOTEMPTY` from a
// worktree teardown usually means a live handle, and the holders are
// predictable: the Task-scoped TerminalDrawer shell rooted INSIDE the
// worktree being removed, an editor indexing it, or Defender scanning a fresh
// checkout for a few seconds after it lands. Node's own
// `maxRetries`/`retryDelay` covers the transient scanner; a shell sitting in
// the directory needs the user, so the message has to name it.
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * `fs.rmSync(target, { recursive, force })`, retrying on win32.
 *
 * Node retries `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM` when
 * `maxRetries` is set, with a linear backoff that covers an antivirus scan or
 * an editor's indexer letting go. On POSIX the options are omitted entirely
 * (`maxRetries` defaults to 0).
 *
 * Throws exactly what `rmSync` throws; callers decide what a failure means.
 */
export function rmTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, ...(isWindows() ? RM_RETRY : {}) });
}

/**
 * A trailing clause for a user-facing teardown failure, naming the likely
 * culprit. Empty string off win32, where a held handle isn't why a delete
 * failed and the guess would just be wrong.
 */
export function heldHandleHint(): string {
  return isWindows()
    ? ". On Windows a file can't be deleted while it's open; a terminal or editor still has this checkout open"
    : "";
}
