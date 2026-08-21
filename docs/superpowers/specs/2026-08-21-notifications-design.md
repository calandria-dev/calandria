# Notifications — design

Date: 2026-08-21
Status: approved, ready for an implementation plan

Tell the user when a task needs them, without the user having to look. The
driving case is the one the app is built around: many sessions running in
parallel, one of them parks on a question, and it sits there — sometimes for
hours — because nothing on the machine says so. Today the only way to find out
is to have the tab on screen and notice a badge change.

## What exists today, and what doesn't

The detection half is already built and correct.

`lib/events.ts` has a wildcard channel (`subscribeGlobal()`) that sees every
task's events across every project, and `GET /api/events` already relays a
coarse subset of it to every open tab — that is what moves the "N need you"
pill. `awaiting_input` is persisted on the task row before it is published, so
any consumer reading the row at publish time gets an authoritative snapshot.
`lib/store.ts` already has the `NOT_SNOOZED` predicate that decides whether a
waiting task should be counted as needing attention at all.

What's missing is **anything that leaves the tab**. Every existing signal is a
pixel in the app's own chrome. There is no notion of a notification, no channel,
and no user preference for one.

Two facts worth notifying on are additionally missing from the bus altogether:

- **A turn that failed** publishes an `error` event, but `coarse()` in
  `app/api/events/route.ts` drops it — the global stream never carries it.
- **A scheduled run that settled `failed`** publishes nothing at all. This is
  the app's only genuinely unattended work, so a morning run that mints nothing
  is invisible until someone opens the schedules card.

> **Correction, added 2026-08-21 during implementation (Task 6):** the premise
> above is wrong on one point. `app/orchestrator/useOrchestrator.ts` already had
> a client-side browser notifier — its own `new Notification()` call, wired
> straight off `liveAwaiting`, with its own wording and its own `await-<id>`
> dedupe tag — that fired when a task in the CURRENTLY SELECTED PROJECT started
> awaiting input. It predates this design and was missed writing it. It was
> retired in commit `9854665` once it was shown double-firing alongside the
> server-composed channel this design builds, for the same event with different
> text. So "there is no notion of a notification, no channel" should read as
> "no notification that covers every project, no `turn_failed` or
> `schedule_failed`, and no settings" — this feature is a replacement plus a
> large extension, not a first-ever addition, though everything the Decisions
> section below adds is genuinely new. `app/orchestrator/Welcome.tsx`'s
> onboarding prompt for browser-notification permission is unrelated to either
> notifier and was not touched.

## Decisions

| Question | Decision |
|-|-|
| Where policy lives | SERVER. A notification is composed in `lib/notifications/` and fanned out on the existing bus. The browser is a *channel*, not the author. |
| Channels in this feature | Browser (Web Notifications API) only. Webhooks and iMessage are follow-up tasks. |
| Events | `awaiting_input`, `turn_failed`, `schedule_failed`. Not "turn finished", not "suggestion filed". |
| Timing | Immediate. No grace delay, no watcher-count gate. |
| Where preferences live | The existing `settings` key/value table, edited from a new Settings → Notifications section. |
| Channel storage | No `notification_channels` table yet — see "Why no channels table". |
| How the dispatcher starts | Lazily, from `GET /api/events`. Boot-pinging it buys nothing until a channel can fire with no tab open. |

### Why the server composes the notification

The browser could derive most of this itself: it already receives
`awaiting_input` on the global stream and could call `new Notification()` when
it sees one. That was rejected.

Two of the three events are not on the global stream at all, so the client
version starts by adding them anyway. More importantly, the next two channels
(webhook, iMessage) have no browser: if the rules for *what is worth a
notification* live in React, those channels must reimplement snooze
suppression, dedupe and the per-event toggles, and the two implementations will
drift. Composing server-side makes the browser channel a renderer of a payload
that any other channel can also deliver.

### Why no channels table yet

The chosen configuration model was "Settings UI + DB table". The UI half ships
here. The table does not, because the browser channel has nothing to put in it:
its only per-device state is `Notification.permission`, which is owned by the
browser and cannot be stored server-side meaningfully — a grant on the laptop
says nothing about the phone. A table with one implicit row and no columns that
vary is an abstraction with no second case to justify it.

