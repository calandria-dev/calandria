# Groups → tags — design

Date: 2026-08-27
Status: implemented

Task **groups** (`docs/superpowers/specs/2026-08-24-task-grouping-design.md`) gave a
multi-task feature a name, a description, a chip, a strip, a progress fraction — and,
the part that pays for the feature, a context block telling each member session which
step of what it is. The one thing that spike deliberately got wrong is the one this
document changes: **cardinality**. A task belonged to at most one group, so the moment
a task was a step of the auth migration *and* part of the 0.4 release *and* one of the
flaky-test sweep, it had to pick one and the other two facts were unsayable.

Tags are groups with that constraint removed, and the noun renamed to match: a task
carries as many tags as it has reasons to, and takes context from **every** one.

## What changed, and what didn't

Unchanged: everything a tag IS. Project-scoped, named, described, tinted, positioned,
`origin_task_id` provenance, derived-per-read progress, hard delete, no page of its own,
orthogonal to `blocked_by`, never spanning repositories. The chip bar, the strip, the
badges, the landing card, the palette entries, the insights leaderboard and the agent
tools all survive as-is in shape.

Changed:

| | Groups | Tags |
|-|-|-|
| Membership | `tasks.group_id` (nullable FK) | `task_tags(task_id, tag_id, position)` |
| Per task | 0 or 1 | 0..n, ordered |
| Filter | one chip lit | many chips lit, **any** (default) or **all** |
| Strip | shown for the lit chip | shown only when exactly one is lit |
| Badges | one per row | one per tag, capped at 3 + `+N` |
| Context | one block | one block per tag, in tag order |
| `suggest_task` | `group: string` | `tags: string[]` |
| `update_task` | `group: string`, `""` clears | `tags: string[]`, replaces, `[]` clears |
| `list_tasks` | `group` filter | `tag` filter |
| read tool | `list_groups` | `list_tags` |
| bulk write | assign one group | `add` / `remove` / `set` |
| move semantics | per task | per tag |
| insights | `usage.g` | separate `tagUsage` |

## Decisions

**Rename, don't alias.** `task_groups` becomes `tags`, `list_groups` becomes
`list_tags`, `GroupChips` becomes `TagChips`. A compatibility alias would leave two
words for one thing in a codebase whose whole convention is that the noun on screen,
the noun in the schema and the noun in the tool description are the same noun. This is
self-hosted with no external API consumers; the only migration cost is one DB pass.

**Migration copies, it doesn't rename the table.** `lib/db.ts`'s schema block runs
before `migrate()`, so `tags` already exists (empty) by the time an upgrade gets there.
Every `task_groups` row is copied across **with its id intact** — so `origin_task_id`
and any id a user bookmarked still resolve — every non-null `tasks.group_id` becomes
one `task_tags` row, and then the column and the old table go. The column is dropped
rather than left behind because two places answering "which tags does this task carry"
is exactly the bug that outlives the migration. Recorded agent edits naming the old
`group` field are rewritten to `tags` with their scalar values wrapped in one-element
arrays, or the Revert button would silently do nothing on that row.

**Union by default; intersection behind a toggle.** Two lit chips mean "show me both
plans" far more often than they mean "show me the overlap" — a chip bar reads as a set
of things to look at, not a query being narrowed. The `any/all` toggle appears only once
two chips are lit, because with one the two answers are the same set and a control that
changes nothing invites the user to wonder what it did.

**The strip stays single-tag.** A tag's detail view is a band of prose about one
feature. Above a list showing two features it would misread, and stacking two strips
would push the list off the screen. The chip bar is the multi-tag surface.

**`update_task`'s `tags` REPLACES.** Same rule as `blocked_by`, for the same reason:
a tool that could only add has no way to say "this isn't part of the mobile PWA after
all", and one that guessed between add and replace would do the wrong one silently. The
selection bar is where add/remove live, because a mixed selection rarely shares tags and
a replace there would strip labels the user never saw.

**All-or-nothing resolution.** One unusable ref refuses the whole call, and with
`create: true` nothing is minted for the refs before it either. Filing a task under two
of the three tags an agent named, and reporting success, is worse than refusing.

**Insights splits the spend.** A task with three tags joins to three usage rows, so
folding tags into the existing per-day rollup would triple that task's spend on every
chart. `usage` goes back to `(day, project, agent)` and a separate `tagUsage` carries
the tag dimension. The tag leaderboard therefore does NOT sum to the project total —
stated on the card, because a task that is part of two features really did cost both of
them its time, and dividing spend we have no basis to divide would be a worse lie.

**Move is decided per tag.** A tag travels with the movers only when *every* task
carrying it is moving (the both-ends rule dependencies already use); otherwise the
movers lose that one tag and keep the rest. Under groups this was per task because a
task had one group; under tags, "the auth migration came along and flaky-tests stayed"
is a sentence the report has to be able to say.

## Schema

```sql
CREATE TABLE IF NOT EXISTS tags (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  color          TEXT,
  origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,   -- this task's tag order
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, tag_id)
);
```

`task_tags.position` is what makes tag order meaningful per task: the badges render in
it and `tagContextBlock` injects in it, so the tag a task is *mostly* about is the first
thing its session reads. CASCADE on both ends: deleting a tag untags its tasks (keeping
their other tags), deleting a task takes its memberships with it.

## Context block

One block per tag, joined, in tag order:

```
--- This task is tagged "Auth migration" (step 3 of 7) ---
<description>
Other tasks with this tag:
  ✓ Add session table migration (done, merged)
  → Port login route to AuthService   ← this task
  · Port signup route (not started, blocked by this task)
Planned in task "Plan the auth migration" (id …); use get_task to read the brief.

--- This task is tagged "0.4 release" (step 5 of 12) ---
...
```

"Step N of M" is per tag, over that tag's members only, in the same topological order
the strip numbers (`depends_on` restricted to the tag, ties by `tasks.position`).
Sibling descriptions stay out for the same context-budget reason as before — and the
reason is stronger now, since a task with three tags would otherwise inline three
plans' worth of briefs. `send_context = 0` suppresses all of it.

## Files

Server: `lib/db.ts` (tables + migration), `lib/types.ts` (`Tag`, `TAG_COLORS`,
`parseTagColor`, `tagIsDone`), `lib/store.ts` (`listTags`/`getTag`/`getTaskTags`/
`getTaskTagIds`/`createTag`/`updateTag`/`deleteTag`/`resolveTag`/`setTaskTags`/
`addTaskTags`/`removeTaskTags`, `listTasks.tag_ids`, `moveTasks`, insights),
`lib/tagContext.ts`, `lib/agentTools.ts` (`resolveTagRefs`, `listTagsForAgent`),
`lib/agentToolDefs.mjs`, `lib/events.ts` (`tags_changed`), the Claude driver, the stdio
bridge, `app/api/{tags/[id],projects/[id]/tags,tasks/tags,tasks/[id],tasks,
internal/agent-tools/*}`.

Client: `app/shell/TagChips.tsx`, `TagStrip.tsx`, and the surfaces that render them
(`TasksColumn`, `TaskBoard`, `modals`, `ProjectLanding`, `CommandPalette`,
`InsightsView`, `SessionView`, `Shell`, `useShell`, `useGlobalEvents`).

## Out of scope

Everything the group spike listed, still: an integration branch per tag, board
swimlanes, cross-project tags, tag-level verbs. Plus one the many-to-many shape newly
invites and which is deliberately not here: **tag hierarchies** (a tag implying
another). Two tags on a task already says everything a parent tag would, and a graph
of implications would have to be resolved everywhere a count is derived.
