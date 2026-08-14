# Scheduled task execution — design

Date: 2026-08-14
Status: approved, ready for an implementation plan

Run a saved prompt on a recurring schedule so work is waiting in the tray before
the user sits down. Driving use case: run the `/jira-tasks` skill at 08:30 on
weekdays so the morning's Jira assignments arrive as triaged suggested tasks
with nobody logged in.

## What exists today, and what doesn't

Unattended execution already exists. `lib/autoStart.ts` launches a task's first
turn by itself when its last blocker clears, and `lib/permissions.ts` already
reasons about how long a prompt may park with nobody watching. What is missing
is a TIME trigger and somewhere to hang it.

The important gap: **there is no server-owned periodic work anywhere in the
app.** The recap "sweep" that looks like a scheduler is driven by a browser
`setInterval` in `app/orchestrator/useRecaps.ts` hitting `/api/recaps/sweep`,
which does nothing when no tab is open. This feature introduces the first real
server-side ticker, and everything below is shaped by the requirement that it
work with no browser attached.

## Decisions

Each of these was settled explicitly rather than falling out of the code.

| Question | Decision |
|-|-|
| What repeats | A `schedules` row owning a prompt + target project. Each firing MINTS A FRESH TASK. |
| Where the schedule lives | Its own table, project-keyed — it must survive the tasks it creates being finished or deleted. |
| Timezone | An IANA zone string, never an offset. Fires on the user's local wall clock. |
| Missed firings | Catch up ONCE within a 4h window; past it, record a visible `missed` row. Never silent. |
| Overlap | Skip, recorded as `skipped_overlap` with a link to the blocking run. |
| Unattended permissions | An explicit `RunContext` marks the turn `interactionPolicy: "deny"`. Presence heuristics are bypassed. |
| Visibility | A Schedules card in the project landing pane: next run, last outcome, pause, Run now. |

### Why mint a task per firing

Re-running one durable task row accumulates turns in a single session and its
context grows without bound — and `/clear` doesn't fix it, because generation
N+1 is seeded with all prior summaries, so it grows anyway. A fresh task per
firing keeps each run clean and independently reviewable.

The accepted cost is board litter: one weekday schedule is ~260 tasks a year.
Runs are tagged with `schedule_id` so the UI can group them and offer a bulk
clear, but **nothing is auto-deleted in v1**. Delete is hard delete throughout
this repo with no undo, so automatic removal of rows the user might not have
reviewed is not something to add unprompted. The tag makes it addable later.

## Schema

Two new tables and one new column.

### `schedules`

```
id            TEXT PRIMARY KEY
project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
name          TEXT NOT NULL              -- "Jira triage"
prompt        TEXT NOT NULL              -- what the minted task's first turn sends
days_mask     INTEGER NOT NULL           -- bitmask, Sun=1 Mon=2 … Sat=64; weekdays = 62
time_of_day   TEXT NOT NULL              -- 'HH:MM', 24h, local to `timezone`
timezone      TEXT NOT NULL              -- IANA zone, e.g. 'America/Los_Angeles'
enabled       INTEGER NOT NULL DEFAULT 1
agent         TEXT NOT NULL              -- driver for minted tasks
permission_mode TEXT                     -- pinned; see "Unattended execution"
send_context  INTEGER NOT NULL DEFAULT 1
priority      TEXT NOT NULL DEFAULT 'med'
catch_up_ms   INTEGER NOT NULL           -- 0 = never catch up
next_fire_at  INTEGER NOT NULL           -- ms epoch UTC; persisted so a restart keeps its place
created_at    INTEGER NOT NULL
updated_at    INTEGER NOT NULL
```

Deliberately **not cron**. A days-of-week mask plus one time-of-day covers the
driving case, renders as a legible form, and makes "what does a missed firing
mean" answerable. Twice a day is two schedules.

`next_fire_at` is a cache of the time math, not the source of truth — the spec
(mask + time + zone) is. It is recomputed on create, on edit, on resume, after
each adjudicated firing, and revalidated on boot (a tzdata update can move it).

### `schedule_runs`

One row per *occurrence*, including occurrences that did not run. This is the
visibility surface; without it a schedule that stops is indistinguishable from
one that had nothing to do.

