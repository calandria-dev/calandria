# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the user a task needs them without the user having to look at the app — starting with browser notifications for a task waiting on input, a failed turn, and a failed scheduled run.

**Architecture:** Notifications are composed on the SERVER in `lib/notifications/` and fanned out on the existing in-process bus (`lib/events.ts`) as a new `notification` event, relayed to every tab by `GET /api/events`. The browser is one *channel* that renders a payload; the policy (which events matter, snooze suppression, dedupe, per-event toggles) lives server-side so the webhook and iMessage channels planned next reuse it instead of reimplementing it in React. Two of the three events are not on the global stream today, so they gain sources: a bus subscriber maps the runner's existing `ask`/`permission`/`error` events, and `settleRun()` hooks the one fact that never reaches the bus at all.

**Tech Stack:** TypeScript (strict), Next.js App Router, better-sqlite3, React 19 client hooks, Web Notifications API, vitest (unit) + Playwright (e2e), all run in Docker.

**Spec:** `docs/superpowers/specs/2026-08-21-notifications-design.md`

## Global Constraints

- **Tests run in a container.** `npm run test:docker -- tests/<file>.test.ts`, `npm run typecheck:docker`, `npm run test:e2e:docker`, `npm run preflight:docker`. Never hand-roll a `docker run`. A vitest *flag* (not a path) needs a second `--`: `npm run test:docker -- -- tests/x.test.ts -t "name"`.
- **Settings keys, all defaulting ON** (a notification system that ships off is one nobody discovers): `notifications`, `notify_awaiting_input`, `notify_turn_failed`, `notify_schedule_failed`. `"off"` is the only value that disables; anything else (including absent) is on.
- **`lib/notifications/*` must stay SDK-free** — DB + bus only, pinned by `tests/importGraph.test.ts`.
- **Dedupe window: 10,000 ms**, keyed `(kind, taskId)`.
- **Notification kinds:** `awaiting_input`, `turn_failed`, `schedule_failed`, `test`. No "turn finished" and no "suggestion filed" — deliberately out of scope.
- **`turn_failed` fires on ANY turn error**, not only the four classified-recoverable ones.
- **No `notification_channels` table.** It ships with the webhook follow-up task.
- **Comments explain WHY**, matching this repo's density. Commits are detailed and end with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## File Structure

| File | Responsibility |
|-|-|
| `lib/notifications/types.ts` (create) | The `NotificationKind` union and `NotificationPayload` shape. No logic, no imports — safe for both server and client to import as types. |
| `lib/notifications/notify.ts` (create) | The emitter: settings gates, suppression, dedupe, payload composition, publish. The only module that mints a notification. |
| `lib/notifications/dispatcher.ts` (create) | The bus subscriber translating `ask`/`permission`/`error` into emitter calls. Started once per process. |
| `lib/store.ts` (modify) | Gains `taskNeedsYou(id)` — the shared NEEDS_YOU predicate asked of one row. |
| `lib/events.ts` (modify) | Gains the `notification` bus + wire event members. |
| `app/api/events/route.ts` (modify) | Relays the notification payload; starts the dispatcher. |
| `lib/schedule/store.ts` (modify) | `settleRun()` emits `schedule_failed` on a genuine transition to `failed`. |
| `app/api/settings/route.ts` (modify) | Accepts the four new keys. |
| `app/api/notifications/test/route.ts` (create) | "Send test notification" — publishes through the real path. |
| `app/orchestrator/useNotifications.ts` (create) | The browser channel: permission state, the pure display rule, `new Notification()`, click-to-open. |
| `app/orchestrator/useGlobalEvents.ts` (modify) | Routes the new event to the channel. |
| `app/orchestrator/useOrchestrator.ts` (modify) | Adds `selTaskRef`, wires the hook, listens for the click-to-open window event. |
| `app/orchestrator/SettingsView.tsx` (modify) | The Notifications section. |
| `app/icons.tsx` (modify) | A `bell` icon. |
| `tests/notifications.test.ts` (create) | Emitter, dispatcher, relay, `settleRun`, test route, display rule. |
| `tests/importGraph.test.ts` (modify) | Pins the new modules SDK-free. |
| `e2e/13-notifications.spec.ts` (create) | The whole path through a real browser with `window.Notification` stubbed. |

---

### Task 1: The payload, the row predicate, and the emitter

**Files:**
- Create: `lib/notifications/types.ts`
- Create: `lib/notifications/notify.ts`
- Modify: `lib/store.ts` (add `taskNeedsYou` after `countAwaiting`, ~line 119)
- Modify: `lib/events.ts` (add the `notification` member to `TaskMutationEvent` and `GlobalWireEvent`)
- Modify: `tests/importGraph.test.ts` (`PINNED` list, ~line 145)
- Test: `tests/notifications.test.ts`

**Interfaces:**
- Consumes: `getTask`, `getProject`, `getSetting`, `publishGlobal` (all existing).
- Produces:
  - `type NotificationKind = "awaiting_input" | "turn_failed" | "schedule_failed" | "test"`
  - `interface NotificationPayload { id: string; kind: NotificationKind; taskId: string; projectId: string; title: string; body: string; ts: number }`
  - `taskNeedsYou(id: string): boolean`
  - `notificationsEnabled(): boolean`
  - `emitAwaitingInput(taskId: string): NotificationPayload | null`
  - `emitTurnFailed(taskId: string, content: string): NotificationPayload | null`
  - `emitScheduleFailed(a: { scheduleName: string; projectId: string; taskId: string; detail: string }): NotificationPayload | null`
  - `emitTestNotification(): NotificationPayload | null`
  - `resetNotificationDedupe(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/notifications.test.ts`:

