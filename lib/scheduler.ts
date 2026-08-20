// The server-owned schedule ticker: the app's first piece of periodic work that
// does not need a browser.
//
// (The recap "sweep" that looks like a scheduler is driven by a setInterval in
// app/orchestrator/useRecaps.ts, so it does nothing when no tab is open. This
// has to run at 08:30 with nobody logged in, so it lives here, in the server
// process, started from a boot self-ping — see app/api/instance/scheduler.)
//
// Reaches lib/runner.ts (through lib/dispatch.ts) to launch turns, exactly as
// lib/autoStart.ts does, and is therefore NOT in tests/importGraph.test.ts's
// SDK-free PINNED set. The decision logic lives in lib/schedule/due.ts, which
// IS pinned.
//
// The mint-a-task-and-launch-its-first-turn half of fireSchedule() lives in
// lib/dispatch.ts, shared with runbooks — a runbook is this feature with the
// clock taken off, and two copies of that sequence would have drifted.

import { SCHEDULER_ENABLED, SCHEDULE_TICK_MS } from "@/lib/config";
import { adjudicate } from "@/lib/schedule/due";
import {
  activeRun, getSchedule, listEnabledSchedules, refreshNextFire, claimRun, settleRun, startRun, specOf,
} from "@/lib/schedule/store";
import { describeSpec, formatWallClock } from "@/lib/schedule/time";
import { dispatchPromptTask } from "@/lib/dispatch";
import { hasTurn } from "@/lib/abort";
import { SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import type { Schedule, ScheduleRun } from "@/lib/types";

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  /** When the ticker was started, so "no tick has completed yet" can be aged. */
  startedAt: number;
  /** When the last sweep FINISHED. Stale = the sweep is wedged or dead. */
  lastTickAt: number;
  /** The last per-schedule failure, cleared by the next clean sweep. */
  lastError: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __orchScheduler: SchedulerState | undefined;
}

const state = (): SchedulerState =>
  (global.__orchScheduler ??= { timer: null, ticking: false, startedAt: 0, lastTickAt: 0, lastError: "" });

/**
 * What the card needs to tell the truth about the ticker. `tickMs` travels with
 * it so the client can age `lastTickAt` against the real interval instead of
 * guessing one, and `startedAt` covers the case `lastTickAt` cannot: a ticker
 * that started and whose very FIRST sweep never came back.
 */
export const schedulerHealth = () => {
  const s = state();
  return {
    started: !!s.timer,
    startedAt: s.startedAt,
    lastTickAt: s.lastTickAt,
    lastError: s.lastError,
    tickMs: SCHEDULE_TICK_MS,
  };
};

/**
 * Start the ticker. Idempotent — the boot ping and a lazy call from the
 * schedules API can both reach it, and only the first wins.
 */
export function startScheduler(): void {
  const s = state();
  if (s.timer || !SCHEDULER_ENABLED) return;
  // A restart can land mid-slot, and a tzdata update can move a cached
  // next_fire_at. Revalidate every enabled schedule against its spec before the
  // first tick, so boot catch-up adjudicates from a correct position.
  for (const schedule of listEnabledSchedules()) {
    try {
      if (schedule.next_fire_at <= 0) refreshNextFire(schedule);
    } catch (err) {
      console.error(`[scheduler] schedule ${schedule.id} has an unusable spec:`, err);
    }
  }
  s.startedAt = Date.now();
  s.timer = setInterval(() => { void tickSchedules(); }, SCHEDULE_TICK_MS);
  // Never hold the process open on the ticker alone.
  s.timer.unref?.();
  void tickSchedules();
}

export function stopScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/**
 * One sweep. Single-flight (a slow sweep must not overlap itself) and
 * sequential (ten schedules at 08:30 must not spawn ten worktree setups and ten
 * CLIs at once). Returns how many firings launched.
 */
