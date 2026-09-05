// Subscribes to the runner's wildcard event bus and turns its events into
// notifications, so no call site in lib/runner.ts has to publish one itself.
// Covers `ask`, `permission` and `turn_end`; the ROW decides in every case,
// since the emitter re-reads it through taskAwaitingInput().
//
// Started from GET /api/events (every tab calls it) and from the scheduler's
// boot ping (app/api/instance/scheduler/route.ts), so a scheduled run that
// parks with no tab open still reaches a subscriber, and the push channel
// that hangs off the emitter this subscriber feeds still fires.

import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { emitAwaitingInput, emitTurnFailed } from "./notify";

declare global {
  // eslint-disable-next-line no-var
  var __calandriaNotifier: (() => void) | undefined;
}

function handle(taskId: string, ev: BusEvent): void {
  switch (ev.type) {
    // An AskUserQuestion card and a tool-permission prompt both set
    // awaiting_input, matching how GET /api/events' coarse() treats them.
    case "ask":
    case "permission":
      emitAwaitingInput(taskId);
      return;
    // The most common awaiting_input site: the runner's finally sets it on
    // any turn that opened a session and ended mid-task. This is not a "turn
    // finished" notification: emitAwaitingInput screens through
    // taskAwaitingInput(), filtering out a scheduled success (left at 0), a
    // settled task, a snoozed one and an archived project's, and the dedupe
    // window collapses the card-then-end pair a parked turn produces.
    case "turn_end":
      emitAwaitingInput(taskId);
      return;
    case "error":
      emitTurnFailed(taskId, ev.content);
      return;
    default:
      // Everything else is transcript detail. `notification` must fall
      // through here: the emitter publishes onto this same bus, so handling
      // it here would loop.
      return;
  }
}

/**
 * Subscribe the notifier to the bus. Safe to call on every request.
 *
 * `internal: true` keeps this subscription out of watcherCount(), which
 * lib/permissions.ts uses to decide whether a human is around to answer a
 * permission card. This subscription never goes away once the process has
 * served one request, so counting it as a watcher would tell the gate someone
 * is always watching and unattended auto-deny would never fire.
 */
export function ensureNotifier(): void {
  if (global.__calandriaNotifier) return;
  global.__calandriaNotifier = subscribeGlobal((taskId, ev) => {
    try {
      handle(taskId, ev);
    } catch (err) {
      // A throw here would surface inside publish(), i.e. inside the turn
      // that published the event, and a missed notification is not worth a
      // failed turn.
      console.error("[notifications] dispatch failed:", err);
    }
  }, { internal: true });
}

/** Unsubscribe. Test seam, also used to reset the subscription on HMR. */
export function stopNotifier(): void {
  global.__calandriaNotifier?.();
  global.__calandriaNotifier = undefined;
}