```ts
// The notification emitter is the ONLY place a notification is minted, so it is
// the only place the policy can be pinned: which events are worth a buzz, which
// rows must stay quiet (snoozed, suggested, already-settled), and the dedupe
// window that stops one assistant message opening two cards from sending two.
// Composed server-side on purpose — the browser is a channel, not the author —
// so these assertions are what the webhook channel will inherit.
import { beforeEach, describe, expect, it } from "vitest";
import { createProject, createTask, setSetting, updateTask } from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import {
  emitAwaitingInput, emitScheduleFailed, emitTestNotification, emitTurnFailed,
  resetNotificationDedupe,
} from "@/lib/notifications/notify";
import type { NotificationPayload } from "@/lib/notifications/types";

// Every notification published while `fn` runs, in order.
function notificationsDuring(fn: () => void): NotificationPayload[] {
  const seen: NotificationPayload[] = [];
  const unsub = subscribeGlobal((_taskId, ev: BusEvent) => {
    if (ev.type === "notification") seen.push(ev.payload);
  });
  try { fn(); } finally { unsub(); }
  return seen;
}

// A task parked on a question: in_progress + awaiting_input, not suggested,
// not snoozed — the same shape the NEEDS_YOU predicate recognizes.
function parkedTask(projectId: string, title = "Parked") {
  const t = createTask({ project_id: projectId, title });
  updateTask(t.id, { status: "in_progress", running: 1, awaiting_input: 1 });
  return t;
}

let projectId: string;

beforeEach(() => {
  resetNotificationDedupe();
  for (const k of ["notifications", "notify_awaiting_input", "notify_turn_failed", "notify_schedule_failed"])
    setSetting(k, null);
  projectId = createProject({ name: `Notify ${Math.random().toString(36).slice(2, 8)}` }).id;
});

describe("the notification emitter", () => {
  it("publishes an awaiting_input notification naming the task and its project", () => {
    const project = createProject({ name: "Inbox Zero" });
    const task = parkedTask(project.id, "Review the migration");

    const sent = notificationsDuring(() => emitAwaitingInput(task.id));

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("awaiting_input");
    expect(sent[0].taskId).toBe(task.id);
    expect(sent[0].projectId).toBe(project.id);
    expect(sent[0].title).toBe("Waiting for input");
    expect(sent[0].body).toContain("Review the migration");
    expect(sent[0].body).toContain("Inbox Zero");
    // The id doubles as the browser Notification tag, so it must be STABLE per
    // (kind, task) — a timestamped id would stack toasts instead of replacing.
    expect(sent[0].id).toBe(`awaiting_input:${task.id}`);
  });

  it("stays quiet for a row that does not actually need the user", () => {
    const snoozed = parkedTask(projectId, "Snoozed");
    updateTask(snoozed.id, { snoozed_until: Date.now() + 60_000 });
    const suggested = createTask({ project_id: projectId, title: "Suggested", suggested: true });
    updateTask(suggested.id, { status: "in_progress", awaiting_input: 1 });
    // Settled between the runner's publish and our read — an ask that
    // auto-denied on an unattended turn looks exactly like this.
    const settled = createTask({ project_id: projectId, title: "Settled" });
    updateTask(settled.id, { status: "in_progress", awaiting_input: 0 });

    const sent = notificationsDuring(() => {
      emitAwaitingInput(snoozed.id);
      emitAwaitingInput(suggested.id);
      emitAwaitingInput(settled.id);
      emitAwaitingInput("no-such-task");
    });

    expect(sent).toEqual([]);
  });

  it("collapses a repeat inside the dedupe window but not a different kind or task", () => {
    const a = parkedTask(projectId, "A");
    const b = parkedTask(projectId, "B");

    const sent = notificationsDuring(() => {
      emitAwaitingInput(a.id);
      emitAwaitingInput(a.id); // one message opened an ask AND a permission card
      emitTurnFailed(a.id, "⚠ boom");
      emitAwaitingInput(b.id);
    });

    expect(sent.map((n) => `${n.kind}:${n.taskId}`)).toEqual([
      `awaiting_input:${a.id}`, `turn_failed:${a.id}`, `awaiting_input:${b.id}`,
    ]);
  });

  it("honors the master switch and the per-kind switch", () => {
    const task = parkedTask(projectId, "Quiet please");

    setSetting("notifications", "off");
    expect(notificationsDuring(() => emitAwaitingInput(task.id))).toEqual([]);

    setSetting("notifications", null);
    setSetting("notify_awaiting_input", "off");
    resetNotificationDedupe();
    expect(notificationsDuring(() => emitAwaitingInput(task.id))).toEqual([]);

    // The other kinds are unaffected by one kind's opt-out.
    resetNotificationDedupe();
    expect(notificationsDuring(() => emitTurnFailed(task.id, "⚠ boom"))).toHaveLength(1);
  });

  it("carries the first line of a turn error, and fires for an unclassified one", () => {
    const task = parkedTask(projectId, "Crashed");

    const sent = notificationsDuring(() =>
      emitTurnFailed(task.id, "⚠ ENOSPC: no space left on device\n\nsecond line"));

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("turn_failed");
    expect(sent[0].title).toBe("Turn failed");
    expect(sent[0].body).toContain("Crashed");
    expect(sent[0].body).toContain("ENOSPC: no space left on device");
    expect(sent[0].body).not.toContain("second line");
    expect(sent[0].body).not.toContain("⚠");
  });

  it("emits a schedule failure that names the schedule, with or without a task", () => {
    const withTask = parkedTask(projectId, "Morning sweep");
    const sent = notificationsDuring(() => {
      emitScheduleFailed({ scheduleName: "Morning sweep", projectId, taskId: withTask.id, detail: "Unknown command: /x" });
      emitScheduleFailed({ scheduleName: "Nightly", projectId, taskId: "", detail: "no agent connected" });
    });

    expect(sent).toHaveLength(2);
    expect(sent[0].kind).toBe("schedule_failed");
    expect(sent[0].taskId).toBe(withTask.id);
    expect(sent[0].body).toContain("Morning sweep");
    expect(sent[0].body).toContain("Unknown command: /x");
    // A run that failed before minting a task still notifies — that is the
    // silent failure this kind exists for.
    expect(sent[1].taskId).toBe("");
    expect(sent[1].body).toContain("Nightly");
  });

  it("sends a test notification past the per-kind switches and the dedupe window", () => {
    setSetting("notify_awaiting_input", "off");

    const sent = notificationsDuring(() => { emitTestNotification(); emitTestNotification(); });

    expect(sent).toHaveLength(2); // a diagnostic that silently self-suppresses is a lie
    expect(sent[0].kind).toBe("test");
    expect(sent[0].taskId).toBe("");

    // …but the master switch still governs it.
    setSetting("notifications", "off");
    expect(notificationsDuring(() => emitTestNotification())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:docker -- tests/notifications.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notifications/notify"`.

- [ ] **Step 3: Create the payload type**

Create `lib/notifications/types.ts`:

```ts
// The shape of a notification, shared by the server that composes it and the
// browser channel that renders it. Deliberately logic-free and import-free so
// a client component can `import type` it without dragging the DB in.
//
// See docs/superpowers/specs/2026-08-21-notifications-design.md.

export type NotificationKind =
  | "awaiting_input"
  | "turn_failed"
  | "schedule_failed"
  /** Settings' "Send test notification" — belongs to no task. */
  | "test";

export interface NotificationPayload {
  /**
   * Stable per (kind, task) — NOT unique per send. It is also the browser
   * Notification `tag`, so a second notification about the same task REPLACES
   * the first instead of stacking a second toast on a screen the user isn't
   * looking at.
   */
  id: string;
  kind: NotificationKind;
  /** Empty on a test notification, which belongs to no task. */
  taskId: string;
  /** Empty when the notification names no project. */
  projectId: string;
  /** The fact, e.g. "Waiting for input". Composed server-side so a second
   *  channel renders identically rather than inventing its own wording. */
  title: string;
  /** The detail: task title, project name, and the error when there is one. */
  body: string;
  ts: number;
}
```

- [ ] **Step 4: Add the single-row needs-you predicate**

In `lib/store.ts`, directly after `countAwaiting` (~line 119):

```ts
// Does this ONE task need the user right now? The same predicate the pill
// count and the dropdown use, asked of a single row — including the
// deprecated-project join listNeedsYou applies, since a project the user has
// archived should not buzz their phone.
//
// The notification emitter screens through this rather than trusting the event
// that woke it: a snoozed task, an unreviewed suggestion, and an ask that
// auto-denied on an unattended turn all publish the same "your turn" event,
// and none of them is a reason to interrupt anybody.
export function taskNeedsYou(id: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND p.deprecated = 0 AND ${NEEDS_YOU}`
    )
    .get(id);
  return !!row;
}
```

- [ ] **Step 5: Add the bus + wire event members**

In `lib/events.ts`, add the import at the top beside the existing one:

```ts
import type { NotificationPayload } from "./notifications/types";
```

Extend the comment block above `TaskMutationEvent` with a final paragraph:

```
// notification is the odd one out and knows it: not a fact about a row that
// listeners should re-read, but a message COMPOSED for a human — the payload is
// already final by the time it is published (lib/notifications/notify.ts), and
// its taskId is empty on a test send. Like runbooks_changed it therefore
// bypasses the relay's re-read-the-task enrichment entirely.
```

Add the member to `TaskMutationEvent`:

```ts
  | { type: "notification"; payload: NotificationPayload };
