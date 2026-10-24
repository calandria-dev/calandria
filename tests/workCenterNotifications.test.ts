import { beforeEach, describe, expect, it } from "vitest";

// Work Center notification receipts (contract work-center/1, amendment 1):
// durable per-channel dedupe, restart seeding, and snooze-expiry reminders.
import { createProject, createTask, setSetting, updateTask, workCenterInstanceId } from "@/lib/store";
import { getDb } from "@/lib/db";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { emitAwaitingInput, emitTurnFailed, resetNotificationDedupe } from "@/lib/notifications/notify";
import { bootNotifications, reconcileNotifications, resetNotificationBoot } from "@/lib/notifications/reminders";
import {
  claimInitial, claimReminder, finishReceipt, markResolved, pruneReceipts, recoverClaimedReceipts,
  RECEIPT_RETENTION_MS, seedActive, type DeliveryKey,
} from "@/lib/workCenter/notifyReceipts";
import type { NotificationPayload } from "@/lib/notifications/types";
import { parkAsk } from "./helpers";

const key = (over: Partial<DeliveryKey> = {}): DeliveryKey => ({
  sourceId: "question:a", sourceRevision: "r1", channel: "browser", recipientKey: "local", ...over,
});

// Tasks from earlier cases stay in the shared test DB, so a case watches only its own.
function during(fn: () => void, taskId?: string): NotificationPayload[] {
  const seen: NotificationPayload[] = [];
  const off = subscribeGlobal((_t, ev: BusEvent) => { if (ev.type === "notification" && (!taskId || ev.payload.taskId === taskId)) seen.push(ev.payload); });
  try { fn(); } finally { off(); }
  return seen;
}

async function parked(projectId: string, title = "Parked") {
  const t = createTask({ project_id: projectId, title });
  updateTask(t.id, { status: "in_progress", started: 1, running: 1, awaiting_input: 1 });
  await parkAsk(t.id);
  return t;
}

let projectId: string;
beforeEach(() => {
  getDb().exec("DELETE FROM work_center_notification_active; DELETE FROM work_center_notification_receipts;");
  resetNotificationDedupe();
  resetNotificationBoot();
  for (const k of ["notifications", "notify_awaiting_input", "notify_turn_failed"]) setSetting(k, null);
  projectId = createProject({ name: `WCN ${Math.random().toString(36).slice(2, 8)}` }).id;
});

describe("receipt claims", () => {
  it("grants the initial transition once per (source, revision, channel, recipient)", () => {
    expect(claimInitial(key())).toBeTruthy();
    expect(claimInitial(key())).toBeNull();
    expect(claimInitial(key({ sourceRevision: "r2" }))).toBeTruthy();
    expect(claimInitial(key({ channel: "push", recipientKey: "sub1" }))).toBeTruthy();
    expect(claimInitial(key({ channel: "push", recipientKey: "sub2" }))).toBeTruthy();
  });

  it("reminders need a strictly greater deadline and never replay", () => {
    expect(claimReminder(key(), 100)).toBeTruthy();
    expect(claimReminder(key(), 100)).toBeNull();
    expect(claimReminder(key(), 50)).toBeNull();
    expect(claimReminder(key(), 200)).toBeTruthy();
    // A reminder is an announcement: the ordinary event must not repeat it.
    expect(claimInitial(key())).toBeNull();
  });

  it("seeding records a source as announced without a receipt", () => {
    seedActive(key(), 500);
    expect(claimInitial(key())).toBeNull();
    expect(claimReminder(key(), 500)).toBeNull();
    expect(claimReminder(key(), 501)).toBeTruthy();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM work_center_notification_receipts").get()).toEqual({ n: 1 });
  });

  it("turns unfinished claims indeterminate on restart and keeps the transition consumed", () => {
    const id = claimInitial(key())!;
    expect(recoverClaimedReceipts(1000)).toBe(1);
    const row = getDb().prepare("SELECT state, finished_at FROM work_center_notification_receipts WHERE id = ?").get(id);
    expect(row).toEqual({ state: "indeterminate", finished_at: 1000 });
    expect(claimInitial(key())).toBeNull();
  });

  it("prunes finished receipts and resolved sources after 30 days, never live rows", () => {
    const done = claimInitial(key())!;
    finishReceipt(done, "sent", null, 1000);
    claimInitial(key({ sourceId: "question:live" }));
    markResolved(new Set(["question:live"]), 1000);
    const later = 1000 + RECEIPT_RETENTION_MS;
    expect(pruneReceipts(later - 1)).toEqual({ receipts: 0, active: 0 });
    expect(pruneReceipts(later)).toEqual({ receipts: 1, active: 1 });
    expect(claimInitial(key({ sourceId: "question:live" }))).toBeNull();
  });

  it("scopes rows to the instance", () => {
    expect(claimInitial(key({ instanceId: "other" }))).toBeTruthy();
    expect(claimInitial(key())).toBeTruthy();
    expect(workCenterInstanceId()).not.toBe("other");
  });
});

