// Landed -> reclaimed: turns "this task's work is in the base branch" into
// "this checkout is disposable". A local merge (`merged_at`) or a merged PR
// (`pr_state = "merged"`) triggers it, and landedVia() is where the two meet.
//
// A reclaim fast-forwards the local base branch from origin, removes the
// worktree, deletes the local branch (the remote one goes with the merge),
// and marks the task done. It must never discard unpushed or uncommitted
// work: worktreePruneSafety() gates every reclaim, read per landing since a
// squash merge leaves a branch permanently ahead of its base with no real
// unmerged commits. It must not bump `updated_at` except on the status
// write, so an automatic reclaim can't float a stale task to the top of Done.

import fs from "node:fs";
import { clearTaskWorktreePath, getProject, getTask, updateTask } from "@/lib/store";
import {
  advanceBaseBranch,
  fetchBase,
  remoteBaseStatus,
  removeWorktree,
  unpushedCommits,
  worktreeDiskUsage,
  worktreePruneSafety,
} from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { UNSAFE_DISCARD_REASON } from "@/lib/taskMove";
import { withTaskLock } from "@/lib/taskLock";
import { withRepoLock } from "@/lib/repoLock";
import { hasTurn } from "@/lib/abort";
import { publishGlobal } from "@/lib/events";
import { heldHandleHint } from "@/lib/paths";
import type { Task } from "@/lib/types";

/** How a task's work reached the base branch. */
export type Landing = "pr" | "merge";

/**
 * Has this task's work landed, and by which route?
 *
 * GitHub's verdict wins when both are true. A merged PR is the better-informed
 * of the two answers: it accounts for a squash the local repo cannot see, and
 * its safety reading below is the correct one for that case.
 */
export function landedVia(task: Task): Landing | null {
  if (task.pr_state === "merged") return "pr";
  if (task.merged_at > 0) return "merge";
  return null;
}

/** What the reclaim would cost, so a button can say it before it is pressed. */
export interface ReclaimPreview {
  landing: Landing | null;
  hasWorktree: boolean;
  branch: string;
  baseBranch: string;
  bytes: number;
  running: boolean;
  /** Removing this checkout would destroy work; the acknowledgement is required. */
  unsafe: boolean;
  unsafeReason: string | null;
}

export interface ReclaimResult {
  ok: boolean;
  /** Why it refused. */
  reason?: string;
  /** The refusal was the safety gate; `discardUnsafe` would get past it. */
  unsafe?: boolean;
  landing?: Landing;
  /** Disk freed by removing the checkout. */
  bytes?: number;
  /** The local base branch was fast-forwarded to the remote's tip. */
  baseAdvanced?: boolean;
  baseBranch?: string;
  /** Why the base branch could not be caught up. Never fatal; see catchUpBase. */
  baseError?: string;
  worktreeRemoved?: boolean;
  branchDeleted?: boolean;
  /** The task was moved to done by this reclaim (it wasn't terminal before). */
  markedDone?: boolean;
}

const TERMINAL = new Set(["done", "cancelled"]);

/**
 * Catch the local base branch up with its remote, best-effort.
 *
 * The first step of the tail, and the only one whose failure is not a reason
 * to stop: a repo with no remote, no network, or a dead credential should
 * still have its checkout reclaimed. Strictly forward-only, like every other
 * base move in the app: advanceBaseBranch refuses a base branch holding
 * commits of its own, and that refusal is reported, not worked around.
 */
async function catchUpBase(repoPath: string, baseBranch: string): Promise<{ advanced: boolean; error?: string }> {
  // Forced past the fetch cooldown: this runs because something just landed,
  // and the tracking ref a launch-time fetch left behind is older than that by
  // definition. Without it, the ordinary case (a task cut minutes ago, its PR
  // merged, reclaim clicked) reads a stale origin and skips step one.
  const fetched = await fetchBase(repoPath, baseBranch, { force: true });
  if (!fetched.attempted) return { advanced: false };
  const status = await remoteBaseStatus(repoPath, baseBranch);
  // No local ref to move; advanceBaseBranch would refuse this in the same words.
  if (status.baseMissing) return { advanced: false, error: `base branch ${baseBranch} not found in this repository` };
  if (status.unknown) return { advanced: false, error: `could not compare ${baseBranch} with ${status.label}` };
  if (!status.canFastForward) return { advanced: false, ...(status.diverged ? { error: `${baseBranch} has diverged from ${status.label}` } : {}) };
  const moved = await advanceBaseBranch(repoPath, baseBranch, status.remoteTip);
  return moved.ok ? { advanced: true } : { advanced: false, error: moved.error };
}

