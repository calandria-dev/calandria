// The server-owned schedule ticker: the app's first piece of periodic work that
// does not need a browser.
//
// (The recap "sweep" that looks like a scheduler is driven by a setInterval in
// app/orchestrator/useRecaps.ts, so it does nothing when no tab is open. This
// has to run at 08:30 with nobody logged in, so it lives here, in the server
// process, started from a boot self-ping — see app/api/instance/scheduler.)
//
// Reaches lib/runner.ts to launch turns, exactly as lib/autoStart.ts does, and
// is therefore NOT in tests/importGraph.test.ts's SDK-free PINNED set. The
// decision logic lives in lib/schedule/due.ts, which IS pinned.

import fs from "node:fs";
import { SCHEDULER_ENABLED, SCHEDULE_TICK_MS } from "@/lib/config";
import { getProject, createTask, updateTask, addMessage } from "@/lib/store";
import { adjudicate } from "@/lib/schedule/due";
import {
  activeRun, getSchedule, listEnabledSchedules, refreshNextFire, claimRun, settleRun, startRun, specOf,
} from "@/lib/schedule/store";
import { describeSpec, formatWallClock } from "@/lib/schedule/time";
import { validatePrompt } from "@/lib/schedule/commands";
import { startTurn } from "@/lib/runner";
import { claimTurn, hasTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { publish } from "@/lib/events";
import { ensureWorktree } from "@/lib/git";
import { isAgentConnected } from "@/lib/agents/connections";
import { SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import { workEnded, workStarted } from "@/lib/idle";
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
 * Preflight, mint, launch. Mirrors the initial-turn branch of
 * POST /api/tasks/[id]/messages (and lib/autoStart.ts launchInitialTurn) —
 * keep in step with those.
 */
export async function fireSchedule(schedule: Schedule, run: ScheduleRun): Promise<void> {
  // ---- preflight: fail with something actionable rather than minting a task
  // that cannot possibly work.
  const project = getProject(schedule.project_id);
  if (!project) {
    settleRun(run.id, "failed", "the project this schedule belongs to no longer exists");
    return;
  }
  if (!project.repo_path.trim()) {
    settleRun(run.id, "failed", `"${project.name}" has no working directory set, so a session cannot start`);
    return;
  }
  if (!isAgentConnected(schedule.agent)) {
    // Checked for THIS agent — never allowed to fall back to another, which
    // would silently run the work on the wrong login.
    settleRun(run.id, "failed", `${schedule.agent} is not connected — reconnect it and the next run will work`);
    return;
  }
  // Re-check the slash command at FIRE time, not just at save time: a plugin
  // can be uninstalled or renamed between the two, and an unknown command does
  // not fail — it returns "Unknown command: /x" as a SUCCESS, so the run would
  // report green having done nothing. Best-effort: `unchecked` (no registry
  // reachable) proceeds rather than blocking the morning's work on a probe.
  const check = await validatePrompt(schedule.prompt, project, schedule.agent);
  if (!check.ok) {
    const hint = check.suggestions?.length ? ` Did you mean ${check.suggestions.map((c) => `/${c}`).join(", ")}?` : "";
    settleRun(run.id, "failed", `${check.error}${hint}`);
    return;
  }

  workStarted();
  try {
    fs.mkdirSync(project.repo_path, { recursive: true });
    // In the SCHEDULE's zone, not UTC: an 08:30 America/Los_Angeles job titled
    // "15:30" is the feature contradicting, on its most visible artifact, the
    // one thing it is fastidious about.
    const stamp = formatWallClock(run.scheduled_for, schedule.timezone);
    const task = createTask({
      project_id: schedule.project_id,
      title: `${schedule.name} — ${stamp}`,
      description: `Created automatically by the "${schedule.name}" schedule (${describeSpec(specOf(schedule))}).`,
      priority: schedule.priority,
      agent: schedule.agent,
      send_context: schedule.send_context !== 0,
      permission_mode: schedule.permission_mode,
      // Set at creation rather than patched on afterwards — not because
      // updateTask would drop it (it merges {...cur, ...patch}, so an omitted
      // field is preserved from the current row), but because there's no
      // reason to pay a create-then-update round trip for a value we already
      // know at insert time.
      schedule_id: schedule.id,
    });
    startRun(run.id, task.id);

    const controller = claimTurn(task.id);
    if (!controller) {
      settleRun(run.id, "failed", "the task's turn slot was already taken");
      return;
    }
    let launched = false;
    try {
      await withTaskLock(task.id, async () => {
        let fresh = { ...task };
        try {
          const wt = await ensureWorktree(project.repo_path, task.id, project.branch);
          if (wt) {
            fresh = { ...fresh, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha };
            updateTask(task.id, { worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
          }
        } catch {
          // fall back to repo_path, exactly as the route and autoStart do
        }
        const userMsg = addMessage(task.id, fresh.generation, "user", schedule.prompt);
        updateTask(task.id, { running: 1, awaiting_input: 0 });
        publish(task.id, {
          type: "user", content: userMsg.content, msgId: userMsg.id,
          generation: fresh.generation, ts: userMsg.created_at,
        });
        const late = run.trigger === "catch_up" ? " (catching up — the app was not running at the scheduled time)" : "";
        const note = `▶ Scheduled — ${schedule.name}, ${describeSpec(specOf(schedule))}${late}.`;
        startTurn(fresh, project, schedule.prompt, note, controller, {
          ...SCHEDULED_RUN_CONTEXT,
          scheduleRunId: run.id,
        });
        launched = true;
      });
    } finally {
      if (!launched) {
        unregisterTurn(task.id, controller);
        settleRun(run.id, "failed", "the turn could not be launched");
      }
    }
  } catch (err) {
    settleRun(run.id, "failed", err instanceof Error ? err.message : String(err));
  } finally {
    workEnded();
  }
}
