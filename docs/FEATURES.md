# Features

Operator is a control room for running coding-agent work across repositories. This page
contains the longer feature inventory kept out of the project README.

## Parallel work without collisions

Each task runs in its own git worktree and branch with an independent Claude Code or Codex
session. Projects and tasks share one workspace, so you can run many sessions without
mixing their files, terminals, or transcripts.

The cross-project **Needs you** signal identifies sessions waiting for input. Turns run on
the server and their events are persisted, so reloading the page or sleeping your laptop
does not lose the transcript. Follow-ups can be queued while a turn is running.

## Context that survives the task

Each project has reusable context that is injected into new tasks. **Refresh with AI** can
redraft that context from the repository, and context injection can be disabled for an
individual project or task when a lean session is preferable.

A task is a lineage of agent sessions. `/clear` summarizes the current conversation and
starts a clean context window with that history, allowing long-running work to continue
without turning into one unbounded prompt.

## Review and delivery

Operator puts the task conversation and git diff side by side. From there you can:

- review every changed file before it reaches the base branch;
- sync a stale task branch;
- merge with one click;
- ask the agent to resolve conflicts; or
- create a GitHub pull request.

Worktrees for merged or finished tasks can be reclaimed from Settings. Discarding unmerged
work requires an explicit permanent-discard confirmation.

### Staying level with the remote

Work does not only arrive through the merge button — a pull request merged on GitHub, a
teammate's push, or a pull in another checkout all land on the remote instead. Operator
fetches the base branch (best-effort) when you open a project and again before it cuts a
new task worktree, so a new task starts from the real tip rather than a local `main` that
went stale hours ago.

Your own checkout is never moved behind your back. When local `main` is behind, the project
header says so and offers a one-click fast-forward; when it is ahead, it offers a push; when
the two have diverged, it says that and leaves the resolution to you. After a merge lands,
the same push is offered inline, so the app-side loop and the GitHub-side loop stop drifting
apart. Set `ORCH_GIT_FETCH=off` to keep an instance entirely offline.

Advancing the base branch is what turns an in-flight task's pending merge from a
fast-forward into a sync-then-merge, so a task that read "up to date" a moment ago can
suddenly want syncing. The sync banner names the reason: the base branch moved on, not
anything about the task.

## Planning and orchestration

Use a compact list or a full-width kanban board with Suggested, Not started, In progress,
Needs input, and Done states. Tasks can depend on other tasks; **Start when unblocked**
launches an opted-in task as soon as its final blocker is marked done.

A misfiled task can be moved to another project from **Edit task**, keeping its description
and transcript. The move drops any blocked-by links it had, since dependencies can't span
projects.

A task that has already run can move too, but its git worktree can't come along — that
checkout was cut from the current project's repository. So moving one discards the worktree
and its branch, and the modal asks for that explicitly, after telling you what's in there:
a clean, merged worktree loses nothing, while uncommitted edits or commits your base branch
never took are named and need a second confirmation. Everything else follows the task — the
transcript, the summaries, the cost history and the sessions and merges recorded against the
old project — and the next turn cuts a fresh worktree from the new project's repository.
A task with a live turn is refused outright; stop it first.

A whole batch can go at once: tick the checkboxes in the task list (shift-click for a range,
the Suggested tray included) and use **Move to project…** in the selection bar. They move
under one transaction, and a blocked-by link whose *both* ends are in the selection survives
the trip — select a whole dependency chain and it arrives intact. Anything that can't move
is named in a report rather than quietly left behind. Bulk moves never discard worktrees:
each one is its own irreversible answer, so started tasks are reported and re-filed one at a
time from **Edit task**.

Agents can also suggest follow-up tasks while they work — into their own project, or into
any other one. When you spot work in a session that belongs to a different repo, the agent
looks up the project and files the suggestion straight into that tray, with that project's
default agent and settings. It has to name the project exactly (by name or id); an
unrecognized name is refused rather than filed in the wrong place. Blocked-by links still
can't span projects, so they have to point at tasks in whichever project the new task lands
in. Project recaps help restore your mental context when you return later.

Agents can read the board as well as add to it: they can list the tasks in a project, see
what each one is blocked by, and open any task in full — including the brief they were
started with. Changing a task is deliberately narrower. An agent can retitle, re-describe,
reprioritize or close **its own** task, and nothing else: no session can rearrange the board
around it, and cancelling stays your call. When an agent marks its own task done, anything
set to **Start when unblocked** behind it launches just as it would have from your click.

## Workspace tools

The integrated terminal provides a real shell for each project. Managed `dev`, `setup`, and
`test` services keep running after an agent turn or browser tab ends, with live logs and
stable per-project ports. Optional service hostnames can expose previews with private,
shared-link, or public visibility.

See [Managed services](SERVICES.md) for setup and security details.

## Transparent usage

Every task reports tokens and usage. The Insights dashboard breaks activity down by day,
project, and agent, while keeping Operator's background work separate from task usage.
Subscription users see an API-price equivalent for context—not a bill.

See [Insights and usage](INSIGHTS.md) for how to read the numbers.

## Agent connections

Claude Code and Codex are first-class agent drivers. Operator detects expired connections,
preserves queued follow-ups, and provides a reconnect action. Background jobs choose a
connected agent automatically, so a Claude-only or Codex-only installation works without
special configuration.

See [Supported agents](AGENTS.md) for capabilities and upstream limitations.