```
id            TEXT PRIMARY KEY
schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE
scheduled_for INTEGER NOT NULL           -- the wall-clock slot this represents
claimed_at    INTEGER NOT NULL
fired_at      INTEGER                    -- when the turn actually launched
finished_at   INTEGER
task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL
status        TEXT NOT NULL              -- see below
trigger       TEXT NOT NULL              -- 'scheduled' | 'catch_up' | 'manual'
detail        TEXT NOT NULL DEFAULT ''   -- actionable error text
dst_adjusted  TEXT NOT NULL DEFAULT ''   -- '' | 'gap_forward' | 'ambiguous_first'
UNIQUE(schedule_id, scheduled_for)
```

`status` is one of `claimed`, `running`, `succeeded`, `failed`, `stopped`,
`interrupted`, `missed`, `skipped_overlap`.

**`UNIQUE(schedule_id, scheduled_for)` is the durable claim** and the single
most important line in the schema. It is what makes a double fire impossible
when two ticks overlap, when a tick races "Run now", or when a restart
re-adjudicates a slot it already handled. A select-then-insert check is racy;
this is not.

Retention: keep the most recent N (50) runs per schedule, pruning older
terminal rows. Run rows are audit records, not user work, so pruning them is
safe in a way that pruning tasks is not.

### `tasks.schedule_id`

`TEXT REFERENCES schedules(id) ON DELETE SET NULL`, nullable. Added via the
`migrate()` column-add pattern in `lib/db.ts`.

`SET NULL`, not cascade: deleting a schedule must not delete the work it
produced. The run row carries a snapshot of the schedule's name so history
stays readable after the definition is gone.

## Time math — `lib/schedule/time.ts`

Pure, dependency-free, `Intl`-only, no DB and no SDK imports (a candidate for
the `tests/importGraph.test.ts` pinned set). One exported function:

```ts
nextFireAt(spec: { daysMask: number; timeOfDay: string; timezone: string }, afterMs: number): {
  ms: number;
  dstAdjusted: "" | "gap_forward" | "ambiguous_first";
}
```

Algorithm: enumerate local calendar dates forward from `afterMs` rendered in the
zone, using calendar arithmetic on the y/m/d tuple (never by adding 24h to an
epoch, which breaks on DST days). Skip dates the mask disallows. For each
allowed date, resolve `HH:MM` to an instant by offset inversion — take
`Date.UTC(y, m, d, H, M)`, subtract the zone offset at that guess, then repeat
once so the second pass settles on the correct side of a transition — then
verify by formatting the result back and comparing to the requested wall time.
Return the first candidate strictly greater than `afterMs`.

This was prototyped and verified against real ICU before being written down.

**DST rules**, both verified:

- The whole point — the *wall clock* is fixed and the UTC instant moves.
  `08:30 America/Los_Angeles` resolves to `16:30Z` on Mar 7, `15:30Z` on Mar 8,
  and `16:30Z` on Nov 1.
- **Spring-forward gap** — the requested wall time does not exist (e.g. `02:30`
  on a US spring-forward Sunday). Fire at the first valid instant after the gap:
  `02:30` → `03:00`. Record `dst_adjusted = 'gap_forward'`. (Shifting by the
  skipped hour to `03:30` is defensible but strictly worse for background work —
  30 minutes late beats 60.)
- **Fall-back overlap** — the wall time happens twice. Take the **earlier**
  instant and run once; record `dst_adjusted = 'ambiguous_first'`. The unique
  claim on `scheduled_for` makes the second occurrence a no-op even if a tick
  lands between the two.

Verification also confirmed the resolver handles fractional-offset zones
(Kathmandu, +05:45) and 30-minute DST (Lord Howe) — both are test cases.

## The trigger — `lib/scheduler.ts`

A `setInterval` at 30s (fires are minute-granular, so worst-case lateness is
30s), guarded on `globalThis` so it survives dev HMR — the same pattern
`lib/events.ts`, `lib/abort.ts`, `lib/asks.ts` and `lib/services.ts` already
use.

**Started from the existing boot self-ping route**,
`app/api/instance/services-restore/route.ts`, which `server.js` already
loopback-POSTs with the service token right after listen; also started lazily
from the schedules API so a dev boot that missed the ping still works.

