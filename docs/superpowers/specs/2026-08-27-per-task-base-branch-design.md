# Per-task base branches — design spike

Date: 2026-08-27
Status: spike — a proposal for discussion, not yet approved

Follow-on to `2026-08-24-task-grouping-design.md`, which named this the "most
valuable follow-on and the most invasive" and deferred it explicitly.

A project has exactly one base branch (`projects.branch`, default `main`). Every
task in it is cut from that branch, catches up to that branch, merges into that
branch and opens its PR against that branch. The moment a real feature needs its
own integration branch — five agents landing on `feature/auth` while three others
keep shipping to `main` — the model has no way to say so. Today the workaround is
a second project row pointing at the same repo with a different `branch`, which
splits the task list, the recap, the insights and the group chips in half.

This spike answers: what is the smallest change that lets a **task** name the
branch it works against, lets an **agent** retarget its own worktree, and makes a
**group** the place a whole plan's base is configured once.

## What exists today, and what doesn't

The git layer is already there. `lib/git.ts` takes `baseBranch` as a plain string
parameter in every function that needs one — `ensureWorktree`, `taskDiff`,
`worktreeSyncStatus`, `fastForwardWorktree`, `mergeTask`, `prepareWorktreeMerge`,
`completeWorktreeMerge`, `worktreePruneSafety`, `fetchBase`, `baseRemote`,
`remoteBaseStatus`, `advanceBaseBranch`, `pushBaseBranch`, and `createTaskPr` in
`lib/github.ts`. **Not one of them reads `project.branch` itself.** Redirecting the
whole app to a per-task value is a call-site change at ~15 places, not a refactor
of the git layer.

- **`mergeTask` already handles a base that isn't the main checkout**: `target !==
  current` routes to `mergeIntoTargetWorktree`, whose fast path merges at the
  object level (`merge-tree --write-tree` → `commit-tree` → `update-ref`) with no
  working tree materialized at all (`lib/git.ts:1294`). Landing on `feature/auth`
  while the user's checkout sits on `main` is a solved problem.
- **The fetch cooldown is already per-branch**: `fetchBase` keys on
  `repoLockKey(repoPath) + "\0" + baseBranch` (`lib/git.ts:355`), so two bases in
  one repo don't starve each other.
- **Merges are already serialized per repo** by `withRepoLock`, and `mergeViaTree`
  passes the old tip to `update-ref` so a concurrent move is refused rather than
  silently discarded. Two tasks landing on the same feature branch is already safe.
- **The diff base already self-heals.** `resolveBase` (`lib/git.ts:919`) prefers the
  stored `base_sha`, corrects it forward to `merge-base(baseBranch, HEAD)` when the
  worktree was caught up out of band, and deliberately *keeps* the snapshot when the
  base was rewritten. That policy is what makes a retarget cheap — see below.
- **What doesn't exist**: any per-task or per-group storage for a branch name, any
  verb to change one, and any UI that shows which base a task is actually on.
  `projects.branch` is even commented `// git branch (context only)`
  (`lib/types.ts:17`) — it stopped being context-only a long time ago.
- **`tasks.base_sha` and `tasks.work_branch` are already per-task**, so half the
  state a per-task base needs is in place.

## Decisions

| Question | Decision |
|-|-|
| Where a task's base lives | `tasks.base_branch TEXT NOT NULL DEFAULT ''`. `""` = inherit; non-empty = this task's base, full stop. |
| Where a group's default lives | `task_groups.base_branch TEXT NOT NULL DEFAULT ''`, same convention. |
| Resolution order | `task.base_branch` → its group's `base_branch` → `project.branch`. One helper, `resolveBaseBranch()`; never re-derived ad hoc at a call site. |
| When inheritance stops | **At the worktree cut.** `ensureWorktree` writes the resolved name back into `tasks.base_branch`. Before the cut a task follows its group; after it, the task owns the answer — because `base_sha` came from that branch and nothing else can be true. |
| Retarget of a started task | Never rewrites history. Sets the branch, recomputes `base_sha = merge-base(new base, work branch)`, reports the resulting behind-count. The existing Sync banner does the rest. |
| Retarget of a task with no commits | Re-cut instead: `reset --hard` the worktree to the new base's start point. Nothing can be lost, and the task ends up *up to date* rather than merely renumbered. |
| Bases that may be named | Any branch that exists locally, or exists only as a remote-tracking ref (created locally at the fetched tip, tracking it). Refused: a branch checked out in any linked worktree, the task's own work branch, anything `refNameSafe()` rejects. |
| Who can change it | The user (task edit dialog, group strip) and agents (`set_base_branch`, `update_group`). |
| Agent verb shape | One dedicated tool, `set_base_branch`. **Not** a field on `update_task` — see below. |
| Group editing | New `update_group` tool: name, description, color, base branch. No delete verb, mirroring runbooks. |
| Project-level banner | Stays project-scoped and unchanged. It is about the project's *default* base; a per-task base surfaces on the task's own sync banner, which already renders whatever `GET /api/tasks/[id]/sync` returns. |
| Cross-project move | `moveTasks` clears `tasks.base_branch` on every moved row, and clears a carried group's `base_branch`. A branch name means nothing in a different repository. |
| New env vars | None. This is a data model, not per-instance config. |