/**
 * Which part of worktreePruneSafety()'s verdict actually blocks THIS landing,
 * as a reason string, or null when nothing does. See the header.
 */
async function blockingWork(
  landing: Landing,
  safety: { isDirty: boolean; ahead: number | null; reason?: string },
  repoPath: string,
  workBranch: string,
  baseBranch: string
): Promise<string | null> {
  if (safety.isDirty) return safety.reason ?? "uncommitted changes not saved to any branch";
  if (safety.ahead === 0) return null;
  // A null count means the base branch has no ref here, so nothing was
  // compared. A local merge is judged against exactly that branch, so
  // unknowable must block it. A PR landing never trusted the count anyway (a
  // squash leaves every landed branch permanently ahead) and still has
  // unpushedCommits below: a question about the remote, which a missing local
  // base doesn't touch.
  if (landing === "merge")
    return safety.reason ?? (safety.ahead === null ? "the base branch could not be compared" : `${safety.ahead} commits not yet in the base branch`);

  const unpushed = await unpushedCommits(repoPath, workBranch, baseBranch);
  if (unpushed === null) return null; // nothing to compare; GitHub's verdict stands
  if (unpushed === 0) return null;
  return `${unpushed} commit${unpushed === 1 ? "" : "s"} never pushed, so the merged pull request did not include ${unpushed === 1 ? "it" : "them"}`;
}

/** Read-only: what reclaiming this task would do, without doing any of it. */
export async function reclaimPreview(taskId: string): Promise<ReclaimPreview | null> {
  const task = getTask(taskId);
  if (!task) return null;
  const landing = landedVia(task);
  const project = getProject(task.project_id);
  const baseBranch = project ? resolveBaseBranch(task, project) : "";
  const empty: ReclaimPreview = {
    landing,
    hasWorktree: !!task.worktree_path,
    branch: task.work_branch,
    baseBranch,
    bytes: 0,
    running: task.running === 1 || hasTurn(taskId),
    unsafe: false,
    unsafeReason: null,
  };
  if (!landing || !project?.repo_path || (!task.worktree_path && !task.work_branch)) return empty;

  const safety = await worktreePruneSafety({
    repoPath: project.repo_path,
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch,
  });
  const blocking = await blockingWork(landing, safety, project.repo_path, task.work_branch, baseBranch);
  return {
    ...empty,
    bytes: task.worktree_path ? await worktreeDiskUsage(task.worktree_path) : 0,
    unsafe: !!blocking,
    unsafeReason: blocking,
  };
}

/**
 * Do the whole tail for one landed task.
 *
 * Takes locks in the order lib/taskMove.ts and the sweep take them (the task
 * lock, then the repo lock), so the three can only ever wait on each other in
 * one direction. The task lock is what makes the safety read mean anything: it
 * is the lock the turn-launch path holds through registerTurn(), so nothing
 * can start writing into the checkout between "this is clean" and
 * `git worktree remove`.
 *
 * `discardUnsafe` is the acknowledgement lib/taskMove.ts demands. It is
 * re-checked here instead of trusted from whatever preview the caller
 * rendered, so work that appeared after the preview is refused instead of
 * being swept up.
 */
