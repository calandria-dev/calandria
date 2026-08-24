# Task groups — design spike

Date: 2026-08-24
Status: spike — a proposal for discussion, not yet approved

A feature, a migration, or a refactor is rarely one task. It's five or ten, planned
together, run over days, merged one at a time. Jira hangs those off an **epic** and
lets you filter the board by it. Calandria has no noun for the set: today a plan
arrives as N unrelated rows in the Suggested tray, related only by the moment they
were filed and whatever `blocked_by` edges the planning turn drew. This spike
answers: what is the Calandria-shaped version of that noun?

## What exists today, and what doesn't

The mechanics of a multi-task feature are mostly present — what's missing is the
container.

- **Dependencies** (`task_dependencies`, `setTaskDeps`, `lib/autoStart.ts`) already
  give a feature its *order*: `blocked_by` + **Start when unblocked** turns a set of
  tasks into a pipeline that runs itself. But edges are pairwise; nothing names the
  pipeline, and a task with no edges is invisible as a member.
- **Planning turns** already *produce* the set: an agent asked to break work down
  calls `suggest_task` once per step, then `update_task` to order them
  (`docs/FEATURES.md` → Planning and orchestration). That batch is the epic being
  born, and the app forgets it was a batch the moment the tray renders.
- **Views** are project-scoped and status-grouped: the list (`TasksColumn.tsx`)
  buckets by status, the board (`TaskBoard.tsx`) columns by status, both with a
  free-text search and nothing else. The only grouping above a task is the project.
- **No labels, tags, parents, milestones** exist anywhere in `lib/` or `app/`
  (grepped). The `Task` type, `TaskRow`, `createTask`, the PATCH route and every
  agent tool are group-blind.
- **Spend** is recorded per task (`task_usage`), rolled up per project. "What did the
  auth migration cost" is currently a sum you do by hand.

## Decisions

| Question | Decision |
|-|-|
| What a group is | A named, project-scoped container of tasks with a description. **Not** a task itself: no session, no worktree, no status of its own. |
| Cardinality | One group per task (`tasks.group_id`, nullable). Not many-to-many labels — the driving case is "this task is one step of that feature", and a single axis is what filters, badges and agent context can all agree on. |
| Scope | Project-scoped, like dependencies and runbooks. A group never spans repositories. |
| Status | Derived, never stored: *done* when every member is terminal (done/cancelled) and there is at least one member; *active* otherwise. No "close epic" verb — the tasks are the truth. |
| Name in the UI | **Group**. "Epic" is mentioned once in the docs so people searching for it find this; it carries Jira's size connotation and Calandria's groups can be two tasks. |
| Who creates them | The user (edit dialog, New task, selection bar) and planning agents (`suggest_task` gains `group`, exact-match-or-create in the target project). |
| Provenance | `origin_task_id` points at the session that filed the group, when an agent did. The plan's transcript is the epic's rationale; the group links back to it. |
| Where members see it | **Injected into the member's session context**: name, description, and siblings with status and order. This is the part Jira can't do and the part that pays for the feature. |
| Relationship to dependencies | Orthogonal. Groups say *belongs with*; edges say *waits for*. Cross-group edges are fine (same project). Nothing is inferred from one to the other. |
| Delete | Hard delete, like everything else; members are ungrouped (`ON DELETE SET NULL`), never deleted. Deleting the last member doesn't delete the group. |
| Integration branch per group | **Out of scope for v1**, deliberately — see below. |

### Why not make the group a task

The obvious Calandria move is `tasks.parent_id`: the planning session *is* a task,
its children are tasks, done. It's tempting because the planning transcript really
is the epic's origin. But a task here is a worktree + a branch + an agent + a status
+ a `running` flag + an `awaiting_input` count + a board column, and a container
row would have to opt out of all of that everywhere: the runner, `ensureWorktree`,
the "needs you" pill, board `member()` predicates, auto-start, `listTasks`' sort.
Every one of those becomes an `if (!isContainer)` and the first one missed is a bug
where a session is launched for a row that has no work. The link to the planning
session is kept — `origin_task_id` — without conflating the plan with the set.

### Why not labels

