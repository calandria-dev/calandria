// Where a notification is composed. Every channel (today the browser,
// app/shell/useNotifications.ts; next a webhook) receives what this file
// built, so the policy lives here once: which switches apply, which rows are
// skipped, how a repeat is collapsed, and how the text reads.
//
// Published onto the same in-process bus the transcript uses
// (publishGlobal, GET /api/events, every open tab) and, from the same exit,
// pushed to every subscribed browser (lib/push). SDK-free: store, bus and
// fetch only, pinned by tests/importGraph.test.ts.

import { publishGlobal } from "@/lib/events";
import { pushNotificationDetached, type PushGate } from "@/lib/push/send";
import { interactionDenied } from "@/lib/runContext";
import { getProject, getSetting, getTask, taskAwaitingInput } from "@/lib/store";
import { sourceId } from "@/lib/workCenter/ids";
import {
  claimInitial,
  claimReminder,
  finishReceipt,
  type Channel,
} from "@/lib/workCenter/notifyReceipts";
import { assembleSnapshot } from "@/lib/workCenter/snapshot";
import type { Attention } from "@/lib/workCenter/types";
import type { NotificationKind, NotificationPayload } from "./types";

// Per-kind opt-outs. All default on: a notification feature that ships off
// is one nobody discovers, and every kind here is a task nobody is watching,
// either stopped or moving on its own at an hour the user is asleep.
const KIND_SETTING: Record<Exclude<NotificationKind, "test">, string> = {
  awaiting_input: "notify_awaiting_input",
  turn_failed: "notify_turn_failed",
  schedule_failed: "notify_schedule_failed",
  queued_start: "notify_queued_start",
  queued_start_skipped: "notify_queued_start_skipped",
};

/** The master switch. "off" is the only value that disables. */
export function notificationsEnabled(): boolean {
  return getSetting("notifications") !== "off";
}

function kindEnabled(kind: Exclude<NotificationKind, "test">): boolean {
  return getSetting(KIND_SETTING[kind]) !== "off";
}

// One assistant message can open an AskUserQuestion card and a permission
// card: two events describing one moment. The browser's `tag` hides the
// duplicate toast, but a webhook would deliver both, so the collapse
// happens here instead of per channel. Keyed by the payload id, i.e.
// (kind, taskId).
const DEDUPE_MS = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __calandriaNotifySeen: Map<string, number> | undefined;
}

function seen(): Map<string, number> {
  if (!global.__calandriaNotifySeen) global.__calandriaNotifySeen = new Map();
  return global.__calandriaNotifySeen;
}

/** Was this exact payload id delivered inside the window? Reads, never records. */
function recentlyDelivered(id: string, now: number): boolean {
  const last = seen().get(id);
  return last !== undefined && now - last < DEDUPE_MS;
}

function deduped(id: string, now: number): boolean {
  const m = seen();
  if (recentlyDelivered(id, now)) return true;
  m.set(id, now);
  // Keys are per task, and tasks are hard-deleted, so without a sweep a
  // long-lived server keeps one entry per task it ever notified about.
  if (m.size > 500) for (const [k, t] of m) if (now - t >= DEDUPE_MS) m.delete(k);
  return false;
}

/** Test seam: forget every dedupe window. */
export function resetNotificationDedupe(): void {
  seen().clear();
}

