# Runbooks — design

Date: 2026-08-20
Status: approved, ready for an implementation plan

Save a task you run often as a named recipe, then dispatch it in two keystrokes.
Driving cases, in the user's words: *"we have a lot of unpushed changes, push
them to origin and babysit the ci/cd"* and *"run a sweep of my jiras/IMs/emails
and report"*. Both are boilerplate — the same brief, retyped every time — and
the app has nowhere to keep one.

## What exists today, and what doesn't

Almost all of the mechanism already exists, in the wrong shape.

`lib/scheduler.ts`'s `fireSchedule()` already does the whole job: preflight a
project and an agent, mint a fresh task carrying a saved prompt and a saved
dispatch config, cut its worktree, persist and publish the opening user message,
and hand off to `lib/runner.ts`. A `schedules` row is *already* "a saved prompt
+ agent + permission mode + priority + send_context". The only thing making it a
schedule rather than a runbook is the clock in front of it.

What's missing is a way to reach that machinery **on demand**, and somewhere to
keep a recipe that isn't tied to a time of day.

So this feature is mostly an extraction. The new code is a table, a card, and a
dispatch sheet; the launch path is the one that has been firing schedules since
2026-08-14.

## Decisions

Each settled explicitly rather than falling out of the code.

| Question | Decision |
|-|-|
| What a runbook is | A persisted task-launch preset. Running one MINTS A FRESH TASK, exactly as a schedule firing does. |
| Where it lives | Its own `runbooks` table, project-keyed — it outlives every task it dispatches. |
| Relationship to schedules | ONE shared dispatch core (`lib/dispatch.ts`). Claiming, the ledger and `next_fire_at` stay in the scheduler. |
| Parameters | No `{{template}}` language. One optional free-text "Instructions for this run", appended under a delimiter. |
| Scope | Project-scoped, like schedules, plus an explicit "Copy to…" action. No nullable `project_id`, no project picker at dispatch. |
| Run history | No ledger. `tasks.runbook_id` is the link; "last run" is an ordinary task query. |
| Attended or not | Attended. A dispatch is a button press, so NO deny-policy `RunContext` — unlike a schedule firing. |
| Schedules → runbooks | A schedule may link a runbook and read its prompt at fire time. Deleting the runbook DETACHES (copies the recipe back) rather than orphaning. |
| Agents | `create_runbook` / `list_runbooks` / `update_runbook` orchestrator tools. No delete, and no editing a runbook a schedule depends on. |

### Why mint a task per run

The same reason the scheduled-tasks design gives, and it applies harder here. A
durable "runbook task" re-run weekly accumulates turns in one session and its
context grows without bound — and `/clear` doesn't fix it, because generation
N+1 is seeded with all prior summaries. A fresh task per run keeps each run
clean, independently reviewable, and independently mergeable, since each gets
its own worktree and branch.

The accepted cost is the same board litter schedules already produce, and it is
addressed the same way: the task is tagged `runbook_id` so the UI can group and
bulk-clear later. Nothing is auto-deleted. Delete is hard delete throughout this
repo with no undo.

### Why not just prefill the New Task modal

Client-side templates don't survive a different browser or device, can't be read
by the server (so a schedule could never reference one), and leave no provenance
on the task that ran. The database is this app's source of truth; a saved recipe
belongs in it.

### Why not unify schedules into runbooks

Tempting — a schedule really is a runbook plus a trigger — and rejected. A
schedule is unattended automation with durable claiming, catch-up adjudication,
DST handling, crash recovery and an audit ledger, all of it heavily tested. A
runbook is an interactive launcher. Migrating the schedules table to buy zero
new user capability is risk with no payoff.

Coherence comes from **one dispatch behavior**, not one normalized table. What
gets shared is the tail both paths already have in common.

## The shared dispatch core

New module `lib/dispatch.ts`, extracted from the body of `fireSchedule()`:

```ts
export interface DispatchInput {
  project_id: string;
  title: string;
  description: string;      // the minted task's brief (buildProjectContext reads it)
  prompt: string;           // the FIRST USER MESSAGE, so a /slash command expands
  agent: string;
  permission_mode: string | null;
  send_context: boolean;
  priority: Priority;
  note: string;             // the "▶ …" transcript line recording WHY this session began
  runContext?: RunContext;  // schedules pass SCHEDULED_RUN_CONTEXT; runbooks pass nothing
  schedule_id?: string | null;
  runbook_id?: string | null;
  /** Called with the new task id after createTask, BEFORE the launch. */
  onTaskCreated?: (taskId: string) => void;
}

export type DispatchResult =
  | { ok: true; task: Task }
  | { ok: false; error: string };
```