Labels are the cheaper thing to build and the wrong thing to build first. They
carry no description, no progress, no "this is the planning session that filed
you", and a task with three labels has no answer to "which feature are you part
of" — which is the question a member session needs answered. Labels as a second,
orthogonal axis remain possible later; nothing here precludes them.

### Why no integration branch (yet)

The real git question — should a group's member branches merge into a group branch
that merges to base once, rather than each task landing on `main` separately — is
the most valuable follow-on and the most invasive. It changes the merge target in
`mergeTask`/`prepareWorktreeMerge`, the base-sync banner's notion of "base", what
a worktree is cut from (`ensureWorktree` cuts from the fetched base tip), conflict
resolution prompts and `createTaskPr`. Today's model — each task cut from base,
later tasks blocked by earlier ones so they're cut *after* the earlier merge — already
works for sequential pipelines and is what the dependency feature was built on.
Groups as a planning/navigation/context construct stand on their own; a group
branch is a second design with its own spec, and having the group noun first is a
prerequisite for it.

## Schema

```sql
CREATE TABLE IF NOT EXISTS task_groups (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  color          TEXT,                       -- optional badge tint, from a small fixed palette
  origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  position       INTEGER NOT NULL DEFAULT 0, -- chip order; user-draggable later, created_at for now
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
-- migrate(): same pattern as schedule_id
ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);
```

`foreign_keys = ON` is already pragma'd in `lib/db.ts`, so both `SET NULL` clauses
are real. `UNIQUE(project_id, name)` is what makes exact-name resolution from an
agent unambiguous; rename collisions are a 409.

`listTasks` selects `t.*`, so `group_id` reaches the client `TaskRow` with no wire
change. The group rows themselves ride the project GET
(`app/api/projects/[id]/route.ts` already embeds `listTasks`) as `groups: TaskGroup[]`
with derived counts attached server-side:

```ts
type TaskGroup = {
  id; project_id; name; description; color; origin_task_id; position; created_at; updated_at;
  counts: { total; done; cancelled; running; awaiting };   // derived per read, never stored
};
```

## Surfaces

Groups change *what's shown*, not the status buckets the control room is built on.
The list stays grouped by status and the board stays columned by status; a group
is a filter over both, and a badge on every row and card.

**Filter chips.** A chip bar above the list/board: `All · Auth migration · Mobile PWA
· ⋯`. One selected chip narrows every bucket, the Suggested tray included, to that
group's members; the selection is per-project and persisted the way collapsed
sections are (`useCollapsed` pattern). Done groups fold behind a `Done (3)` chip so
a long-lived project's bar doesn't fill with finished work. Each chip shows a
progress fraction (`4/7`) and inherits the "needs you" dot when a member is waiting.

**Badges.** A tinted pill with the group name on list rows, board cards, the
session header and palette results. On the board the pill is the only cue; on the
list it sits after the title. Clicking a badge selects the chip.

**Group strip.** When a chip is selected, a strip under the bar shows the
description, a progress bar, `Planned in <origin task>` (a link, when set), and
the members in dependency order — a `topoSort` over `depends_on` restricted to the
group, ties by `position` — with each one's status dot. Verbs: **Edit** (rename,
describe, recolor), **Delete group** (ungroups, confirm names the count). That's
the whole "epic page"; a group doesn't get its own route.

**Project landing** (`ProjectLanding.tsx`). A *Groups* card between the recap and
Runbooks: active groups with progress bars and needs-you counts, click → selects
the project with that chip active. Empty groups (planned, nothing filed yet) show
as `no tasks yet`.

**Edit task / New task** (`modals.tsx`). A **Group** field: a combobox over the
project's groups plus `New group…` inline (name only; description from the strip
later). Lives above **Blocked by**, since "which feature" is decided before "which
step". Changing a task's project (`MoveProjectField`) clears the group, stated in
the modal the way dropped blockers are.

**Selection bar** (`TasksColumn.tsx`). Beside **Move to project…**: **Group…** →
the same combobox, applied to every ticked row in one PATCH batch. This is the
cheap path for grouping a batch of suggestions an agent filed before groups
existed, and for regrouping by hand.

