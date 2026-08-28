// When each live turn last produced anything, and the mark that says one has
// stopped.
//
// A turn stays `running` for as long as its session is held open — which, with
// no linger deadline (BACKGROUND_LINGER_MS = 0, the default), is unbounded. So
// "the model is working" and "the model is waiting on something that finished
// half an hour ago" are drawn identically: one spinner, no way to tell them
// apart short of opening the transcript and reading the timestamps.
//
// This is the cheap, honest half of telling them apart. It records the moment
// of the last event the runner persisted and, once that goes cold, marks the
// turn — and marks it, deliberately, without touching it. The server cannot
// distinguish a wedged wait from a slow one: a 40-minute Docker e2e run and a
// `while pgrep …; do sleep; done` loop that self-matched its own command line
// look exactly the same from here. Stopping the second would mean sometimes
// stopping the first, which is far worse than the disease. So this reports the
// age and the human judges it, the same answer schedulerHealth() gives for a
// ticker whose last sweep is stale (lib/scheduler.ts).
//
// Two things the mark must never be, both of which would make it worse than
// nothing:
//
// - It is NOT "needs you". Nothing here needs answering, and diluting that pill
//   with items nobody can act on is a real cost. It rides the activity line the
//   card already draws, beside the running indicator.
// - It is NOT set on a turn parked on the user. A question card and a permission
//   prompt produce no transcript activity either, and those waits are legitimate
//   and open-ended BY DESIGN — flagging them would fire the mark on ordinary use
//   and teach people to ignore it.
//
// The model is the one party that CAN judge its own wait, and it is reached
// from the same transition — but only on an instance that opted in, because
// reaching it costs a turn's tokens. That half lives in lib/idleNudge.ts; the
// mark below is complete without it and unchanged by it.
//
// State is in memory on globalThis, the same pattern (and for the same reason)
// as lib/abort.ts, lib/asks.ts and lib/turnInput.ts: it describes a turn owned
// by THIS process, it must survive dev HMR, and it must die with the process —
// `tasks.running` can outlive a crash, this cannot. Nothing is persisted, which
// also keeps the mark off `tasks.updated_at`: that column is the board's sort
// key and retention's clock, and a task going quiet must not float to the top
// of the list as if something had happened.

import { activeTurnIds } from "./abort";
import { hasOpenAsk } from "./asks";
import { TURN_IDLE_MS, TURN_IDLE_SWEEP_MS } from "./config";
import { publishGlobal } from "./events";
import { nudgeIdleTurn } from "./idleNudge";
import { createLogger } from "./log.mjs";
import { getTask } from "./store";

const log = createLogger("turn-idle");

interface TurnActivity {
  /** When this turn last produced anything the runner persisted. */
  at: number;
  /**
   * The `at` value the sweep marked this turn idle at, or 0 while it is not
   * marked. Holding the timestamp rather than a boolean is what lets every
   * surface age it ("no activity for 34m") without a second field.
   */
  idleSince: number;
  /**
   * Whether this turn has already been TOLD it went quiet (lib/idleNudge.ts,
   * off unless CALANDRIA_TURN_IDLE_NUDGE). Deliberately NOT cleared by
   * markTurnActivity, unlike `idleSince`: a nudged model that answered and went
   * back to waiting has considered the question and said yes, so telling it
   * again is a loop that bills for itself. One per turn, for the life of the
   * turn.
   */
  nudged: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaTurnActivity: Map<string, TurnActivity> | undefined;
  // eslint-disable-next-line no-var
  var __calandriaTurnIdleTimer: NodeJS.Timeout | null | undefined;
}

function registry(): Map<string, TurnActivity> {
  if (!global.__calandriaTurnActivity) global.__calandriaTurnActivity = new Map();
  return global.__calandriaTurnActivity;
}

/**
 * Record that a turn just produced something — any event the runner persists:
 * assistant text, a tool call, a tool result, a notice, a linger boundary.
 * Called once per event from the runner's stream loop, so it must stay a Map
 * write and a branch.
 *
 * Clearing an existing mark publishes, because the client cannot learn it any
 * other way: mid-turn output is transcript detail that the global lifecycle
 * stream deliberately does not carry, so a card told "idle" once would keep
 * saying so while the turn talked.
 */
export function markTurnActivity(taskId: string): void {
  const reg = registry();
  const now = Date.now();
  const rec = reg.get(taskId);
  if (!rec) {
    reg.set(taskId, { at: now, idleSince: 0, nudged: false });
    startIdleSweep();
    return;
  }
  rec.at = now;
  if (rec.idleSince) {
    rec.idleSince = 0;
    publishGlobal(taskId, { type: "turn_idle" });
  }
}

