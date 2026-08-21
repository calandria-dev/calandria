// Where a notification is MINTED. Every channel — today the browser
// (app/orchestrator/useNotifications.ts), next a webhook — receives what this
// file composed, so the policy lives here exactly once: which switches apply,
// which rows stay quiet, how a repeat is collapsed, and how the text reads.
//
// Published onto the same in-process bus the transcript uses
// (publishGlobal → GET /api/events → every open tab). SDK-free: store + bus
// only, pinned by tests/importGraph.test.ts.

import { publishGlobal } from "@/lib/events";
import { interactionDenied } from "@/lib/runContext";
import { getProject, getSetting, getTask, taskNeedsYou } from "@/lib/store";
import type { NotificationKind, NotificationPayload } from "./types";

// Per-kind opt-outs. All default ON — a notification feature that ships off is
// one nobody discovers, and every kind here is a task that has STOPPED.
const KIND_SETTING: Record<Exclude<NotificationKind, "test">, string> = {
  awaiting_input: "notify_awaiting_input",
  turn_failed: "notify_turn_failed",
  schedule_failed: "notify_schedule_failed",
};

/** The master switch. "off" is the only value that disables. */
export function notificationsEnabled(): boolean {
  return getSetting("notifications") !== "off";
}

function kindEnabled(kind: Exclude<NotificationKind, "test">): boolean {
  return getSetting(KIND_SETTING[kind]) !== "off";
}

// One assistant message can open an AskUserQuestion card AND a permission card
// — two events describing one moment. The browser's `tag` hides the duplicate
// toast, but a webhook would deliver both, so the collapse belongs here rather
// than in the channel. Keyed by the payload id, i.e. (kind, taskId).
const DEDUPE_MS = 10_000;

declare global {
  // eslint-disable-next-line no-var
  var __orchNotifySeen: Map<string, number> | undefined;
}

function seen(): Map<string, number> {
  if (!global.__orchNotifySeen) global.__orchNotifySeen = new Map();
  return global.__orchNotifySeen;
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
  // Keys are per task and tasks are hard-deleted, so without a sweep a
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

// The single exit. Every emitter below composes a payload and hands it here so
// the master switch, the dedupe and the publish can't be forgotten by one path.
function deliver(payload: NotificationPayload, dedupe = true): NotificationPayload | null {
  if (!notificationsEnabled()) return null;
  if (dedupe && deduped(payload.id, payload.ts)) return null;
  try {
    publishGlobal(payload.taskId, { type: "notification", payload });
  } catch (err) {
    // In-process pub/sub. A dead subscriber must never take down the turn that
    // triggered this.
    console.error("[notifications] publish failed:", err);
    return null;
  }
  return payload;
}

/** "· Project Name", or nothing when the project is gone. */
function projectSuffix(projectId: string): string {
  const project = getProject(projectId);
  return project ? ` · ${project.name}` : "";
}

/** A task is parked on a question, a permission card, or a finished turn. */
export function emitAwaitingInput(taskId: string): NotificationPayload | null {
  if (!kindEnabled("awaiting_input")) return null;
  // A declared-unattended turn (a scheduled run) never waits for anyone: the
  // driver publishes the card BEFORE waitForPermission() runs, and the deny
  // policy settles it inside that call — so the row really does hold
  // awaiting_input = 1 for the instant this subscriber reads it. Notifying
  // would tell the user a task is waiting on them that by design never will,
  // the same false item the scheduler keeps out of the "N need you" pill by
  // leaving awaiting_input at 0 on success.
  if (interactionDenied(taskId)) return null;
  const task = getTask(taskId);
  // The ROW decides, not the event: see taskNeedsYou in lib/store.ts.
  if (!task || !taskNeedsYou(taskId)) return null;
  return deliver({
    id: `awaiting_input:${taskId}`,
    kind: "awaiting_input",
    taskId,
    projectId: task.project_id,
    title: "Waiting for input",
    body: `${task.title}${projectSuffix(task.project_id)}`,
    ts: Date.now(),
  });
}

/**
 * A turn died. Deliberately ANY error, not just the four classified-recoverable
 * ones (dead login, context overflow, approval block, spent quota): an
 * unclassified crash parks the task just as hard and has no recovery button to
 * make itself noticeable, so restricting this would leave the worst failures
 * as the only silent ones.
 *
 * Screens `suggested` (an inert tray row nobody committed to) and NOT
 * taskNeedsYou(), so a snooze does not silence it. That asymmetry with
 * emitAwaitingInput is deliberate: snoozing a question means "remind me later
 * about this decision", never "hide it from me if the session then crashes". A
 * crash is new information, not the thing that was put off. Same for the
 * archived-project screen inside taskNeedsYou — an archived project shouldn't
 * be nagging about a pending decision, but if its work is still running and
 * falls over, that is worth knowing. emitScheduleFailed goes further and
 * screens nothing at all, because the run it reports may have failed before it
 * minted any task to be snoozed.
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
  });
}

/**
 * A scheduled run settled `failed`. The app's only genuinely unattended work,
 * and the only kind here that can name no task at all — a run that failed its
 * preflight never minted one, which is precisely the failure nobody would
 * otherwise see.
 */
export function emitScheduleFailed(a: {
  scheduleName: string;
  projectId: string;
  taskId: string;
  detail: string;
}): NotificationPayload | null {
  if (!kindEnabled("schedule_failed")) return null;
  // A scheduled turn that ERRORS reports twice: the runner publishes `error`
  // during the turn ("Turn failed · <task> · <err>") and then settles the run
  // from its finally with the same error text. Different ids, so the dedupe
  // window and the browser's tag both let the pair through as two near-identical
  // toasts. The user has already been told, with the same words, so this one
  // stands down — but ONLY for that case: a run that failed with no turn error
  // at all (preflight, unknown command, a turn cut short by an unattended deny)
  // left no `turn_failed` behind and is exactly the silent failure this kind
  // exists for.
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
 * Settings' "Send test notification". Skips the per-kind switches and the
 * dedupe window — a diagnostic that silently suppresses itself teaches the user
 * the wrong thing — but honors the master switch, which is a real answer the
 * button should report.
 */
export function emitTestNotification(): NotificationPayload | null {
  return deliver({
    id: "test",
    kind: "test",
    taskId: "",
    projectId: "",
    title: "Operator notifications are working",
    body: "You'll get one of these when a task needs you.",
    ts: Date.now(),
  }, false);
}
