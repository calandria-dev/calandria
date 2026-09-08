# Rebasing a task onto a base branch that was rewritten under it

Date: 2026-09-08

Follows `2026-09-06-rewritten-base-branch-sync.md`, which added the detection and the banner
and left the button as its own task. This is that button.

## The operation

`POST /api/tasks/[id]/sync` gains three actions alongside its existing sync tier, all under the
same `withTaskLock` the sync runs under:

| Action | What it does |
|-|-|
| `rebase` | `git rebase --onto <base tip> <base_sha> <work branch>` in the task's worktree, then advances `tasks.base_sha` to the tip it replayed onto |
| `rebase-continue` | Stages the resolution and drives `git rebase --continue` to a conclusion |
| `rebase-abort` | `git rebase --abort`, restoring the pre-rebase tip |

A bodyless POST still means the ordinary Sync click, which is what every caller before this
change sent.

`base_sha` is the cut point, so `base_sha..work_branch` is exactly the task's own work.
Rebasing the branch against the base by name instead would replay the pre-rewrite copies of the
base's own commits along with it, which is the same reconciliation the merge was doing.

The primitives are `rebaseWorktreeOntoBase`, `continueWorktreeRebase`, `abortWorktreeRebase` and
`worktreeRebaseStatus` in `lib/git.ts`. `SyncStatus` gains `rebaseInProgress`, and
`worktreeSyncStatus` reports it before it reads the ahead/behind counts for anything, because a
stopped replay makes those counts describe a moment that no longer applies: the branch ref still
points at the pre-rebase tip while HEAD is detached partway through.

## The four decisions

**Uncommitted work is refused.** `prepareWorktreeMerge` commits pending edits first and this
does not, which looks inconsistent and is not. A merge's pre-commit is recoverable: whatever the
merge then does, the commit stays on the branch at a SHA the reflog can find. A rebase replays
what it finds committed, so the same move would rewrite work the user has never looked at into
new commits under new SHAs. Committing on someone's behalf is cheap. Rewriting on their behalf
is not.

**An open pull request refuses once, then goes ahead on an acknowledgement.** A rebase makes the
branch non-fast-forward against its remote, so the PR's head can only be updated by a force
push. Three options were on the table:

- Refuse outright. Rejected: a task with an open PR based on an integration branch that a
  landing task rebased is the incident's own shape, so refusing there is refusing in the case
  the feature exists for.
- Force-push it. Rejected: nothing in `lib/git.ts` force-pushes today, `pushBaseBranch` is
  documented as deliberately non-force, and a first force push belongs in a change whose subject
  is publishing, not one whose subject is local history.
- Warn behind a gate. Taken. `POST` with `action: "rebase"` returns 409 and `prOpen: true` when
  `tasks.pr_state` is `open`; the banner's button becomes "Rebase anyway" and the second click
  sends `acknowledgePr: true`. The rebase then runs locally and the response carries
  `forcePushNeeded` plus the exact `git push --force-with-lease` line, which the banner shows.
  Calandria still never pushes.

The acknowledgement is a flag rather than the list of ids `move_task` demands, because there is
exactly one pull request per task, so one answer cannot stand in for several.

**A stopped replay uses the paused-merge shape.** Conflict markers are left in the worktree, the
file list and a resolution prompt come back on the response, and the banner escalates to a
resolution turn exactly as the merge tier does. It is a separate `rebaseInProgress` flag rather
than a reuse of `mergeInProgress` because the two finish through different commands: a banner
offering `merge --continue` over a stopped rebase would be offering something that cannot work.
While one is paused it owns the checkout, and the ordinary sync tier is refused with 409 and
`rebaseInProgress: true`, since merging on top would commit a half-replayed tree full of
markers.

The resolution prompt is `buildRebaseConflictPrompt`, not the merge one. Every sentence of the
merge prompt that mentions git is wrong here: nothing was merged into this branch, the conflict
is against one replayed commit rather than the whole branch, and the sides are reversed, since
"ours" during a rebase is the base being replayed onto.

**The pre-rebase tip is captured before anything moves**, in a worktree-scoped
`refs/worktree/calandria-rebase-abort`, the same device `prepareWorktreeMerge` uses.
`git rebase --abort` normally does the restoring and is preferred, because it puts the branch
tip and the working tree back together; the recorded ref is what makes that restore verifiable
and what a forced abort (`rebase --quit` plus `reset --hard`) uses when git's own state
directory is unusable. With no rebase paused, `abortWorktreeRebase` clears a stale marker and is
a no-op: once the replay has finished, later commits sit on top of it, and resetting to a
pre-rebase tip that no longer describes a paused operation is data loss with a reassuring name.

## Deliberately not done

**Pushing.** The rebase is local. An open PR is left pointing at the old commits with the
command that fixes it printed, which is the same posture the detection change took.

**Catching up sibling tasks.** A landing task that rebases and force-pushes a branch other tasks
are based on should catch those tasks up as its last step. That is the second task under the
`base-rewrite-sync` tag.

## Verification

`tests/syncRewrittenBase.test.ts`, extended against real git repositories:

- the clean case, where the replay lands the task's own commits on the rewritten tip while the
  merge in the same fixture conflicts in `shared.txt`, and `baseRewritten` goes false afterwards;
- uncommitted work refused, with the branch tip unmoved and nothing committed;
- an open PR refused once and rebased on the acknowledgement, with `git ls-remote` proving
  nothing was pushed;
- a stopped replay reported by `worktreeSyncStatus`, blocking the sync tier, refusing to
  continue while markers remain, and finishing once resolved;
- an abort restoring the pre-rebase tip exactly, and a second abort as a no-op;
- a missing cut point refused rather than replayed against the branch name.