describe("transition-based delivery", () => {
  it("announces a parked task once, however many events or tabs repeat it", async () => {
    const t = await parked(projectId);
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(1);
    resetNotificationDedupe(); // past the 10s window
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(0);
  });

  it("does not replay after a restart", async () => {
    const t = await parked(projectId);
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(1);
    resetNotificationDedupe();
    resetNotificationBoot();
    bootNotifications();
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(0);
  });

  it("seeds open items at startup so they are not announced afterwards", async () => {
    const t = await parked(projectId);
    bootNotifications();
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(0);
    // A new request after startup notifies normally.
    await parkAsk(t.id);
    resetNotificationDedupe();
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(1);
  });

  it("announces a failed turn once per turn", () => {
    const t = createTask({ project_id: projectId, title: "Fails" });
    updateTask(t.id, { status: "in_progress", started: 1 });
    const setTurn = (id: string) => getDb().prepare("UPDATE tasks SET active_turn_id = ? WHERE id = ?").run(id, t.id);
    setTurn("turn-1");
    expect(during(() => { emitTurnFailed(t.id, "boom"); }, t.id)).toHaveLength(1);
    resetNotificationDedupe();
    expect(during(() => { emitTurnFailed(t.id, "boom"); }, t.id)).toHaveLength(0);
    setTurn("turn-2");
    resetNotificationDedupe();
    expect(during(() => { emitTurnFailed(t.id, "boom"); }, t.id)).toHaveLength(1);
  });
});

describe("snooze reminders", () => {
  it("sends exactly one reminder at expiry, none while snoozed, none after a restart", async () => {
    const t = await parked(projectId);
    const deadline = Date.now() + 60_000;
    updateTask(t.id, { snoozed_until: deadline });
    bootNotifications();
    expect(during(() => { emitAwaitingInput(t.id); }, t.id)).toHaveLength(0); // snoozed: silent
    expect(during(() => { reconcileNotifications(deadline - 1); }, t.id)).toHaveLength(0);
    const sent = during(() => { reconcileNotifications(deadline + 1); });
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Snooze ended");
    expect(during(() => { reconcileNotifications(deadline + 2); }, t.id)).toHaveLength(0);
    resetNotificationBoot();
    bootNotifications(deadline + 3);
    expect(during(() => { reconcileNotifications(deadline + 4); }, t.id)).toHaveLength(0);
  });

  it("consumes an already-expired snooze at startup without a send", async () => {
    const t = await parked(projectId);
    const deadline = Date.now() + 10;
    updateTask(t.id, { snoozed_until: deadline });
    const sent = during(() => { bootNotifications(deadline + 1); reconcileNotifications(deadline + 2); });
    expect(sent).toHaveLength(0);
  });

  it("re-snoozing to a later deadline yields one more reminder", async () => {
    const t = await parked(projectId);
    const d1 = Date.now() + 1000;
    updateTask(t.id, { snoozed_until: d1 });
    bootNotifications();
    expect(during(() => { reconcileNotifications(d1 + 1); }, t.id)).toHaveLength(1);
    const d2 = d1 + 5000;
    updateTask(t.id, { snoozed_until: d2 });
    expect(during(() => { reconcileNotifications(d2 + 1); }, t.id)).toHaveLength(1);
  });

  it("stays quiet for an item resolved while snoozed", async () => {
    const t = await parked(projectId);
    const deadline = Date.now() + 1000;
    updateTask(t.id, { snoozed_until: deadline, awaiting_input: 0 });
    getDb().prepare("DELETE FROM messages WHERE task_id = ?").run(t.id);
    bootNotifications();
    expect(during(() => { reconcileNotifications(deadline + 1); }, t.id)).toHaveLength(0);
  });
});
