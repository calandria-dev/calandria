// Delivery of a human's request-changes feedback to the agent that submitted
// the work (contract work-center/1, "Decisions, effects, and recovery").
//
// The decision (request -> changes_requested) and the action row commit first,
// in lib/reviews/actions.ts; this module is the effect. It never resends:
//   - an idle task gets a fresh turn launched through the ordinary launcher
//     under the task lock, with the action id riding along so the runner can
//     tell when the agent actually processed it;
//   - a busy task gets the text parked in pending_messages with the action id
//     attached, and the runner's existing drains pick it up;
//   - the target is the generation the work was submitted from. A /clear, a
//     deleted task or a blocked launch is a named failure, never a redirect to
//     the newest session.
//
// Reaches the runner and the auto-start hooks through `await import()`, like
// every other module that launches a turn (tests/importGraph.test.ts).

import fs from "node:fs";

import { claimTurn, isClearing, unregisterTurn } from "../abort";
import { publish } from "../events";
import { createLogger } from "../log.mjs";
import { addPendingMessage, getProject, getTask, listPendingMessages } from "../store";
import { withTaskLock } from "../taskLock";
import { bumpWorkCenter } from "../workCenter/execution";
import { failFeedback, listQueuedFeedback, markFeedbackDispatching, markFeedbackIndeterminate, readFeedbackOperation, revertFeedbackDispatching } from "./feedbackStore";
import { getAction, getRequest, getSubmission } from "./store";

const log = createLogger("review-feedback");

/** The message the agent receives. Names the request and the exact version a resubmission must cite. */
export function feedbackText(input: { outputKey: string; revision: number; requestId: string; version: number; submissionId: string; reason: string }): string {
  return [
    `A reviewer requested changes on your submission "${input.outputKey}" (revision ${input.revision}).`,
    "",
    input.reason,
    "",
    `When the changes are done, call submit_review again for this output with requestId ${input.requestId}, expectedVersion ${input.version} and expectedSubmissionId ${input.submissionId}.`,
  ].join("\n");
}

function textFor(actionId: string): string | null {
  const action = getAction(actionId);
  const req = action && getRequest(action.request_id);
  const sub = action && getSubmission(action.submission_id);
  if (!action || !req || !sub || !action.reason) return null;
  return feedbackText({ outputKey: req.output_key, revision: sub.revision, requestId: req.id, version: req.version, submissionId: sub.id, reason: action.reason });
}

/**
 * Start (or queue) the delivery of a persisted feedback action. Safe to call
 * repeatedly: it acts only on an action whose delivery is still `queued`, and
 * recording dispatch intent is a compare-and-set, so a second caller finds
 * nothing to do.
 */
export async function deliverFeedback(actionId: string): Promise<void> {
  try {
    await deliver(actionId);
  } catch (e) {
    log.error("feedback delivery crashed", { action: actionId, err: e });
    // An unexpected throw after intent was recorded cannot be told apart from
    // a delivered message, so it is never retried automatically.
    markFeedbackIndeterminate(actionId, "delivery_error");
  }
  bumpWorkCenter();
}

async function deliver(actionId: string): Promise<void> {
  const action = getAction(actionId);
  const op = action && readFeedbackOperation(action);
  if (!action || !op || action.state !== "pending" || op.delivery !== "queued") return;

  const task = getTask(op.taskId);
  if (!task) return void failFeedback(actionId, "task_deleted");
  if (task.generation !== op.expectedGeneration) return void failFeedback(actionId, "generation_changed");
  const project = getProject(task.project_id);
  if (!project || !project.repo_path.trim()) return void failFeedback(actionId, "launch_blocked");
  const text = textFor(actionId);
  if (!text) return void failFeedback(actionId, "feedback_unavailable");

  // Already parked behind a live turn: the runner drains it.
  if (listPendingMessages(task.id).some((m) => m.review_action_id === actionId)) return;

  const controller = isClearing(task.id) ? null : claimTurn(task.id);
  if (!controller) {
    // A lingering turn holds an open input: hand the text straight in. The
    // driver says whether it can take it; a refusal means nothing was sent,
    // so intent is withdrawn and the text parks instead.
    if (listPendingMessages(task.id).length === 0 && markFeedbackDispatching(actionId)) {
      const { sendToLingeringTurn } = await import("../runner");
      if (sendToLingeringTurn(task.id, text, actionId)) return;
      revertFeedbackDispatching(actionId);
    }
    const pm = addPendingMessage(task.id, task.generation, text, actionId);
    publish(task.id, { type: "queued", msgId: pm.id, content: text, generation: task.generation, ts: pm.created_at });
    return;
  }

  let launched = false;
  try {
    await withTaskLock(task.id, async () => {
      const fresh = getTask(task.id);
      const proj = fresh && getProject(fresh.project_id);
      if (!fresh || !proj) return void failFeedback(actionId, "task_deleted");
      if (fresh.generation !== op.expectedGeneration) return void failFeedback(actionId, "generation_changed");
      try {
        fs.mkdirSync(proj.repo_path, { recursive: true });
      } catch {
        return void failFeedback(actionId, "launch_blocked");
      }
      // Dispatch intent is durable before the launcher can write anything.
      if (!markFeedbackDispatching(actionId)) return;
      launched = true;
      const [{ startResumeTurn }, { AUTO_START_HOOKS }] = await Promise.all([import("../runner"), import("../autoStart")]);
      await startResumeTurn(fresh, proj, text, controller, AUTO_START_HOOKS, actionId);
    });
  } catch (e) {
    log.error("feedback launch failed", { action: actionId, err: e });
    unregisterTurn(task.id, controller);
    const row = getAction(actionId);
    const now = row && readFeedbackOperation(row);
    // Before the transcript insert nothing reached the agent; after it, the
    // launcher failed in a window where the text may already be in flight.
    if (now?.delivery === "dispatching" && now.recordedAt === null) {
      revertFeedbackDispatching(actionId);
      failFeedback(actionId, "launch_failed");
    } else {
      markFeedbackIndeterminate(actionId, "launch_failed");
    }
    return;
  } finally {
    // The claim is released if the locked section never launched the turn.
    if (!launched) unregisterTurn(task.id, controller);
  }
}

/**
 * Re-drive feedback whose dispatch never started: the queue it was parked in
 * is cleared on restart and on Stop, and a busy task defers it. Intent was
 * never recorded for these, so starting them is the first attempt, not a
 * resend. Anything already dispatching is left alone.
 */
export async function reconcileFeedback(ownerTaskId?: string): Promise<number> {
  let started = 0;
  for (const row of listQueuedFeedback(ownerTaskId)) {
    const op = readFeedbackOperation(row);
    if (!op) continue;
    if (listPendingMessages(op.taskId).some((m) => m.review_action_id === row.id)) continue;
    await deliverFeedback(row.id);
    started++;
  }
  return started;
}
