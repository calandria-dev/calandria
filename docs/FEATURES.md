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

Typing `/` in the composer opens the command menu. It lists the commands the task's own
agent would actually expand — your skills, plugin commands, and the `.claude/commands` in
the checked-out repo — discovered from the agent itself rather than from a list Operator
maintains, so a command you install shows up without an Operator release. Arrow keys move
the highlight, Enter or Tab completes it, and a command typed in full sends as usual.
Operator's own `/clear` heads the list; the agent's same-named command is hidden so one
name can't mean two things, as are the run-control commands (`/model`, `/effort`, `/fast`)
that the task's own pickers own.

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
is named in a report rather than quietly left behind. Started tasks can come along, but one
answer at a time: each row that holds a worktree gets its own checkbox, off until you tick
it, with what that particular checkout holds beside it — clean and merged, or the uncommitted
edits and unmerged commits it would destroy, in red. Ticking none is a plain move. Three
worktrees holding unsaved work in a selection of eleven don't refuse the other eight; the
three are reported and stay where they are, checkouts untouched.

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
reprioritize or close **its own** task, and beyond that only a suggestion still sitting
unreviewed in a Suggested tray — in any project — so a planning turn can go back and sharpen
the roadmap it just filed. Anything you've accepted, or another session has started, is
refused: no session rearranges the board around it, and cancelling stays your call.

Sharpening a suggestion includes **ordering** it. A plan whose steps have to happen in
sequence is half a plan until the sequence is written down, so an agent asked to break work
down files the tasks first, then goes back and sets what each one is blocked by — the same
links you'd tick in the edit dialog, arriving already drawn. It can only do that to
suggestions still sitting in a tray, it can't chain a task to one in another project, and it
can't mark its own running task as blocked by anything (blockers decide whether a task may
*start*, and that one already has).

An agent that decides one of its own suggestions was redundant can **withdraw** it, and has
to say why. The card stays in your tray, struck through with the reason underneath and
sorted below the live suggestions — a recommendation to drop it, not a deletion. **Restore**
puts it back (clearing the strike-through and the note), **Start** runs it anyway, and the ✕
dismisses it for good, exactly as before. Withdrawing is the only way an agent can retract
work it proposed; it can't cancel or delete anything.

