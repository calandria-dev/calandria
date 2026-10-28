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
 * culprit. On win32 that is a held handle. On POSIX it is the first entry left
 * under `dir` that another user owns, since this process can't unlink what a
 * foreign-owned directory contains. Empty string when neither applies.
 */
export function heldHandleHint(dir?: string): string {
  if (isWindows())
    return ". On Windows a file can't be deleted while it's open; a terminal or editor still has this checkout open";
  const entry = dir ? undeletableEntry(dir) : null;
  return entry ? `. ${undeletableReason(entry)}` : "";
}

/** An entry under a directory that this process can't delete. */
export interface UndeletableEntry {
  path: string;
  /** `owner`: another user owns it. `parent`: its directory isn't writable by this process. */
  kind: "owner" | "parent";
  uid: number;
}

/** One user-facing sentence naming the entry and how to clear it. */
export function undeletableReason(entry: UndeletableEntry): string {
  if (entry.kind === "owner")
    return `${entry.path} is owned by uid ${entry.uid}, so this server can't delete it. A container that ran as root in this checkout usually leaves files like this; delete the directory as that user, then retry`;
  return `${entry.path} is not writable by this server, so it can't delete what that directory contains. Restore write permission on it or delete the directory as uid ${entry.uid}, then retry`;
}

/**
 * Why this process can't delete the tree at `dir`, as one sentence, or null
 * when nothing blocks it or `dir` doesn't exist. `git worktree remove --force`
 * deletes `.git` and every file it can before failing on the rest, so callers
 * run this first and delete nothing when it answers.
 */
export function undeletableTreeReason(dir: string): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const entry = undeletableEntry(dir);
  return entry ? `the worktree can't be removed: ${undeletableReason(entry)}` : null;
}

/**
 * The topmost entry under `dir` that a recursive delete by this process would
 * fail on, or null when none is found. Two causes count: an entry another user
 * owns, and a non-empty directory this process can't write into.
 *
 * Breadth-first, so the reported entry is the one whose ownership or mode
 * blocks everything beneath it. Bounded by `limit` entries. POSIX only: null
 * on win32 and for root.
 */
export function undeletableEntry(dir: string, limit = 2000): UndeletableEntry | null {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) return null;
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < limit) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.length && !writable(current)) {
      let owner = uid;
      try {
        owner = fs.statSync(current).uid;
      } catch {
        // Keep our own uid; the path is still the one to name.
      }
      return { path: current, kind: "parent", uid: owner };
    }
    for (const entry of entries) {
      if (++seen > limit) break;
      const p = path.join(current, entry.name);
      let owner: number;
      try {
        owner = fs.lstatSync(p).uid;
      } catch {
        continue;
      }
      if (owner !== uid) return { path: p, kind: "owner", uid: owner };
      if (entry.isDirectory()) queue.push(p);
    }
  }
  return null;
}

// Unlinking a child needs write and search permission on its directory.
function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
