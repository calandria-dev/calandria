# Sync against a base branch whose history was rewritten

Date: 2026-09-06

## The incident

Task `ASIt_D2PMuVZ3jW23pIGH` ("Land integration/code-deslop on main") was cut from
`integration/code-deslop` at `09bec28`. Its instructions told it to do the rebase in a
separate scratch worktree rather than in its own, so the rebase onto main happened outside
Calandria and the result was force-pushed to `origin/integration/code-deslop`, ending at
`8bc8467`.

The task's own worktree stayed pinned at `09bec28`. Calandria never reported that the branch
underneath it had been replaced. A hand-run `git merge integration/code-deslop` in that
worktree then conflicted in 28 files, because merging a rebased branch against its own
pre-rebase ancestor reconciles two copies of the same work under different SHAs. A
`git rebase --onto` would have replayed the same commits cleanly.

## What Calandria did

`worktreeSyncStatus` (`lib/git.ts`) compares the task's work branch against the **local** base
branch, with two one-sided `git rev-list --count` calls. It never consults the remote, and
before this change it had no way to express a rewrite. Two distinct failure shapes follow, both
reproduced and measured in `tests/syncRewrittenBase.test.ts`.

### Shape 1: the local base ref never moved (the incident)

Nobody fetched or advanced the local `integration/code-deslop`, so it still pointed at the
pre-rewrite tip. Measured status:

```
{"behind":0,"ahead":0,"isDirty":false,"canFastForward":false,"clean":true,"conflicts":[]}
```

Every number is zero. `SyncBanner` renders nothing at all for a zero `behind`, so the task
looked healthy. The information existed: `remoteBaseStatus(repo, "integration")` reported
`{"behind":2,"ahead":1,"diverged":true}` for the same branch at the same moment. Nothing asked
it, because the remote comparison was wired only to the project default branch
(`app/api/projects/[id]/base-branch/route.ts` passes `project.branch`, and `BaseBranchBanner` is
mounted once per project). A task based on an integration branch or a tag's `base_branch` had
nothing watching origin for it.

A second contributor: `fetchBase` coalesces on a per-repo, per-branch cooldown. The fetch that
would have revealed the rewrite is skipped whenever a recent one already ran.

### Shape 2: the local base ref does catch up

Once the local ref is force-updated to the rewritten tip, the same call reports:

```
{"behind":2,"ahead":1,"clean":false,"conflicts":["shared.txt"]}
```

`fastForwardWorktree` returns `false`. The banner reads this as ordinary divergence and renders
"integration moved on: 2 ahead of this task, conflicts in 1 files" with a **Fix with AI**
button. That button runs `prepareWorktreeMerge`, which is exactly the merge that produced the
28-file conflict wall. Calandria would have driven the user into the same outcome through the
UI.

The ahead/behind pair cannot distinguish a rewrite from ordinary divergence. Both read as
"behind N, ahead M". The remedies differ: one is a merge, the other is a rebase.

## What this change does

Detection and warning only. No automated history rewriting.

**Rewrite detection.** `SyncStatus` gains `baseRewritten`. `worktreeSyncStatus` takes the task's
`base_sha` and tests whether it is still reachable from the base tip with
`git merge-base --is-ancestor`. This is the test that separates the two cases: forward movement
keeps the old tip an ancestor, a rebase or an amend does not. The SHA is verified with
`rev-parse --verify` first, because `--is-ancestor` exits 1 for "not an ancestor" and 128 for
"not a valid object", and a garbage-collected cut point must not read as a rewrite.

**Per-task remote comparison.** `GET /api/tasks/[id]/sync` now runs `fetchBase` plus
`remoteBaseStatus` against the task's own resolved base branch and returns a `baseRemote` block.
This is what catches shape 1, where the local ref is the stale thing.

**A banner that stops the merge.** `SyncBanner` renders a new state above the ordinary tiers,
before the early return that hides a zero `behind`. A rewrite always shows. A merely diverged
base shows only when it is not the project default, since `BaseBranchBanner` already reports
that case above the task list. The rewrite variant names the command that replays cleanly:

```
git rebase --onto <base> <base_sha> <work_branch>
```

It offers no one-click action. There is no safe generic one, for the reasons below.

## Deliberately not done

Both were filed as follow-up tasks and both are now done. The first is
`2026-09-08-rebase-onto-rewritten-base.md`; what it decided about each of the four hazards below
is recorded there.

**An automated rebase button.** Rewriting a task branch's history under the user is not a
drive-by change. It has to decide what happens to uncommitted work in the worktree, to a branch
that has already been pushed and has an open PR, and to a rebase that stops on a conflict
partway through. It also needs an abort path that restores the pre-rebase tip. That is its own
task with its own tests.

**Making the landing-task pattern update its originating task.** A task that rebases and
force-pushes a branch other tasks are based on should catch those tasks up as its last step,
instead of leaving them to rot. That is a change to the landing workflow and to what a task may
do to a sibling task's worktree, not to the sync path. Done in
`2026-09-09-landing-task-catch-up.md`, as a flag rather than a sweep of rebases; that spec says
why.

## Verification

`tests/syncRewrittenBase.test.ts` covers four cases against real git repositories:

- the local ref never moved, so every count is zero while `remoteBaseStatus` reports `diverged`;
- the same case with `base_sha` supplied still reports `baseRewritten: false`, documenting that
  the remote comparison is what catches it;
- the local ref caught up, so `baseRewritten` is `true` alongside `behind: 2, ahead: 1`;
- an ordinary forward-moving base reports `baseRewritten: false` with `behind > 0`, the
  regression guard against the flag firing on normal movement.
