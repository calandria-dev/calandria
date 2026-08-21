// Turns the events the runner ALREADY publishes into notifications.
//
// The alternative was a call at each site in lib/runner.ts that sets
// awaiting_input — an ask card, a permission card, and the turn-end settle that
// leaves a card open. That is three chances to miss a path today and a fourth
// every time the runner grows one. Subscribing to the wildcard channel needs no
// edits to the runner at all, and it is the same seam the webhook channel will
// attach to.
//
// Started from GET /api/events (idempotent, so every tab calls it). A boot ping
// like the scheduler's buys nothing while the only channel is a browser tab:
// the stream is a live tail, so a payload published with no tab open is
// discarded either way. The webhook task adds one.

import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { emitAwaitingInput, emitTurnFailed } from "./notify";

declare global {
  // eslint-disable-next-line no-var
  var __orchNotifier: (() => void) | undefined;
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

/** Subscribe the notifier to the bus. Safe to call on every request. */
export function ensureNotifier(): void {
  if (global.__orchNotifier) return;
  global.__orchNotifier = subscribeGlobal((taskId, ev) => {
    try {
      handle(taskId, ev);
    } catch (err) {
      // A throw here would surface inside publish(), i.e. inside the TURN that
      // published the event. A missed notification is not worth a failed turn.
      console.error("[notifications] dispatch failed:", err);
    }
  });
}

/** Unsubscribe. Test seam, and the symmetry HMR wants. */
export function stopNotifier(): void {
  global.__orchNotifier?.();
  global.__orchNotifier = undefined;
}
