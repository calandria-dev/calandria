// Durable notification dedupe for the Work Center (contract work-center/1,
// amendment 1). Two tables: an active high-water row per (instance, source,
// revision, channel, recipient) that remembers whether the source's initial
// notification was claimed and the highest snooze deadline already reminded,
// and a receipt row per attempted transition.
//
// The claim and the high-water update share one transaction and happen BEFORE
// the send. A failed or indeterminate attempt consumes the transition: when
// the outcome of an external send is unknown it is never retried, so a
// delivery is at most once. Web Push can still arrive twice only if a push
// service duplicates it; this module promises no more than that.
//
// DB-only so it stays out of the SDK graph (tests/importGraph.test.ts).

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { workCenterInstanceId } from "@/lib/store";

export type Channel = "browser" | "push" | "desktop";
export type ReceiptState = "claimed" | "sent" | "failed" | "indeterminate";

/** Retention for finished receipts and for active rows after their source resolved. */
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const INITIAL_TRANSITION = "actionable";
export const snoozeExpiredTransition = (deadline: number): string => `snooze_expired:${deadline}`;

export interface DeliveryKey {
  sourceId: string;
  sourceRevision: string;
  channel: Channel;
  recipientKey: string;
  instanceId?: string;
}

const inst = (k: DeliveryKey): string => k.instanceId ?? workCenterInstanceId();

function ensureActive(k: DeliveryKey): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO work_center_notification_active
         (instance_id, source_id, source_revision, channel, recipient_key) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey);
}

function insertReceipt(k: DeliveryKey, transition: string, now: number): string | null {
  const id = nanoid();
  const r = getDb()
    .prepare(
      `INSERT OR IGNORE INTO work_center_notification_receipts
         (id, instance_id, source_id, source_revision, transition, channel, recipient_key, state, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?)`,
    )
    .run(id, inst(k), k.sourceId, k.sourceRevision, transition, k.channel, k.recipientKey, now);
  return r.changes > 0 ? id : null;
}

const WHERE_ACTIVE =
  "instance_id = ? AND source_id = ? AND source_revision = ? AND channel = ? AND recipient_key = ?";

/**
 * Claim the initial notification for a source revision. Returns the receipt id
 * when this caller owns the send, null when the transition was already
 * claimed (another tab, a reconnect, a restart, a duplicate event).
 */
export function claimInitial(k: DeliveryKey, now = Date.now()): string | null {
  const db = getDb();
  return db.transaction((): string | null => {
    ensureActive(k);
    const row = db
      .prepare(`SELECT initial_claimed FROM work_center_notification_active WHERE ${WHERE_ACTIVE}`)
      .get(inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey) as { initial_claimed: number };
    if (row.initial_claimed) return null;
    const id = insertReceipt(k, INITIAL_TRANSITION, now);
    if (!id) return null;
    db.prepare(`UPDATE work_center_notification_active SET initial_claimed = 1, source_resolved_at = NULL WHERE ${WHERE_ACTIVE}`).run(
      inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey,
    );
    return id;
  })();
}

/**
 * Claim the reminder for a snooze that expired at `deadline`. The deadline must
 * exceed the highest one already consumed, so an equal or earlier deadline
 * never replays and re-snoozing to a later one yields exactly one more.
 */
export function claimReminder(k: DeliveryKey, deadline: number, now = Date.now()): string | null {
  const db = getDb();
  return db.transaction((): string | null => {
    ensureActive(k);
    const row = db
      .prepare(`SELECT latest_reminder_deadline AS d FROM work_center_notification_active WHERE ${WHERE_ACTIVE}`)
      .get(inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey) as { d: number | null };
    if (row.d !== null && deadline <= row.d) return null;
    // The high-water persists even when the receipt insert is refused, so a
    // consumed deadline is never offered twice.
    db.prepare(`UPDATE work_center_notification_active SET latest_reminder_deadline = ?, source_resolved_at = NULL WHERE ${WHERE_ACTIVE}`).run(
      deadline, inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey,
    );
    // A reminder tells the user about the item, so a later ordinary event for
    // the same revision must not announce it a second time.
    db.prepare(`UPDATE work_center_notification_active SET initial_claimed = 1 WHERE ${WHERE_ACTIVE}`).run(
      inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey,
    );
    return insertReceipt(k, snoozeExpiredTransition(deadline), now);
  })();
}

/**
 * Record a source as already notified without sending: startup seeding and the
 * reconnect path. `reminderDeadline` consumes an already-expired snooze the
 * same way.
 */
export function seedActive(k: DeliveryKey, reminderDeadline: number | null = null): void {
  const db = getDb();
  db.transaction(() => {
    ensureActive(k);
    db.prepare(`UPDATE work_center_notification_active SET initial_claimed = 1, source_resolved_at = NULL WHERE ${WHERE_ACTIVE}`).run(
      inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey,
    );
    if (reminderDeadline !== null) {
      db.prepare(
        `UPDATE work_center_notification_active
            SET latest_reminder_deadline = MAX(COALESCE(latest_reminder_deadline, 0), ?)
          WHERE ${WHERE_ACTIVE}`,
      ).run(reminderDeadline, inst(k), k.sourceId, k.sourceRevision, k.channel, k.recipientKey);
    }
  })();
}

/** Settle a claimed receipt. Every terminal attempt records finished_at. */
export function finishReceipt(id: string, state: Exclude<ReceiptState, "claimed">, errorCode: string | null = null, now = Date.now()): void {
  getDb()
    .prepare("UPDATE work_center_notification_receipts SET state = ?, finished_at = ?, error_code = ? WHERE id = ?")
    .run(state, now, errorCode, id);
}

/**
 * Boot recovery: a send that was claimed when the process died has an unknown
 * outcome. It becomes indeterminate and is never retried.
 */
export function recoverClaimedReceipts(now = Date.now()): number {
  return getDb()
    .prepare("UPDATE work_center_notification_receipts SET state = 'indeterminate', finished_at = ? WHERE state = 'claimed'")
    .run(now).changes;
}

/**
 * Stamp active rows whose source is no longer in `liveSourceIds` as resolved,
 * and clear the stamp on any that came back. Scoped to this instance.
 */
export function markResolved(liveSourceIds: ReadonlySet<string>, now = Date.now(), instanceId = workCenterInstanceId()): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT DISTINCT source_id, source_resolved_at FROM work_center_notification_active WHERE instance_id = ?")
    .all(instanceId) as Array<{ source_id: string; source_resolved_at: number | null }>;
  db.transaction(() => {
    const set = db.prepare("UPDATE work_center_notification_active SET source_resolved_at = ? WHERE instance_id = ? AND source_id = ?");
    for (const r of rows) {
      const live = liveSourceIds.has(r.source_id);
      if (!live && r.source_resolved_at === null) set.run(now, instanceId, r.source_id);
      else if (live && r.source_resolved_at !== null) set.run(null, instanceId, r.source_id);
    }
  })();
}

/** Delete finished receipts and resolved active rows past retention. Never touches live rows. */
export function pruneReceipts(now = Date.now()): { receipts: number; active: number } {
  const db = getDb();
  const cutoff = now - RECEIPT_RETENTION_MS;
  const receipts = db.prepare("DELETE FROM work_center_notification_receipts WHERE finished_at IS NOT NULL AND finished_at <= ?").run(cutoff).changes;
  const active = db.prepare("DELETE FROM work_center_notification_active WHERE source_resolved_at IS NOT NULL AND source_resolved_at <= ?").run(cutoff).changes;
  return { receipts, active };
}
