# A landing task catching up the tasks it orphaned

Date: 2026-09-09

Third and last of the `base-rewrite-sync` tag, after
`2026-09-06-rewritten-base-branch-sync.md` (detection and the banner) and
`2026-09-08-rebase-onto-rewritten-base.md` (the rebase button). Both left this open in
their "deliberately not done": a task that rebases and force-pushes a branch other tasks are
based on should catch those tasks up as its last step.

## The gap the first two changes leave

The banner detects a rewrite correctly and the button fixes it. Neither one arrives.

`SyncBanner` mounts inside `SessionView`, which renders for the selected task only
(`app/shell/SessionView.tsx:56`). Nothing on the board or in the task list fetches
`/api/tasks/[id]/sync`. So a task orphaned by a landing sits on the board looking healthy, and
the warning waits until somebody happens to open it. In the incident that was four days and a
28-file conflict wall.

There is also nothing to hook. The rewrite reaches this box as a force-push an agent ran in a
scratch worktree, outside every path Calandria owns. No route, no lock and no event fires.

## What this change does

`report_base_rewrite`, an agent tool. The task that did the rewriting names the branch it
rewrote, and every other task still based on that branch is verified against the new tip and
flagged: a `base rewritten` chip on the board, and the exact `git rebase --onto` line written
into that task's transcript.

`lib/baseRewrite.ts` holds the whole policy. `tasks.base_rewritten_at` holds the flag.

## The three decisions

**Membership goes through `resolveBaseBranch`.** The sweep is every task in the caller's
project whose resolved base branch equals the rewritten one. Resolution already reads
`tasks.base_branch`, then the first tag with a non-empty `base_branch`, then `projects.branch`
(`lib/baseBranch.ts:60`), so a task that inherits the branch from its tag is included by
construction. That is the other way tasks end up sharing a base, and it needs no separate
query.

Four kinds of task are named and passed over instead of flagged: a terminal one has nothing
left to catch up, a suggestion has no checkout, an unstarted task cuts its worktree from
whatever the tip is when it launches, and a task with no recorded cut point has nothing to
replay from.

**Flag, never rebase.** The landing task does not touch a sibling's branch or worktree. Each
flagged task runs its own rebase from its own banner, under the guards the previous change
built: uncommitted work refused, an open pull request refused once and then acknowledged, a
stopped replay resolved in that task's own session.

Those guards are questions only the task's own owner can answer, and a sweep cannot answer them
in a batch. The acknowledgement in particular is a flag because there is exactly one pull
request per task; over N tasks one click would be consenting to N force-pushes on somebody
else's behalf. `move_task` already refuses that shape, demanding lists of ids and never a
boolean over a batch, and the reason is the same here.

Rewriting a sibling's history is also the one operation in this area with no undo that Calandria
owns. `abortWorktreeRebase` restores the pre-rebase tip only while the replay is paused; a
finished replay is finished. Doing that to a task the user has not looked at, from a session
they are not watching, is not a thing a last step should do.

**The caller's word is only the branch name.** Whether a given task was actually orphaned is
re-derived per task from git, with the same `merge-base --is-ancestor` test `worktreeSyncStatus`
uses (`baseShaRewritten`, `lib/git.ts`). A branch that moved forward normally flags nobody, and a
wrong or stale branch name flags nobody.

`cutPointOrphaned` asks both sides, and either one orphans the task. The local ref alone is not
enough: the incident's own shape is a force-push made from another checkout, so the local branch
still points at the pre-rewrite tip and `fetchBase` writes only the tracking ref. A local-only
test reports "not rewritten" in exactly the case the feature exists for. The remote alone is not
enough either, since a repository with no remote still has branches somebody can rebase. The
remote side is tested against the resolved tracking tip and never the ref name, because a branch
this box has never fetched has no tracking ref, and `merge-base --is-ancestor` exits the same way
for "no such ref" as for "not an ancestor".

The sweep's fetch is forced. The landing task's own work leaves the per-repo cooldown warm, and a
coalesced skip would read the very ref the rewrite replaced.

The sync banner's `baseRewritten` stays a local-ref question. It decides whether a merge would
reconcile two copies of the same work, and a merge merges the local ref. The chip answers the
wider one: has this task been left behind by a rewrite anywhere. The two can differ while the
local ref is stale, and the chip is the earlier signal, which is the point. The banner is not
silent in that window either: `baseRemote.diverged` already renders its own "resolve the branch in
your own checkout first" state for a non-default base.

## The flag

`tasks.base_rewritten_at`, ms epoch, 0 = nothing outstanding. It rides on `SELECT t.*` like
`agent_edited_at` and `unread_run_at` do, so the chip costs the board no extra query.

It is not "needs you". Nothing is waiting on an answer, and `needsYou` stays the union of a
parked ask and a red PR (`app/shell/format.ts`). This is the same posture `unread_run_at` takes:
a fact the user should see on the card, with its own resting state.

Nothing acknowledges it. `GET /api/tasks/[id]/sync` clears it the moment `cutPointOrphaned` reads
false, and `POST` clears it at the source on a clean rebase or a finished `rebase-continue`. So a
task that rebased, or that was retargeted onto another branch, drops the chip the first time
anybody looks. A flag that outlived the condition it describes would be worse than no flag.

The clear runs on the same predicate the flag was raised with, not on `status.baseRewritten`.
Clearing on the local-ref answer would drop a chip raised off a fetched-but-unmerged force-push
on its first read, which is the case the chip is most useful for.

## Deliberately not done

**Pushing, still.** The rebase each flagged task runs is local, and an open PR is left pointing
at the old commits with the `--force-with-lease` line printed. Unchanged from the previous
change.

**A board-level sync poll.** Fetching `/api/tasks/[id]/sync` per row would surface a rewrite
with no tool call at all, at the cost of a fetch, a merge-tree conflict prediction and a
remote comparison per task per render. The chip carries the same fact for the case that
produces it.

**Anything automatic.** There is no trigger to attach one to. If a later change gives Calandria
its own force-push path, the sweep is one call from wherever that lands.

## Verification

`tests/baseRewriteCatchUp.test.ts`, against real git repositories with a real `origin`:

- a sibling flagged after a real rebase and force-push, with its branch tip proven unmoved and
  the rebase command in its transcript;
- a task that inherits the base from its tag's `base_branch` found by the sweep;
- the incident's own shape, where nobody fetched and the local ref still points at the
  pre-rewrite tip, flagged off the tracking ref and left flagged through a sync read whose own
  local-only `baseRewritten` says false;
- a base that only moved forward flagging nobody, the regression guard against the sweep
  trusting the branch name it was handed;
- a task on another base, a terminal one and an unstarted one each passed over, and named;
- the flag cleared by the next sync read once the cut point is reachable again, and not before;
- the tool defaulting to the caller's own base branch, and reporting plainly when no other task
  shares the branch.