It owns: the preflight (project exists, `repo_path` set, agent connected,
`validatePrompt` for a slash prompt), `workStarted`/`workEnded`, the `mkdirSync`,
`createTask`, `claimTurn`, and the `withTaskLock` block that ensures the
worktree, persists + publishes the opening message, marks the row running and
calls `startTurn`. Every non-launch exit releases the claim.

**It returns a result instead of throwing.** The scheduler needs the failure
*text* to `settleRun(run.id, "failed", …)`; a route needs it for a 400. A thrown
error would force both callers to re-derive the same string.

**`onTaskCreated` is the ledger seam.** `fireSchedule` must call
`startRun(run.id, task.id)` after the row exists but before the launch — a crash
mid-launch has to remain attributable to a run. Returning the task and letting
the caller link afterwards loses exactly that window.

**What stays in `lib/scheduler.ts`:** `claimRun`, `startRun`, `settleRun`,
`advanceNextFire`, overlap adjudication, and the unattended `RunContext`. The
dispatcher knows nothing about clocks. Likewise `background_jobs` gating (which
today governs recaps and one-shots, not schedules) must never migrate into the
dispatcher: a user-initiated runbook is not a background job.

`lib/dispatch.ts` reaches `lib/runner.ts` and so is NOT in
`tests/importGraph.test.ts`'s SDK-free `PINNED` set. It imports the runner
statically, as `lib/scheduler.ts` already does — it sits in no cycle with the
async graph, so `lib/autoStart.ts`'s dynamic-import problem does not apply.
Callers reach *it* through `await import()` from routes, matching how routes
already reach the scheduler.

### The refactor is behavior-preserving

Phase 2 lands with no new user-visible behavior. The existing schedule suite
(`scheduleRunner`, `scheduleUnattended`, `scheduler`, `schedulerBoot`,
`scheduleApi`, …) must stay green untouched. If a schedule test needs editing to
pass, the extraction changed something it shouldn't have.

## Schema

One table, two columns, no ledger.

```
runbooks
  id              TEXT PRIMARY KEY
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
  name            TEXT NOT NULL              -- "Push & babysit CI"
  description     TEXT NOT NULL DEFAULT ''   -- what it does; becomes the minted task's brief
  prompt          TEXT NOT NULL              -- the minted task's first user message
  agent           TEXT NOT NULL DEFAULT 'claude'
  permission_mode TEXT
  send_context    INTEGER NOT NULL DEFAULT 1
  priority        TEXT NOT NULL DEFAULT 'med'
  position        INTEGER NOT NULL DEFAULT 0 -- manual order in the card
  created_by      TEXT NOT NULL DEFAULT ''   -- '' = the user; else the agent id that filed it
  created_at      INTEGER NOT NULL
  updated_at      INTEGER NOT NULL

tasks.runbook_id      TEXT REFERENCES runbooks(id) ON DELETE SET NULL
schedules.runbook_id  TEXT REFERENCES runbooks(id) ON DELETE SET NULL

CREATE INDEX idx_runbooks_project ON runbooks(project_id);
CREATE INDEX idx_tasks_runbook    ON tasks(runbook_id);
```

`runbooks` is created with `CREATE TABLE IF NOT EXISTS`, so older DBs pick it up
with no `migrate()` entry. The two columns are `ALTER TABLE` additions and DO
need entries in `migrate()`, beside the existing `tasks.schedule_id` one.

### Why no `runbook_runs` ledger, and no counters

A schedule needs a ledger because its defining failure is *silently not
happening* at 08:30 with nobody watching — an occurrence that never ran leaves
no other trace. A runbook dispatch produces a visible task immediately, in the
tray the user is already looking at, and a failed launch surfaces in that task's
own transcript through the runner's existing error path.

Denormalized `run_count` / `last_run_at` columns are also rejected: they start
lying the first time a user deletes one of the minted tasks. "Last run" is
`SELECT … FROM tasks WHERE runbook_id = ? ORDER BY created_at DESC LIMIT 1`.

### What the minted task looks like

| Field | Value |
|-|-|
| `title` | The dispatch sheet's title, prefilled `"<name> — <local date, HH:MM>"` and editable |
| `description` | The runbook's `description` (a runbook with none gets a line naming it) |
| first user message | The runbook's `prompt`, plus the run's extra instructions when given |
| `agent`, `permission_mode`, `send_context`, `priority` | Copied from the runbook AT DISPATCH TIME |
| `runbook_id` | The runbook |

Config is **materialized at dispatch**, never re-read from the runbook
afterwards. The task is the immutable record of what actually ran; editing the
runbook tomorrow must not rewrite the history of what happened today.

### Why the prompt is a user message, not the description

