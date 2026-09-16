// What the server does when it learns the agent CLI cut a Calandria tool call
// off: log one line, and tell the person watching once per turn.
//
// The Claude driver already does both from inside its own stream pump, which is
// the only place the in-process transport's cut-off is visible. This module is
// the same pair for the stdio bridge, whose cancellation watch
// (watchToolCancellation in lib/agentToolGuard.mjs) runs in a separate process
// and reports back over POST /api/internal/agent-tools/tool-cutoff. Both
// transports therefore emit the same log line and the same shape of transcript
// notice.
//
// Kept SDK-free (store + events + the .mjs guard only) and pinned in
// tests/importGraph.test.ts: the route that calls it is an ordinary sync-compiled
// route entry.
import { addMessage, getTask } from "./store";
import { hasTurn, turnSignal } from "./abort";
import { publish } from "./events";
import { logAgentToolCutoff } from "./agentToolLog";
import { toolDiscardedNotice } from "./agentToolGuard.mjs";

/**
 * Turns this turn has already been told about, so the user gets one notice per
 * turn, not one per cut-off call. Keyed by task and generation, since
 * `/clear` starting the next generation is exactly the recovery the notice
 * advises and the next generation deserves to be told again if it recurs.
 *
 * On globalThis so HMR can't reset it mid-turn, the house pattern for
 * server-side state that must outlive a reload (lib/events.ts, lib/abort.ts).
 * Insertion-ordered and trimmed, so a long-lived instance can't grow it without
 * bound; a trimmed key only risks one extra notice.
 */
const MAX_REMEMBERED_TURNS = 500;
function noticedTurns(): Map<string, true> {
  const g = globalThis as unknown as { __calandriaToolCutoffNoticed?: Map<string, true> };
  if (!g.__calandriaToolCutoffNoticed) g.__calandriaToolCutoffNoticed = new Map();
  return g.__calandriaToolCutoffNoticed;
}

/** For tests: forget every turn, so one case's notice can't suppress the next one's. */
export function resetToolCutoffNotices(): void {
  noticedTurns().clear();
}

export interface BridgeToolCutoff {
  /** The tool's own name, as the bridge registered it (e.g. `create_pr`). */
  tool: string;
  /** How long the call had been in flight, in ms. */
  ms: number;
  /** The cancellation's own words, when it brought any. */
  reason?: string;
}

/**
 * Was this cancellation the turn coming down, instead of a CLI cutting off a
 * call it is about to carry on past?
 *
 * Stop and `/clear` abort the turn's own controller, which tears down every tool
 * call in flight, and the graceful-shutdown drain does the same. Those are not
 * this failure: the user asked for them, and telling them their tool call was
 * discarded would put a warning on every stopped turn. An ended turn (no
 * registry entry at all) reads the same way, since the bridge reports
 * synchronously on the abort and a live turn is still registered at that point.
 */
function turnIsComingDown(taskId: string): boolean {
  if (!hasTurn(taskId)) return true;
  return turnSignal(taskId)?.aborted === true;
}

/**
 * Record a cut-off the stdio bridge observed. Logs unconditionally, so every
 * occurrence leaves a server-side trace, and appends the user-visible notice
 * only the first time this turn, matching the Claude driver's once-per-turn rule.
 *
 * Returns whether a notice was written, which is what the endpoint reports back.
 * An unknown task is logged and dropped: the bridge outlives nothing, but a task
 * deleted mid-turn has no transcript left to write to.
 */
export function reportBridgeToolCutoff(taskId: string, cut: BridgeToolCutoff): { notified: boolean } {
  const teardown = turnIsComingDown(taskId);
  logAgentToolCutoff(cut.tool, "bridge", taskId, {
    // Always true here: the bridge only learns of a cut-off it was already
    // serving, so unlike the in-process case the call did reach a handler.
    reached: true,
    ms: cut.ms,
    // Which kind of cancellation this was, so the log still records a Stop that
    // dropped a call mid-flight even though the user is told nothing.
    teardown,
    ...(cut.reason ? { reason: cut.reason } : {}),
  });
  if (teardown) return { notified: false };

  // Re-read: the bridge's env-injected id is trusted, but the row it names may
  // have moved generation (or gone) while the call was in flight.
  const task = getTask(taskId);
  if (!task) return { notified: false };

  const key = `${task.id}:${task.generation}`;
  const seen = noticedTurns();
  if (seen.has(key)) return { notified: false };
  seen.set(key, true);
  while (seen.size > MAX_REMEMBERED_TURNS) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }

  const note = toolDiscardedNotice(cut.tool);
  const m = addMessage(task.id, task.generation, "system", note);
  publish(task.id, { type: "notice", content: note, msgId: m.id, generation: task.generation, ts: m.created_at });
  return { notified: true };
}