```

(move the `;` off the `runbooks_changed` line), and add the wire type beside `RunbooksChangedWireEvent`:

```ts
/** A composed, ready-to-render notification. See lib/notifications/. */
export type NotificationWireEvent = { type: "notification"; payload: NotificationPayload };
```

then add `| NotificationWireEvent` to the `GlobalWireEvent` union.

- [ ] **Step 6: Write the emitter**

Create `lib/notifications/notify.ts`:

```ts
// Where a notification is MINTED. Every channel — today the browser
// (app/orchestrator/useNotifications.ts), next a webhook — receives what this
// file composed, so the policy lives here exactly once: which switches apply,
// which rows stay quiet, how a repeat is collapsed, and how the text reads.
//
// Published onto the same in-process bus the transcript uses
// (publishGlobal → GET /api/events → every open tab). SDK-free: store + bus
// only, pinned by tests/importGraph.test.ts.

import { publishGlobal } from "@/lib/events";
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

function deduped(id: string, now: number): boolean {
  const m = seen();
  const last = m.get(id);
  if (last !== undefined && now - last < DEDUPE_MS) return true;
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

/** A task is parked on a question or a permission card. */
export function emitAwaitingInput(taskId: string): NotificationPayload | null {
  if (!kindEnabled("awaiting_input")) return null;
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
```

- [ ] **Step 7: Pin the new modules SDK-free**

In `tests/importGraph.test.ts`, add to `PINNED` after the `lib/runContext.ts` entry:

```ts
  "lib/notifications/notify.ts", //   composes notifications; store + bus only, no driving
```

Only this line. `reachablePackages()` reads each `PINNED` entry off disk, so naming `dispatcher.ts` before Task 2 creates it fails the suite with ENOENT — Task 2 adds its own line.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:docker -- tests/notifications.test.ts
npm run typecheck:docker
```

Expected: PASS, 7 tests. Typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add lib/notifications/types.ts lib/notifications/notify.ts lib/store.ts lib/events.ts tests/notifications.test.ts tests/importGraph.test.ts
git commit -m "$(cat <<'EOF'
Notifications: compose them on the server, not in the browser

The app can only tell you a task needs you in its own chrome, which is
exactly the signal that gets missed when a dozen sessions are running.
This is the emitter behind fixing that: one module that decides what is
worth interrupting somebody for, and publishes a finished payload onto
the bus the transcript already uses.

Composed server-side deliberately. The browser could derive a toast from
the awaiting_input event it already receives, but the next two channels
(a webhook, then an iMessage relay) have no browser to run the rules in,
and two of the three events aren't on the global stream at all. Putting
the policy in React would mean reimplementing snooze suppression and
dedupe per channel and watching them drift.

The screen is taskNeedsYou(), not the event that woke us: a snoozed task,
an unreviewed suggestion, an archived project's task, and an ask that
auto-denied on an unattended turn all publish the same "your turn" event
and none of them should reach a phone. The 10s dedupe covers a real case
rather than a hypothetical one — one assistant message can open an ask
card AND a permission card, which is two events about one moment.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The dispatcher — bus events become notifications

**Files:**
- Create: `lib/notifications/dispatcher.ts`
- Test: `tests/notifications.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `subscribeGlobal` (`lib/events.ts`), `emitAwaitingInput` / `emitTurnFailed` (Task 1).
- Produces: `ensureNotifier(): void`, `stopNotifier(): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/notifications.test.ts`:

```ts
import { publish } from "@/lib/events";
import { ensureNotifier, stopNotifier } from "@/lib/notifications/dispatcher";

describe("the notification dispatcher", () => {
  it("translates the runner's own events, and ignores its own", () => {
    const task = parkedTask(projectId, "Parked by the runner");
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(task.id, { type: "ask", id: "a1", questions: [] });
        publish(task.id, { type: "assistant", content: "thinking out loud" });
        publish(task.id, { type: "usage", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 } });
      });
      expect(sent.map((n) => n.kind)).toEqual(["awaiting_input"]);
    } finally {
      stopNotifier();
    }
  });

  it("maps a permission card and a turn error", () => {
    const a = parkedTask(projectId, "Permission");
    const b = parkedTask(projectId, "Boom");
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => {
        publish(a.id, { type: "permission", request: { id: "p1", tool: "Bash", input: { command: "npm run lint" } } });
        publish(b.id, { type: "error", content: "⚠ the session ended unexpectedly" });
      });
      expect(sent.map((n) => `${n.kind}:${n.taskId}`)).toEqual([
        `awaiting_input:${a.id}`, `turn_failed:${b.id}`,
      ]);
    } finally {
      stopNotifier();
    }
  });

  it("subscribes at most once however many callers start it", () => {
    const task = parkedTask(projectId, "Once only");
    ensureNotifier();
    ensureNotifier();
    ensureNotifier();
    try {
      const sent = notificationsDuring(() => publish(task.id, { type: "ask", id: "a1", questions: [] }));
      expect(sent).toHaveLength(1); // three subscribers would send three
    } finally {
      stopNotifier();
    }
  });
});
```

Note on the `permission` payload: check `PermissionRequest` in `lib/types.ts` and use its real fields — the test must compile under strict TS. If the shape differs, adjust the literal, not the assertion.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:docker -- tests/notifications.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/notifications/dispatcher"`.

- [ ] **Step 3: Write the dispatcher**

Create `lib/notifications/dispatcher.ts`:

```ts
// Turns the events the runner ALREADY publishes into notifications.
//
// The alternative was a call at each site in lib/runner.ts that sets
// awaiting_input — an ask card, a permission card, and the turn-end settle that
// leaves a card open. That is three chances to miss a path today and a fourth
// every time the runner grows one. Subscribing to the wildcard channel needs no
// edits to the runner at all, and it is the same seam the webhook channel will
// attach to.
//
// Started from GET /api/events (idempotent, so every tab calls it). A boot ping
// like the scheduler's buys nothing while the only channel is a browser tab:
// the stream is a live tail, so a payload published with no tab open is
// discarded either way. The webhook task adds one.

import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { emitAwaitingInput, emitTurnFailed } from "./notify";

declare global {
  // eslint-disable-next-line no-var
  var __orchNotifier: (() => void) | undefined;
}

function handle(taskId: string, ev: BusEvent): void {
  switch (ev.type) {
    // Both kinds of "your turn" park the task identically — an
    // AskUserQuestion card and a tool-permission prompt each set
    // awaiting_input — exactly as GET /api/events' coarse() treats them.
    case "ask":
    case "permission":
      emitAwaitingInput(taskId);
      return;
    case "error":
      emitTurnFailed(taskId, ev.content);
      return;
    default:
      // Everything else is transcript detail. `notification` in particular MUST
      // fall through here: the emitter publishes onto the very bus this
      // subscriber reads, so handling it would loop.
      return;
  }
}

/** Subscribe the notifier to the bus. Safe to call on every request. */
export function ensureNotifier(): void {
  if (global.__orchNotifier) return;
  global.__orchNotifier = subscribeGlobal((taskId, ev) => {
    try {
      handle(taskId, ev);
    } catch (err) {
      // A throw here would surface inside publish(), i.e. inside the TURN that
      // published the event. A missed notification is not worth a failed turn.
      console.error("[notifications] dispatch failed:", err);
    }
  });
}

/** Unsubscribe. Test seam, and the symmetry HMR wants. */
export function stopNotifier(): void {
  global.__orchNotifier?.();
  global.__orchNotifier = undefined;
}
```