This placement is deliberate and worth not "fixing" later:

- It touches **neither `server.js` nor `middleware.ts`**. Both are fork-point
  files that the private hosted overlay repo carries its own variants of, so
  edits there cost a merge conflict in a repo this one can't see.
- Reusing an already-whitelisted service-token path means no new entry in
  `middleware.ts`'s allowlist.
- `instrumentation.ts` would be the idiomatic Next home and is out for the
  reason the repo already documents on that route: Turbopack dev tries to bundle
  `better-sqlite3` into its edge variant and breaks the app.

The tick is **single-flight** (an in-flight guard, so a slow tick can't overlap
itself) and fires due schedules **sequentially** — ten schedules at 08:30 must
not spawn ten worktree setups and ten CLIs at once.

## What a firing does

1. **Claim**, in one short synchronous SQLite transaction (atomic under
   better-sqlite3 in a single process): re-read the schedule and confirm it's
   still enabled, insert the `schedule_runs` occurrence (the unique index
   adjudicates), advance `next_fire_at`. **No worktree creation or agent work
   inside the transaction.**
2. **Preflight**, recording an actionable `failed` run instead of minting a
   doomed task:
   - the project still exists and its `repo_path` is set and reachable;
   - the schedule's agent is connected (checked for *that* agent — never
     allowed to fall back to Claude, which would run the work on the wrong
     login);
   - if the prompt is a slash command, that it is registered (see below).
