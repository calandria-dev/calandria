# Retention for tasks minted by a schedule — design

Date: 2026-08-19
Status: approved, ready for an implementation plan
Builds on: `2026-08-14-scheduled-tasks-design.md`

Scheduled execution mints a fresh task per firing. That is the right call for
context hygiene, and the accepted cost was board litter: one weekday 08:30
schedule is ~260 task rows a year. The scheduled-tasks design deferred the
cleanup deliberately — it tagged every minted task with `tasks.schedule_id` and
shipped no auto-deletion, on the grounds that delete is hard delete throughout
this repo and rows the user may not have reviewed should not vanish unasked.

This document settles the retention story that tag was for.

## The thesis

**Litter is a rendering problem. Solve it by rendering. Delete only on an
explicit decision, and only what provably holds nothing unreviewed.**

Everything below follows from that. Grouping is the primary fix and destroys
nothing. Clearing is real deletion and is therefore gated on a predicate that
must be wrong in the safe direction. Auto-clearing exists but ships off, is
per-schedule, is narrower than the manual action, and announces itself.

## Decisions

| Question | Decision |
|-|-|
| How runs stop littering | Collapsed into one stack per schedule, in both the list and the board. Display only — no rows are touched. |
| Bulk clear | Two-phase and scoped to one schedule: a manifest with an exact count and per-run reasons, then a POST that re-screens and reports what it actually did. |
| Auto-delete | Yes, but per-schedule, **default off**, age-based, and strictly narrower than the manual clear. Never silent. |
| What "untouched" means | Six signals, below. `worktreePruneSafety()` is the one that matters. |
| A run that produced nothing | Keeps its task row. It is the first thing both clears take, but it is never free. |
| A run whose work was merged | Never clearable, by either path. |

### Why auto-clear ships at all, and why it ships off

Two facts pull against each other. A weekday schedule genuinely does accumulate
faster than anyone reviews, and asking the user to run a manual clear every week
forever is a chore the machine should absorb. But nobody has yet watched a board
accumulate a year of real runs, hard delete has no undo, and the run ledger
(below) means task rows are the only durable history past a schedule's 50th
firing.

The resolution is consent scoped to one schedule at a time. A user who turns it
on for "Jira triage" has looked at that schedule's runs, seen what they contain,
and decided. That is a much narrower claim than a global default, and it is
revocable. Shipping it off means the calibration argument is answered by the
person with the data rather than guessed at here.

### Why the run ledger is not a substitute for the task row

`pruneRuns()` (`lib/schedule/store.ts:220`) keeps `RUN_RETENTION = 50` rows per
schedule. This is correct for what it is — run rows are audit records — but it
means the ledger **rolls**. Past firing 50 there is no `schedule_runs` row for a
morning; `tasks.schedule_id` is the only durable record it happened, and the
task's transcript is the only thing that explains what came of it.

So "the run row already records it, the task row is redundant" is false, and any
argument that reaches for it is wrong. This is the reason an empty run keeps its
row, and part of the reason auto-clear is opt-in.

## The predicate — `lib/retention.ts`

One module, one job, no SDK reach (added to `tests/importGraph.test.ts`'s
`PINNED` list alongside `lib/taskMove.ts`, which has the same store + git + locks
shape).

```ts
export interface RunRetention {
  taskId: string;
  title: string;
  safe: boolean;
  /** Why not, in the words the modal shows. Empty when `safe`. */
  blockers: string[];
}

export async function runRetention(task: Task, project: Project): Promise<RunRetention>;
```

A minted run is **untouched** when none of these fire. They are checked in cost
order and short-circuit, so the git call is never paid for a task a cheap DB
read already refused.

| # | Signal | Test | Why it is a touch |
|-|-|-|-|
| 1 | live | `task.running` ∨ `hasTurn(task.id)` ∨ its `schedule_runs` row is `claimed`/`running` | it is still working |
| 2 | hand-statused | `status ∉ {in_progress, not_started}` | `lib/runner.ts:262` is the only non-human writer of `tasks.status` and it only ever writes `in_progress`. Anything else was typed by a person. |
| 3 | conversation | a `role='user'` row beyond the first ∨ `generation > 1` ∨ any `summaries` row | the schedule's own prompt is user message #1 (`lib/scheduler.ts:241`). Anything after it is the user talking to the run; a bumped generation or a summary is a `/clear`, which is equally a human act. |
| 4 | attachments | the task's uploads directory is non-empty | the user handed it a file |
| 5 | shipped | `merged_at > 0` ∨ `pr_url !== ''` | reviewed work exists and this row is where it came from |
| 6 | **unreviewed changes** | `!(await worktreePruneSafety({ repoPath, worktreePath, workBranch, baseBranch })).safe` | a dirty worktree, or commits the base branch has not absorbed |

Signal 6 is the test that matters, and it is deliberately not new code:
`lib/git.ts:678` already computes exactly this for the worktree-prune and
task-move paths and is already covered by `tests/worktree.test.ts`. It compares
against the base **branch** rather than `merged_at` bookkeeping, so it reflects
git reality.

