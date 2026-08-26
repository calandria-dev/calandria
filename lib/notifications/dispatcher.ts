// Turns the events the runner ALREADY publishes into notifications.
//
// The alternative was a call at each site in lib/runner.ts that sets
// awaiting_input — an ask card, a permission card, and the turn-end settle that
// parks any turn which opened a session and ended mid-task. That is three
// chances to miss a path today and a fourth every time the runner grows one.
// Subscribing to the wildcard channel needs no edits to the runner at all, and
// it is the same seam the webhook channel will attach to. All three sites are
// covered here — `ask`, `permission` and `turn_end` — and the ROW decides in
// every case, because the emitter re-reads it through taskNeedsYou().
//
// Started from GET /api/events (idempotent, so every tab calls it) AND from the
// scheduler's boot ping (app/api/instance/scheduler/route.ts). The second one
// matters since Web Push shipped: a scheduled run that parks at 08:30 with no
// tab open anywhere publishes onto a bus nobody is reading unless this
// subscriber was attached at boot, and the push channel hangs off the emitter
// this subscriber feeds.

import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { emitAwaitingInput, emitTurnFailed } from "./notify";

declare global {
  // eslint-disable-next-line no-var
  var __calandriaNotifier: (() => void) | undefined;
}

function handle(taskId: string, ev: BusEvent): void {
  switch (ev.type) {
    // Both kinds of "your turn" park the task identically — an
    // AskUserQuestion card and a tool-permission prompt each set
    // awaiting_input — exactly as GET /api/events' coarse() treats them.
    case "ask":
    case "permission":
      emitAwaitingInput(taskId);
      return;
    // The third awaiting_input site, and the most common one by far: the
    // runner's finally sets awaiting_input on ANY turn that opened a session
    // and ended mid-task — "finished on its own or was Stopped — your move".
    // This does NOT make it a "turn finished" notification, which the design
    // ruled out: emitAwaitingInput screens through taskNeedsYou(), so a
    // scheduled success (left at 0 deliberately), a settled task, a snoozed one
    // and an archived project's are all filtered out, and the dedupe window
    // collapses the card-then-end pair a parked turn produces into one.
    case "turn_end":
      emitAwaitingInput(taskId);
      return;
    case "error":
      emitTurnFailed(taskId, ev.content);
      return;
    default:
      // Everything else is transcript detail. `notification` in particular MUST
      // fall through here: the emitter publishes onto the very bus this
      // subscriber reads, so handling it would loop.
      return;
  }
}

/**
 * Subscribe the notifier to the bus. Safe to call on every request.
 *
 * `internal: true` is load-bearing, not tidiness: watcherCount() is how
 * lib/permissions.ts decides whether a human is around to answer a permission
 * card, and this subscription never goes away once the process has served one
 * request. Counted as a watcher it would tell the gate someone is always
 * watching, and unattended auto-deny would never fire again.
 */
export function ensureNotifier(): void {
  if (global.__calandriaNotifier) return;
  global.__calandriaNotifier = subscribeGlobal((taskId, ev) => {
    try {
      handle(taskId, ev);
    } catch (err) {
      // A throw here would surface inside publish(), i.e. inside the TURN that
      // published the event. A missed notification is not worth a failed turn.
      console.error("[notifications] dispatch failed:", err);
    }
  }, { internal: true });
}

/** Unsubscribe. Test seam, and the symmetry HMR wants. */
export function stopNotifier(): void {
  global.__calandriaNotifier?.();
  global.__calandriaNotifier = undefined;
}