- [ ] **Step 4: Pin the dispatcher SDK-free**

Now that the file exists, add to `PINNED` in `tests/importGraph.test.ts`, directly under the `notify.ts` line from Task 1:

```ts
  "lib/notifications/dispatcher.ts", // the bus subscriber behind /api/events
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:docker -- tests/notifications.test.ts
npm run test:docker -- tests/importGraph.test.ts
npm run typecheck:docker
```

Expected: PASS, 10 notification tests; importGraph green with the two new entries.

- [ ] **Step 6: Commit**

```bash
git add lib/notifications/dispatcher.ts tests/notifications.test.ts tests/importGraph.test.ts
git commit -m "$(cat <<'EOF'
Notifications: subscribe to the bus rather than calling from the runner

awaiting_input is set in three places in lib/runner.ts and a fourth will
appear the next time the turn lifecycle grows a branch. A subscriber on
the wildcard channel maps the events the runner already publishes — ask,
permission, error — and needs no edits to the runner at all.

The default case is load-bearing: the emitter publishes onto the very bus
this subscriber reads, so falling through on `notification` is what stops
it looping. The handler's try/catch is too — a throw here would surface
inside publish(), inside the turn that published the event, and a missed
toast is not worth a failed turn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Relay the notification to every tab

**Files:**
- Modify: `app/api/events/route.ts` (the `runbooks_changed` branch, ~line 110; and the top of `GET`)
- Test: `tests/notifications.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `ensureNotifier` (Task 2), the `notification` wire event (Task 1).
- Produces: nothing new — `GET /api/events` now emits `{"type":"notification","payload":{…}}` frames.

- [ ] **Step 1: Write the failing test**

Append to `tests/notifications.test.ts`:

```ts
import { GET as eventsRoute } from "@/app/api/events/route";

describe("the /api/events relay", () => {
  it("streams a notification payload verbatim, task row or not", async () => {
    const task = parkedTask(projectId, "Streamed");
    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://localhost/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the ": connected" preamble so the assertion below can't read it.
    await reader.read();

    emitAwaitingInput(task.id);
    emitTestNotification();

    let buf = "";
    const frames: string[] = [];
    while (frames.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const chunk of buf.split("\n\n")) if (chunk.startsWith("data: ")) frames.push(chunk.slice(6));
      buf = "";
    }
    ac.abort();

    const payloads = frames.map((f) => JSON.parse(f));
    expect(payloads[0].type).toBe("notification");
    expect(payloads[0].payload.taskId).toBe(task.id);
    // The task-less test notification must survive the relay: the branch has to
    // sit BEFORE the getTask re-read, which would drop it.
    expect(payloads[1].payload.kind).toBe("test");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:docker -- -- tests/notifications.test.ts -t "relay"
```

Expected: FAIL — the second payload never arrives (the `getTask("")` bail drops it), or neither does.

- [ ] **Step 3: Add the relay branch**

In `app/api/events/route.ts`, immediately after the `runbooks_changed` branch and before `const event = coarse(ev)`:

```ts
        // A composed notification (lib/notifications/notify.ts). Bypasses the
        // re-read below for the strongest reason of all these branches: the
        // payload isn't a fact to look up but a message already written for a
        // human, screened against the row when it was minted — and a test
        // notification names no task at all, so the getTask bail would drop it.
        if (ev.type === "notification") {
          send({ type: "notification", payload: ev.payload });
          return;
        }
```

- [ ] **Step 4: Start the dispatcher when the first client connects**

At the top of the `GET` function body in the same file, before `const encoder = …`:

```ts
  // The bus subscriber that mints notifications. Idempotent, so every tab's
  // stream calls it and only the first one subscribes. Here rather than at boot
  // because this stream IS the only channel today: a notification published
  // with no tab open has nowhere to go.
  ensureNotifier();
```

and add the import beside the others:

```ts
import { ensureNotifier } from "@/lib/notifications/dispatcher";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:docker -- tests/notifications.test.ts
npm run typecheck:docker
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add app/api/events/route.ts tests/notifications.test.ts
git commit -m "$(cat <<'EOF'
Notifications: relay them on the global stream, and start the notifier there

The notification branch sits with task_deleted and its siblings, above the
re-read-the-task enrichment, for a reason the others only half share: the
payload was composed for a human and already screened against the row, and
a test notification names no task at all — the getTask bail would silently
swallow the one message whose whole purpose is proving delivery works.

ensureNotifier() runs at stream open rather than from a boot ping like the
scheduler's. While the browser is the only channel, this stream IS the
delivery path: a payload published with no tab open is discarded whether or
not a subscriber was listening. The webhook channel adds the boot ping when
that stops being true.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: A failed scheduled run notifies

**Files:**
- Modify: `lib/schedule/store.ts` (`settleRun`, ~line 188)
- Test: `tests/notifications.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `emitScheduleFailed` (Task 1), `getRun` / `getSchedule` (already in the same file).
- Produces: no new exports — `settleRun`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/notifications.test.ts`. Check `createSchedule`'s real signature in `lib/schedule/store.ts` and match it — the fields below are the ones the scheduler sets:

```ts
import { claimRun, createSchedule, settleRun, startRun } from "@/lib/schedule/store";