### Why a dedicated tool and not `update_task(base_branch)`

`update_task` is a synchronous, atomic DB write with an audit trail, and its whole
policy lives in `lib/agentTools.ts`, which `tests/importGraph.test.ts` pins SDK-free
and which deliberately re-reads both rows and patches them in one better-sqlite3
block (`updateTaskForAgent`). Retargeting is asynchronous, touches git, can create a
local ref, can `reset --hard` a worktree and can fail halfway. Folding that into the
field-writer would either make the field-writer async and non-atomic for every other
field, or create a second policy path for the same verb — the exact drift CLAUDE.md
keeps warning about (`isInertSuggestion()` shared between `update_task` and
`withdraw_suggestion`, `ruleFromTypedCommand()` sharing `prefixVerdict()`).

So: `set_base_branch` owns the whole thing, `update_task` explicitly refuses
`base_branch` and its parameter list names the tool that does it. The model never
has to know whether a worktree exists yet — the one verb covers both.

### Why pin at the cut instead of resolving live forever

Live resolution is one line shorter and quietly wrong: change a group's default and
every started member's merge target moves under it, while their `base_sha` still
points at a commit on the branch they actually forked from. The diff would be
computed against one branch and landed on another.

Pinning at the cut is what makes the group surface *safe to give to an agent*. An
`update_group` that retargets a plan can only affect members that haven't been cut
yet; a member already running keeps the base its work is built on, and moving it is
an explicit `set_base_branch` with the sync it implies. That is the whole reason
group editing needs no audit row of its own.

### Why not an integration branch that auto-merges to base

The grouping spike floated "member branches merge into a group branch that merges
to base once". That is a *workflow*, and it needs a group-level merge verb, a
group-level PR, a policy for when the integration branch itself lands, and an owner
for the branch's lifecycle (who creates it, who deletes it after the merge).

A per-task base branch is the *mechanism* underneath that workflow and is useful on
its own: point five tasks at `feature/auth`, they cut from it, catch up to it, and
land on it — the integration branch exists, it is simply created and merged by a
human or by an ordinary task, like any other branch. Group-level verbs
(`merge the group`, `PR the group`) stay out of scope, exactly as the grouping spike
left them.

### Why not let a task base on another task's work branch

Tempting — it's stacked PRs — and it is the one thing this design refuses outright.
`mergeViaTree` lands a merge by `update-ref`-ing the target branch
(`lib/git.ts:1337`). If that branch is checked out in another task's live worktree,
its HEAD moves while its working tree and index do not: that session's next
`git status` shows the whole merge as uncommitted deletions, and the agent in it has
no way to know why. `advanceBaseBranch` already refuses for this reason
(`lib/git.ts:525-527`), and this design extends the same refusal to the point where
the base is *chosen*, where it can carry an explanation instead of a late failure.

Stacked tasks are a real follow-on: they need the merge path to detect a
live-worktree target and route through that worktree, plus a restack policy when the
lower branch moves. Out of scope here.

## Schema

```sql
-- migrate(), following the tasks.group_id / schedules.runbook_id pattern
ALTER TABLE tasks       ADD COLUMN base_branch TEXT NOT NULL DEFAULT '';
ALTER TABLE task_groups ADD COLUMN base_branch TEXT NOT NULL DEFAULT '';
```

Both backfill to `''` on existing rows, which reads as "inherit from the project" —
i.e. every task in every existing database keeps behaving exactly as it does today.
That is the whole migration; there is no data to move and no index to add (nothing
queries by base branch).

`task_groups` needs its own `PRAGMA table_info` read in `migrate()` alongside the
existing `taskCols`/`schedCols`/`editCols` ones (`lib/db.ts:618`).

