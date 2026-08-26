// "Start at the usage-window reset" — the sweep behind tasks.start_at.
//
// A spent subscription limit (Claude's 5-hour window, the weekly cap) stops
// every turn on the instance until it resets, and the reset lands at an hour
// nobody wants to babysit. The user can already see WHEN (the titlebar plan
// meter, lib/agents/claude/planUsage.ts) and the runner already parks a dead
// task's queue rather than burning it (lib/usageLimit.ts) — what was missing
// is the hand-off: "when that passes, go". So a task carries ONE stored
// deadline, `start_at`, and this module is the ticker that honours it:
//
//   never started  → its first turn launches, exactly as "Start session" or a
//                    dependency auto-start would (lib/autoStart.ts);
//   started        → the session resumes with the oldest queued follow-up if
//                    one is parked, else a generic "continue" — the message
//                    the user would have typed at the reset themselves.
//
// The deadline is a plain epoch rather than "the reset" because the reset the
// user queued against is a fact at click time (the client reads it off the
// meter, lib/usageReset.ts, and adds a minute of head-room); re-deriving it at
// fire time from a snapshot that has since healed would find no reset at all.
// It is consumed by ANY turn launch (lib/runner.ts startTurn), not only this
// sweep, so a task the user started by hand in the meantime never fires twice.
//
// Unlike snoozing (app/shell/snooze.ts), which is pure derivation and
// needs no ticker, a launch is a side effect — so this is server-owned periodic
// work like lib/scheduler.ts, started from the same boot ping and idempotent
// on globalThis. It is deliberately NOT folded into that ticker: it is not a
// schedule, and `CALANDRIA_SCHEDULER=off` must not silently disable a button the
// task hero offers. Boot catch-up is free: a deadline that passed while the
// server was down is simply due on the first sweep.
//
// lib/runner.ts is reached through `await import()` for the reason spelled out
// in lib/autoStart.ts — this module shares that file's position beside the
// driver's cycle, and is pinned DYNAMIC_ONLY in tests/importGraph.test.ts.

import { SCHEDULE_TICK_MS } from "@/lib/config";
import {
  getTask,
  getProject,
  getTaskDeps,
  updateTask,
  addMessage,
  popPendingMessage,
  listDueDeferredStarts,
} from "@/lib/store";
import { claimTurn, unregisterTurn, hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish, publishGlobal } from "@/lib/events";
import { blocks, launchInitialTurn } from "@/lib/autoStart";
import type { Project, Task } from "@/lib/types";

/** Rides the runner's sync-note slot at the top of a queued first turn. */
export const DEFERRED_START_NOTE = "▶ Started automatically — queued for the usage-window reset.";
/** Persisted just before a queued resume's user message, so the transcript says why it moved. */
export const DEFERRED_RESUME_NOTE = "▶ Resumed automatically — queued for the usage-window reset.";
/** What a queued resume sends when nothing was parked in the follow-up queue. */
export const DEFERRED_RESUME_PROMPT = "The usage limit has reset — continue where you left off.";

const SKIPPED_LIVE = "ℹ Queued start skipped — a turn was already running.";
const SKIPPED_BLOCKED = "ℹ Queued start skipped — this task is still blocked by another task.";
const SKIPPED_NO_REPO = "ℹ Queued start skipped — set this project's working directory first.";

interface TickerState {
  timer: NodeJS.Timeout | null;
  sweeping: boolean;
  lastSweepAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaDeferredStart: TickerState | undefined;
}

const state = (): TickerState => (global.__calandriaDeferredStart ??= { timer: null, sweeping: false, lastSweepAt: 0 });

const isTerminal = (t: Task) => t.status === "done" || t.status === "cancelled";

/** Start the ticker. Idempotent — the boot ping and a lazy call from the task route both reach it. */
export function startDeferredStartTicker(): void {
  const s = state();
  if (s.timer) return;
  s.timer = setInterval(() => { void sweepDeferredStarts(); }, SCHEDULE_TICK_MS);
  // Never hold the process open on the ticker alone.
  s.timer.unref?.();
  void sweepDeferredStarts();
}