Signal 6 also subsumes "produced no diff" and "produced no commits" — those are
precisely `!isDirty && ahead === 0`. There is no separate definition of
"produced nothing" anywhere in this design, and there should not be one.

### What is deliberately not a blocker

**`awaiting_input`.** A scheduled turn that succeeds leaves it at 0 by design;
a scheduled turn that **fails** sets it, so failures surface in "Needs you".
A failed run with an empty worktree is exactly the litter worth clearing, so it
must not be permanently untouchable. It is instead the line between the two
consumers: the manual modal offers it (unchecked, labelled), the auto sweep
never takes it. See "Two consumers, two screens".

**Suggestions the run filed.** `suggest_task` rows are independent task rows
that outlive their filer. Deleting the run costs provenance, not work, and
blocking on it would make the `/jira-tasks` case — whose entire output is
suggestions — permanently unclearable, which inverts the feature.

### Two consumers, two screens

The manual clear and the auto sweep are different acts and get different
screens. The user is present and reviewing at click time; the sweep is not.

```
manual clearable  = runRetention().safe
auto  clearable   = runRetention().safe  ∧  awaiting_input = 0  ∧  age ≥ N days
```

`age` is measured from `updated_at`, which for an untouched run is when its turn
last wrote — the honest "nothing has happened here since" timestamp.

The narrowing is one-directional by construction: the sweep can only ever take a
subset of what the modal would offer. A future change that widens the sweep has
to widen the predicate, which means changing the test that matters.

## Grouping

Pure client-side display. No rows change, no endpoint is added. `schedule_id`
does need adding to the client `TaskRow` (`app/orchestrator/types.ts:30`), which
does not carry it today.

A **stack** is the collapsed representation of one schedule's runs:

```
▸ ⏱ Jira triage · 37 runs · latest 2h ago
```

Expanding renders the ordinary cards in place. Collapsed by default, persisted
per (project, schedule) through the existing `useCollapsed`
(`TasksColumn.tsx:162`). A stack forms at **3 or more** runs — a group header
over two cards is worse than two cards.

**The rule that keeps stacking safe: a stack only ever hides runs that are idle
and unremarkable.** A run that is awaiting input, running, or currently selected
is always rendered as itself. Concretely, the "Needs your input" group never
stacks — a schedule that starts failing every morning must get louder, not
quieter.

### List

One stack per (status group × schedule), inside the existing groups. Status
stays the primary axis, `TaskGroup` (`TasksColumn.tsx:81`) already implements
collapsible groups, and the alternative — hoisting each schedule into its own
top-level section — would make a schedule's runs jump out of the status model
every other user interaction depends on.

The stack header carries the count, the newest run's relative time, and a
`Clear finished runs…` affordance that opens the same modal the Schedules card
does.

### Board

A stack card in the column, occupying the slot of its newest member, not itself
draggable; expanding reveals the real draggable cards.

Drag math survives because `drop()` (`TaskBoard.tsx:189`) rebuilds every
column's order from `cols` — the full membership list — rather than from what is
rendered. The only wiring needed is mapping a hovered stack to its first
member's index, so a drop beside a collapsed stack lands where it looks like it
will.

## Bulk clear

Scoped to one schedule, two phases, following the manner `POST /api/tasks/move`
established: screen per item, refuse per item, proceed with the rest.

**`GET /api/schedules/[id]/runs/clear`** returns the manifest — every task with
`tasks.schedule_id = [id]`, each with `safe` and its `blockers` in the words the
modal shows (`"2 commits not yet in main"`, `"you replied in this run"`,
`"merged"`). This is the count before it acts, and it is an exact list rather
than a number.

**`POST /api/schedules/[id]/runs/clear`** takes `{ ids: string[] }` — the ids the
user actually saw and confirmed — re-screens each one under `withTaskLock`, and
deletes only what still passes. It returns `{ deleted: string[], refused:
[{ id, reason }] }`.