## The resolver

```ts
// lib/baseBranch.ts — store + types + git only. Pinned SDK-free.
export function resolveBaseBranch(task: Task, project: Project): string {
  if (task.base_branch) return task.base_branch;
  if (task.group_id) {
    const g = getGroup(task.group_id);
    if (g?.base_branch) return g.base_branch;
  }
  return project.branch;
}
```

Every call site that today writes `project.branch` writes `resolveBaseBranch(task,
project)` instead. The two sites that can't take a `Task`:

- **`listReclaimableWorktrees`** (`lib/store.ts:982`) joins `p.branch AS
  base_branch` for the Settings → Storage sweep. It becomes a `LEFT JOIN
  task_groups g ON g.id = t.group_id` plus
  `COALESCE(NULLIF(t.base_branch,''), NULLIF(g.base_branch,''), p.branch)`. The
  resolution order is expressed twice, in TS and in SQL; `tests/baseBranch.test.ts`
  asserts they agree.
- **`taskDiffStat`** (`lib/git.ts:963`) is called with `baseBranch: ""` on purpose
  from the board-card polling path and stays that way — it reads `base_sha` only.

## Retarget

`retargetTaskBase(task, project, branch)` in `lib/baseBranch.ts`, one function
behind both the route and the agent tool so the two policies cannot drift:

1. **Name check** — `refNameSafe(branch)`, else refuse by name.
2. **Existence** — local branch wins. Otherwise `fetchBase` then look for
   `refs/remotes/<remote>/<branch>`; found, create the local branch at that tip with
   `--track` and say so in the result. Neither found → refuse, naming both places
   looked. (Refusing a branch the user can see on GitHub is the failure mode this
   step exists to avoid.)
3. **Occupancy** — `worktreeForBranch(repoPath, branch)` non-null → refuse, naming
   the worktree holding it. This is what blocks `calandria/<id>` bases; the refusal
   says so rather than saying "in use".
4. **Self** — `branch === task.work_branch` → refuse.
5. **Merge in flight** — `worktreeMergeStatus(task.worktree_path).mergeInProgress` →
   refuse: the paused resolution merge is against the *old* base and retargeting
   under it would land a merge nobody asked for.
6. **Liveness** — a target task with `running = 1` that isn't the caller's own row →
   refuse, mirroring `updateTaskForAgent`.
7. **Write + reconcile**:
   - no worktree yet → DB write only, done.
   - worktree, `ahead === 0`, clean tree → `reset --hard selectStartPoint(newBase)`,
     `base_sha` = that sha. Up to date, nothing lost.
   - otherwise → DB write, `base_sha = merge-base(newBase, work_branch)`.

Step 7's last case is the subtle one and it is deliberately *not* clever. The
Changes tab is a merge preview: "what would arrive in the base if I merged now". A
task cut from `main` and retargeted to `feature/auth` genuinely would carry `main`'s
newer commits into `feature/auth`, so showing them is the honest answer, and one
Sync collapses the diff back to the task's own work. Leaving `base_sha` alone
instead would make `resolveBase` keep a snapshot that is on neither branch's
first-parent line and quietly under-report after the sync.

The result is reported, not silent: `Now based on feature/auth (12 behind — sync to
catch up).`

## Surfaces