Reviewing a suggestion is a decision made on its brief, so the tray lets you read the whole
thing: each row has a **disclosure triangle** that unclamps the one-line summary (click the
brief itself, too — it's the same toggle). A withdrawn row expands to show what was proposed
underneath why it was pulled, which the struck-through row otherwise replaces entirely.
Expanding is per-reading, not a saved preference — nothing stays open across a project
switch. The ✎ opens the full **Edit task** dialog, and the tray's own verbs are in its footer:
**Save** keeps the sharpened brief in the tray, **Add** accepts it into the task list, and
**Add & start** does that and launches the first session — one write, so an edit and the
decision it led to can't half-apply. An already-added task that hasn't started yet gets
**Save & start** in the same place. Start is greyed out, with the reason, while a blocker is
unfinished or the task's agent isn't connected.

When a task stops blocking — you mark it done, you cancel it, or an agent withdraws it —
anything set to **Start when unblocked** behind it launches just as it would have from your
click. Cancelling counts because a cancelled task will never finish: waiting on one would
leave the task behind it blocked forever.

## Runbooks

Plenty of work isn't one-off. "We have a lot of unpushed changes — push them and babysit the
CI/CD." "Sweep my Jiras, IMs and email and report." The brief is the same every time, and
before runbooks the only way to run one was to retype it.

A **runbook** is a saved task-launch preset: a name, a one-line description, the prompt its
first turn sends, and the agent, permission mode, priority and context setting to run it
under. It lives on the project landing pane, above **Schedules** — click the project's name
at the top of the task list to get there. Pressing **Run** mints a **fresh task**, exactly as
a schedule firing does, and launches its first turn.

That shared machinery is not a coincidence: a runbook is a schedule with the clock taken off.
Both go through one dispatch path, so a recipe behaves identically whether a person pressed
the button or the ticker did. The one deliberate difference is that a runbook dispatch is
**attended** — you're standing there — so its turn may legitimately stop and ask you a
permission question, where a scheduled run declines automatically because nobody is around
to answer.

**Instructions for this run** is the one field that changes per dispatch: an optional box
appended to the saved prompt. It covers "…and focus on CEAP-1234" without turning the prompt
into a template language with variables, defaults, escaping and validation — and without
raising the question of what a *schedule* would fill those variables in with. If the recipe
is a slash command, the extra text becomes part of that command's arguments.

Everything else is decided when you save the runbook, and **copied onto the task at dispatch
time** rather than read back later. The task is the record of what actually ran; editing the
recipe tomorrow must not rewrite the history of what happened today.

**There is no run history of its own.** A schedule needs one because its defining failure is
silently *not happening* at 08:30 with nobody watching — an occurrence that never fired leaves
no other trace. A dispatch produces a visible task immediately, in the tray you're already
looking at, so "last run" is just a link to the most recent task the runbook created.

Other things the card does:

- **Copy to…** duplicates a recipe into another project as an independent row. Not a shared
  reference: projects have different repos, different agents connected and different command
  registries, so a link would quietly mean something else at the far end.
- The **prompt is validated** against the project's real slash-command registry before you
  save, with one-click suggestions — the same check the schedules editor runs, for the same
  reason (see the slash-command gotcha below). It never blocks saving.
- **⌘K** offers every runbook in the current project as its own row (`Run: Push & babysit
  CI`), dispatching immediately rather than opening the sheet. The palette is behind the
  `omniSearch` feature flag, which ships **off** — set `ORCH_FEATURE_OMNI_SEARCH=1` to
  enable it. The card works either way.

### Schedules that fire a runbook

"The morning sweep" is one procedure, so keeping it in step in two places is how the two
quietly diverge. A schedule can therefore point at a runbook and take its prompt and config
from that row at fire time.

The cost is that unattended automation now reads from something you can edit, so the app says
so rather than hiding it: the schedule editor names the runbook and warns that editing it
changes what fires there, and the runbook's row lists the schedules it feeds.

**Deleting a linked runbook does not break the schedule.** The recipe is copied back into the
schedule's own columns in the same transaction as the delete, so it keeps firing exactly what
it fired yesterday and the whole prompt is visible in its editor again. Simply clearing the
link would leave a schedule with an empty prompt firing nothing every morning — the precise
silent failure the schedules design exists to rule out. A link across projects is refused
outright, at save time and again at fire time, because a runbook is written against one
repo's commands.

### Agents can write runbooks

An agent that has just worked out a procedure with you can save it: `create_runbook`,
`list_runbooks` and `update_runbook` are available to every task session. An
agent-created recipe is tagged on the card with which agent filed it, and — like any other
runbook — sits inert until you dispatch it, so there's no review tray to clear.

Two things an agent deliberately cannot do:

- **Delete a runbook.** Delete is hard delete with no undo throughout Operator, and retiring
  a recipe is your call.
- **Edit a runbook that a schedule fires.** That would silently change work which runs
  unattended. The refusal names the schedules involved, so the agent can tell you what it
  would have changed and let you decide — or save a new recipe instead.

## Scheduled tasks

A schedule is a saved prompt plus a recurring day/time, owned by the project it lives in —
found on the project landing pane, under **Schedules**. Click the project's name at the top
of the task list to get there from anywhere.
Unlike everything else in Operator, a schedule's firing needs no browser tab open: it's the
app's only server-owned periodic work, driven by a ticker in the server process itself, not a
timer in your browser.

Each firing **mints a fresh task** — its own transcript, worktree, and turn — rather than
reusing one across occurrences, so every run is reviewable exactly like a task you started by
hand, and a bad run never contaminates the next one's context.

**Timezone** is picked explicitly (defaulting to your browser's), not inferred from the
server, because the server may run in a different zone (a container on UTC, a user on
Pacific) than the person who set the schedule up. The time is wall-clock, so "08:30" keeps
meaning 08:30 across a Daylight Saving transition — the underlying instant moves by an hour
twice a year so the wall time doesn't. The editor previews the next three occurrences as you
set the days, time and timezone, specifically so a mistake in any of them is visible while
you're still looking at the form, not the following Monday.

**Catching up**: if the app was asleep or down when a firing was due (the machine slept, the
container restarted), the next tick runs the most recent missed slot once, marked `catch_up`
— useful for a morning run discovered at noon, not one that starts at 6pm. Anything older
than that window is recorded `missed` rather than skipped silently, so a quiet schedule shows
*why* it's quiet instead of just going dark. **Overlap** is handled the same way: if the
previous firing's turn is still running when the next one comes due, the new slot is recorded
`skipped_overlap` rather than piling a second turn on top of the first.

**Permission mode is a required, explicit choice** — not inherited from some other default —
because a scheduled run cannot answer a permission prompt: nobody is there. Anything other
than **Auto-run** still declines every prompt automatically rather than parking, which means
the turn can stop early with the job half done. Auto-run is the only mode that runs a
schedule all the way through unattended; pick it deliberately, not by default.

When that happens the run is recorded as **failed**, not as a quiet green "ran", and says so:
*the agent needed approval and nobody was watching*. A half-done job reported as a success is
the exact failure this feature exists to prevent. The same applies to a question — if the
agent asks one mid-run, it's declined immediately with the question preserved in the
transcript, rather than parking the run forever waiting on an answer that isn't coming.

The card also watches **the ticker itself**. If the scheduler isn't running, or its sweeps
stop completing (a wedged check hangs every schedule on the instance at once), a banner says
so instead of showing you a confident next-run time that will never arrive.

**The slash-command gotcha**: a prompt like `/jira-tasks` is expanded by the CLI before the
model ever sees it, which is what makes it suitable for unattended work — but an unrecognized
command is not an error. The CLI answers "Unknown command: /x" as a *success*, with no tool
calls, so a typo'd schedule would report green every morning having quietly done nothing. The
editor checks the prompt against the project's real command registry before you save and
shows the failure with one-click suggestions; the same check runs again when the schedule
fires, where an unknown command records the run as **failed** and creates no task, because a
plugin can be uninstalled or renamed between the two. A prompt that merely *starts* with a
filesystem path is not a command at all — `/etc/passwd, tell me what's in it` is an ordinary
prompt about a file, and a token followed by `/` is read as a path. The check reads the same
command list the composer's `/` menu offers, so the two can't disagree — and it only ever
*refuses* on a freshly read list, never a cached one, so a command you installed a minute ago
isn't rejected for being new. Two things it declines to judge rather than get wrong: an MCP
server's `/mcp__server__prompt` (those names aren't in the list it can read without spawning
your whole server fleet) and any prompt it couldn't check at all — both save with a note, and
run.

Save is never blocked on the check, because the check is a typo catcher and not an authority:
it reads one session's command list, so a conditionally-registered command can read as
unknown. If it *is* right, the run fails loudly rather than reporting a success it didn't earn.

## Workspace tools

The integrated terminal provides a real shell for each project. It opens in the project's
working directory; a Project/Task toggle in its bar switches the shell into the selected
task's git worktree, so you can run tests or poke at a task's changes before merging.
Managed `dev`, `setup`, and `test` services keep running after an agent turn or browser tab
ends, with live logs and stable per-project ports. Optional service hostnames can expose
previews with private, shared-link, or public visibility.

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
