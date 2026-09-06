// In-process registry of AbortControllers for actively streaming task turns.
// The messages route registers a controller when a turn starts; the abort route
// looks it up by task id and aborts it. Single Node process, so an in-memory map
// is enough. Kept on globalThis so it survives dev HMR module reloads.

declare global {
  // eslint-disable-next-line no-var
  var __calandriaAbort: Map<string, AbortController> | undefined;
  // eslint-disable-next-line no-var
  var __calandriaClearing: Set<string> | undefined;
}

function registry(): Map<string, AbortController> {
  if (!global.__calandriaAbort) global.__calandriaAbort = new Map();
  return global.__calandriaAbort;
}

// Tasks whose generation POST /clear is currently retiring. Kept separate from
// the turn registry above: hasTurn, the turns-active metric and the shutdown
// drain must not treat a clearing generation as a streaming turn. claimTurn and
// handoffTurn read this to veto a launch into that window.
function clearing(): Set<string> {
  if (!global.__calandriaClearing) global.__calandriaClearing = new Set();
  return global.__calandriaClearing;
}

// Atomically claims the turn slot for a task: registers a fresh controller and
// returns it, or returns null if the slot is already occupied or the task is
// mid-/clear (issue #36). The check and the register happen in one synchronous
// step, so two concurrent launches can't both see the slot free. Callers must
// hand the controller to the runner, whose finally releases it, or call
// unregisterTurn themselves on every other path.
export function claimTurn(taskId: string): AbortController | null {
  const reg = registry();
  if (reg.has(taskId) || clearing().has(taskId)) return null;
  const controller = new AbortController();
  reg.set(taskId, controller);
  return controller;
}

// Atomically passes the turn slot from a finishing turn to its dequeued
// follow-up, returning the follow-up's fresh controller. Returns null if `prev`
// no longer owns the slot (aborted, or claimed by a successor). The swap is
// synchronous, so occupancy never lapses and no other launch can slip in.
export function handoffTurn(taskId: string, prev: AbortController): AbortController | null {
  const reg = registry();
  // Same veto as claimTurn: a clear in flight will discard the queue this
  // follow-up came from, so the caller leaves it parked instead of draining it.
  if (clearing().has(taskId)) return null;
  if (reg.get(taskId) !== prev) return null;
  const controller = new AbortController();
  reg.set(taskId, controller);
  return controller;
}

// Whether `controller` is the current occupant of the task's slot. A finishing
// turn uses this to detect a successor that started after it was Stopped, so it
// doesn't clobber the successor's state.
export function ownsTurn(taskId: string, controller: AbortController): boolean {
  return registry().get(taskId) === controller;
}

// Low-level: force-register a controller, replacing any occupant. Production
// launch paths must use claimTurn/handoffTurn (atomic, never orphan a live
// controller); this exists for tests that stage the registry directly.
export function registerTurn(taskId: string, controller: AbortController): void {
  registry().set(taskId, controller);
}

// Drop the controller once the turn ends. Only clears the entry if it still
// points at this controller (so a newer turn's registration isn't wiped).
export function unregisterTurn(taskId: string, controller: AbortController): void {
  const reg = registry();
  if (reg.get(taskId) === controller) reg.delete(taskId);
}

// The abort signal of the task's live turn, if any. Lets out-of-band waiters
// (the ask_user bridge parking in lib/asks.ts) tie their lifetime to the turn,
// so a Stop tears them down along with it.
export function turnSignal(taskId: string): AbortSignal | undefined {
  return registry().get(taskId)?.signal;
}

// Whether a turn is live for this task right now. The registry is the source
// of truth for liveness: task.running in SQLite can be stale after a server
// restart mid-turn, but this map dies with the process.
export function hasTurn(taskId: string): boolean {
  return registry().has(taskId);
}

// Number of turns live in this process right now (idleness signal).
export function activeTurnCount(): number {
  return registry().size;
}

// Every task id with a live turn right now. Used by the graceful-shutdown
// drain (lib/runner.ts's drainActiveTurns) to know what to abort before the
// process exits. Returns a snapshot array, so callers can abort while
// iterating without walking the live registry.
export function activeTurnIds(): string[] {
  return [...registry().keys()];
}

// Claims the task for a generation retirement (POST /clear). Returns false if
// a clear is already in flight; the caller must not release a claim it didn't
// take. Does not fail on a live turn: /clear aborts that turn itself, taking
// this claim first so the freed slot can't be retaken while it summarizes.
export function beginClearing(taskId: string): boolean {
  const set = clearing();
  if (set.has(taskId)) return false;
  set.add(taskId);
  return true;
}

// Release the clearing claim. Must run from a finally: a summarize that throws,
// or a task deleted mid-clear, would otherwise leave the task unable to ever
// start another turn for the life of the process.
export function endClearing(taskId: string): void {
  clearing().delete(taskId);
}

// Whether a generation retirement is in flight for this task. Read by the POST
// /messages launch path, which claims the turn slot BEFORE it takes the per-task
// lock: a /clear can land in that window, abort the claimed-but-not-yet-launched
// controller, and start retiring the generation the POST is about to run on.
export function isClearing(taskId: string): boolean {
  return clearing().has(taskId);
}

// Signal abort for a task's active turn. Returns true if one was running.
export function abortTurn(taskId: string): boolean {
  const reg = registry();
  const controller = reg.get(taskId);
  if (!controller) return false;
  reg.delete(taskId);
  controller.abort();
  return true;
}