**Task edit dialog** (`app/shell/modals.tsx` `EditTaskModal`). A "Base branch"
field under the group picker, its placeholder the *inherited* value ("main — from
the project" / "feature/auth — from group Auth migration"), empty meaning inherit.
Saving a change on a started task goes through `POST /api/tasks/[id]/base-branch`,
not the generic PATCH, so it gets the reconciliation above; on an unstarted task the
same endpoint just writes the row.

**Group strip** (`app/shell/GroupStrip.tsx`). The Edit form already writes name,
description and color through `PATCH /api/groups/[id]`; base branch joins them.
Below it, one line of consequence, because this is the field whose blast radius
isn't obvious: `New tasks in this group branch from feature/auth. 3 members already
cut from main keep it.`

**Session header / Changes tab.** Show the base **only when it differs from the
project default** — a badge next to the work branch in `DiffFooter` and the Changes
tab header. Every task showing `main` is noise; the one showing `feature/auth` is
the whole point.

**Sync banner** (`app/shell/SessionView.tsx`). No change: it renders
`st.baseBranch` from `GET /api/tasks/[id]/sync`, which now returns the resolved
per-task value.

**Base-branch banner** (`app/shell/BaseBranchBanner.tsx`). No change. It is the
project's default base, and its fast-forward/push actions are about that branch.
A "3 tasks are on other bases" summary is a follow-on, not a v1 requirement.

**PR.** `createTaskPr` targets the task's base. GitHub requires that branch to exist
on the remote, so when `baseRemote()` finds no counterpart the route refuses with
`feature/auth isn't on the remote yet — push it first` rather than letting `gh` fail
with its own wording. It does **not** push the base branch as a side effect of
opening a PR; `pushBaseBranch` is an explicit action and stays one.

## Agent-facing tools

Two new verbs, one changed payload, two context lines.

- **`set_base_branch(branch, task?)`** — retarget. `task` defaults to the caller's
  own row and may name any task in the same project. The description has to carry
  the model's mental model, because nothing else will:

  > "Change the git branch this task's worktree is based on — what it was cut from,
  > what Sync catches it up to, and what Merge lands it into. Use it when the work
  > belongs on a feature or integration branch rather than the project's default.
  > The branch must already exist (locally or on the remote); it can't be another
  > task's `calandria/…` branch, because that branch is checked out in a live
  > worktree. If this task has already made commits, nothing is rewritten — you are
  > told how far behind the new base you are, and syncing catches you up. To set the
  > base for a whole plan at once, put it on the group with `update_group` instead;
  > tasks inherit it until their worktree is cut."

- **`update_group(group, {name?, description?, color?, base_branch?})`** — the
  editing verb groups never had. Project-scoped, exact-name-or-id like every other
  group reference, rename collisions refused by name. `base_branch: ""` clears the
  default back to the project's. No delete verb: hard delete with no undo is the
  user's call, the same line runbooks draw.

  > "Edit a group as the plan changes — rename it, rewrite its brief, or set the git
  > branch its tasks are based on. Setting `base_branch` points every task filed
  > under this group from now on at that branch instead of the project's default;
  > members whose worktree has already been cut keep the branch they forked from, so
  > this is safe to set mid-plan. There is no delete — that's the user's call."

- **`list_groups`** gains `base_branch` on each group, and `get_task` /
  `list_tasks` rows gain the task's *resolved* base (the effective answer, not the
  raw column — an agent asking "what am I based on" must not have to reimplement the
  fallback chain).

- **`buildProjectContext()`** (`lib/agents/shared.ts:35`) — `Git branch: main`
  becomes:

  ```
  Base branch: feature/auth — this worktree was cut from it, Sync catches up to it,
  and Merge lands into it. (The project's default is main.)
  ```

  The parenthetical only when they differ.

- **`groupContextBlock()`** (`lib/groupContext.ts:91`) gains one line under the
  description when the group sets a base: `Tasks in this group are based on
  feature/auth.`

Codex reaches all of it through the existing stdio bridge: definitions in
`lib/agentToolDefs.mjs`, policy in `lib/baseBranch.ts`, transport in
`scripts/calandria-mcp.mjs` → `app/api/internal/agent-tools/*`.

## Semantics that need deciding, decided

- **A group whose base is set after members were cut.** Members already cut keep
  their branch (pinned). The strip says how many, so the number is visible rather
  than inferred. Retargeting them is a per-task decision with a per-task sync.
- **Cross-project move.** `moveTasks` clears `tasks.base_branch` on every mover and
  on a carried group, beside the existing `dropped_blockers`/`ungrouped` reporting.
  A started task's checkout is destroyed by the move anyway, so nothing is stranded.
- **Deleting a group.** Members are already `SET NULL`-ungrouped; a member that was
  cut keeps its pinned branch, an uncut one falls back to the project default. No
  new behavior.
- **A base branch deleted out from under a task.** Every git call already degrades:
  `ensureWorktree` falls back to HEAD when the base doesn't exist
  (`lib/git.ts:679`), `worktreeSyncStatus` returns the all-zero `none`,
  `prepareWorktreeMerge` refuses by name, and `mergeTask` falls back to the repo's
  current branch. The one addition: the Changes tab says `base branch feature/auth
  no longer exists` instead of silently retargeting the merge at whatever the user's
  checkout happens to be on — that fallback is defensible for a *misconfigured*
  project and indefensible as the silent answer to a deleted feature branch.