/**
 * When this task's live turn went quiet, or 0 — not idle, not running, or the
 * mark is switched off. This is what the wire payload and the tasks list carry;
 * the client ages it against its own clock, so the value is a fixed instant
 * rather than a duration that would be stale the moment it was serialized.
 */
export function turnIdleSince(taskId: string): number {
  return registry().get(taskId)?.idleSince ?? 0;
}

/**
 * Drop a finished turn's record. A leak here is harmless — the sweep only ever
 * looks at ids with a live turn, and prunes anything else — but the map should
 * not grow for the life of the process either.
 */
export function forgetTurnActivity(taskId: string): void {
  registry().delete(taskId);
  if (registry().size === 0) stopIdleSweep();
}

/**
 * One pass: mark every live turn that has gone quiet, and unmark nothing (a
 * turn that speaks again is cleared by markTurnActivity, in the same tick it
 * speaks). Exported so tests can drive it deterministically instead of waiting
 * on the ticker.
 *
 * `activeTurnIds()` is the liveness source of truth rather than `tasks.running`
 * — the row can be stale after a crash mid-turn, the registry cannot (see
 * lib/abort.ts) — and iterating it rather than the map is also what prunes a
 * record whose turn ended down a path that never called forgetTurnActivity.
 */
export function sweepIdleTurns(now: number = Date.now()): void {
  const reg = registry();
  if (!TURN_IDLE_MS) return;
  const live = new Set(activeTurnIds());
  for (const id of reg.keys()) if (!live.has(id)) reg.delete(id);
  for (const id of live) {
    const rec = reg.get(id);
    if (!rec || rec.idleSince) continue;
    if (now - rec.at < TURN_IDLE_MS) continue;
    // The whole false-positive class, and the one that would make this feature
    // worse than not having it: a turn parked on a question card or a
    // permission prompt is silent for exactly the same reason an idle one is,
    // but it is waiting on a HUMAN and is already surfaced as such. Both facts
    // are checked because they settle at slightly different instants — the
    // registry entry exists from the moment the gate parks, the row flag from
    // the moment the runner persists the event behind it.
    if (hasOpenAsk(id)) continue;
    const task = getTask(id);
    // Deleted mid-turn: nothing left to mark, and the next pass prunes it.
    if (!task || task.awaiting_input) continue;
    rec.idleSince = rec.at;
    // Tell the model too, if this instance asked for that. Between the mark and
    // the publish on purpose: a nudge that lands ends the linger, and the one
    // event that follows should carry the row as it is AFTER that rather than
    // leaving every card saying "working in background" until the next
    // boundary. The mark itself stands either way — the nudge is us talking,
    // not the session, so it must not reset a clock that measures the session.
    // A turn that answers clears the mark through markTurnActivity like any
    // other output; one that stays silent goes on being marked, which is the
    // whole point of not treating the nudge as activity.
    if (!rec.nudged) {
      try {
        if (nudgeIdleTurn(id, rec.idleSince, now)) rec.nudged = true;
      } catch (err) {
        // Advisory, like the sweep around it. A failed nudge must never cost
        // the rest of this pass the marks it was about to set.
        log.error("idle nudge failed", { task: id, err });
      }
    }
    publishGlobal(id, { type: "turn_idle" });
  }
  if (reg.size === 0) stopIdleSweep();
}

/**
 * Run the sweep while any turn is live. Started by the first markTurnActivity
 * of a turn and stopped when the last one is forgotten, so an idle instance
 * holds no timer at all. Unref'd: this must never be the reason the process (or
 * a vitest worker) stays up.
 */
function startIdleSweep(): void {
  if (!TURN_IDLE_MS || global.__calandriaTurnIdleTimer) return;
  const timer: NodeJS.Timeout = setInterval(() => {
    try {
      sweepIdleTurns();
    } catch {
      // A sweep is advisory. One bad pass (a row deleted underneath it) must
      // never take down the process that is running the turns it describes.
    }
  }, TURN_IDLE_SWEEP_MS);
  timer.unref?.();
  global.__calandriaTurnIdleTimer = timer;
}

function stopIdleSweep(): void {
  const timer = global.__calandriaTurnIdleTimer;
  if (!timer) return;
  clearInterval(timer);
  global.__calandriaTurnIdleTimer = null;
}

/** Test seam: forget every record and stop the ticker. */
export function resetTurnActivity(): void {
  registry().clear();
  stopIdleSweep();
}
