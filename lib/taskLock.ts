// Per-task exclusive async lock coupling "a turn is launching" to "a git
// operation is rewriting the worktree".
//
// A merge/sync/complete route checking task.running and then running a
// multi-second git operation (git add -A + commit over the whole worktree) is
// not atomic: a POST /messages landing in that window could flip running=1
// and launch the agent, which writes into the same worktree while the merge
// is staging, committing half-written files into the base branch.
//
// Both sides run under this lock instead. A merge/sync holds it for the whole
// git operation and re-checks hasTurn() once inside; a turn launch holds it
// through registerTurn(), so by the time it releases, hasTurn() is true and a
// waiting merge gets a 409. The lock is not held while a turn streams: a live
// turn is excluded by the hasTurn() re-check, not by lock tenure, so a merge
// fails fast with 409 instead of queueing for minutes behind an agent.
//
// Kept on globalThis so dev HMR module reloads don't fork the lock table
// (same pattern as lib/events.ts / lib/abort.ts). Single Node process; no
// cross-process story needed.

declare global {
  // eslint-disable-next-line no-var
  var __calandriaTaskLocks: Map<string, Promise<void>> | undefined;
}

function locks(): Map<string, Promise<void>> {
  if (!global.__calandriaTaskLocks) global.__calandriaTaskLocks = new Map();
  return global.__calandriaTaskLocks;
}

/**
 * Run `fn` holding the exclusive per-task lock. Waiters queue FIFO behind the
 * current holder, so whatever state check `fn` performs first is atomic with
 * the work that follows it. Rethrows `fn`'s error; always releases.
 */
export async function withTaskLock<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
  const map = locks();
  const prev = map.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)); // executor runs synchronously
  const tail = prev.then(() => gate);
  map.set(taskId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Last one out drops the entry so idle tasks don't accumulate in the map.
    if (map.get(taskId) === tail) map.delete(taskId);
  }
}

/**
 * Run `fn` holding the locks of every task in `ids` at once, for a batch
 * mutation whose state check has to be atomic with a write spanning all of
 * them.
 *
 * Acquired in sorted id order, deduplicated, so two batches with overlapping
 * selections can only ever wait on each other in one direction and can't
 * deadlock (a single-task holder is the one-element case of the same
 * ordering). Locks nest: withTaskLock is not reentrant, so each lock is
 * taken inside the previous one's tenure and released by unwinding.
 */
export async function withTaskLocks<T>(ids: string[], fn: () => Promise<T> | T): Promise<T> {
  const sorted = [...new Set(ids)].sort();
  const acquire = (i: number): Promise<T> =>
    i === sorted.length ? Promise.resolve(fn()) : withTaskLock(sorted[i], () => acquire(i + 1));
  return acquire(0);
}

/** Whether anyone currently holds (or is queued on) this task's lock. */
export function isTaskLocked(taskId: string): boolean {
  return locks().has(taskId);
}