3. **Mint** the task via `createTask` — whose `permission_mode` parameter was
   already written with this in mind ("a task that will run UNATTENDED
   (auto-start, and later a schedule)") — tagged with `schedule_id`, taking
   agent / permission mode / send_context / priority from the schedule.
4. **Launch** the first turn by the same sequence `autoStart.ts
   launchInitialTurn` uses: claim the turn slot, ensure the worktree under the
   per-task lock, persist and publish the prompt, hand off to `startTurn`. The
   differences are the schedule's prompt in place of `INITIAL_TASK_PROMPT`, the
   `RunContext`, and a sync note recording why the session began —
   `▶ Scheduled — Jira triage, 08:30 Mon–Fri`.

## Missed firings

On every tick and on boot, one sweep processes the **entire** backlog rather
than one slot per tick. Down from Friday to Monday 10:00, with a 4h window:

- Friday 08:30 → `missed`
- Monday 08:30 → fired once, `trigger = 'catch_up'`
- `next_fire_at` → Tuesday 08:30

At most one execution regardless of how many slots elapsed. Each skipped
occurrence gets its own `missed` row — one row per slot, which the unique
constraint already models and retention already bounds. (An aggregated
"missed 14 runs" row would be more compact and is deliberately not used: it
loses which specific mornings were lost.)

The catch-up window defaults to 4 hours via `lib/config.ts`
(`ORCH_SCHEDULE_CATCHUP_MS`, documented in `.env.example` per the env-driven
convention), `0` disables catch-up entirely, and it is per-schedule
overridable through `catch_up_ms`. For an 08:30 run, arriving at noon and
finding it ran is useful; finding it start at 6pm is not.

**Paused schedules accrue no `missed` rows.** On resume, the next occurrence is
computed strictly after the resume time — otherwise unpausing a schedule you
parked for a month greets you with a wall of red for slots you deliberately
skipped.

## Overlap

If the schedule's previous run is still live, skip and record
`skipped_overlap`, with the blocking run linked.

Liveness is `hasTurn(taskId)` from `lib/abort.ts` — the real turn registry —
plus a non-terminal run row. It is explicitly **not** `task.status`, which stays
"in progress" long after a turn ends, nor `awaiting_input`, which every
completed turn sets.

The UI shows "blocked by a run since …" with a Stop control, so a single wedged
turn cannot silently skip every future occurrence forever.

## Unattended execution — `lib/runContext.ts`

`lib/permissions.ts` currently decides how long a permission card may park by
`watcherCount()` — presence, not intent. A tab left open on a sleeping laptop
reads as attended. For a scheduled 08:30 run that is backwards: the user never
launched this turn, and a card could park it for the full 4-hour attended cap.

A small explicit shape, deliberately named rather than a bare boolean so that
task S6asJLbDQpfWp_u3pDpEC ("Thread an explicit RunContext instead of inferring
unattended from SSE presence") can widen it **in place**:

```ts
export type RunContext = {
  origin: "user" | "dependency" | "schedule";
  interactionPolicy: "interactive" | "deny";
  scheduleRunId?: string;
};
```

Set by the scheduler, threaded through `startTurn`, held by the **runner** for
the turn's lifetime (registered at start, cleared in the `finally`), and read by
the permission gate. The `AgentDriver.runTurn()` signature is **not** changed —
restructuring the driver seam belongs to that task, not this one.

Under `interactionPolicy: "deny"` the gate bypasses the watcher heuristic
entirely and settles immediately with a distinct machine-readable reason rather
than parking. The existing `unattendedDeny` handling in `lib/runner.ts` already
does the right thing downstream: it parks the pending queue instead of running
every follow-up into the same unanswerable prompt.

On the permission **mode**, "never prompt" and "allow everything" are separate
axes and shouldn't be conflated. The schedule stores its own `permission_mode`,
defaulting to `bypassPermissions` for Claude (Codex already runs
`approval_policy: never`), and the editor states the resulting authority in
plain words instead of burying it behind a mode name.

`Run now` uses the same unattended policy and does **not** shift
`next_fire_at`. An interactive run is a different action — open the task and
send a message. Its run row is `trigger = 'manual'` with `scheduled_for` set to
the moment the button was pressed, so it can never collide with a real slot
under the unique constraint (and two rapid presses collide with each other,
which is the desired outcome).

## Settling the run truthfully

`fired` is an event, not an outcome. The `scheduleRunId` travels on the
`RunContext` so the run is settled from the turn's own `finally` in
`lib/runner.ts`, which already knows `turnError`, whether a session `opened`,
whether it was `stopped`, and the recoverable-failure classifications (dead
login, spent usage limit, unattended deny). Reconstructing this from outside by
polling `task.running` cannot work.

Actionable error categories on the run: missing repo, expired login, usage
limit, permission denied, unknown slash command, launch failure,
interrupted/unknown.

### Success is quiet, failure is loud

`lib/runner.ts` ends every turn that opened a session with `awaiting_input: 1`,
which feeds the shared `NEEDS_YOU` predicate in `lib/store.ts` behind both the
titlebar "N need you" pill and its dropdown. Left alone, **every scheduled run
would add a permanent item nobody ever needs to answer** — five a week,
compounding the litter problem and training the user to ignore the pill.

So a scheduled turn that completes leaves `awaiting_input: 0` and reports
through the schedule card and whatever it filed in the tray. A scheduled run
that **fails** surfaces in "Needs you" like anything else. A schedule that
silently stops is worse than no schedule; a schedule that cries wolf every
morning is how you get one.

## Slash commands are a real mechanism — and a real hazard

The driving case is a prompt that is literally `/jira-tasks`. Whether that is
the harness expanding a command or merely the model recognising a name matters
enormously for an unattended run, so it was tested rather than assumed, through
the same SDK path the app uses (`settingSources: ["user", "project", "local"]`).

| Prompt | Tool calls | Result |
|-|-|-|
| `/orch-probe-skill` | none | the skill body's magic token |
| `orch-probe-skill` | `Skill({"skill":"orch-probe-skill"})` | narration, then the token |

The slash form is **textually expanded by the CLI before the model sees it** —
the skill body becomes the prompt, with no model judgement involved. The bare
name is the model reading the name and choosing to call the `Skill` tool. Only
the first is appropriate for unattended work. Custom commands
(`.claude/commands/*.md`) expand identically. Plugin skills register namespaced
(`superpowers:brainstorming`, `skill-codex:codex`); user-level skills register
bare (`jira`, `confluence`) — so the exact registered name matters.

**The hazard**: an unregistered command is not an error.

```
/orch-probe-skil → "Unknown command: /orch-probe-skil. Did you mean …?"
                    subtype: "success", is_error: false, zero tool calls
```

The turn reports success. Without a guard the run records `succeeded`, the tray
is empty, and the user concludes Jira had nothing for them — a silent skip
wearing a green check.

**The guard is free.** The session's `init` message carries the full command
registry (64 entries in the probe environment) and arrives in ~1.5s, *before
any model call* — so a query can be started, the list read, and the session
abandoned at zero token cost.

- **Save time**: when a schedule's prompt starts with `/`, validate it against
  the live registry and offer the list. `jira-tasks` vs
  `ce-aura-claude-code:jira-tasks` gets settled while the user is sitting there.
- **Fire time**: re-check as a preflight. An unregistered command records
  `failed` with `slash_command_unknown` and does not mint a task.

## UI — project landing pane

Schedules are project-keyed and the landing pane is what you see when you open a
project in the morning, which is exactly when a schedule's output matters.

A Schedules card beside the recap, one row per schedule:

- next run in local words ("tomorrow 08:30"), with the zone shown when it isn't
  the browser's;
- last run: outcome badge, when, and a link to the task it produced;
- `scheduled_for` shown next to the actual fired time when they differ, with
  catch-up and DST-adjustment badges;
- pause toggle, Edit, Run now;
- for `skipped_overlap`, a link to the blocking run and a Stop.

The editor takes name, prompt, days, time, timezone (defaulting to the
browser's), agent, and permission mode, and **previews the next three
occurrences** — a timezone or day-mask mistake should be visible before saving,
not the following Monday.

Scheduler health (ticker started, last successful tick) is exposed for the
card to show a warning if the ticker itself is dead.

## Testing

Unit (vitest, serial, hermetic per `tests/setup.ts`; run in a container).

`tests/scheduleTime.test.ts` carries the weight, because this is the part that
fails twice a year with nobody watching:

- strict-after semantics at exactly 08:30;
- weekday mask, month/year rollover, leap day;
- a UTC host with an `America/Los_Angeles` schedule (the container case);
- spring-forward gap → one run at the first valid instant;
- fall-back overlap → the earlier instant only, including a tick landing between
  the two occurrences;
- fractional offset (Kathmandu) and 30-minute DST (Lord Howe);
- invalid IANA zone and empty day mask.

`tests/scheduler.test.ts`:

- offline across several occurrences → older `missed`, newest caught up exactly
  once, `next_fire_at` advanced past the whole backlog;
- catch-up window boundary, and `catch_up_ms = 0`;
- concurrent ticks → exactly one run and one task (the unique claim);
- a tick racing Run now;
- pause racing a due claim; a paused schedule accruing no `missed` rows;
- `next_fire_at` surviving a restart, and boot revalidation;
- overlap skip while a turn is live, and recovery once it ends;
- preflight failures: missing project, missing repo path, disconnected agent,
  unknown slash command — each records an actionable run and mints no task.

`tests/scheduleUnattended.test.ts`:

- a permission request during a scheduled turn with browser watchers open is
  denied immediately, with no parked card;
- a completed scheduled turn does not set `awaiting_input`; a failed one
  surfaces;
- the runner settles the run from its `finally` for success, failure, and stop.

E2E (`npm run test:e2e`, deterministic mock agent): create a schedule, Run now,
see the minted task appear and the card show the outcome; pause and confirm it
stops.

## Out of scope

- **Two app instances on one DB.** Already unsupported — `lib/db.ts` resets
  every `tasks.running` flag and clears `pending_messages` at init, so a second
  process corrupts the first's view before scheduling enters into it. The unique
  run claim is defense in depth, not support.
- **Sub-daily / interval schedules** ("every 30 minutes"). The mask + time
  shape doesn't cover it and the driving case doesn't need it.
- **Auto-pruning scheduled tasks.** The `schedule_id` tag makes it addable; the
  no-undo delete semantics mean it shouldn't be added unasked.
- **A wrong host clock.** Forward jumps become catch-up/missed adjudication and
  backward jumps can't duplicate (the unique claim), but a badly wrong system
  clock is not solvable from inside the app.

## Definition of done

- A schedule can be created and paused from the UI.
- It survives an app restart (`next_fire_at` persisted and revalidated on boot).
- It fires at the right local wall-clock time across a DST boundary.
- A missed firing behaves the way this document chose, and says so visibly.
- A weekday 08:30 run of the jira-tasks skill lands suggested tasks in the tray
  with nobody logged in.
