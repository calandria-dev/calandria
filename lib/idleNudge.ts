// Telling the MODEL that its own turn has gone quiet.
//
// lib/turnActivity.ts is the human-facing half: it marks a turn that has
// produced nothing for CALANDRIA_TURN_IDLE_MS and stops there, on the grounds
// that the server cannot tell a wedged wait from a slow one. That is true of
// the SERVER. It is not true of the model, which is the only party that knows
// what it is waiting for and whether that wait still means anything — and which
// is, today, the one party never told.
//
// This is the seam that tells it, and it exists only because of one structural
// fact: the ONLY way into a live session is lib/turnInput.ts, and the Claude
// driver's `send` refuses unless the session is LINGERING (see sendMidTurn in
// lib/agents/claude/driver.ts). So the dangerous case cannot be reached from
// here at all. A turn that is genuinely mid-thought — a 40-minute Docker run in
// the foreground, a long build, a model that has been reasoning for half an
// hour — is refused by the driver, not by a heuristic in this file that could
// be wrong. What CAN be reached is exactly the case worth reaching: the model's
// output is finished, nothing is in flight, and the session is being held open
// solely so background work can settle or a wakeup can fire. A message there
// costs no work and interrupts nothing; it starts the next turn, which is the
// same thing a user typing during a linger already does.
//
// What it costs is a turn's tokens, on a wait that may be perfectly legitimate.
// That is why it is OFF by default (CALANDRIA_TURN_IDLE_NUDGE) and why it lands
// AT MOST ONCE for the life of a turn. A model that has been told once and
// decided to keep waiting has answered the question; asking again is a loop
// that bills the user for it, and across a fleet of long-running tasks a
// repeating nudge is a storm.
//
// Two exclusions, one inherited and one its own:
//
// - Parked on a human. Inherited free: the sweep never marks a turn holding a
//   question or a permission card, and the nudge only ever fires on that mark.
// - A scheduled run. Its own, and the one case where the nudge is worse than
//   nothing: a firing carries interactionPolicy "deny" precisely because
//   nobody is reading it, so a nudge would bill an unattended turn and extend a
//   run whose whole contract is to be quiet. Presence is deliberately NOT
//   checked beyond that — watcherCount() is the wrong question here. Unlike a
//   permission card, a nudge needs no answer, and the case it pays for most is
//   the one where the user launched a task and walked away.
//
// SDK-free and pinned by tests/importGraph.test.ts, like the mark it hangs off:
// it is reached from a sweep that itself runs under a route's module graph, and
// lib/agents/registry.ts must never be dragged in behind it.

import { TURN_IDLE_NUDGE_ENABLED } from "./config";
import { publish } from "./events";
import { createLogger } from "./log.mjs";
import { interactionDenied } from "./runContext";
import { addMessage, getTask, listPendingMessages, updateTask } from "./store";
import { sendTurnInput } from "./turnInput";

const log = createLogger("idle-nudge");

/**
 * What the model is told. Written FOR it, in the shape the ask-denial notice
 * (lib/runContext.ts) established: state the fact, say what to check, and name
 * both acceptable outcomes so the answer isn't "apologize and keep waiting".
 *
 * Prefixed so it can't be mistaken for the user. It arrives as an ordinary user
 * message — that is the only channel a CLI session has — and a model that
 * thinks the user typed this will answer the user rather than re-examine its
 * wait.
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
 * Offer the nudge to a turn that has just been marked idle. Returns true only
 * if the session TOOK it — the caller uses that to make sure it lands at most
 * once per turn, and a refusal is deliberately not remembered, because the
 * reasons to refuse are all temporary (the turn is mid-thought; the user has
 * something queued that gets the session first).
 *
 * Everything after the handoff mirrors lib/runner.ts's recordSentMessage,
 * because accepting the message ends the linger and a real model turn starts:
 * the background flags stop being true in the same tick, and the whole body is
 * synchronous so nothing interleaves between the CLI taking the message and the
 * transcript recording it. What it does NOT do is persist a `user` message. The
 * user did not type this, and a transcript that says they did is a lie the next
 * `/clear` summary would carry forward; it lands as the system notice it is.
 */
export function nudgeIdleTurn(taskId: string, idleSince: number, now: number = Date.now()): boolean {
  if (!TURN_IDLE_NUDGE_ENABLED) return false;
  // Nobody asked for this turn and nobody will read it (lib/runContext.ts).
  if (interactionDenied(taskId)) return false;
  const task = getTask(taskId);
  // Deleted mid-turn; the sweep prunes the record on its next pass.
  if (!task) return false;
  // The user's own follow-up was promised the session first — it was typed
  // earlier and renders above this as a queued bubble. Same rule, and the same
  // reason, as sendToLingeringTurn's refusal (lib/runner.ts). The queue drains
  // into the session on its own at linger entry, and that message is a far
  // better wake-up than this one anyway.
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