export async function tickSchedules(now = Date.now()): Promise<number> {
  const s = state();
  if (s.ticking) return 0;
  s.ticking = true;
  let launched = 0;
  // Rebuilt every sweep rather than accumulated: this is the state of the world
  // NOW, so a clean sweep clears it. Left sticky (as it was), one transient
  // failure showed the banner forever, while everything else fired correctly —
  // an alarm that never goes off is one the user learns to scroll past, which
  // is the same disease as a schedule that cries wolf every morning.
  let failure = "";
  try {
    for (const schedule of listEnabledSchedules()) {
      try {
        const verdict = adjudicate(schedule, now, isScheduleBusy);
        if (verdict.kind !== "fire") continue;
        const fresh = getSchedule(schedule.id);
        if (!fresh) continue;
        await fireSchedule(fresh, verdict.run);
        launched++;
      } catch (err) {
        // One bad schedule must never abort the sweep. Named, because "the tick
        // failed" sent the user looking at the ticker when the fault was in one
        // schedule they could go and fix.
        failure = `"${schedule.name}": ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[scheduler] schedule ${schedule.id} failed to fire:`, err);
      }
    }
    s.lastError = failure;
    s.lastTickAt = Date.now();
  } finally {
    s.ticking = false;
  }
  return launched;
}

/**
 * Is this schedule's previous run still live? Turn liveness comes from the
 * abort registry, not task.status — a task stays "in progress" long after its
 * turn ends, and every finished turn sets awaiting_input.
 */
function isScheduleBusy(scheduleId: string): boolean {
  const active = activeRun(scheduleId);
  if (!active) return false;
  if (!active.task_id) return active.status === "claimed"; // mid-launch
  return hasTurn(active.task_id);
}

/** Fire NOW, out of band. Does not disturb the next scheduled occurrence. */
export async function runScheduleNow(scheduleId: string): Promise<ScheduleRun | null> {
  const schedule = getSchedule(scheduleId);
  if (!schedule) return null;
  // scheduled_for is the moment the button was pressed, so a manual run can
  // never collide with a real slot under the unique claim (and two rapid
  // presses collide with each other, which is what we want).
  const run = claimRun(schedule.id, Date.now(), "manual");
  if (!run) return null;
  await fireSchedule(schedule, run);
  return run;
}

/**
 * Preflight, mint, launch. The mint-and-launch half now lives in
 * lib/dispatch.ts, shared with runbooks — everything left here is the part
 * that makes a firing a FIRING: the ledger link, the wall-clock stamp, and the
 * unattended RunContext.
 */
export async function fireSchedule(schedule: Schedule, run: ScheduleRun): Promise<void> {
  // In the SCHEDULE's zone, not UTC: an 08:30 America/Los_Angeles job titled
  // "15:30" is the feature contradicting, on its most visible artifact, the one
  // thing it is fastidious about.
  const stamp = formatWallClock(run.scheduled_for, schedule.timezone);
  const late = run.trigger === "catch_up" ? " (catching up — the app was not running at the scheduled time)" : "";

  const result = await dispatchPromptTask({
    project_id: schedule.project_id,
    title: `${schedule.name} — ${stamp}`,
    description: `Created automatically by the "${schedule.name}" schedule (${describeSpec(specOf(schedule))}).`,
    prompt: schedule.prompt,
    agent: schedule.agent,
    permission_mode: schedule.permission_mode,
    send_context: schedule.send_context !== 0,
    priority: schedule.priority,
    note: `▶ Scheduled — ${schedule.name}, ${describeSpec(specOf(schedule))}${late}.`,
    runContext: { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: run.id },
    schedule_id: schedule.id,
    // The turn actually launched: link the task and mark the run live. Done
    // inside the dispatch rather than after it, so a launch that dies half-way
    // is still attributable to this run.
    onTaskCreated: (taskId) => startRun(run.id, taskId),
  });

  if (!result.ok) settleRun(run.id, "failed", result.error);
}