`buildProjectContext()` injects title + description into the system prompt, and
the ordinary first turn sends the generic `INITIAL_TASK_PROMPT`. That's wrong
for a runbook: `/jira-sweep` only expands when it arrives as a **user message**.
Schedules already send their prompt that way for the same reason, and runbooks
follow. The description still carries the brief, so both halves land.

### Extra instructions

Appended after a blank line under a short delimiter. When the prompt is a slash
command, that text becomes part of the command's arguments — which is the
desired behavior, and the same shape the schedules form already invites with its
`/jira-tasks, or plain instructions` placeholder.

The **resolved** prompt is what gets persisted as the task's user message, so
what was actually dispatched is always inspectable in the transcript.

## Schedules that point at a runbook

The payoff: "the morning sweep" is one recipe, edited in one place, fired both
on a clock and on demand.

`fireSchedule` resolves its effective prompt and config from the linked runbook
when `schedules.runbook_id` is set and the row still exists; otherwise from the
schedule's own columns, exactly as today. The runbook must belong to the same
project as the schedule — enforced server-side, since both are project-scoped
and a cross-project link would fire the wrong repo's recipe.

**The hazard, and the guard.** Pointing unattended automation at a mutable row
means an edit silently changes what runs at 08:30. Editing is the entire point,
so that half stays and is made *visible* instead: the schedule editor states
"this schedule runs the **X** runbook — editing it changes what fires here", and
the runbook row shows "used by 2 schedules". Fire-time `validatePrompt` already
catches an edit that introduces an unknown slash command, settling the run
`failed` rather than reporting green having done nothing.

Deleting is the half with no upside, so **delete detaches**. `deleteRunbook()`
copies `prompt`, `agent`, `permission_mode`, `send_context` and `priority` back
into every linked schedule row and then deletes, in one transaction. The
schedule keeps firing with the recipe frozen as of the deletion; the alternative
(`ON DELETE SET NULL` alone) leaves a schedule with no prompt that fires nothing
every morning, which is precisely the silent failure the schedules design was
built to rule out.

## Agent-facing tools

An agent that has just worked out a procedure should be able to save it. Three
new orchestrator tools, defined in `lib/agentToolDefs.mjs` so the in-process
Claude server and the stdio bridge can't drift, with the policy in one shared
module (`lib/runbookTools.ts`) so the two paths can't either.

| Tool | Policy |
|-|-|
| `create_runbook(name, description, prompt, priority?, permission_mode?, project?)` | Files into the calling project, or any project by id/exact name via the existing strict `resolveTargetProject()`. `agent` is resolved connected-first (`resolveConnectedAgent`), not a model-chosen param. `created_by` records the calling agent. Never linked to a schedule. |
| `list_runbooks(project?)` | Read-only. Same optional `project` param, same strictness. |
| `update_runbook(runbook, name?, description?, prompt?, priority?, permission_mode?)` | The same fields `create_runbook` sets, each optional. **Refused when any schedule links that runbook**, naming them. |
| delete | Not offered. |

`update_runbook`'s screen is the runbook analogue of `isInertSuggestion()`: an
agent may rewrite a recipe nothing has committed to, and may not rewrite one the
user has wired into unattended automation. A model editing the 08:30 sweep is
the hazard above with the human removed from it.

Nothing needs a suggested-tray equivalent: a runbook is **inert** until someone
presses Run, unlike a task, which is work that will execute. Provenance is
carried by `created_by` and rendered as a chip on the row, so a recipe the user
didn't write is identifiable at a glance.

`buildProjectContext()` gains a sentence naming these verbs — it is where the
agent learns what tools exist, and an undocumented tool is an unused one.

## Surfaces

**Runbooks card** — `app/orchestrator/Runbooks.tsx`, in the project landing pane
above `Schedules`, reusing its visual vocabulary. Rows: name, description, last
run, `created_by` chip, "used by N schedules" when linked. Buttons: Run, Edit,
Copy to…, Delete.

**Run sheet** — editable title, read-only prompt preview, the "Instructions for
this run" textarea, the resolved agent / permission mode / priority, and "Start
session immediately" checked by default. Double-dispatch is prevented by
disabling the button for the in-flight request.

**Editor** — the create/edit form, validating a slash prompt against the
project's real command registry via the existing `POST /api/schedules/validate`,
with the same non-blocking treatment the schedules form uses.

**⌘K** — every runbook in the current project is its own palette row
(`Run: Push & babysit CI`). This is the accelerator that decides whether the
feature gets used; a picker behind a generic "Run runbook…" row costs an extra
keystroke and a second list to read.

**Copy to…** — reuses `ProjectTargetList` from `modals.tsx`, the same
destination list the move flows render.

Not building: a dedicated column, and a template picker bolted onto the ordinary
New Task flow. Neither earns its permanent cost.

