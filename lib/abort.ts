// In-process registry of AbortControllers for actively streaming task turns.
// The messages route registers a controller when a turn starts; the abort route
// looks it up by task id and aborts it. Single Node process, so an in-memory map
// is enough — kept on globalThis so it survives dev HMR module reloads.

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

// Tasks whose generation is being retired by POST /clear right now. A second
// registry rather than a fake entry in the one above, because the two facts are
// read for different things: `hasTurn` feeds the SSE snapshot's running flag,
// the `calandria_turns_active` metric and the shutdown drain (which waits for a
// turn_end a clear never publishes), and none of those should see a clear as a
// streaming turn. What a clear DOES need is the launch veto, so the guard lives
// in claimTurn/handoffTurn — the two chokepoints every launch path goes through.
function clearing(): Set<string> {
  if (!global.__calandriaClearing) global.__calandriaClearing = new Set();
  return global.__calandriaClearing;
}

// Atomically claim the turn slot for a task: register a fresh controller and
// return it, or return null if a turn already occupies the slot. Check +
// register happen in one synchronous step — this is the guard against the
// launch TOCTOU where two concurrent POSTs both read hasTurn()===false across
// an await (worktree creation / sync) and started two turns on one session,
// with Stop only able to reach the second. Callers must either hand the
// controller to the runner (whose finally releases it) or release it
// themselves via unregisterTurn on every non-launch path.
//
// A task mid-/clear is refused the same way an occupied slot is: the route
// aborts the live turn, then spends minutes in summarizeTranscript before it
// advances the generation, and a turn launched into that window would run
// against a generation being retired (issue #36).
export function claimTurn(taskId: string): AbortController | null {
  const reg = registry();
  if (reg.has(taskId) || clearing().has(taskId)) return null;
  const controller = new AbortController();
  reg.set(taskId, controller);
  return controller;
}

// Atomically pass the slot from a finishing turn to its dequeued follow-up.
// Returns the follow-up's fresh controller, or null if `prev` no longer owns
// the slot (it was aborted, or a successor turn claimed it). Because the swap
// is synchronous, occupancy never lapses across the handoff — no POST can
// slip a parallel turn in between the two.
export function handoffTurn(taskId: string, prev: AbortController): AbortController | null {
  const reg = registry();
  // Same veto as claimTurn: a clear in flight is retiring the generation this
  // follow-up was parked against, and will discard the queue it came from. The
  // caller leaves the message parked and settles instead of draining it.
  if (clearing().has(taskId)) return null;
  if (reg.get(taskId) !== prev) return null;
  const controller = new AbortController();
  reg.set(taskId, controller);
  return controller;
}

// Whether `controller` is the current occupant of the task's slot. A finishing
// turn uses this to detect a successor (a turn started after this one was
// Stopped but before it unwound) so it doesn't clobber the successor's state.
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
// (the ask_user bridge parking in lib/asks.ts) tie their lifetime to the turn —
// a Stop tears them down along with the turn itself.
export function turnSignal(taskId: string): AbortSignal | undefined {
  return registry().get(taskId)?.signal;
}

// Whether a turn is live for this task right now. The registry is the source
// of truth for liveness — task.running in SQLite can be stale after a server
// restart mid-turn, but this map dies (and clears) with the process.
export function hasTurn(taskId: string): boolean {
  return registry().has(taskId);
}

// Number of turns live in this process right now (idleness signal).
export function activeTurnCount(): number {
  return registry().size;
}

// Every task id with a live turn right now. Used by the graceful-shutdown
// drain (lib/runner.ts's drainActiveTurns) to know what to abort before the
// process exits — activeTurnCount() only gives a size, not something to
// iterate. A snapshot: safe to abort-while-iterating since callers copy this
// array rather than walking the live registry.
export function activeTurnIds(): string[] {
  return [...registry().keys()];
}

// Claim the task for a generation retirement (POST /clear). Returns false if a
// clear is already in flight — the caller must NOT release a claim it didn't
// take. Deliberately does not fail on a live turn: /clear's job is to abort
// that turn, and it takes this claim first so the slot the abort frees can't be
// re-taken while it summarizes.
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
