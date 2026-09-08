// Per-repo async mutex. Git mutations of a project's shared main working tree
// (checkouts, in-tree merges, worktree add/remove) are not safe to run
// concurrently: two merges in the same repo race the HEAD/index and can strand
// the repo on the wrong branch or leave it stuck mid-merge. This serializes
// them per repo so only one main-tree mutation runs at a time.
//
// The lock is keyed on the repo's common git dir, not on the path the caller
// handed us. Callers pass `project.repo_path` verbatim, and two spellings of
// the same directory (a symlink such as macOS's `/tmp` -> `/private/tmp`, a
// trailing slash, or two projects configured against the same repo with
// different base branches) would otherwise take two different locks and run
// concurrently. Git resolves realpaths, so the lock has to agree with it:
// `rev-parse --path-format=absolute --git-common-dir` is the identity git
// itself uses, one answer per repository, shared by the main checkout and
// every linked worktree of it, already canonicalized.
//
// Single Node process, so an in-memory promise chain is enough. Kept on
// globalThis so it survives dev HMR module reloads, the same pattern as
// lib/events.ts, lib/abort.ts, lib/asks.ts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { canonicalPath } from "./paths";

const execFileAsync = promisify(execFile);

declare global {
  // eslint-disable-next-line no-var
  var __calandriaRepoLocks: Map<string, Promise<unknown>> | undefined;
  // eslint-disable-next-line no-var
  var __calandriaRepoLockKeys: Map<string, Promise<string>> | undefined;
}

function locks(): Map<string, Promise<unknown>> {
  if (!global.__calandriaRepoLocks) global.__calandriaRepoLocks = new Map();
  return global.__calandriaRepoLocks;
}

function keyCache(): Map<string, Promise<string>> {
  if (!global.__calandriaRepoLockKeys) global.__calandriaRepoLockKeys = new Map();
  return global.__calandriaRepoLockKeys;
}

// Generous: this is a local `rev-parse`, so the ceiling only exists to stop a
// wedged subprocess from parking a task launch forever. A timeout falls back
// to the path form, the same as a non-git directory.
const RESOLVE_TIMEOUT_MS = 10_000;

async function gitCommonDir(repoPath: string): Promise<string> {
  if (!repoPath) return "";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: RESOLVE_TIMEOUT_MS }
    );
    const dir = stdout.trim();
    // `--path-format` needs git 2.31+; anything older errors out into the
    // catch. The absolute check guards against a relative answer that would
    // key ambiguously.
    return path.isAbsolute(dir) ? dir : "";
  } catch {
    return "";
  }
}

// Best available identity for a directory that isn't a git repo: a greenfield
// project, which `ensureWorktree` initializes on first launch. Canonicalized
// the same way, so two spellings still share a lock while they wait, case
// included, because on NTFS `C:\Code\App` and `c:\code\app` are one directory
// and taking two locks on it is exactly the concurrency this module exists to
// prevent (lib/paths.ts).
const pathIdentity = canonicalPath;

/**
 * The lock key for a repo path: its common git dir, or a canonicalized form of
 * the path itself when there's no repo there yet.
 *
 * Cached per input path: a `git` spawn costs 10-40ms and the lock is taken on
 * hot paths (every task launch, every merge). Exported for tests; callers use
 * `withRepoLock`, which applies this itself so no call site can forget to.
 */
export function repoLockKey(repoPath: string): Promise<string> {
  const cache = keyCache();
  const hit = cache.get(repoPath);
  if (hit) return hit;
  const pending = gitCommonDir(repoPath).then((dir) => {
    if (dir) return `git:${dir}`;
    // Don't cache a miss. A greenfield project becomes a real repo the first
    // time a task launches into it, and a remembered "not a repo" would key
    // every later call differently from the ones that follow the init,
    // handing the two of them different locks.
    if (cache.get(repoPath) === pending) cache.delete(repoPath);
    return `path:${pathIdentity(repoPath)}`;
  });
  cache.set(repoPath, pending);
  return pending;
}

/**
 * Run `fn` with exclusive access to the repository at `repoPath`. Calls for the
 * same repo queue and run one at a time, in arrival order; different repos
 * never block each other. `fn`'s result (or rejection) is returned to its own
 * caller, so a failing critical section never poisons the ones waiting behind
 * it.
 *
 * Different paths naming the same repository, including a linked worktree of
 * it, resolve to the same key and therefore the same lock.
 *
 * Acquisition is not synchronous with the call, since the key is resolved
 * first, so "arrival order" means the order callers finish resolving. Nothing
 * depends on stricter fairness than that, and the cache makes it the call
 * order in practice.
 */
export async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = await repoLockKey(repoPath);
  const reg = locks();
  const prev = reg.get(key) ?? Promise.resolve();
  // Chain fn after whatever holds the lock, regardless of how that settled.
  const run = prev.then(fn, fn);
  // The tail others wait on is settle-only, so a rejection here doesn't reject
  // the next waiter's `prev`.
  const tail = run.then(
    () => {},
    () => {}
  );
  reg.set(key, tail);
  // Drop the entry once we're the last in line, so the map doesn't grow forever.
  tail.then(() => {
    if (reg.get(key) === tail) reg.delete(key);
  });
  return run;
}
