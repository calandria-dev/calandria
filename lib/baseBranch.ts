// Which branch a task is based on, and how to change it.
//
// A project has one DEFAULT base branch (`projects.branch`), but a task may name
// its own (`tasks.base_branch`) — the branch it was cut from, the branch Sync
// catches it up to, and the branch Merge lands it into. That is what lets five
// tasks land on `feature/auth` while three others keep shipping to `main`,
// without splitting the board into two projects pointed at one repo.
// Design: docs/superpowers/specs/2026-08-27-per-task-base-branch-design.md.
//
// Two rules make the rest of the app simple:
//
//   1. Every call site that used to write `project.branch` writes
//      `resolveBaseBranch(task, project)`. The git layer never learns about any
//      of this — it already takes `baseBranch` as a plain string parameter.
//   2. Inheritance stops AT THE WORKTREE CUT. `ensureWorktree` reports the base
//      it actually used and the launch paths pin it into `tasks.base_branch`.
//      Resolving live forever is one line shorter and quietly wrong: a default
//      changed underneath a started task would move its merge target while its
//      `base_sha` still pointed at a commit on the branch it really forked from,
//      so the diff would be computed against one branch and landed on another.
//
// Pinned SDK-free by tests/importGraph.test.ts: this sits behind the task
// routes, and (from phase 3) behind the agent-tool bridge.

import { hasTurn } from "./abort";
import { publishGlobal } from "./events";
import {
  baseStartPoint,
  commitsSinceCut,
  ensureLocalBaseBranch,
  mergeBaseSha,
  refNameSafe,
  resetWorktreeTo,
  worktreeForBranch,
  worktreeIsDirty,
  worktreeMergeStatus,
  worktreeSyncStatus,
} from "./git";
import { getTask, updateTask } from "./store";
import type { Project, Task } from "./types";

/**
 * The branch this task is actually based on: its own if it has one, else the
 * project's default.
 *
 * The middle leg of the chain — a tag's default base — arrives in phase 2 of the
 * build order and slots in here, between the task and the project. Its SQL twin
 * is the COALESCE in `listReclaimableWorktrees` (lib/store.ts), which has no
 * Task in hand; the two orders must stay identical and tests/baseBranch.test.ts
 * asserts that they do.
 */
export function resolveBaseBranch(task: Pick<Task, "base_branch">, project: Pick<Project, "branch">): string {
  return task.base_branch || project.branch;
}

/** Whether this task has a base of its own rather than following the project. */
export function hasOwnBase(task: Pick<Task, "base_branch">, project: Pick<Project, "branch">): boolean {
  return !!task.base_branch && task.base_branch !== project.branch;
}

export interface RetargetResult {
  ok: boolean;
  /** Why it was refused — phrased to be shown to a user AND read by a model. */
  error?: string;
  /** The branch now in force. */
  baseBranch?: string;
  /** Set when the local branch didn't exist and was created here, e.g. "origin/feature/auth". */
  createdFrom?: string;
  /** The worktree was re-cut from the new base (nothing of the task's own to lose). */
  recut?: boolean;
  /** Commits of the new base this task hasn't got. 0 after a re-cut. */
  behind?: number;
  /** One line for the user, and the agent tool's return value. */
  message?: string;
}

const refuse = (error: string): RetargetResult => ({ ok: false, error });

/**
 * Point a task at a different base branch, reconciling whatever already exists.
 *
 * ONE function behind the route and (phase 3) the `set_base_branch` agent tool,
 * because the two would otherwise drift: this is asynchronous, touches git, can
 * create a local ref, can `reset --hard` a worktree and can fail halfway —
 * none of which belongs in `update_task`'s synchronous, atomic field-writer.
 *
 * Nothing is ever rewritten. A task that has already made commits keeps every
 * one of them; it is simply told how far behind the new base it now is, and the
 * existing Sync banner does the rest.
 *
 * `callerTaskId` is the session making the call (phase 3): a task may retarget
 * ITSELF mid-turn, which is the whole point of the tool, but not some other
 * task whose turn is live — mirroring `updateTaskForAgent`.
 */