**Suggested tray.** Rows carry the badge. A planning turn that filed with `group`
lands its whole plan already grouped; the chip appears the moment the first
suggestion does, so the tray reads as "here's the Auth migration plan" rather than
seven rows.

**Command palette.** Groups are searchable (`Group · Auth migration · 4/7`) and
selecting one navigates to the project with the chip active. `listAllTasksLite`
gains `group_name` so task results can show their badge.

**Insights.** A *Groups* leaderboard beside the project/agent ones: spend and
tokens summed over `task_usage` joined through `tasks.group_id`. This is the "what
did the migration cost" answer and it's one query.

**Needs-you inbox.** Unchanged, except the row shows the badge. Grouping is not a
snooze; nothing about urgency changes.

## Agent-facing tools

Three existing tools gain a `group` parameter; one new read tool; no delete.

- `suggest_task(…, group?)` — id or exact name, resolved in the **target** project
  (after `resolveTargetProject`, so a cross-project suggestion groups within the
  project it lands in). No match → the group is created there with
  `origin_task_id` = the calling task, and the result says so:
  `Created group "Auth migration" in <project>.` Exact-match-or-create is right
  for the planning verb: the common case *is* "this group doesn't exist yet", and
  the round trip of `create_group` then N suggestions is the two-phase dance
  `blocked_by` already forces. A near-miss creating a duplicate is bounded by
  `UNIQUE(project_id, name)` plus the tool result naming what happened.
- `update_task(…, group?)` — strict: existing id or exact name only, `""` to
  ungroup. Same blast-radius policy as every other field on that tool: the caller's
  own row, or an inert tray suggestion in any project. Unknown group fails the call
  with the reason; nothing else in the call lands (mirrors the `blocked_by` rule).
- `list_tasks(…, group?)` — filter; every returned row carries `group: {id, name}`
  or null. `list_groups(project?)` returns name, description, counts and members'
  ids, so an agent asked "how's the migration going" can answer without paging.
- `buildProjectContext()` gains a block for a member task — the **group context**:

  ```
  --- This task is part of the group "Auth migration" (step 3 of 7) ---
  <description>
  Other tasks in this group:
    ✓ Add session table migration (done, merged)
    ✓ Introduce AuthService (done, merged)
    → Port login route to AuthService   ← this task
    · Port signup route to AuthService (not started, blocked by this task)
    · Remove legacy auth middleware (not started)
  Planned in task "Plan the auth migration" (id …); use get_task to read the brief.
  ```

  "Step N of M" comes from the same topological order the strip shows. Sibling
  *summaries* are deliberately not inlined — a seven-task group would spend a
  fifth of a session's context on them; `get_task` is one call away and the agent
  can choose. `send_context = 0` suppresses this block the way it suppresses
  project context.

Codex reaches all of this through the stdio bridge (`scripts/orch-mcp.mjs` →
`/api/internal/agent-tools/*`); the definitions live in `lib/agentToolDefs.mjs`
so the two drivers can't drift, and the policy in `lib/agentTools.ts` (pinned
SDK-free).

## Semantics that need deciding, decided

- **Move to another project.** `moveTasks` clears `group_id` on every moved row
  and reports it beside `dropped_blockers`. If *every* member of a group is in the
  selection, the group row moves with them (re-keyed `project_id`, name collision
  → the moved group is suffixed `(moved)` and reported). Mirrors the "both ends
  moving" rule dependencies already have, and reuses the moving-set it already
  computes.
- **Withdrawn / cancelled members** count as terminal for group progress — the same
  rule `blocks()` uses. A group of five with two withdrawn is `3/3` done when the
  three finish, shown as `3 done · 2 withdrawn` in the strip so the count doesn't
  read as a lie.
- **A dispatched or scheduled task** (`runbook_id`/`schedule_id`) can be grouped
  like any other; runbooks and schedules don't carry a default group. A recurring
  sweep isn't a feature.
- **Live refresh.** Membership changes are task edits (`task_edited` → refetch, as
  today). Group create/rename/delete/recolor publishes `task_groups_changed`,
  project-keyed, following `runbooks_changed` exactly (bus keyed with `""`,
  bypasses the re-read-the-task enrichment because no task row is involved).
