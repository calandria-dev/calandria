// Tells the MODEL that its own turn has gone idle. lib/turnActivity.ts
// marks the turn on the human/UI side after CALANDRIA_TURN_IDLE_MS; this is
// the model-facing counterpart.
//
// Only reachable when a session is LINGERING: lib/turnInput.ts's `send`
// refuses a mid-thought turn (see sendMidTurn in lib/agents/claude/driver.ts),
// so a nudge only lands once the model's output has finished and the
// session is held open for background work or a wakeup.
//
// Off by default (CALANDRIA_TURN_IDLE_NUDGE) and fires at most once per
// turn, to avoid billing a repeating nudge across long-running tasks.
// Excluded: a turn already parked on a human, and a scheduled run
// (interactionPolicy "deny", where nobody is reading it).
//
// SDK-free and pinned by tests/importGraph.test.ts; must not pull in
// lib/agents/registry.ts.

import { TURN_IDLE_NUDGE_ENABLED } from "./config";
import { publish } from "./events";
import { createLogger } from "./log.mjs";
import { interactionDenied } from "./runContext";
import { addMessage, getTask, listPendingMessages, updateTask } from "./store";
import { sendTurnInput } from "./turnInput";

const log = createLogger("idle-nudge");

/**
 * What the model is told. Written for it, in the shape the ask-denial notice
 * (lib/runContext.ts) established: state the fact, say what to check, and
 * name both acceptable outcomes so the answer isn't "apologize and keep
 * waiting".
 *
 * Prefixed so it can't be mistaken for the user. It arrives as an ordinary
 * user message, the only channel a CLI session has, and a model that thinks
 * the user typed this would answer the user instead of re-examining its wait.
 */
export function idleNudgeText(minutes: number): string {
  return (
    `[Calandria] This session has produced nothing for ${minutes} minutes — no output, no tool ` +
    `call — and is being held open only so background work can finish or a wakeup can fire. ` +
    `Nothing has been stopped and nothing is necessarily wrong. Check whether what you are ` +
    `waiting on is still worth waiting for: the process may have already exited, the file or ` +
    `condition you are polling may already be satisfied, or the loop doing the waiting may be ` +
    `matching itself and unable to ever finish. If the wait is still meaningful, say so in one ` +
    `line and carry on waiting. If it is not, stop waiting and finish the task. You will not be ` +
    `told this again on this turn.`
  );
}

/** The same fact, for the human reading the transcript afterwards. */
function idleNudgeNote(minutes: number): string {
  return (
    `⏸ No activity for ${minutes}m, so Calandria asked the session to re-check what it is waiting ` +
    `on. Nothing was stopped. (CALANDRIA_TURN_IDLE_NUDGE)`
  );
}

/**
 * Offer the nudge to a turn that has just been marked idle. Returns true
 * only if the session took it; the caller uses that to make sure it lands
 * at most once per turn. A refusal is not remembered, since the reasons to
 * refuse are all temporary (the turn is mid-thought; the user has something
 * queued that gets the session first).
 *
 * Everything after the handoff mirrors lib/runner.ts's recordSentMessage,
 * because accepting the message ends the linger and a real model turn
 * starts: the background flags stop being true in the same tick, and the
 * whole body is synchronous so nothing interleaves between the CLI taking
 * the message and the transcript recording it. It does not persist a
 * `user` message: the user did not type this, and a transcript that says
 * they did would carry that claim into the next `/clear` summary, so it
 * lands as the system notice it is.
 */
export function nudgeIdleTurn(taskId: string, idleSince: number, now: number = Date.now()): boolean {
  if (!TURN_IDLE_NUDGE_ENABLED) return false;
  // Nobody asked for this turn and nobody will read it (lib/runContext.ts).
  if (interactionDenied(taskId)) return false;
  const task = getTask(taskId);
  // Deleted mid-turn; the sweep prunes the record on its next pass.
  if (!task) return false;
  // The user's own follow-up was promised the session first: it was typed
  // earlier and renders above this as a queued bubble. Same rule as
  // sendToLingeringTurn's refusal (lib/runner.ts). The queue drains into the
  // session on its own at linger entry, and that message is a better
  // wake-up than this one anyway.
  if (listPendingMessages(taskId).length > 0) return false;

  const minutes = Math.max(1, Math.round((now - idleSince) / 60_000));
  // The one check that matters, and the driver's to make: refused unless the
  // session is lingering. A mid-thought turn is unreachable from here.
  if (!sendTurnInput(taskId, idleNudgeText(minutes))) return false;

  // A real model turn is starting, so "working in background" is no longer true
  // on any surface that reads the row. Persisted before the publish, like every
  // state the global stream re-reads.
  updateTask(taskId, { background_pending: 0, background_note: "" });
  try {
    const m = addMessage(taskId, task.generation, "system", idleNudgeNote(minutes));
    publish(taskId, { type: "notice", content: idleNudgeNote(minutes), msgId: m.id, generation: task.generation, ts: m.created_at });
  } catch (err) {
    // The row went away between two synchronous steps. The CLI has the message
    // and there is no transcript left to show it in; say so and move on, the
    // same way recordSentMessage does.
    log.error("nudged an idle turn but could not persist the note", { task: taskId, err });
  }
  log.info("idle turn nudged", { task: taskId, idleMinutes: minutes });
  return true;
}