export async function retargetTaskBase(
  task: Task,
  project: Project,
  branch: string,
  opts: { callerTaskId?: string } = {}
): Promise<RetargetResult> {
  const want = branch.trim();
  const repo = project.repo_path.trim();
  const current = resolveBaseBranch(task, project);

  // 1. Name. Before any git runs, so an unusable name is refused BY NAME rather
  //    than through whatever the first subprocess happens to say.
  if (!refNameSafe(want)) return refuse(`"${want || "(empty)"}" isn't a usable git branch name.`);
  if (!repo) return refuse(`${project.name} has no working directory, so there is no branch to be based on.`);

  // 2. Self. A task cannot be based on the branch its own work is on — the diff
  //    and the merge would both be against itself. Checked before the existence
  //    step below so this never mints a local ref on its way to a refusal.
  if (want === task.work_branch)
    return refuse(`${want} is this task's own work branch — a task can't be based on the branch its commits are on.`);

  // 3. Liveness. Re-read rather than trusting the caller's snapshot: a detached
  //    turn's copy of the row outlives a lot, and a retarget that resets a
  //    worktree out from under a running session is the one thing this must not
  //    do. `hasTurn` catches the window before `running` is persisted.
  const fresh = getTask(task.id);
  if (!fresh) return refuse("that task no longer exists.");
  if ((fresh.running === 1 || hasTurn(fresh.id)) && fresh.id !== opts.callerTaskId)
    return refuse(`${fresh.title} has a turn running — wait for the session to finish before changing its base branch.`);

  // 4. Merge in flight. The paused resolution merge in the worktree is against
  //    the OLD base; retargeting under it would land a merge nobody asked for.
  if (fresh.worktree_path) {
    const paused = await worktreeMergeStatus(fresh.worktree_path).catch(() => ({ mergeInProgress: false, unresolved: [] }));
    if (paused.mergeInProgress)
      return refuse(
        `a merge of ${current} is paused in this task's worktree — accept or discard it first, or the retarget would land a merge nobody asked for.`
      );
  }

  // 5. Existence. Local wins; otherwise the remote, where the branch a colleague
  //    just pushed lives. Refusing a branch the user can plainly see on GitHub is
  //    the failure mode this step exists to avoid, so a miss names both places.
  const found = await ensureLocalBaseBranch(repo, want);
  if (found.found === "missing")
    return refuse(
      found.remoteLabel
        ? `${want} isn't a branch here — not locally, and not on ${found.remoteLabel}. Push it or check the spelling.`
        : `${want} isn't a branch in this repository, and it has no remote to look on.`
    );

  // 6. Occupancy. Merging lands by moving the target branch's ref, so a branch
  //    some other worktree has checked out would have its HEAD moved while that
  //    worktree's files and index stayed put — the session in there would see
  //    the whole merge as uncommitted deletions with no way to know why. This is
  //    what blocks basing on another task's calandria/… branch, and it says so.
  const holder = await worktreeForBranch(repo, want);
  if (holder && !holder.isMain)
    return refuse(
      `${want} is checked out in ${holder.path}. Merging moves that branch, which would leave the session working in there describing a commit it no longer points at — pick a branch nothing has open.`
    );

  const created = found.found === "created" ? found.label : undefined;

  // 7. Write + reconcile. Three cases, in increasing order of what exists.
  //
  //    No worktree yet — nothing to reconcile. The cut hasn't happened, so the
  //    row is the whole state and the first turn will branch from here.
  if (!fresh.worktree_path || !fresh.work_branch) {
    updateTask(fresh.id, { base_branch: want });
    publishGlobal(fresh.id, { type: "task_edited" });
    return {
      ok: true, baseBranch: want, createdFrom: created, behind: 0,
      message: `Now based on ${want}. Its worktree is cut from that branch on the first turn.${createdNote(created)}`,
    };
  }

  //    A worktree with nothing of the task's own in it — no commits since the
  //    cut, clean tree. Re-cut rather than renumber: nothing can be lost, and
  //    the task ends up UP TO DATE with its new base instead of merely pointed
  //    at it. `commitsSinceCut` returning null means "couldn't tell", which is
  //    read as "assume there is work" — this gates a reset --hard.
  const ahead = await commitsSinceCut(fresh.worktree_path, fresh.base_sha);
  const dirty = await worktreeIsDirty(fresh.worktree_path);
  if (ahead === 0 && !dirty) {
    const start = await baseStartPoint(repo, want);
    if (start && (await resetWorktreeTo(fresh.worktree_path, start))) {
      updateTask(fresh.id, { base_branch: want, base_sha: start });
      publishGlobal(fresh.id, { type: "task_edited" });
      return {
        ok: true, baseBranch: want, createdFrom: created, recut: true, behind: 0,
        message: `Now based on ${want} — the worktree had nothing of its own, so it was re-cut from that branch and is up to date.${createdNote(created)}`,
      };
    }
    // The reset didn't take (a git hiccup, a locked index). Fall through to the
    // ordinary path rather than reporting a re-cut that didn't happen.
  }

  //    A worktree with work in it. Nothing is rewritten: the base_sha becomes
  //    the merge-base of the new base and the work branch, which is the honest
  //    answer to "what would arrive in that branch if I merged now" — a task cut
  //    from main really would carry main's newer commits into feature/auth, and
  //    one Sync collapses the diff back to the task's own work. Leaving base_sha
  //    alone instead would keep a snapshot on neither branch's line and quietly
  //    under-report after that sync.
  const forked = await mergeBaseSha(repo, want, fresh.work_branch);
  updateTask(fresh.id, { base_branch: want, ...(forked ? { base_sha: forked } : {}) });
  publishGlobal(fresh.id, { type: "task_edited" });

  const st = await worktreeSyncStatus({
    repoPath: repo,
    worktreePath: fresh.worktree_path,
    workBranch: fresh.work_branch,
    baseBranch: want,
  }).catch(() => null);
  const behind = st?.behind ?? 0;
  return {
    ok: true, baseBranch: want, createdFrom: created, recut: false, behind,
    message:
      behind > 0
        ? `Now based on ${want} (${behind} commit${behind === 1 ? "" : "s"} behind — sync to catch up).${createdNote(created)}`
        : `Now based on ${want}.${createdNote(created)}`,
  };
}

const createdNote = (label?: string) => (label ? ` Created the local branch from ${label}.` : "");
