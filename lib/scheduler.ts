// The server-owned schedule ticker: the app's first piece of periodic work that
// does not need a browser.
//
// (The recap "sweep" that looks like a scheduler is driven by a setInterval in
// app/shell/useRecaps.ts, so it does nothing when no tab is open. This
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

import {
  RETENTION_ENABLED, SCHEDULER_ENABLED, SCHEDULE_TICK_MS, WORKTREES_DISK_WARN_BYTES, WORKTREE_SWEEP_ENABLED,
} from "@/lib/config";
import { maybeSweepRetention, retentionHealth } from "@/lib/retention";
import { maybeSweepWorktrees, worktreeSweepHealth } from "@/lib/worktreeSweep";
import { adjudicate } from "@/lib/schedule/due";
import {
  activeRun, getSchedule, listEnabledSchedules, refreshNextFire, claimRun, settleRun, startRun, specOf,
} from "@/lib/schedule/store";
import { describeSpec, formatWallClock } from "@/lib/schedule/time";
import { dispatchPromptTask } from "@/lib/dispatch";
import { getRunbook } from "@/lib/runbooks/store";
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
  var __calandriaScheduler: SchedulerState | undefined;
}

const state = (): SchedulerState =>
  (global.__calandriaScheduler ??= { timer: null, ticking: false, startedAt: 0, lastTickAt: 0, lastError: "" });

/**
 * What the card needs to tell the truth about the ticker. `tickMs` travels with
 * it so the client can age `lastTickAt` against the real interval instead of
 * guessing one, and `startedAt` covers the case `lastTickAt` cannot: a ticker
 * that started and whose very FIRST sweep never came back.
 */
export const schedulerHealth = () => {
  const s = state();
  return {
    // "the schedule half is running", not "a timer exists" — the timer also
    // ticks for retention alone, and the card ages this into a "looks stuck"
    // banner about SCHEDULES.
    started: !!s.timer && SCHEDULER_ENABLED,
    startedAt: s.startedAt,
    lastTickAt: s.lastTickAt,
    lastError: s.lastError,
    tickMs: SCHEDULE_TICK_MS,
    // Retention rides this ticker (lib/retention.ts) and has no card of its
    // own, so its cadence is reported here — otherwise "did the prune run?" has
    // no answer short of reading the log.
    retention: retentionHealth(),
    // Same deal for the worktree half (lib/worktreeSweep.ts), which also
    // carries the disk-usage reading behind the log warning — "how big is the
    // worktrees dir" otherwise has no answer short of ssh and `du`.
    worktrees: worktreeSweepHealth(),
  };
};

/**
 * Start the ticker. Idempotent — the boot ping and a lazy call from the
 * schedules API can both reach it, and only the first wins.
 */