The re-screen is not ceremony. Between rendering the manifest and clicking, a
turn can start, the user can reply in another tab, or a worktree can go dirty.
The POST taking an explicit id list (rather than re-deriving "everything
clearable") means the user can never delete a row they did not see, and the
`refused` echo means they are told when the world moved under them.

### Deletion reuses the single-task path

`DELETE /api/tasks/[id]` (`app/api/tasks/[id]/route.ts:149`) already does the
whole job correctly: abort the turn, remove the worktree, remove the uploads,
hard delete, then publish `task_deleted` with the recomputed awaiting count
*after* the delete. That body moves to `deleteTaskFully(id)` in a new
`lib/taskDelete.ts`, and both routes call it. A second copy of that sequence
would drift, and the comment on line 151 explaining the lock would drift with
it.

### Perf, stated rather than assumed

The manifest runs `worktreePruneSafety()` per run — two git subprocesses each.
On a 260-run schedule that is the one real cost in this design. Mitigations:
signals 1–5 short-circuit before it, tasks whose worktree was already pruned
skip the dirty check, and the remainder run concurrency-limited at 8. This is
the number to **measure** during implementation, not to reason about; if it is
bad, the fallback is a manifest that returns DB-level results immediately and
refines the git column as it resolves.

### Where it is reachable from

The Schedules card on the project landing pane (it owns the schedule), and the
stack header in list view (it is where the litter is). Both open the same modal.

## Auto-clear

Three new columns on `schedules`, via the `migrate()` column-add pattern in
`lib/db.ts` — one for the policy, two so the sweep can report itself:

```
schedules.auto_clear_days   INTEGER NOT NULL DEFAULT 0   -- 0 = off
schedules.last_clear_at     INTEGER NOT NULL DEFAULT 0
schedules.last_clear_n      INTEGER NOT NULL DEFAULT 0
```

Age-based rather than count-based (`keep the newest N`). A count cap is a harder
bound on board size, but on a frequent schedule a burst of firings can push out
a run that is hours old and was never seen. An age bound cannot: it only ever
takes rows that have sat untouched for the stated period, which is also how
people actually describe their own review habit. On a weekday schedule, 14 days
settles at roughly ten rows, so it bounds the board as well.

**Swept from the existing scheduler tick** (`lib/scheduler.ts`), after
adjudication, guarded so a schedule with the feature off costs one integer
comparison. No second timer: the app has exactly one server-owned ticker and
adding a second one to delete things would be a poor first use of the pattern.

**It is never silent.** `last_clear_at` / `last_clear_n` drive a line on the
Schedules card — `auto-cleared 4 untouched runs · 2h ago` — so the feature is
visible on the surface that already exists to prove the schedule is alive. A
retention feature the user cannot see working is indistinguishable from data
loss.

**The editor states the consequence, not the mechanism.** A toggle plus a day
count, rendered as a sentence with a live number:

> Auto-clear untouched runs older than **14** days — 12 of this schedule's 37
> runs would go today.

That count comes from the same manifest endpoint, so the editor cannot describe
a policy different from the one that will run.

## Merged runs are absolute

`merged_at > 0` or a non-empty `pr_url` blocks clearing on both paths, forever.

The softer position is defensible — a merged run's commits are safely in the
base branch, so deleting the row loses provenance rather than work. It is
rejected because scheduled runs that produce merged work are rare and are the
most valuable rows a schedule ever creates, and "where did this commit come
from" is a question asked months later. The cost is a handful of permanent rows
on the board, which grouping already collapses.

## Testing

Unit (vitest, serial, hermetic per `tests/setup.ts`; run in the container via
`npm run test:docker`).

`tests/retention.test.ts` carries the weight. **The test that matters is that
anything with unreviewed changes is untouchable**, so it is built with real git
rather than a mocked safety result:

- table-driven, one fixture per blocker (1–6), each asserting `safe === false`
  and a blocker string the modal can show;
- the git fixtures use `tests/helpers.ts` to make a genuinely dirty worktree and
  a genuinely unmerged commit;
- the positive case: a run with only its seeded prompt, `in_progress`,
  generation 1, clean worktree → `safe`;
- the seeded prompt specifically is not mistaken for user input, and a second
  user message specifically is;
- `awaiting_input` alone does not block the manual predicate;
- the auto predicate is a strict subset: an `awaiting_input` run and a
  too-recent run are both refused by it and both offered by the manual one.

`tests/scheduleRetentionApi.test.ts`:

- the manifest counts and classifies a mixed set correctly;
- POST deletes exactly the safe ids and refuses the rest, asserted **against the
  DB and the filesystem**: the dirty run's row survives and its worktree is
  still on disk;
- the race — dirty the worktree between GET and POST, assert the POST refuses
  that id and still deletes the others;
- an id belonging to a different schedule is refused, not deleted;
- the auto sweep with `auto_clear_days = 0` does nothing at all.

E2E (`npm run test:e2e`, mock agent), extending `e2e/10-schedules.spec.ts`:
several runs of one schedule collapse into a stack, expanding shows them, and
the clear modal states a count before it acts.

## Out of scope

- **A global retention setting.** Consent is per schedule; an instance-wide
  default would be exactly the unasked-for auto-deletion the scheduled-tasks
  design refused.
- **Soft delete / undo / a trash view.** Delete is hard delete throughout this
  repo. Making one feature the exception would be a worse inconsistency than the
  no-undo rule itself.
- **Grouping non-scheduled tasks.** A stack keys on `schedule_id`; tasks created
  by hand have no equivalent grouping key and no equivalent litter problem.
- **Raising `RUN_RETENTION`.** The ledger cap shapes this design (task rows are
  the durable history) but changing it is a separate decision about audit
  records.
- **Clearing across schedules or projects at once.** One schedule at a time is
  what makes the count reviewable.

## Definition of done

- 40 runs of one schedule read as one row in the list and one card on the board,
  and an awaiting or running run is never inside the collapsed stack.
- "Clear finished runs" states an exact count and a per-run reason before it
  acts, and reports what it actually did.
- A run with a dirty worktree or an unmerged commit cannot be deleted by either
  path — proven by a test that builds one with real git.
- Auto-clear is off until a user turns it on for one named schedule, takes a
  strict subset of what the manual clear offers, and says so on the card when it
  runs.