Preferences that are genuinely shared policy — the master switch and the three
per-event toggles — DO go in the DB, in the existing `settings` table, so the
webhook channel inherits them rather than inventing a parallel set.

The `notification_channels` table ships with the webhook task, which is the
first thing that needs rows: a URL, a kind, a secret, an enabled flag, and a
per-channel event selection.

### Why a bus subscriber instead of call sites in the runner

`awaiting_input` is set in several places in `lib/runner.ts` (an ask card, a
permission card, and the turn-end settle that leaves a card open). Placing an
`emitNotification()` call at each is three chances to miss a path, and every
future path added to the runner is a fourth.

A single subscriber on the wildcard channel maps the events the runner
*already* publishes — `ask`, `permission`, `error` — and needs no edits to
`runner.ts` at all. It is also precisely the seam the webhook channel will
attach to.

The one event that cannot come from the bus is a failed schedule run, because
nothing publishes it. That hooks `settleRun()` in `lib/schedule/store.ts`
instead — one function covering all four `failed` settle sites.

### Why `turn_failed` covers every error

The user selected "recoverable turn failure" — the four classified cases (dead
login, context overflow, approval-policy block, usage limit) that already append
a recovery notice to the transcript. This design fires on **any** turn error,
carrying the recovery hint in the body when one exists.

An unclassified crash parks the task exactly as hard as a classified one and has
no recovery button to make it noticeable. Restricting the notification to the
recoverable set would leave the least-recoverable failures as the only silent
ones.

## Architecture

### The payload

`lib/notifications/types.ts`:

```ts
export type NotificationKind =
  | "awaiting_input"
  | "turn_failed"
  | "schedule_failed"
  | "test"; // Settings' "Send test notification" — see below

export interface NotificationPayload {
  /** Stable per (kind, task, occasion) — also the browser Notification tag. */
  id: string;
  kind: NotificationKind;
  /** Empty on a test notification, which belongs to no task. */
  taskId: string;
  projectId: string;
  /** Rendered server-side: one place decides how a notification reads. */
  title: string;
  body: string;
  ts: number;
}
```

Text is composed server-side so a second channel renders identically. Titles are
the fact ("Waiting for input", "Turn failed", "Scheduled run failed"); bodies
carry the task title and project name, plus the recovery hint for `turn_failed`.

### The emitter

`lib/notifications/notify.ts` — `emitNotification(kind, taskId, detail?)`:

1. Re-reads the task and project rows. The runner persists before it publishes,
   so a read at publish time is authoritative (the same rule `GET /api/events`
   relies on).
2. Suppresses, in order: master switch off; this kind's toggle off; the row is
   `suggested`; the row is snoozed (`NOT_SNOOZED`); a notification with the same
   `(kind, taskId)` fired inside the last 10s.
3. Composes the payload and calls `publishGlobal(taskId, { type: "notification", payload })`.

DB + events only, no agent SDK — added to `tests/importGraph.test.ts`'s `PINNED`
set.

The 10s dedupe window exists for a specific observed case: one assistant message
can open an AskUserQuestion card *and* a permission card, which is two
`awaiting_input` events describing one moment. The browser `tag` collapses the
visual duplicate, but a webhook would deliver both.

### The dispatcher