/** One line, trimmed to something a toast can show. */
function firstLine(text: string, max = 140): string {
  const line = text.replace(/^⚠\s*/, "").split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The Work Center source a notification reports. `reminderDeadline` marks a
 * snooze-expiry reminder (the persisted deadline); without it the source is
 * announced once, on its first actionable transition.
 */
export interface NotifySource {
  sourceId: string;
  sourceRevision: string;
  reminderDeadline?: number;
}

// The browser tabs and the desktop wrapper both listen to the one bus event,
// so they share a single `browser` receipt per source; Web Push is claimed
// per subscription.
const LOCAL_RECIPIENT = "local";

function claimFor(s: NotifySource, channel: Channel, recipientKey: string): string | null {
  const key = { sourceId: s.sourceId, sourceRevision: s.sourceRevision, channel, recipientKey };
  return s.reminderDeadline !== undefined ? claimReminder(key, s.reminderDeadline) : claimInitial(key);
}

/** Claim every source for one recipient; the ids of the claims this caller won. */
function claimAll(sources: NotifySource[], channel: Channel, recipientKey: string): string[] {
  const won: string[] = [];
  for (const s of sources) {
    const id = claimFor(s, channel, recipientKey);
    if (id) won.push(id);
  }
  return won;
}

function settleAll(ids: string[], state: "sent" | "failed" | "indeterminate", code: string | null = null): void {
  for (const id of ids) {
    try {
      finishReceipt(id, state, code);
    } catch (err) {
      console.error("[notifications] receipt update failed:", err);
    }
  }
}

// The single exit. Every emitter below composes a payload and hands it here so
// the master switch, the dedupe and the publish can't be forgotten by one path.
function deliver(payload: NotificationPayload, dedupe = true, sources: NotifySource[] = []): NotificationPayload | null {
  if (!notificationsEnabled()) return null;
  if (dedupe && deduped(payload.id, payload.ts)) return null;
  // Durable dedupe: send only when this caller wins the claim for at least
  // one source. A store failure fails open, since a missed alert costs more
  // than a repeated one.
  let browserReceipts: string[] = [];
  let gated = sources.length > 0;
  if (gated) {
    try {
      browserReceipts = claimAll(sources, "browser", LOCAL_RECIPIENT);
    } catch (err) {
      console.error("[notifications] receipt claim failed:", err);
      gated = false;
    }
  }
  const pushGate: PushGate | undefined = gated
    ? (subId) => {
        let ids: string[];
        try {
          ids = claimAll(sources, "push", subId);
        } catch {
          return () => {};
        }
        if (ids.length === 0) return null;
        return (result) => {
          if (result === null) settleAll(ids, "indeterminate", "outcome_unknown");
          else if (result.ok) settleAll(ids, "sent");
          // Status 0 is a timeout or network failure: the push service may have accepted it.
          else settleAll(ids, result.status === 0 ? "indeterminate" : "failed", result.status ? String(result.status) : "network");
        };
      }
    : undefined;
  // Nothing new for the local channel. Push is still offered to subscriptions
  // that have not been told (a device added since), through the same gate.
  const localDue = !gated || browserReceipts.length > 0;
  if (!localDue) {
    pushNotificationDetached(payload, pushGate);
    return null;
  }
  try {
    publishGlobal(payload.taskId, { type: "notification", payload });
    settleAll(browserReceipts, "sent");
  } catch (err) {
    settleAll(browserReceipts, "failed", "publish_failed");
    // In-process pub/sub. A dead subscriber must never take down the turn
    // that triggered this.
    console.error("[notifications] publish failed:", err);
    return null;
  }
  // The second channel: Web Push to every subscribed browser
  // (lib/push/send.ts), the same payload the tabs just received. Detached,
  // since this runs inside the turn that stopped and the push services are
  // on the far side of the internet. A device with a tab open gets the toast
  // twice on paper and once on screen: the worker uses the payload id as the
  // notification tag, exactly as useNotifications.ts does, so the two
  // collapse.
  pushNotificationDetached(payload, pushGate);
  return payload;
}

/** "· Project Name", or nothing when the project is gone. */
function projectSuffix(projectId: string): string {
  const project = getProject(projectId);
  return project ? ` · ${project.name}` : "";
}

const toSource = (a: Pick<Attention, "id" | "sourceRevision">): NotifySource => ({ sourceId: a.id, sourceRevision: a.sourceRevision });

/**
 * The Work Center items a "waiting for input" toast reports: the task's
 * question, permission and decision items. A parked turn with no such item
 * (a finished turn awaiting the next message) is keyed on its turn instead, so
 * it still announces once per turn.
 */
export function awaitingSources(taskId: string): NotifySource[] {
  try {
    const row = assembleSnapshot({ recentLimit: 1 }).tasks.find((t) => t.taskId === taskId);
    const items = (row?.attention ?? []).filter((a) => a.kind !== "ci" && a.kind !== "turn_failure" && a.kind !== "turn_result");
    if (items.length) return items.map(toSource);
  } catch (err) {
    console.error("[notifications] snapshot read failed:", err);
  }
  const t = getTask(taskId);
  return [{ sourceId: `awaiting:${taskId}`, sourceRevision: t?.active_turn_id ?? t?.latest_turn_id ?? "0" }];
}

/** A task is parked on a question, a permission card, or a finished turn. */
export function emitAwaitingInput(taskId: string): NotificationPayload | null {
  if (!kindEnabled("awaiting_input")) return null;
  // A declared-unattended turn (a scheduled run) never waits for anyone: the
  // driver publishes the card before waitForPermission() runs, and the deny
  // policy settles it inside that call, so the row briefly holds
  // awaiting_input = 1 while this subscriber reads it. The scheduler keeps
  // that same false item out of the "N need you" pill by leaving
  // awaiting_input at 0 on success; this screen matches that.
  if (interactionDenied(taskId)) return null;
  // A turn that just died already told the user, with the error text. The
  // runner's finally sets awaiting_input = 1 on any turn that opened a
  // session and ended mid-task, and publishes turn_end shortly after, so
  // every failed turn reaches here right behind its own `error` event. The
  // two ids differ, so neither the dedupe window nor the browser tag (which
  // is the id) collapses them on their own, so this guard stops "Turn
  // failed" from stacking with "Waiting for input" for a session that is
  // dead, not waiting. emitScheduleFailed makes the same stand-down, keeping
  // a failed scheduled run at one toast (clearRunContext has already run by
  // then, so the interactionDenied guard above can't catch it).
  //
  // Bounded by the same 10s window: reaching here again needs a new turn to
  // start and park, and the turn that failed settled the task first. The
  // only route that fast is the user clicking Retry, who is at the keyboard
  // with the browser channel already silent for the task on screen. The
  // card, the transcript and the "N need you" pill are unaffected; only the
  // toast is skipped.
  if (recentlyDelivered(`turn_failed:${taskId}`, Date.now())) return null;
  const task = getTask(taskId);
  // The row decides, not the event: see taskAwaitingInput in lib/store.ts.
  if (!task || !taskAwaitingInput(taskId)) return null;
  return deliver({
    id: `awaiting_input:${taskId}`,
    kind: "awaiting_input",
    taskId,
    projectId: task.project_id,
    title: "Waiting for input",
    body: `${task.title}${projectSuffix(task.project_id)}`,
    ts: Date.now(),
  }, true, awaitingSources(taskId));
}

/**
 * A snooze reached its deadline with the item still unresolved: one reminder
 * per recipient, episode and deadline. Skips the 10s id window (the reminder
 * is a different moment) but keeps the master and per-kind switches.
 */
export function emitSnoozeReminder(taskId: string, sources: NotifySource[]): NotificationPayload | null {
  if (!kindEnabled("awaiting_input") || sources.length === 0) return null;
  const task = getTask(taskId);
  if (!task || task.suggested) return null;
  return deliver({
    id: `awaiting_input:${taskId}`,
    kind: "awaiting_input",
    taskId,
    projectId: task.project_id,
    title: "Snooze ended",
    body: `${task.title}${projectSuffix(task.project_id)}`,
    ts: Date.now(),
  }, false, sources);
}

// The same identity the snapshot's turn_failure item carries (the error event
// fires while the turn is still active; it finalizes under the same id).
function turnFailureSource(task: { id: string; active_turn_id: string | null; latest_turn_id: string | null }): NotifySource {
  const turn = task.active_turn_id ?? task.latest_turn_id ?? "0";
  return { sourceId: sourceId("turn_failure", [task.id, turn]), sourceRevision: turn };
}

/**
 * A turn died. Covers any error, not just the four classified-recoverable
 * ones (dead login, context overflow, approval block, spent quota): an
 * unclassified crash parks the task just as hard and has no recovery button
 * to make itself noticeable, so restricting this kind would leave the worst
 * failures unreported.
 *
 * Screens `suggested` (an inert tray row nobody committed to) but not
 * taskAwaitingInput(), so a snooze does not silence it: snoozing a question
 * means "remind me later about this decision", never "hide it from me if the
 * session then crashes". A crash is new information, not the thing that was
 * put off. Same reasoning applies to the archived-project screen inside
 * taskAwaitingInput: an archived project shouldn't nag about a pending
 * decision, but if its work is still running and falls over, that is worth
 * knowing. emitScheduleFailed screens nothing at all, because the run it
 * reports may have failed before it minted any task to be snoozed.
 */
export function emitTurnFailed(taskId: string, content: string): NotificationPayload | null {
  if (!kindEnabled("turn_failed")) return null;
  const task = getTask(taskId);
  if (!task || task.suggested) return null;
  const detail = firstLine(content);
  return deliver({
    id: `turn_failed:${taskId}`,
    kind: "turn_failed",
    taskId,
    projectId: task.project_id,
    title: "Turn failed",
    body: `${task.title}${projectSuffix(task.project_id)}${detail ? `\n${detail}` : ""}`,
    ts: Date.now(),
  }, true, [turnFailureSource(task)]);
}

/**
 * A scheduled run settled `failed`. The app's only genuinely unattended
 * work, and the only kind here that can name no task at all: a run that
 * failed its preflight never minted one, which is exactly the failure
 * nobody would otherwise see.
 */
export function emitScheduleFailed(a: {
  scheduleName: string;
  projectId: string;
  taskId: string;
  detail: string;
}): NotificationPayload | null {
  if (!kindEnabled("schedule_failed")) return null;
  // A scheduled turn that errors reports twice: the runner publishes `error`
  // during the turn ("Turn failed · <task> · <err>") and then settles the
  // run from its finally with the same error text. Different ids, so the
  // dedupe window and the browser's tag both let the pair through as two
  // near-identical toasts. The user has already been told, with the same
  // words, so this one stands down, but only for that case: a run that
  // failed with no turn error at all (preflight, unknown command, a turn cut
  // short by an unattended deny) left no `turn_failed` behind and is exactly
  // the failure this kind exists to report.
  if (a.taskId && recentlyDelivered(`turn_failed:${a.taskId}`, Date.now())) return null;
  const detail = firstLine(a.detail);
  return deliver({
    id: `schedule_failed:${a.taskId || a.scheduleName}`,
    kind: "schedule_failed",
    taskId: a.taskId,
    projectId: a.projectId,
    title: "Scheduled run failed",
    body: `${a.scheduleName}${projectSuffix(a.projectId)}${detail ? `\n${detail}` : ""}`,
    ts: Date.now(),
  });
}

/**
 * A queued start fired (lib/deferredStart.ts): the sweep launched a task's
 * first turn, or resumed a started one, at the usage-window reset. The one
 * kind here that reports work starting instead of stopping, and it is worth a
 * toast for the same reason the others are: the reset lands at whatever hour
 * the window happens to expire, so without this the user learns their quota
 * is being spent by finding the transcript later.
 */
export function emitQueuedStart(taskId: string, resumed: boolean): NotificationPayload | null {
  if (!kindEnabled("queued_start")) return null;
  const task = getTask(taskId);
  if (!task) return null;
  return deliver({
    id: `queued_start:${taskId}`,
    kind: "queued_start",
    taskId,
    projectId: task.project_id,
    title: resumed ? "Resumed at the usage-window reset" : "Started at the usage-window reset",
    body: `${task.title}${projectSuffix(task.project_id)}`,
    ts: Date.now(),
  });
}

/**
 * A queued start reached its deadline and launched nothing: a turn was
 * already live, another task still blocks this one, or the project has no
 * working directory. The deadline is consumed either way, so the task sits
 * there queued for a reset that has been and gone. `why` is the same sentence
 * the sweep writes on the transcript, so the two never drift.
 */
export function emitQueuedStartSkipped(taskId: string, why: string): NotificationPayload | null {
  if (!kindEnabled("queued_start_skipped")) return null;
  const task = getTask(taskId);
  if (!task) return null;
  return deliver({
    id: `queued_start_skipped:${taskId}`,
    kind: "queued_start_skipped",
    taskId,
    projectId: task.project_id,
    title: "Queued start skipped",
    body: `${task.title}${projectSuffix(task.project_id)}\n${firstLine(why)}`,
    ts: Date.now(),
  });
}

/**
 * Settings' "Send test notification". Skips the per-kind switches and the
 * dedupe window, since a diagnostic that suppresses itself with no visible
 * reason teaches the user the wrong thing. Honors the master switch, which
 * is a real answer the button should report.
 */
export function emitTestNotification(): NotificationPayload | null {
  return deliver({
    id: "test",
    kind: "test",
    taskId: "",
    projectId: "",
    title: "Calandria notifications are working",
    body: "You'll get one of these when a task needs you.",
    ts: Date.now(),
  }, false);
}