export async function reclaimTask(
  taskId: string,
  opts: { discardUnsafe?: boolean } = {}
): Promise<ReclaimResult> {
  const outcome = await withTaskLock(taskId, async (): Promise<ReclaimResult> => {
    const task = getTask(taskId);
    if (!task) return { ok: false, reason: "not found" };
    // The row's own flag is the resting state after a turn; the abort registry
    // is the live one. Both, for the same reason the sweep checks both.
    if (task.running || hasTurn(taskId))
      return { ok: false, reason: "a turn is running. Wait for the session to finish" };

    const landing = landedVia(task);
    if (!landing)
      return { ok: false, reason: "this task hasn't landed yet: nothing has been merged and no pull request reports merged" };

    const project = getProject(task.project_id);
    if (!project?.repo_path) return { ok: false, reason: "the project has no repo" };
    const baseBranch = resolveBaseBranch(task, project);
    const result: ReclaimResult = { ok: true, landing, baseBranch, bytes: 0 };

    // Step 1. Outside the repo lock: advanceBaseBranch takes that lock itself,
    // and withRepoLock is a promise chain that cannot be re-entered from
    // inside its own critical section.
    const base = await catchUpBase(project.repo_path, baseBranch);
    result.baseAdvanced = base.advanced;
    if (base.error) result.baseError = base.error;

    // Steps 2 and 3. A task whose checkout is already gone still reaches step
    // 4: being marked done is half of what "reclaimed" means, and the
    // automatic path arrives here after the scheduled sweep has taken the
    // worktree.
    if (task.worktree_path || task.work_branch) {
      const teardown = await withRepoLock(project.repo_path, async (): Promise<ReclaimResult | null> => {
        const safety = await worktreePruneSafety({
          repoPath: project.repo_path,
          worktreePath: task.worktree_path,
          workBranch: task.work_branch,
          baseBranch,
        });
        const blocking = await blockingWork(landing, safety, project.repo_path, task.work_branch, baseBranch);
        if (blocking && !opts.discardUnsafe)
          return { ok: false, unsafe: true, landing, reason: `${UNSAFE_DISCARD_REASON}: ${blocking}` };

        const bytes = task.worktree_path ? await worktreeDiskUsage(task.worktree_path) : 0;
        // keepBranch is NOT set: the branch is the task's diff only while the
        // diff is not in the base branch yet, and by definition it now is.
        // The remote branch is not this function's to delete: the merge that
        // landed the work already took it (mergeTaskPr's --delete-branch, or
        // delete_branch_on_merge), and a reclaim must not make a network
        // write from inside the repo lock.
        await removeWorktree(project.repo_path, task.worktree_path, task.work_branch, { keepBranch: false });
        // removeWorktree never throws, so a surviving directory is only visible
        // by looking. Leave the column pointing at it: worktree paths are keyed
        // by task id, and a row claiming no checkout while a directory sits at
        // the path the next launch wants is how a task adopts a stale tree.
        if (task.worktree_path && fs.existsSync(task.worktree_path))
          return {
            ok: false,
            landing,
            reason: `the worktree directory could not be removed${heldHandleHint()}`,
          };
        clearTaskWorktreePath(taskId, { branch: true });
        result.bytes = bytes;
        result.worktreeRemoved = !!task.worktree_path;
        result.branchDeleted = !!task.work_branch;
        return null;
      });
      if (teardown) return teardown;
    }

    // Step 4. The one write allowed to stamp updated_at; see the header. A
    // task already done or cancelled is left exactly as it is.
    if (!TERMINAL.has(task.status)) {
      updateTask(taskId, { status: "done" });
      result.markedDone = true;
    }
    return result;
  });

  if (outcome.ok) {
    // clearTaskWorktreePath publishes nothing (it is used by an unattended
    // sweep), so the announcement is made here: task_edited is the "re-read the
    // row" event, which is what a cleared worktree and a new status both need.
    publishGlobal(taskId, { type: "task_edited" });
    // A non-terminal → terminal transition releases anything waiting on this
    // task, exactly as the user-facing PATCH and the agent tools do. Dynamic so
    // this module keeps no static path to the agent SDKs (CLAUDE.md).
    if (outcome.markedDone)
      void import("@/lib/autoStart")
        .then((m) => m.maybeAutoStartDependents(taskId))
        .catch((e) => console.error(`[reclaim] dependent sweep for ${taskId} failed:`, e));
  }
  return outcome;
}

/**
 * The automatic half: reclaim this task if its project opted in and its work
 * has landed. Fire-and-forget, and does nothing when the project didn't opt in.
 *
 * Called from every place that learns a task has landed: the three merge
 * routes and lib/prState.ts's refresh, so "the PR merged" and "we merged it
 * locally" reach one implementation instead of two.
 *
 * Never awaited by its callers. A merge route must not hold an HTTP request
 * open across a fetch of origin, and a PR refresh is already a detached job.
 */
export function maybeAutoReclaim(taskId: string): void {
  const task = getTask(taskId);
  if (!task || !landedVia(task)) return;
  // Nothing left to reclaim: no checkout, no branch, and already terminal.
  if (!task.worktree_path && !task.work_branch && TERMINAL.has(task.status)) return;
  const project = getProject(task.project_id);
  if (!project?.auto_reclaim) return;

  void reclaimTask(taskId)
    .then((r) => {
      // An unattended reclaim never forces past the safety gate: there is
      // nobody here to give the acknowledgement, so it reports and leaves the
      // checkout alone, the way the sweep does. The one-click button in the
      // session header is where that answer can actually be given.
      if (!r.ok) console.log(`[reclaim] left task ${taskId} alone: ${r.reason}`);
    })
    .catch((e) => console.error(`[reclaim] automatic reclaim of ${taskId} failed:`, e));
}