- **Two tasks merging into one base concurrently.** Already safe:
  `withRepoLock(repoPath)` serializes, and `mergeViaTree`'s `update-ref` carries the
  old tip so a move it didn't see is refused rather than overwritten. Worth a test,
  not a change.
- **The runner's pre-turn catch-up** (`lib/runner.ts:281`) fast-forwards to the
  resolved base like it does today. A task on `feature/auth` catches up to
  `feature/auth`, not to `main` — which is the entire point of the feature and needs
  no special case.
- **Live refresh.** A base change is a task edit (`task_edited` → refetch) or a
  group edit (`task_groups_changed` → refetch), both already wired.

## Files

| Where | What |
|-|-|
| `lib/db.ts` | `tasks.base_branch` + `task_groups.base_branch` in `migrate()`; a `PRAGMA table_info(task_groups)` read |
| `lib/types.ts` | `base_branch` on `Task` and `TaskGroup`; retire the `// (context only)` comment on `Project.branch` |
| `lib/baseBranch.ts` | **new** — `resolveBaseBranch()`, `retargetTaskBase()`, the refusal wording. Pinned SDK-free |
| `lib/git.ts` | export `worktreeForBranch`; `ensureWorktree` returns the base it used so the caller can pin it |
| `lib/store.ts` | `base_branch` in the task/group update statements; `listReclaimableWorktrees`' COALESCE join; `moveTasks` clearing it |
| `lib/runner.ts`, `lib/autoStart.ts`, `lib/dispatch.ts` | resolved base into `ensureWorktree` + the pre-turn sync; write the pin back |
| `lib/taskMove.ts` | resolved base into both `worktreePruneSafety` calls |
| `lib/agents/shared.ts`, `lib/groupContext.ts` | the two context lines |
| `lib/agentToolDefs.mjs`, `lib/agentTools.ts` | `set_base_branch`, `update_group`, `base_branch` on `list_groups`, resolved base on task rows |
| `scripts/calandria-mcp.mjs`, `app/api/internal/agent-tools/*` | bridge both new tools |
| `app/api/tasks/[id]/base-branch/route.ts` | **new** — `POST` retarget |
| `app/api/tasks/[id]/{sync,diff,merge,merge/prepare,merge/complete,pr}/route.ts`, `app/api/tasks/[id]/messages/route.ts`, `app/api/maintenance/worktrees/route.ts` | `project.branch` → resolved base |
| `app/api/groups/[id]/route.ts` | `base_branch` on PATCH |
| `app/shell/types.ts` | `base_branch` on `TaskRow`/`TaskGroupRow` |
| `app/shell/modals.tsx`, `GroupStrip.tsx`, `DiffFooter.tsx`, `app/TaskChanges.tsx` | the field, the group form + consequence line, the differs-from-default badge |
| `tests/importGraph.test.ts` | pin `lib/baseBranch.ts` and `lib/git.ts` SDK-free |
| `docs/FEATURES.md`, `README.md` | a *Base branches* subsection; the groups bullet gains the default |

## Build order

1. **`tasks.base_branch` + the resolver + every call site + pin-at-cut + retarget +
   `POST /api/tasks/[id]/base-branch` + the task edit field + the context line.**
   Ships alone: a task can be pointed at any branch by hand and everything —
   diff, sync, merge, PR, prune — follows it.
2. **`task_groups.base_branch`**: inheritance, the strip field and its consequence
   line, `list_groups` payload, the group context line, `moveTasks` clearing.
   *A plan gets a base once instead of N times.*
3. **`set_base_branch` + `update_group`.** *Agents retarget themselves and edit the
   plan they are part of.*

3 needs 2 for `update_group`'s base field but the retarget half only needs 1; if 2
slips, ship `set_base_branch` and hold `update_group`.

## Testing

- `tests/baseBranch.test.ts` — resolution order and its SQL twin; pin-at-cut; the
  five refusals (unsafe name, absent, occupied worktree, own work branch, merge in
  flight); retarget of a clean uncommitted task (reset) vs a committed one
  (`base_sha` = merge-base, behind-count reported); a remote-only branch created
  with tracking.
- `tests/sync.test.ts`, `tests/merge.test.ts` — extend with a non-default base:
  catch-up to `feature/x` and not to `main`, a merge landing on `feature/x` while
  the main checkout stays on `main`, two tasks merging into one base under the repo
  lock.
- `tests/groups.test.ts` — a group's default inherited by a new member, ignored by
  a cut one, cleared on a cross-project move.