export function startScheduler(): void {
  const s = state();
  // The ticker is also retention's clock (lib/retention.ts), so it starts for
  // EITHER job. An instance that turned scheduled work off — a shared box, a
  // second container on a copy of the DB — is exactly the one that still wants
  // its disk swept, and coupling the two would have made CALANDRIA_SCHEDULER=off
  // silently disable a policy nobody set.
  // The worktree sweep and the disk-usage warning ride it too, and the warning
  // is deliberately not conditional on the sweep: an instance with everything
  // else switched off still wants to be told its worktrees dir is 40 GB. Set
  // CALANDRIA_WORKTREES_DISK_WARN_GB=0 to stop even that.
  if (s.timer || (!SCHEDULER_ENABLED && !RETENTION_ENABLED && !WORKTREE_SWEEP_ENABLED && WORKTREES_DISK_WARN_BYTES <= 0))
    return;
  // A restart can land mid-slot, and a tzdata update can move a cached
  // next_fire_at. Revalidate every enabled schedule against its spec before the
  // first tick, so boot catch-up adjudicates from a correct position.
  if (SCHEDULER_ENABLED) {
    for (const schedule of listEnabledSchedules()) {
      try {
        if (schedule.next_fire_at <= 0) refreshNextFire(schedule);
      } catch (err) {
        console.error(`[scheduler] schedule ${schedule.id} has an unusable spec:`, err);
      }
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
    // Empty when scheduled work is switched off — the sweep below still runs,
    // which is the whole reason the ticker starts for retention alone.
    for (const schedule of SCHEDULER_ENABLED ? listEnabledSchedules() : []) {
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
    // Retention piggybacks on this ticker rather than starting a second one:
    // this process owns the database (lib/db-lock.mjs), so a prune belongs in
    // the one loop that already runs here. It keeps its own much longer clock
    // and returns immediately when it isn't due, and it is wrapped because a
    // failed prune must never stop tomorrow's 08:30 firing.
    try {
      maybeSweepRetention(Date.now());
    } catch (err) {
      console.error("[retention] sweep failed:", err);
    }
    // The worktree half (issue #15 item 2), on the same clock and wrapped for
    // the same reason. Awaited rather than fired off: it holds task and repo
    // locks and spawns git, and a sweep still running when the next one starts
    // would be two passes racing for the same checkouts.
    try {
      await maybeSweepWorktrees(Date.now());
    } catch (err) {
      console.error("[worktrees] sweep failed:", err);
    }
    s.lastTickAt = Date.now();
  } finally {
    s.ticking = false;
  }
  return launched;
}

/**
 * Is this schedule's previous run still live? Turn liveness comes from the
 * abort registry, not from the task row — the row's resting state after a turn
 * says nothing about whether anything is running: a task stays "in progress"
 * long after its turn ends, a finished turn either sets awaiting_input or (on a
 * clean scheduled run) the unread_run_at mark, and both outlive the turn.
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

/** What a firing actually runs: the linked runbook's recipe, or the schedule's own. */
export type ScheduleRecipe = Pick<Schedule, "prompt" | "agent" | "permission_mode" | "send_context" | "priority">;

/**
 * A schedule may point at a runbook so "the morning sweep" is one recipe edited
 * in one place. The schedule's own columns stay populated as the fallback and
 * are refreshed FROM the runbook if it is ever deleted (deleteRunbook copies
 * them back), so a missing link degrades to yesterday's behavior rather than to
 * an empty prompt firing every morning.
 *
 * A cross-project link is refused rather than resolved: both objects are
 * project-scoped, the runbook was written against a different repo's commands,
 * and firing it here would run the wrong recipe under a name promising
 * otherwise. Refused at save time too — this is the backstop for a row that got
 * linked some other way, or whose project changed underneath it.
 */
export function resolveScheduleRecipe(schedule: Schedule): { recipe: ScheduleRecipe } | { error: string } {
  if (!schedule.runbook_id) return { recipe: schedule };
  const rb = getRunbook(schedule.runbook_id);
  // Not an error: the FK's ON DELETE SET NULL races deleteRunbook's own detach,
  // and either way the schedule's columns hold the recipe.
  if (!rb) return { recipe: schedule };
  if (rb.project_id !== schedule.project_id) {
    return { error: `the runbook "${rb.name}" belongs to a different project, so this schedule cannot fire it` };
  }
  return { recipe: rb };
}

/**
 * Preflight, mint, launch. The mint-and-launch half now lives in
 * lib/dispatch.ts, shared with runbooks — everything left here is the part
 * that makes a firing a FIRING: the ledger link, the wall-clock stamp, and the
 * unattended RunContext.
 */
export async function fireSchedule(schedule: Schedule, run: ScheduleRun): Promise<void> {
  const resolved = resolveScheduleRecipe(schedule);
  if ("error" in resolved) {
    settleRun(run.id, "failed", resolved.error);
    return;
  }
  const recipe = resolved.recipe;
  // In the SCHEDULE's zone, not UTC: an 08:30 America/Los_Angeles job titled
  // "15:30" is the feature contradicting, on its most visible artifact, the one
  // thing it is fastidious about.
  const stamp = formatWallClock(run.scheduled_for, schedule.timezone);
  const late = run.trigger === "catch_up" ? " (catching up — the app was not running at the scheduled time)" : "";

  const result = await dispatchPromptTask({
    project_id: schedule.project_id,
    title: `${schedule.name} — ${stamp}`,
    description: `Created automatically by the "${schedule.name}" schedule (${describeSpec(specOf(schedule))}).`,
    prompt: recipe.prompt,
    agent: recipe.agent,
    permission_mode: recipe.permission_mode,
    send_context: recipe.send_context !== 0,
    priority: recipe.priority,
    note: `▶ Scheduled — ${schedule.name}, ${describeSpec(specOf(schedule))}${late}.`,
    runContext: { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: run.id },
    schedule_id: schedule.id,
    // Tagged on the minted task too, so a run is traceable to the recipe that
    // produced it and not just to the schedule that timed it.
    runbook_id: schedule.runbook_id,
    // The turn actually launched: link the task and mark the run live. Done
    // inside the dispatch rather than after it, so a launch that dies half-way
    // is still attributable to this run.
    onTaskCreated: (taskId) => startRun(run.id, taskId),
  });

  if (!result.ok) settleRun(run.id, "failed", result.error);
}