- **Derived status is read-time.** Counts are computed in the project GET and in
  `list_groups`; no trigger, no cached column, nothing to get stale when a task
  is deleted.

## Files

| Where | What |
|-|-|
| `lib/db.ts` | `task_groups` table (inline `CREATE TABLE IF NOT EXISTS`), `tasks.group_id` in `migrate()`, index |
| `lib/types.ts` | `TaskGroup`; `group_id` on `Task` |
| `lib/store.ts` | `listGroups(projectId)` with counts, `createGroup`, `updateGroup`, `deleteGroup`, `resolveGroup(projectId, ref, {create, originTaskId})`, `setTaskGroup(ids, groupId)`; `moveTasks` group handling; `listAllTasksLite` + `group_name` |
| `lib/groupContext.ts` | `groupContextBlock(task)` — the topo-ordered sibling block; SDK-free, pinned in `tests/importGraph.test.ts` |
| `lib/agents/shared.ts` | `buildProjectContext` calls it |
| `lib/agentToolDefs.mjs`, `lib/agentTools.ts` | `group` on suggest/update/list, `list_groups` |
| `scripts/orch-mcp.mjs`, `app/api/internal/agent-tools/*` | bridge the new param and tool |
| `app/api/projects/[id]/groups/route.ts` | `GET` list, `POST` create |
| `app/api/groups/[id]/route.ts` | `PATCH` rename/describe/recolor, `DELETE` |
| `app/api/tasks/[id]/route.ts`, `app/api/tasks/group/route.ts` | `group_id` on PATCH; bulk assign |
| `app/orchestrator/types.ts` | `TaskGroup`, `group_id` on `TaskRow` |
| `app/orchestrator/GroupChips.tsx`, `GroupStrip.tsx` | chip bar + strip, shared by list and board |
| `TasksColumn.tsx`, `TaskBoard.tsx`, `modals.tsx`, `ProjectLanding.tsx`, `CommandPalette.tsx`, `InsightsView.tsx`, `SessionView.tsx` | badge, filter, field, landing card, palette entries, leaderboard, header pill |
| `docs/FEATURES.md` | a *Groups* subsection under Planning and orchestration |

## Build order

1. Schema, store, types, project GET carrying `groups`, PATCH `group_id`. Badge on
   list rows and board cards; chip bar filtering both. Edit/New task field.
   *Usable on its own: you can group by hand and filter.*
2. Agent tools + group context block. *A planning turn files a grouped plan and
   every member session knows where it sits.*
3. Selection-bar bulk group, landing card, strip with topo order and origin link,
   palette entries, insights leaderboard, `moveTasks` semantics.

Each step ships independently; 2 and 3 both need 1 and are independent of each
other.

## Testing

- `tests/groups.test.ts` — store: unique names per project, `resolveGroup`
  create-vs-strict, `SET NULL` on delete, counts with withdrawn/cancelled members,
  `moveTasks` clearing vs carrying the group.
- `tests/groupContext.test.ts` — topo order with ties, "step N of M", the
  `send_context = 0` suppression, a member with no siblings.
- `tests/agentTools*.test.ts` / `tests/codexUpdateTaskPolicy.test.ts` — `group` on
  each tool through the real bridge, cross-project suggestion grouping in the
  target, strict failure on `update_task`.
- `tests/importGraph.test.ts` — `lib/groupContext.ts` pinned SDK-free.
- e2e: file a grouped plan with the mock agent, assert the chip, the badge, the
  filtered board, and the context block in the next member turn's prompt.

## Out of scope

- **Integration branch per group** — the follow-on spec, above.
- **Labels/tags** as a second axis.
- **Swimlanes** on the board (rows per group). Filter chips first; swimlanes are a
  view option to add once groups exist and someone misses them.
- **Cross-project groups.** Same reasoning as dependencies: a group is planned
  against one repository. A cross-repo feature is two groups, one per project.
- **Group-level verbs** (start all unblocked, merge all, PR the group). Each is a
  batch over existing per-task verbs; none is needed to make groups useful, and
  "merge all" is the integration-branch question in disguise.