`lib/notifications/dispatcher.ts` — `ensureNotifier()`, guarded on `globalThis`
(the repo's HMR-surviving pattern), subscribes once via `subscribeGlobal()` and
maps:

| Bus event | Notification |
|-|-|
| `ask`, `permission` | `awaiting_input` |
| `error` | `turn_failed` |
| everything else, including `notification` itself | ignored |

Ignoring its own event type is load-bearing: the emitter publishes onto the bus
the dispatcher subscribes to.

Called from `GET /api/events` at stream open. Idempotent, so every tab calls it
and the second call through does nothing. When the webhook channel lands it
gains a boot ping (`/api/instance/notifications`, mirroring the scheduler's) so
it runs with no tab open; today that would be a subscriber with no possible
consumer, since the stream is a live tail and a payload published to zero tabs
is discarded either way.

### The wire

`lib/events.ts` gains a `{ type: "notification"; payload: NotificationPayload }`
member on `TaskMutationEvent` and a matching `NotificationWireEvent` on
`GlobalWireEvent`.

`app/api/events/route.ts` relays it with an early return placed **before** the
`getTask` re-read, alongside `task_deleted` and its siblings — the payload is
already composed, and the re-read has nothing to add. (It also must not be
dropped for a task the emitter read successfully but that was deleted
microseconds later.)

### The browser channel

`app/orchestrator/useNotifications.ts`, fed from `useGlobalEvents`'s handler:

- Shows `new Notification(title, { body, tag: id, data: { taskId, projectId } })`.
  The tag makes a repeat replace its predecessor instead of stacking.
- Click focuses the window and selects that project and task, reusing the
  selection path the titlebar "needs you" dropdown already uses.
- One client-side suppression: skip when `document.visibilityState === "visible"`
  **and** the notification's task is the selected one. That is the only case
  where the user is provably already looking at the thing being announced.
- No client-side storage. `Notification.permission` is the per-device truth, and
  the server holds everything else.

### Settings

A new "Notifications" section in `app/orchestrator/SettingsView.tsx`:

- Permission state, with an **Enable browser notifications** button. Requesting
  permission requires a user gesture, so this cannot be done on load. The
  `denied` state gets its own copy — the app cannot re-prompt, only tell the
  user to unblock the site.
- Master toggle and three per-event checkboxes, persisted through the existing
  `PATCH /api/settings` (its `ALLOWED` regex is extended).
- **Send test notification** → `POST /api/notifications/test`, which publishes
  through the real bus and relay so the button exercises the whole path rather
  than calling `new Notification()` locally and proving nothing.

A test notification belongs to no task, so it takes a sibling entry point —
`emitTestNotification()` — rather than squeezing an empty `taskId` through the
task re-read. It skips the per-kind toggles and the dedupe window (both would
make a diagnostic lie about itself) but honors the master switch, and it keys
the bus with `""`, the way `runbooks_changed` already does for a task-less
fact. Client-side it renders like any other notification and its click is a
no-op, since there is no task to select.

Setting keys, all defaulting on: `notifications`, `notify_awaiting_input`,
`notify_turn_failed`, `notify_schedule_failed`.

## Error handling

- A throw inside the dispatcher's subscriber must never break the turn that
  published the event. `publish()` already isolates listeners in a try/catch;
  the emitter additionally swallows its own failures (a deleted row, a settings
  read error) rather than propagating.
- `settleRun()` is called from the runner's `finally`. Its notify call is
  wrapped so a notification failure cannot leave a run unsettled.
- A browser that has no `Notification` (older or hardened browsers, and any
  non-secure context) is feature-detected; the Settings section renders an
  explanatory state instead of a dead button.

## Testing

- `tests/notifications.test.ts` — bus event → payload mapping; suppression by
  master switch, per-kind toggle, `suggested`, and snooze; the 10s dedupe
  window; `settleRun(..., "failed")` emitting; the dispatcher ignoring its own
  event.
- `tests/importGraph.test.ts` — `lib/notifications/*` added to `PINNED`.
- `e2e/10-notifications.spec.ts` — stub `window.Notification` with
  `addInitScript`, drive the mock agent to an ask card, assert one notification
  carrying the task title; then assert none fires when that task is selected and
  the tab is visible.
- Gate: `npm run preflight:docker`.

## Out of scope

Filed as follow-up tasks rather than built here:

- **Outbound webhooks** (Slack / Discord / Teams / generic JSON), which brings
  the `notification_channels` table, per-channel event routing, delivery
  timeouts and a last-error surface, and the boot ping that makes the dispatcher
  server-owned.
- **iMessage**, blocked on webhooks. The app runs in a Linux container and
  `osascript` lives on the macOS host, so this is a host-side relay the webhook
  channel posts to — not a driver inside the app.

Explicitly not built, per the feature's scoping: notifications for a finished
turn, and for a suggestion filed by an agent.
