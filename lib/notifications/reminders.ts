// Startup seeding and snooze-expiry reconciliation for Work Center
// notifications (contract work-center/1, amendment 1).
//
// bootNotifications() runs once per process: unfinished sends from a dead
// predecessor become indeterminate, and every item that is already open is
// recorded as announced WITHOUT a send, so a restart or reconnect never
// replays old decisions. Expired snoozes are consumed the same way.
//
// reconcileNotifications() runs on the scheduler's ticker (which also runs
// with scheduled work off). Snooze expiry produces no task event, so this sweep
// is the only thing that notices a deadline passing: a still-open item whose
// persisted deadline has passed gets one reminder per deadline.

import { listPushSubscriptions } from "@/lib/push/store";
import { getTask, workCenterInstanceId } from "@/lib/store";
import { bumpWorkCenter } from "@/lib/workCenter/execution";
import { markResolved, pruneReceipts, recoverClaimedReceipts, seedActive } from "@/lib/workCenter/notifyReceipts";
import { assembleSnapshot } from "@/lib/workCenter/snapshot";
import type { Attention, Snapshot } from "@/lib/workCenter/types";
import { emitSnoozeReminder, type NotifySource } from "./notify";

declare global {
  // eslint-disable-next-line no-var
  var __calandriaNotifyBooted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __calandriaExpiredSnoozes: Set<string> | undefined;
}

// Snooze deadlines already announced to the Work Center stream, so the count
// returning at expiry is published once per deadline.
const expired = (): Set<string> => (global.__calandriaExpiredSnoozes ??= new Set());

function recipients(): Array<["browser" | "push", string]> {
  return [["browser", "local"], ...listPushSubscriptions().map((s): ["push", string] => ["push", s.id])];
}

/** Items the user was already told about, or may be told about only by a reminder. */
const announceable = (a: Attention): boolean => a.kind !== "ci";

function seedSnapshot(snap: Snapshot, now: number): void {
  const to = recipients();
  for (const row of snap.tasks) {
    const deadline = getTask(row.taskId)?.snoozed_until ?? 0;
    for (const a of row.attention) {
      if (!announceable(a)) continue;
      if (deadline > 0 && deadline <= now) expired().add(`${row.taskId}:${deadline}`);
      const consumed = deadline > 0 && deadline <= now && a.firstOccurredAt <= deadline ? deadline : null;
      for (const [channel, recipientKey] of to) {
        seedActive({ sourceId: a.id, sourceRevision: a.sourceRevision, channel, recipientKey }, consumed);
      }
    }
  }
}

/** Idempotent per process (HMR-safe). Returns true when this call did the boot. */
export function bootNotifications(now = Date.now()): boolean {
  if (global.__calandriaNotifyBooted) return false;
  global.__calandriaNotifyBooted = true;
  try {
    recoverClaimedReceipts(now);
    seedSnapshot(assembleSnapshot({ now, recentLimit: 1 }), now);
  } catch (err) {
    console.error("[notifications] boot seeding failed:", err);
  }
  return true;
}

/** Test seam. */
export function resetNotificationBoot(): void {
  global.__calandriaNotifyBooted = false;
  global.__calandriaExpiredSnoozes = undefined;
}

/**
 * One sweep: remind expired snoozes, track resolved sources, prune history.
 * Returns the number of tasks a reminder was offered for.
 */
export function reconcileNotifications(now = Date.now()): number {
  if (bootNotifications(now)) return 0;
  const snap = assembleSnapshot({ now, recentLimit: 1 });
  let offered = 0;
  const live = new Set<string>();
  for (const row of snap.tasks) {
    for (const a of row.attention) live.add(a.id);
    const deadline = getTask(row.taskId)?.snoozed_until ?? 0;
    if (deadline <= 0 || deadline > now) continue;
    // The task rejoins every count at its deadline with no task event; tell
    // the stream so badges (web and desktop) refetch.
    const key = `${row.taskId}:${deadline}`;
    if (!expired().has(key)) {
      expired().add(key);
      bumpWorkCenter();
    }
    // Only items that already existed when the snooze ran out are reminded;
    // anything newer is an ordinary new transition and announces itself.
    const sources: NotifySource[] = row.attention
      .filter((a) => announceable(a) && a.firstOccurredAt <= deadline)
      .map((a) => ({ sourceId: a.id, sourceRevision: a.sourceRevision, reminderDeadline: deadline }));
    if (sources.length === 0) continue;
    emitSnoozeReminder(row.taskId, sources);
    offered++;
  }
  markResolved(live, now, workCenterInstanceId());
  pruneReceipts(now);
  return offered;
}