describe("a failed scheduled run", () => {
  it("notifies once, only on the transition, and only for failure", () => {
    const schedule = createSchedule({
      project_id: projectId,
      name: "Morning sweep",
      prompt: "/sweep",
      days_mask: 127,
      time_of_day: "08:30",
      timezone: "America/Los_Angeles",
      agent: "claude",
    });

    const failed = claimRun(schedule.id, 1, "scheduled")!;
    const sent = notificationsDuring(() => {
      settleRun(failed.id, "failed", "no agent connected");
      // Idempotent re-settle: the UPDATE matches no row, so no second buzz.
      settleRun(failed.id, "failed", "no agent connected");
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("schedule_failed");
    expect(sent[0].body).toContain("Morning sweep");
    expect(sent[0].body).toContain("no agent connected");
    expect(sent[0].projectId).toBe(projectId);

    // A run that succeeded is not news.
    const ok = claimRun(schedule.id, 2, "scheduled")!;
    expect(notificationsDuring(() => settleRun(ok.id, "succeeded", ""))).toEqual([]);

    // A run that DID mint a task carries it, so clicking the toast can open it.
    const task = parkedTask(projectId, "08:30 sweep");
    const withTask = claimRun(schedule.id, 3, "scheduled")!;
    startRun(withTask.id, task.id);
    resetNotificationDedupe();
    const second = notificationsDuring(() => settleRun(withTask.id, "failed", "Unknown command: /x"));
    expect(second[0].taskId).toBe(task.id);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:docker -- -- tests/notifications.test.ts -t "failed scheduled run"
```

Expected: FAIL — `expected [] to have a length of 1`.

- [ ] **Step 3: Hook `settleRun`**

In `lib/schedule/store.ts`, add the import at the top:

```ts
import { emitScheduleFailed } from "@/lib/notifications/notify";
```

and replace `settleRun` with:

```ts
/** Terminal outcome. Idempotent — a settled run is never re-settled. */
export function settleRun(runId: string, status: ScheduleRunStatus, detail = ""): void {
  const res = getDb()
    .prepare("UPDATE schedule_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ? AND finished_at = 0")
    .run(status, detail, Date.now(), runId);
  // A failed run is the one failure in this app with no witness: nobody is
  // watching at 08:30, and a run that fell over in preflight never minted a
  // task to notice. This is the only notification source that isn't on the bus,
  // so it is hooked at the single function all four `failed` settle sites go
  // through rather than at each of them.
  //
  // Gated on `changes` so the idempotent re-settle above can't notify twice,
  // and wrapped because this runs inside the runner's `finally`: a notification
  // failure must never leave a run unsettled.
  if (status !== "failed" || res.changes === 0) return;
  try {
    const run = getRun(runId);
    if (!run) return;
    const schedule = getSchedule(run.schedule_id);
    emitScheduleFailed({
      scheduleName: schedule?.name || "Scheduled run",
      projectId: schedule?.project_id ?? "",
      taskId: run.task_id ?? "",
      detail,
    });
  } catch (err) {
    console.error("[schedule] failed-run notification failed:", err);
  }
}
```

`getRun` and `getSchedule` are already defined in this file. If `getSchedule` returns `Schedule | undefined` vs `| null`, the `?.` handles both. No import cycle is created: `lib/notifications/notify.ts` imports `lib/store.ts`, never `lib/schedule/store.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:docker -- tests/notifications.test.ts
npm run test:docker -- tests/importGraph.test.ts
npm run typecheck:docker
```

Expected: PASS. `importGraph` matters here specifically — `lib/schedule/store.ts` is PINNED SDK-free and now imports the notifications module.

- [ ] **Step 5: Commit**

```bash
git add lib/schedule/store.ts tests/notifications.test.ts
git commit -m "$(cat <<'EOF'
Notifications: a scheduled run that fails says so

Scheduled runs are the app's only genuinely unattended work, and a failure
is its only completely silent event: nothing publishes it on the bus, and a
run that fell over in preflight never minted a task to leave a trace. It sat
in the schedules card waiting to be noticed.

Hooked at settleRun rather than at the four `failed` call sites, gated on
the UPDATE's `changes` so the function's own idempotent re-settle can't buzz
twice. Wrapped in a try/catch because one of those call sites is the
runner's `finally` — a notification failure must not leave a run unsettled,
which would wedge overlap detection for the next fifty occurrences.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Settings keys and the test-send route

**Files:**
- Modify: `app/api/settings/route.ts` (the `ALLOWED` regex, ~line 15)
- Create: `app/api/notifications/test/route.ts`
- Test: `tests/notifications.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `emitTestNotification`, `notificationsEnabled` (Task 1).
- Produces: `POST /api/notifications/test` → `{ ok: boolean; payload: NotificationPayload | null }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/notifications.test.ts`:

```ts
import { PATCH as patchSettings } from "@/app/api/settings/route";
import { POST as testNotification } from "@/app/api/notifications/test/route";

describe("notification settings", () => {
  it("persists the four keys through PATCH /api/settings", async () => {
    const res = await patchSettings(new Request("http://localhost/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ notifications: "off", notify_turn_failed: "off", bogus_key: "off" }),
    }));
    const saved = await res.json();
    expect(saved.notifications).toBe("off");
    expect(saved.notify_turn_failed).toBe("off");
    expect(saved.bogus_key).toBeUndefined();
  });

  it("sends a test notification through the real bus, and reports the master switch", async () => {
    // Subscribed by hand rather than through notificationsDuring: the route is
    // async, and that helper only spans a synchronous callback.
    const sent: NotificationPayload[] = [];
    const unsub = subscribeGlobal((_id, ev) => { if (ev.type === "notification") sent.push(ev.payload); });
    try {
      const ok = await (await testNotification()).json();
      expect(ok.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].kind).toBe("test");

      setSetting("notifications", "off");
      const off = await (await testNotification()).json();
      expect(off.ok).toBe(false); // the button can say WHY nothing appeared
      expect(sent).toHaveLength(1);
    } finally {
      unsub();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:docker -- -- tests/notifications.test.ts -t "notification settings"
```

Expected: FAIL — `Failed to resolve import "@/app/api/notifications/test/route"`.

- [ ] **Step 3: Widen the settings allowlist**

In `app/api/settings/route.ts`, extend the comment block with:

```
// The notify_* keys and their master switch (`notifications`) gate
// lib/notifications — server-side rather than in the browser because the
// webhook channel planned next must obey the same policy. All default on.
```

and the regex to:

```ts
const ALLOWED = /^(background_jobs|recap_mode|notifications|notify_awaiting_input|notify_turn_failed|notify_schedule_failed|default_agent|utility_agent|default_reasoning(:[a-z0-9_-]+)?|default_permission_mode(:[a-z0-9_-]+)?)$/;
```

- [ ] **Step 4: Add the test-send route**

Create `app/api/notifications/test/route.ts`:

```ts
import { NextResponse } from "next/server";
import { emitTestNotification, notificationsEnabled } from "@/lib/notifications/notify";

export const dynamic = "force-dynamic";

// Settings' "Send test notification". Publishes through the REAL emitter, bus
// and relay rather than calling new Notification() in the client, so a green
// result means the whole path works — not just that the browser granted
// permission. `ok: false` is the master switch being off, which is the one
// answer the button should report rather than appear broken over.
export async function POST() {
  const payload = emitTestNotification();
  return NextResponse.json({ ok: !!payload, enabled: notificationsEnabled(), payload });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:docker -- tests/notifications.test.ts
npm run typecheck:docker
```

Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add app/api/settings/route.ts app/api/notifications/test/route.ts tests/notifications.test.ts
git commit -m "$(cat <<'EOF'
Notifications: the switches, and a test send that proves the whole path

The four keys live in the server-side settings table rather than in the
browser's own preferences because they are policy the webhook channel will
inherit; only the permission grant is per-device, and the browser already
owns that.

"Send test notification" goes through the real emitter, bus and relay. A
button that called new Notification() locally would light up green on an
instance where the stream, the dispatcher or the relay was broken — proving
only that the browser granted permission. It reports the master switch as
`ok: false` instead of appearing broken when the user has turned
notifications off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The browser channel

**Files:**
- Create: `app/orchestrator/useNotifications.ts`
- Modify: `app/orchestrator/useGlobalEvents.ts` (new prop + branch)
- Modify: `app/orchestrator/useOrchestrator.ts` (`selTaskRef`, hook wiring, the click-to-open listener)
- Test: `tests/notifications.test.ts` (append a `describe` block for the pure rule)

**Interfaces:**
- Consumes: the `notification` wire event (Task 1).
- Produces:
  - `shouldDisplay(payload: NotificationPayload, ctx: { visible: boolean; selectedTaskId: string | null }): boolean`
  - `useNotifications(a: { selTaskRef: MutableRefObject<string | null> }): (payload: NotificationPayload) => void`
  - `useGlobalEvents` gains a required `onNotification: (payload: NotificationPayload) => void` prop.
  - Window event `orch:goto-task` with `detail: { projectId: string; taskId: string }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/notifications.test.ts`:

```ts
import { shouldDisplay } from "@/app/orchestrator/useNotifications";

describe("the browser channel's display rule", () => {
  const payload = (taskId: string): NotificationPayload => ({
    id: `awaiting_input:${taskId}`, kind: "awaiting_input", taskId,
    projectId: "p1", title: "Waiting for input", body: "x", ts: 1,
  });

  it("stays silent only when you are demonstrably looking at that very task", () => {
    expect(shouldDisplay(payload("t1"), { visible: true, selectedTaskId: "t1" })).toBe(false);
    // Tab open but on another task, or hidden behind twelve other tabs: notify.
    expect(shouldDisplay(payload("t1"), { visible: true, selectedTaskId: "t2" })).toBe(true);
    expect(shouldDisplay(payload("t1"), { visible: false, selectedTaskId: "t1" })).toBe(true);
    expect(shouldDisplay(payload("t1"), { visible: true, selectedTaskId: null })).toBe(true);
  });

  it("always shows a test notification, which belongs to no task", () => {
    const test: NotificationPayload = { id: "test", kind: "test", taskId: "", projectId: "", title: "t", body: "b", ts: 1 };
    expect(shouldDisplay(test, { visible: true, selectedTaskId: null })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:docker -- -- tests/notifications.test.ts -t "display rule"
```

Expected: FAIL — `Failed to resolve import "@/app/orchestrator/useNotifications"`.

- [ ] **Step 3: Write the channel hook**

Create `app/orchestrator/useNotifications.ts`:

```ts
"use client";

import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { NotificationPayload } from "@/lib/notifications/types";

/**
 * The one client-side suppression, kept pure so it can be pinned by a test.
 *
 * The server already decided this is worth interrupting somebody for; the
 * browser knows exactly one thing the server cannot, which is whether the user
 * is looking at the very task being announced. Everything else — a background
 * tab, another task selected, a second monitor — is a case where a toast is the
 * whole point, so the rule is deliberately narrow rather than "notify only when
 * the tab is hidden".
 */
export function shouldDisplay(
  payload: NotificationPayload,
  ctx: { visible: boolean; selectedTaskId: string | null },
): boolean {
  if (!payload.taskId) return true; // a test send belongs to no task
  return !(ctx.visible && ctx.selectedTaskId === payload.taskId);
}

/** Is this browser able to show a notification right now? */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/**
 * The browser channel. Renders a payload the SERVER composed — the wording, the
 * suppression rules and the dedupe all happened before this hook saw it, so a
 * webhook delivering the same payload says the same thing.
 */
export function useNotifications({ selTaskRef }: { selTaskRef: MutableRefObject<string | null> }) {
  // The ref object is stable, so the returned callback is too — which is what
  // keeps useGlobalEvents from re-subscribing its EventSource on every render.
  return useCallback((payload: NotificationPayload) => {
    if (notificationPermission() !== "granted") return;
    if (!shouldDisplay(payload, {
      visible: document.visibilityState === "visible",
      selectedTaskId: selTaskRef.current,
    })) return;
    try {
      // `tag` is the payload id — stable per (kind, task) — so a second
      // notification about the same task replaces the first rather than
      // stacking toasts on a screen nobody is watching.
      const n = new Notification(payload.title, { body: payload.body, tag: payload.id });
      n.onclick = () => {
        window.focus();
        n.close();
        if (!payload.taskId) return;
        // Routed through a window event rather than a callback prop: this hook
        // is wired before goToTask exists in useOrchestrator, and the app
        // already uses this pattern for cross-cutting facts (orch:runbooks).
        window.dispatchEvent(new CustomEvent("orch:goto-task", {
          detail: { projectId: payload.projectId, taskId: payload.taskId },
        }));
      };
    } catch {
      // Some browsers throw on construction (notably iOS Safari outside a
      // service worker). A failed toast must never break the event stream.
    }
  }, [selTaskRef]);
}
```

- [ ] **Step 4: Route the event to the channel**

In `app/orchestrator/useGlobalEvents.ts`, add to the imports:

```ts
import type { NotificationPayload } from "@/lib/notifications/types";
```

add `onNotification` to the parameter object type and destructuring:

```ts
  /** The browser channel — see useNotifications. */
  onNotification: (payload: NotificationPayload) => void;
```

add the branch immediately before `if (ev.type !== "task") return;`:

```ts
    // A notification the server composed for a human. Nothing in this hook's
    // state changes — the badges and spinners ride the task events below — so
    // it goes straight to the channel.
    if (ev.type === "notification") { onNotification(ev.payload); return; }
```

and add `onNotification` to the `handle` closure's dependencies implicitly (it is re-created each render and stored in `handleRef`, so no dependency array change is needed).

- [ ] **Step 5: Wire it in the orchestrator**

In `app/orchestrator/useOrchestrator.ts`:

Add the imports:

```ts
import { useNotifications } from "./useNotifications";
```

After the existing `selProjRef` block (~line 105), add:

```ts
  // selTaskRef mirrors selProjRef: the browser notification channel needs the
  // CURRENT selection at delivery time, and it is wired before most callbacks
  // exist.
  const selTaskRef = useRef(selTask);
  useEffect(() => { selTaskRef.current = selTask; }, [selTask]);
```

Before the `useGlobalEvents(...)` call (~line 178):

```ts
  const showNotification = useNotifications({ selTaskRef });
```

and pass it:

```ts
  useGlobalEvents({ selProjRef, reorderRef, setTaskRunning, setTasks, setProjects, loadTasks, reconcileRunning, refreshAgents, onNotification: showNotification });
```

After `goToTask` is defined (~line 508), add:

```ts
  // Clicking a browser notification. A window event rather than a prop because
  // the channel hook runs above this definition — same pattern as orch:runbooks.
  useEffect(() => {
    const onGoto = (e: Event) => {
      const { projectId, taskId } = (e as CustomEvent<{ projectId: string; taskId: string }>).detail;
      if (taskId) goToTask(projectId, taskId);
    };
    window.addEventListener("orch:goto-task", onGoto);
    return () => window.removeEventListener("orch:goto-task", onGoto);
    // goToTask is re-created each render but only calls setState, so binding
    // the first instance is safe and keeps the listener stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:docker -- tests/notifications.test.ts
npm run typecheck:docker
```

Expected: PASS, 16 tests. Typecheck must be clean — this task touches the largest client file.

- [ ] **Step 7: Commit**

```bash
git add app/orchestrator/useNotifications.ts app/orchestrator/useGlobalEvents.ts app/orchestrator/useOrchestrator.ts tests/notifications.test.ts
git commit -m "$(cat <<'EOF'
Notifications: the browser channel

Renders what the server composed — wording, suppression and dedupe all
happened before this hook saw the payload, which is what will let a webhook
deliver the same notification and say the same thing.

The client adds exactly one rule, and it is deliberately narrow: stay silent
only when the tab is visible AND the announced task is the selected one, the
single case where the user is provably already looking at the thing being
announced. "Only when hidden" would have been easier and wrong — a tab open
on another task in another project is the case this feature exists for.

Click-to-open is routed through a window event rather than a callback,
because the channel is wired above goToTask's definition in useOrchestrator;
orch:runbooks set that precedent. The `tag` is the payload id, stable per
(kind, task), so a repeat replaces its predecessor instead of stacking
toasts on a screen nobody is watching.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Settings → Notifications

**Files:**
- Modify: `app/icons.tsx` (add `bell`)
- Modify: `app/orchestrator/SettingsView.tsx` (section entry, nav footer copy, the section body, `isDefault`)

**Interfaces:**
- Consumes: `notificationPermission` (Task 6), `POST /api/notifications/test` (Task 5), `appDefaults` / `setAppDefault` (existing).
- Produces: nothing other modules import.

- [ ] **Step 1: Add the icon**

In `app/icons.tsx`, beside `bolt` (~line 51):

```tsx
  bell: (p?: P) => S(<><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16z" /><path d="M10 21a2 2 0 0 0 4 0" /></>, p),
```

- [ ] **Step 2: Register the section**

In `app/orchestrator/SettingsView.tsx`, add to `SETTINGS_SECTIONS` after the `background` entry:

```ts
  { id: "notifications", label: "Notifications", icon: Icon.bell },
```

and add a case to the nav footer ternary chain, before the trailing default:

```tsx
section === "notifications" ? "alerts · saved to this workspace" :
```

- [ ] **Step 3: Write the section component**

In the same file, above `SettingsView`, add:

```tsx
// Browser notifications. The permission grant is per-DEVICE and owned by the
// browser, so it is read live from Notification.permission rather than stored;
// everything else is server-side policy the webhook channel will inherit.
function NotificationSettings({ appDefaults, setAppDefault }: {
  appDefaults: Record<string, string>;
  setAppDefault: (key: string, value: string | null) => void;
}) {
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("unsupported");
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "off" | "error">("idle");
  useEffect(() => { setPerm(notificationPermission()); }, []);

  const on = appDefaults.notifications !== "off";
  const kinds: [string, string, string][] = [
    ["notify_awaiting_input", "A task is waiting for input", "An agent asked a question or needs a tool approved, and the task has stopped until you answer."],
    ["notify_turn_failed", "A turn failed", "The session died — a dead login, a spent quota, a full context window, or a crash."],
    ["notify_schedule_failed", "A scheduled run failed", "A schedule fired and got nowhere. Nobody is watching at 08:30, so this is the one failure with no other witness."],
  ];

  async function sendTest() {
    setTestState("sending");
    try {
      const r = await jsend<{ ok: boolean }>("/api/notifications/test", "POST");
      setTestState(r.ok ? "sent" : "off");
    } catch {
      setTestState("error");
    }
  }

  return (
    <>
      <div className="field">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div className="lab">{Icon.bell()} Notify me when a task needs me</div>
            <div className="hlp" style={{ marginTop: 4 }}>
              Operator tells you when a session stops and waits. Turn this off to silence every notification at once.
            </div>
          </div>
          <button
            role="switch"
            aria-label="Notify me when a task needs me"
            aria-checked={on}
            className={`in-switch${on ? " on" : ""}`}
            onClick={() => setAppDefault("notifications", on ? "off" : null)}
          ><span /></button>
        </div>
      </div>

      <div className="field">
        <div className="lab">{Icon.bolt()} Browser notifications</div>
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
          {perm === "unsupported"
            ? "This browser can't show notifications, or the page isn't on a secure origin (https or localhost)."
            : perm === "granted"
              ? "This browser is allowed to show notifications. They appear only when you aren't already looking at the task."
              : perm === "denied"
                ? "You've blocked notifications for this site. Operator can't ask again — unblock it in your browser's site settings for this address."
                : "Allow notifications so Operator can reach you when this tab isn't in front of you."}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {perm === "default" && (
            <button className="btn btn-line btn-sm" onClick={async () => setPerm(await Notification.requestPermission())}>
              {Icon.bell()} Enable browser notifications
            </button>
          )}
          <button className="btn btn-line btn-sm" onClick={sendTest} disabled={perm !== "granted" || testState === "sending"}>
            {Icon.send()} {testState === "sending" ? "Sending…" : "Send test notification"}
          </button>
        </div>
        {testState === "sent" && <div className="hlp" style={{ marginTop: 8 }}>Sent — it went through the same path a real notification takes.</div>}
        {testState === "off" && <div className="hlp" style={{ marginTop: 8 }}>Nothing sent: notifications are switched off above.</div>}
        {testState === "error" && <div className="hlp" style={{ marginTop: 8 }}>Couldn&apos;t reach the server to send it.</div>}
      </div>

      <div className="field">
        <div className="lab">{Icon.list()} What to notify me about</div>
        <div className="hlp" style={{ marginTop: 0, marginBottom: 10 }}>
          Each of these means a task has STOPPED. Finished turns and new suggestions deliberately stay quiet.
        </div>
        {kinds.map(([key, label, help]) => {
          const kindOn = appDefaults[key] !== "off";
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12, opacity: on ? 1 : 0.5 }}>
              <div style={{ flex: 1 }}>
                <div className="lab" style={{ marginBottom: 2 }}>{label}</div>
                <div className="hlp" style={{ marginTop: 0 }}>{help}</div>
              </div>
              <button
                role="switch"
                aria-label={label}
                aria-checked={kindOn}
                disabled={!on}
                className={`in-switch${kindOn ? " on" : ""}`}
                onClick={() => setAppDefault(key, kindOn ? "off" : null)}
              ><span /></button>
            </div>
          );
        })}
      </div>
    </>
  );
}
```

Add the imports it needs at the top of the file:

```ts
import { notificationPermission } from "./useNotifications";
import { jsend } from "./api";
```

(`jget` is already imported from `./api` — extend that import rather than adding a second line. `useState`/`useEffect` are already imported.)

- [ ] **Step 4: Render it and count it as a non-default**

In `SettingsView`'s body, after the `{section === "background" && (…)}` block:

```tsx
            {section === "notifications" && <NotificationSettings appDefaults={appDefaults} setAppDefault={setAppDefault} />}
```

and extend `isDefault` so "Reset to defaults" lights up when a notification switch is off — add above it:

```ts
  const hasNotifyDefault = ["notifications", "notify_awaiting_input", "notify_turn_failed", "notify_schedule_failed"]
    .some((k) => appDefaults[k] === "off");
```

then add `&& !hasNotifyDefault` to the `isDefault` chain.

- [ ] **Step 5: Verify it builds and renders**

```bash
npm run typecheck:docker
npm run dev
```

Open Settings → Notifications. Confirm: the permission button appears when permission is `default`, disappears once granted; "Send test notification" produces a real system notification; toggling the master switch dims and disables the three per-event switches; "Reset to defaults" becomes enabled once a switch is off.

- [ ] **Step 6: Commit**

```bash
git add app/icons.tsx app/orchestrator/SettingsView.tsx
git commit -m "$(cat <<'EOF'
Notifications: the Settings section

Permission state is read live from Notification.permission rather than
stored: the grant is per-device and the browser owns it, so a copy in the
settings table would be wrong on the second machine. The denied state gets
its own copy because the app cannot re-prompt — only tell the user where to
unblock it — which is otherwise an "Enable" button that does nothing twice.

The per-event switches are disabled and dimmed under the master switch
rather than hidden, so the section still says what Operator WOULD notify
about when it is off, and the copy names the shared rule behind the three:
each one means a task has stopped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: End-to-end through a real browser

**Files:**
- Create: `e2e/13-notifications.spec.ts`
- Modify: `e2e/README.md` (the specs table)

**Interfaces:**
- Consumes: `e2e/helpers.ts` (`createProject`, `createTask`, `ensureOnboarded`, `gotoApp`, `makeFixtureRepo`, `sendMessage`, `getTask`, `uid`), the mock agent's `e2e:permission=` and `e2e:fail=` directives.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Create `e2e/13-notifications.spec.ts`:

```ts
// Notifications end to end: the server composes one, the SSE stream carries it,
// and the browser channel decides whether to show it. window.Notification is
// stubbed via addInitScript — Playwright cannot observe a real system toast, and
// the interesting logic is which payloads reach the constructor anyway.
//
// Everything below the stub is the production path: the real emitter, the real
// dispatcher on the real bus, the real relay.

import { expect, test } from "@playwright/test";
import {
  createProject, createTask, ensureOnboarded, getTask, gotoApp,
  makeFixtureRepo, sendMessage, uid,
} from "./helpers";

const PROJECT = `Notifications ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("notifications") });
  projectId = project.id;
});

// Replace window.Notification with a recorder, granted by default, before any
// app code runs. Collected on window.__notes for the assertions below.
async function stubNotifications(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __notes: { title: string; body: string; tag: string }[] }).__notes = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: NotificationOptions) {
        (window as unknown as { __notes: unknown[] }).__notes.push({ title, body: opts?.body ?? "", tag: opts?.tag ?? "" });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
  });
}

function notes(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as { __notes: { title: string; body: string; tag: string }[] }).__notes);
}

test("a task parking on a permission card notifies a tab looking elsewhere", async ({ page, request }) => {
  const watching = await createTask(request, { projectId, title: "Something else entirely" });
  const parking = await createTask(request, {
    projectId,
    title: "Needs a permission",
    description: "e2e:permission=npm run lint",
  });

  await stubNotifications(page);
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Something else entirely", { exact: true }).first().click();

  // Park the OTHER task while this tab is looking at `watching`.
  await sendMessage(request, parking.id);
  await expect
    .poll(async () => (await getTask(request, parking.id)).awaiting_input, { timeout: 20_000 })
    .toBe(1);

  await expect.poll(async () => (await notes(page)).length, { timeout: 15_000 }).toBe(1);
  const [note] = await notes(page);
  expect(note.title).toBe("Waiting for input");
  expect(note.body).toContain("Needs a permission");
  expect(note.body).toContain(PROJECT);
  expect(note.tag).toBe(`awaiting_input:${parking.id}`);
});

test("no notification when you are already looking at the task that parked", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Watched while it parks",
    description: "e2e:permission=npm run build",
  });

  await stubNotifications(page);
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Watched while it parks", { exact: true }).first().click();

  await sendMessage(request, task.id);
  await expect
    .poll(async () => (await getTask(request, task.id)).awaiting_input, { timeout: 20_000 })
    .toBe(1);
  // The card is on screen — a system toast about it would be noise.
  await expect(page.getByText("npm run build").first()).toBeVisible({ timeout: 15_000 });
  expect(await notes(page)).toEqual([]);
});

test("a failed turn notifies", async ({ page, request }) => {
  await createTask(request, { projectId, title: "Elsewhere again" });
  const failing = await createTask(request, {
    projectId,
    title: "Falls over",
    description: "e2e:fail=the session ended unexpectedly",
  });

  await stubNotifications(page);
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Elsewhere again", { exact: true }).first().click();

  await sendMessage(request, failing.id);

  await expect.poll(async () => (await notes(page)).map((n) => n.title), { timeout: 20_000 })
    .toContain("Turn failed");
  const note = (await notes(page)).find((n) => n.title === "Turn failed")!;
  expect(note.body).toContain("Falls over");
  expect(note.body).toContain("the session ended unexpectedly");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:e2e:docker -- e2e/13-notifications.spec.ts
```

Expected: FAIL if any wiring from Tasks 1-6 is wrong. If everything landed, these may pass first time — that is fine; the value is the regression pin. **Do not skip running them.**

The e2e server runs the BUILT bundle (see `e2e/README.md`), so a stale `.next` will test old code. The `test:e2e:docker` script builds first.

- [ ] **Step 3: Fix whatever the run surfaces**

Likely candidates, in order: the notification branch in `useGlobalEvents` placed after the `ev.type !== "task"` bail (it must be before); `ensureNotifier()` not called; the mock agent's `e2e:fail` publishing an event shape the dispatcher doesn't map.

- [ ] **Step 4: Document the spec**

In `e2e/README.md`'s specs table, add:

```
| `13-notifications.spec.ts` | browser notifications: a parked task notifies a tab looking elsewhere, stays silent when you're watching that very task, and a failed turn notifies |
```

- [ ] **Step 5: Run the whole gate**

```bash
npm run preflight:docker
```

Expected: PASS. This is the pre-push gate; nothing merges red.

- [ ] **Step 6: Commit**

```bash
git add e2e/13-notifications.spec.ts e2e/README.md
git commit -m "$(cat <<'EOF'
Notifications: pin the whole path with an e2e

window.Notification is stubbed with addInitScript — Playwright cannot see a
real system toast, and which payloads reach the constructor is the part that
can break anyway. Everything below the stub is production: the real emitter,
the real dispatcher on the real bus, the real relay, the real client rule.

The second test is the one worth having. It asserts SILENCE while the user
is looking at the task that parked, which is the difference between a
feature people keep switched on and one they turn off in a week.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/FEATURES.md`
- Modify: `.env.example` — **only if** an env var was added (none is planned; skip if so)

**Interfaces:** none.

- [ ] **Step 1: Find where the feature list lives**

```bash
grep -n "Scheduled tasks\|Runbooks\|needs you" README.md docs/FEATURES.md | head -20
```

- [ ] **Step 2: Add a README bullet**

Alongside the other feature bullets, matching their voice and length:

```markdown
- **Notifications** — a browser notification when a task stops and waits for you, when a turn fails, or when a scheduled run fails. Off-tab by design: it stays quiet only when you're already looking at the task in question. Settings → Notifications.
```

- [ ] **Step 3: Add a `docs/FEATURES.md` section**

Follow the file's existing heading level and prose style:

```markdown
## Notifications

Operator tells you when a task has STOPPED — that's the shared rule behind
every notification it sends:

|-|-|
| A task is waiting for input | An agent asked a question or needs a tool approved. |
| A turn failed | The session died: a dead login, a spent quota, a full context window, or a crash. |
| A scheduled run failed | A schedule fired and got nowhere. Nobody is watching at 08:30, so this is the one failure with no other witness. |

A finished turn and a new suggestion deliberately don't notify.

Today the only channel is a **browser notification**, which needs the app open
in a tab (any tab, in any window — it doesn't have to be in front of you) and
one grant of the browser's notification permission, from Settings →
Notifications. The only time Operator stays quiet is when the tab is visible AND
you already have that exact task selected.

A snoozed task never notifies, and neither does an archived project's.

Notifications are composed on the server, not in the browser, so the channels
planned next — an outbound webhook (Slack, Discord, Teams) and an iMessage relay
— will deliver exactly the same messages under exactly the same rules.
```

- [ ] **Step 4: Verify nothing else claims the app can't do this**

```bash
grep -rn "no notification\|doesn't notify\|cannot notify" README.md docs/ | grep -v superpowers
```

Fix anything stale that turns up.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/FEATURES.md
git commit -m "$(cat <<'EOF'
Docs: notifications

States the rule the three kinds share — a task has STOPPED — rather than
listing them as unrelated alerts, and says plainly what the browser channel
requires (a tab open somewhere) and the one case it stays silent in, since
both are the questions someone asks after their first missed notification.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Follow-up work (file as tasks, do not build here)

1. **Outbound webhook channel** — Slack / Discord / Teams / generic JSON. Brings the `notification_channels` table, per-channel event routing, delivery timeout + last-error surface, and the `/api/instance/notifications` boot ping that makes the dispatcher server-owned so notifications fire with no tab open.
2. **iMessage delivery** — blocked on (1). The app runs in a Linux container and `osascript` is on the macOS host, so this is a small host-side relay the webhook channel posts to, not a driver inside the app.