export function stopDeferredStartTicker(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/**
 * One sweep: launch every task whose deadline has passed. Single-flight (a
 * worktree cut can take seconds and the next tick must not overlap it) and
 * sequential (ten tasks queued for one reset must not spawn ten CLIs at once).
 * Returns how many turns were handed to the runner.
 */
export async function sweepDeferredStarts(now: number = Date.now()): Promise<number> {
  const s = state();
  if (s.sweeping) return 0;
  s.sweeping = true;
  let launched = 0;
  try {
    for (const task of listDueDeferredStarts(now)) {
      try {
        if (await fire(task)) launched++;
      } catch (err) {
        // One task's failed launch must never abort the sweep — and must never
        // leave the deadline set, or the same failure repeats every tick. The
        // launch paths have already put the failure on the task's transcript.
        console.error(`[deferredStart] could not start task ${task.id}:`, err);
        clearQueued(task.id, null);
      }
    }
    s.lastSweepAt = Date.now();
  } finally {
    s.sweeping = false;
  }
  return launched;
}

/** Drop the deadline (if still set) and, when given, say why on the transcript. */
function clearQueued(taskId: string, notice: string | null): void {
  const cur = getTask(taskId);
  if (!cur) return;
  if (cur.start_at) {
    updateTask(taskId, { start_at: 0 });
    publishGlobal(taskId, { type: "task_edited" });
  }
  if (notice) {
    try {
      const m = addMessage(taskId, cur.generation, "system", notice);
      publish(taskId, { type: "notice", content: notice, msgId: m.id, generation: cur.generation, ts: m.created_at });
    } catch (err) {
      console.error(`[deferredStart] could not persist notice for task ${taskId} (row gone?):`, err);
    }
  }
}

async function fire(task: Task): Promise<boolean> {
  // A live turn supersedes the queued one: the user acted in the meantime, and
  // that turn's own finally drains the follow-up queue when it ends.
  if (hasTurn(task.id)) {
    clearQueued(task.id, SKIPPED_LIVE);
    return false;
  }
  const project = getProject(task.project_id);
  if (!project || !project.repo_path.trim()) {
    clearQueued(task.id, SKIPPED_NO_REPO);
    return false;
  }
  if (!task.started) {
    if (getTaskDeps(task.id).some(blocks)) {
      clearQueued(task.id, SKIPPED_BLOCKED);
      return false;
    }
    // The re-check under the lock: still queued (the user can cancel between
    // the selection and the launch) and still startable. A launched turn
    // consumes the deadline in the runner; whatever the outcome, nothing may
    // leave it set for the next tick to find.
    const launched = await launchInitialTurn(task.id, DEFERRED_START_NOTE, (fresh) => fresh.start_at > 0 && !isTerminal(fresh));
    clearQueued(task.id, null);
    return launched;
  }
  return resumeQueued(task, project);
}

// Resume a started task's session, the way the queue drainer in lib/runner.ts
// continues one after a turn: pop the oldest parked follow-up (its "queued"
// bubble goes, startResumeTurn re-echoes it as a normal user message) or send
// the generic continue prompt. Every non-launch exit releases the claim; the
// world is re-read under the per-task lock because the wait can be long.
async function resumeQueued(task: Task, project: Project): Promise<boolean> {
  const controller = claimTurn(task.id);
  if (!controller) {
    clearQueued(task.id, SKIPPED_LIVE);
    return false;
  }
  let launched = false;
  let runner: typeof import("@/lib/runner") | null = null;
  try {
    runner = await import("@/lib/runner");
    const { startResumeTurn } = runner;
    await withTaskLock(task.id, async () => {
      const fresh = getTask(task.id);
      if (!fresh || fresh.start_at === 0 || isTerminal(fresh)) return;
      const proj = fresh.project_id === project.id ? project : getProject(fresh.project_id);
      if (!proj || !proj.repo_path.trim()) return;
      const next = popPendingMessage(fresh.id);
      if (next) publish(fresh.id, { type: "dequeued", msgId: next.id });
      // Consumed BEFORE the launch (the runner clears it again, harmlessly),
      // so a launch that throws below can't leave a deadline that re-fires.
      updateTask(fresh.id, { start_at: 0 });
      fresh.start_at = 0;
      const gen = fresh.generation;
      const m = addMessage(fresh.id, gen, "system", DEFERRED_RESUME_NOTE);
      publish(fresh.id, { type: "notice", content: DEFERRED_RESUME_NOTE, msgId: m.id, generation: gen, ts: m.created_at });
      publishGlobal(fresh.id, { type: "task_edited" });
      await startResumeTurn(fresh, proj, next?.content ?? DEFERRED_RESUME_PROMPT, controller);
      launched = true;
    });
  } catch (err) {
    // Nobody is watching this launch: put the failure on the transcript and
    // settle the row, the same failsafe the queue drainer uses. startResumeTurn
    // has already released the claim on its own throw; the finally's release
    // is identity-checked, so doing it again is a no-op.
    runner?.publishTurnError(task.id, task.generation, err instanceof Error ? err.message : String(err));
    const cur = getTask(task.id);
    if (cur?.running && !hasTurn(task.id)) updateTask(task.id, { running: 0, background_pending: 0, background_note: "" });
    publish(task.id, { type: "turn_end" });
    throw err;
  } finally {
    if (!launched) unregisterTurn(task.id, controller);
  }
  if (!launched) clearQueued(task.id, null);
  return launched;
}
