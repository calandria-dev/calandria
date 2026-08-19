// The DECISION half of the ticker: given a schedule and the time, decide
// whether this occurrence fires, was missed, or is skipped — and claim it.
// DB + time math only, no runner and no SDK, so every branch is testable
// without launching an agent.

import { SCHEDULE_CATCHUP_MS } from "@/lib/config";
import { nextFireAt } from "@/lib/schedule/time";
import {
  advanceNextFire, claimRun, getSchedule, recordMissedRun, recordSkippedRun, specOf,
} from "@/lib/schedule/store";
import type { Schedule, ScheduleRun } from "@/lib/types";

export type Verdict =
  | { kind: "fire"; run: ScheduleRun }
  | { kind: "missed" }
  | { kind: "skipped" }
  | { kind: "none" };

/** The effective catch-up window: the schedule's own, else the instance default. */
export const catchUpWindow = (schedule: Schedule): number =>
  schedule.catch_up_ms >= 0 ? schedule.catch_up_ms : SCHEDULE_CATCHUP_MS;

/**
 * Adjudicate one schedule at `now`. `isBusy` reports whether this schedule's
 * previous run is still live (real turn liveness — NOT task.status, which stays
 * "in progress" long after a turn ends).
 *
 * Every elapsed slot is consumed in ONE call: down from Friday to Monday, the
 * Friday slot is recorded missed and Monday's fires — the caller never has to
 * tick repeatedly to drain a backlog, and a week offline can never produce a
 * week of firings.
 */
export function adjudicate(schedule: Schedule, now: number, isBusy: (scheduleId: string) => boolean): Verdict {
  // Re-read: the snapshot may be stale by a whole tick, and the row may have
  // been paused, edited, or deleted since.
  const fresh = getSchedule(schedule.id);
  if (!fresh || !fresh.enabled) return { kind: "none" };
  if (fresh.next_fire_at > now) return { kind: "none" };

  const window = catchUpWindow(fresh);

  // Walk the backlog. Everything but the newest due slot is missed by
  // definition — we are never going to run Friday's job on Monday. dstAdjusted
  // tracks the CURRENT `slot`'s own adjustment, not the next slot's: seeded from
  // the resolution that produced `slot` itself, then re-seeded each time `slot`
  // advances.
  let slot = fresh.next_fire_at;
  let dstAdjusted = nextFireAt(specOf(fresh), slot - 1).dstAdjusted;
  for (let guard = 0; guard < 1000; guard++) {
    const upcoming = nextFireAt(specOf(fresh), slot);
    if (upcoming.ms > now) break;
    recordMissedRun(fresh.id, slot, "the app was not running at this time");
    slot = upcoming.ms;
    dstAdjusted = upcoming.dstAdjusted;
  }
  // `slot` is now the newest slot that is due, and the loop above recorded the
  // rest. Move the schedule on FIRST, so a crash between here and the launch
  // costs one run rather than wedging the schedule on a slot forever.
  advanceNextFire(fresh.id, slot);

  const lateBy = now - slot;
  if (lateBy > window) {
    recordMissedRun(fresh.id, slot, window === 0
      ? "catch-up is disabled for this schedule"
      : `the app was not running, and this was ${Math.round(lateBy / 60_000)} minutes past the catch-up window`);
    return { kind: "missed" };
  }

  // One wedged turn must not silently swallow every future occurrence, so the
  // skip is recorded and the schedule still advances.
  if (isBusy(fresh.id)) {
    recordSkippedRun(fresh.id, slot, "the previous run of this schedule was still going");
    return { kind: "skipped" };
  }

  const trigger = lateBy > 60_000 ? "catch_up" : "scheduled";
  const run = claimRun(fresh.id, slot, trigger, dstAdjusted);
  // Null means another tick claimed this exact slot first — the unique index
  // doing its job. Not an error, and not ours to run.
  return run ? { kind: "fire", run } : { kind: "none" };
}