**Live updates** — a new project-keyed global event `runbooks_changed
{ projectId }`, following `tasks_reordered` exactly: it carries its own project
id and short-circuits before `GET /api/events`'s re-read-the-task enrichment,
which has no row to read. Published on create / update / delete / copy, and by
`create_runbook`, so a second tab and the ⌘K list stay current.

## Files

| Path | Change |
|-|-|
| `lib/db.ts` | `runbooks` table + 2 indexes; `migrate()` entries for `tasks.runbook_id`, `schedules.runbook_id` |
| `lib/types.ts` | `Runbook`; `Task.runbook_id`; `Schedule.runbook_id` |
| `lib/runbooks/store.ts` | new — typed queries, `copyToProject`, delete-detaches-schedules. SDK-free, added to `importGraph` `PINNED` |
| `lib/dispatch.ts` | new — the shared mint+launch core |
| `lib/scheduler.ts` | `fireSchedule` refactored onto it; resolves a linked runbook |
| `lib/runbookTools.ts` | new — agent-tool policy. SDK-free, `PINNED` |
| `lib/agentToolDefs.mjs` | `CREATE_RUNBOOK`, `LIST_RUNBOOKS`, `UPDATE_RUNBOOK` |
| `lib/agents/claude/driver.ts` | mount the three tools |
| `lib/agents/shared.ts` | `buildProjectContext()` names the verbs |
| `scripts/orch-mcp.mjs` | bridge the three tools |
| `app/api/internal/agent-tools/{create,list,update}-runbook/route.ts` | new |
| `app/api/projects/[id]/runbooks/route.ts` | new — GET / POST |
| `app/api/runbooks/[id]/route.ts` | new — GET / PATCH / DELETE |
| `app/api/runbooks/[id]/run/route.ts` | new — POST `{ title?, extra?, start? }` |
| `app/api/runbooks/[id]/copy/route.ts` | new — POST `{ project_id }` |
| `lib/events.ts` | `runbooks_changed` bus + wire event |
| `app/orchestrator/Runbooks.tsx` | new — card, editor, run sheet |
| `app/orchestrator/ProjectLanding.tsx` | mount the card |
| `app/orchestrator/Schedules.tsx` | prompt-source picker (write a prompt / use a runbook) |
| `app/orchestrator/types.ts`, `useGlobalEvents.ts`, `useOrchestrator.ts`, `app/Orchestrator.tsx` | client types, event handling, palette rows |
| `app/globals.css` | `rb-*` rules mirroring `sched-*` |
| `docs/FEATURES.md`, `README.md`, `CLAUDE.md` | keep current, per repo convention |

## Build order

1. Schema + `lib/runbooks/store.ts` + types
2. `lib/dispatch.ts` + scheduler refactor — **pure refactor, schedule suite green untouched**
3. Runbook REST routes
4. Runbooks card, editor, run sheet, ⌘K rows, `runbooks_changed`
5. Agent tools (defs, policy, driver, bridge, internal endpoints, project context)
6. Schedule → runbook link
7. Docs

Phases 5 and 6 are independent of each other and both come after 4. Phase 6 is
cleanly droppable if it proves noisier than it's worth.

## Testing

Run in the container (`npm run test:docker`), per repo convention.

| Test | Pins |
|-|-|
| `tests/runbookStore.test.ts` | CRUD, position ordering, `copyToProject`, delete DETACHES linked schedules with the recipe intact |
| `tests/runbookDispatch.test.ts` | config materialized onto the task, `runbook_id` set, extras appended to the user message, refusals for missing `repo_path` / disconnected agent, no `RunContext` (an attended dispatch may park on a permission card) |
| `tests/runbookApi.test.ts` | the four routes, including double-dispatch and a cross-project copy |
| `tests/runbookAgentTools.test.ts` | `create_runbook` into another project by name, `update_runbook` REFUSED on a schedule-linked runbook, no delete verb, `created_by` recorded. Driven through the real stdio bridge against the real endpoint, as `codexUpdateTaskPolicy.test.ts` does |
| `tests/scheduleRunbookLink.test.ts` | `fireSchedule` uses the linked runbook's prompt; falls back to its own columns after a detach; refuses a cross-project link |
| `tests/importGraph.test.ts` | `lib/runbooks/store.ts` + `lib/runbookTools.ts` added to `PINNED` |

The existing schedule suite is the regression gate for phase 2 and is not
modified.

## Out of scope

Deferred deliberately, and none of it is blocked by the schema above: named
`{{parameters}}`, runbook versioning, import/export or sharing, multi-step or
nested runbooks, runbooks that mint several linked tasks, retries and
success-condition checks, secrets, and auto-cleanup of dispatched tasks.