- `tests/worktreeMaintenance.test.ts` — the COALESCE join picks the task's base.
- `tests/agentTools*.test.ts` + `tests/codexUpdateTaskPolicy.test.ts` — both new
  tools through the real stdio bridge against the real endpoint, asserting on the
  DB, since Codex is the path where the model names the target.
- `tests/importGraph.test.ts` — the two new pins.
- e2e: a task retargeted to a second branch, merged into it, and the main checkout
  left untouched on `main`.

## Addendum, 2026-08-27 — groups became tags, and a task can carry several

Everything above was written against the one-group-per-task model of
`2026-08-24-task-grouping-design.md`. Groups have since become **tags**
(`docs/superpowers/specs/2026-08-27-tags-design.md`): many-to-many through
`task_tags`, a `tags` row, no `tasks.group_id`. Read the design above for the
reasoning; the symbols have all moved:

| Above | Now |
|-|-|
| `task_groups.base_branch` | `tags.base_branch` |
| `tasks.group_id` | a row in `task_tags` (`task_id`, `tag_id`, `position`) |
| `GroupStrip.tsx` | `app/shell/TagStrip.tsx` |
| `groupContextBlock()` | `tagContextBlock()` in `lib/tagContext.ts` |
| `list_groups` / `update_group` | `list_tags` / `update_tag` |

That change breaks one assumption the middle leg of the resolution chain rested
on: **the task had exactly one group, so "the group's base branch" named exactly
one value.** A task can now carry three tags, two of which set a base.

### Decision: the first tag by `task_tags.position` that sets a base wins

```
task.base_branch → first tag (task_tags.position ASC) with base_branch != ''
                 → project.branch
```

Not an error, not a refusal at tagging time, not "they must agree". Two reasons:

- **`task_tags.position` already means "the tag this task is mostly about".** It
  is the order the badges render on the card, the order `getTaskTags` returns,
  and the order `lib/tagContext.ts` injects the context blocks in — so the first
  tag is already the first thing the session reads about itself. Resolving a
  disagreement by that order adds no new concept; it reuses the one ordering the
  row already carries.
- **The alternative is a refusal at the wrong moment.** Making a conflict an
  error means adding a second tag to a task can fail, or tagging succeeds and the
  *worktree cut* fails later — a launch-time failure for a labelling action taken
  days earlier. Tags are meant to be cheap to add; "this task is also part of the
  flaky-test sweep" must not be able to break its next turn.

Ties are therefore resolved rather than reported — **but silently resolving one
is not acceptable either**, because a base branch would appear on a task from a
tag the user wasn't looking at. So the resolution is stated on the surface where
it is decided:

- `TagStrip`'s consequence line names the members whose base comes from a
  *different* tag, and which one: `2 tasks take their base from another tag
  (Release 3.2) instead.` Without it, a user setting `feature/auth` on the auth
  tag would be told "N new tasks branch from feature/auth" while some of them
  quietly branch from somewhere else.
- The same first-wins order is what `listReclaimableWorktrees` expresses in SQL,
  and `tests/baseBranch.test.ts`'s "agrees with the COALESCE" case covers all
  three legs, so the TS and SQL orders cannot drift apart on the tag leg the way
  they could on a two-leg chain.

**Pin-at-the-cut is unchanged and does the rest of the work.** A tag's base only
ever reaches a task that hasn't been cut yet; the moment `ensureWorktree` runs,
the resolved name is written into `tasks.base_branch` and the task stops asking
its tags. So a re-ordered tag list, a tag added later, or a tag's base edited
mid-plan can never move a started task's merge target — which is what makes both
the tie-break and tag-level editing safe to hand to an agent.

`moveTasks` clears `tags.base_branch` on a CARRIED tag for the same reason it
clears `tasks.base_branch` on every mover: a branch name means nothing in another
repository.

## Out of scope

- **Stacked tasks** — a task based on another task's `calandria/` branch. Needs a
  merge path that routes through a live worktree and a restack policy; refused here
  with an explanation, on purpose.
- **Group-level verbs** — merge the group, PR the group, create the integration
  branch. Each is a batch over per-task verbs; the grouping spike deferred them and
  this doesn't change that.
- **Creating a branch from the tool.** `set_base_branch` requires the branch to
  exist. Agents already have a shell in the worktree, and minting refs as a side
  effect of a targeting call is how you get `feature/uath`.
- **A project-level list of bases in play** on the base-branch banner.
- **Per-task remotes.** One repo, one remote set; a task picks a branch, not a fork.
