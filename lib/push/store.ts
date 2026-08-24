// push_subscriptions CRUD. DB only — pinned SDK-free by tests/importGraph.test.ts.

import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import type { PushDevice, PushSubscriptionJson } from "./types";

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  label: string;
  created_at: number;
  last_seen_at: number;
  last_sent_at: number;
  last_status: number;
  last_error: string;
}

const LABEL_MAX = 80;

/**
 * Register a browser's subscription, or refresh one already known. Keyed on
 * the endpoint: the same browser re-posting (every page load re-syncs, and the
 * worker re-posts after a pushsubscriptionchange) refreshes last_seen_at and
 * the keys rather than minting a second row that would deliver twice.
 */
export function upsertPushSubscription(sub: PushSubscriptionJson, label: string): PushSubscriptionRow {
  const now = Date.now();
  const db = getDb();
  const existing = db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(sub.endpoint) as { id: string } | undefined;
  const trimmed = label.trim().slice(0, LABEL_MAX);
  if (existing) {
    db.prepare(
      `UPDATE push_subscriptions
          SET p256dh = ?, auth = ?, expiration_time = ?, label = CASE WHEN ? = '' THEN label ELSE ? END,
              last_seen_at = ?, last_status = 0, last_error = ''
        WHERE id = ?`
    ).run(sub.keys.p256dh, sub.keys.auth, sub.expirationTime ?? null, trimmed, trimmed, now, existing.id);
    return getPushSubscription(existing.id)!;
  }
  const id = nanoid();
  db.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, expiration_time, label, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.expirationTime ?? null, trimmed, now, now);
  return getPushSubscription(id)!;
}

export function getPushSubscription(id: string): PushSubscriptionRow | undefined {
  return getDb().prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as PushSubscriptionRow | undefined;
}

export function listPushSubscriptions(): PushSubscriptionRow[] {
  return getDb().prepare("SELECT * FROM push_subscriptions ORDER BY created_at ASC").all() as PushSubscriptionRow[];
}

export function deletePushSubscription(id: string): boolean {
  return getDb().prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes > 0;
}

export function deletePushSubscriptionByEndpoint(endpoint: string): boolean {
  return getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
}

/** Record how the push service answered the last delivery to this row. */
export function recordPushResult(id: string, status: number, error: string): void {
  getDb()
    .prepare("UPDATE push_subscriptions SET last_sent_at = ?, last_status = ?, last_error = ? WHERE id = ?")
    .run(Date.now(), status, error.slice(0, 200), id);
}

function serviceOf(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return ""; }
}

/** The device list, with the endpoint and keys deliberately left off the wire. */
export function toPushDevice(row: PushSubscriptionRow): PushDevice {
  return {
    id: row.id,
    label: row.label,
    service: serviceOf(row.endpoint),
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    last_sent_at: row.last_sent_at,
    last_status: row.last_status,
    last_error: row.last_error,
  };
}
