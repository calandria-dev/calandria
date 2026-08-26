// In-process registry of live turns that can still be SPOKEN TO.
//
// The Claude driver runs every turn in streaming-input mode with the prompt
// iterable held open (lib/agents/claude/driver.ts — see the background-linger
// block there), so a turn that has ended its model output but is lingering on
// run_in_background work or a scheduled wakeup still owns a writable channel
// into the CLI. This registry is how a request handler reaches it: the driver
// registers a `send` for the life of its turn, and POST /messages calls
// sendTurnInput() before it falls back to parking the message in
// pending_messages.
//
// Deliberately tiny and SDK-free (pinned by tests/importGraph.test.ts): it is
// reached from the route layer, and lib/agents/registry.ts must never be
// dragged into that graph. It mirrors lib/abort.ts in every structural way —
// keyed by task id, kept on globalThis so dev HMR reloads don't orphan a live
// turn's handle, and identity-guarded on unregister so a finishing turn can
// never wipe a successor's registration.
//
// The policy of WHEN a message may be injected lives in the driver, not here:
// only the driver knows whether the session is lingering (safe: no model turn
// is in flight, the message opens a fresh one) or mid-thought (not safe — that
// is what the pending queue is for). `send` returning false is the driver
// saying "queue it instead", and every caller must honor it.

declare global {
  // eslint-disable-next-line no-var
  var __calandriaTurnInput: Map<string, TurnInputHandle> | undefined;
}

export type TurnInputHandle = {
  /**
   * Push `text` into the open session as a new user message. Returns true if
   * the live turn accepted it — the caller then owns persisting and publishing
   * it like any other user message. False means the turn can't take it (it is
   * mid-model-turn, closing, or already closed); queue it instead.
   *
   * Synchronous by contract: callers persist the message in the same tick, so
   * nothing can interleave between the handoff and the record of it.
   */
  send: (text: string) => boolean;
};

function registry(): Map<string, TurnInputHandle> {
  if (!global.__calandriaTurnInput) global.__calandriaTurnInput = new Map();
  return global.__calandriaTurnInput;
}

/** Register the live turn's input channel. Replaces any stale occupant — a
 *  turn only reaches here after claiming the task's turn slot (lib/abort.ts),
 *  which already guarantees there is at most one live turn per task. */
export function registerTurnInput(taskId: string, handle: TurnInputHandle): void {
  registry().set(taskId, handle);
}

/** Drop the channel when the turn ends. Identity-guarded like unregisterTurn:
 *  a superseded turn unwinding must not clear its successor's handle. */
export function unregisterTurnInput(taskId: string, handle: TurnInputHandle): void {
  const reg = registry();
  if (reg.get(taskId) === handle) reg.delete(taskId);
}

/**
 * Offer `text` to the task's live turn. True means it went into the open
 * session and a real model turn is starting; false means there is no live turn,
 * its driver has no input channel (every agent but Claude today), or it is not
 * in a state that can take a message — park it in the pending queue.
 */
export function sendTurnInput(taskId: string, text: string): boolean {
  return registry().get(taskId)?.send(text) ?? false;
}
