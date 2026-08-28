// Re-parenting tasks, as an operation rather than an endpoint.
//
// Both move routes — POST /api/tasks/[id]/move for one task and
// POST /api/tasks/move for a selection — are the same operation with different
// error manners, so the rules live here once: which tasks are eligible, what
// has to be held while that's decided, and the single event the change
// announces. The routes only translate the result into HTTP.
//
// The store half (lib/store.ts moveTasks) is the DB write and knows nothing
// about turns or git; this half owns the liveness screen, the locks that make
// it mean something, and the worktree teardown that lets a STARTED task move
// at all.

import fs from "node:fs";
import { getProject, getTask, moveTaskBlockedReason, moveTasks, type TaskMoveBatch } from "./store";
import { removeWorktree, worktreePruneSafety } from "./git";
import { resolveBaseBranch } from "./baseBranch";
import { withTaskLocks } from "./taskLock";
import { withRepoLock } from "./repoLock";
import { heldHandleHint } from "./paths";
import { hasTurn } from "./abort";
import { publishGlobal } from "./events";

/** What a discard-move destroyed, so the caller can say what it cost. */
export interface WorktreeDiscard {
  id: string;
  /** The branch deleted along with the checkout ("" if the task had none). */
  branch: string;
  /** Uncommitted edits were present and are now gone. */
  dirty: boolean;
  /** Commits on the work branch the base branch never absorbed, now orphaned. */
  ahead: number;
}

export interface TaskMoveOutcome extends TaskMoveBatch {
  /** One entry per task whose worktree was torn down to let it move. */
  discarded: WorktreeDiscard[];
}

export interface MoveOptions {
  /**
   * The ids whose worktree + branch may be torn down so a started task can
   * move — the caller's acknowledgement that those checkouts are being thrown
   * away. A list rather than a flag over the batch: each worktree is a separate
   * irreversible answer, and one switch over eleven of them isn't consent. A
   * started task not named here is refused and reported like any other.
   */
  discardWorktree?: readonly string[];
  /**
   * The second acknowledgement, required only for a task whose worktree turns
   * out to hold work that removing it would lose (uncommitted edits, or commits
   * the base branch never absorbed). Per id for the same reason as above, and
   * on the same footing: naming one task's unsaved work says nothing about its
   * neighbour's. Without it such a task is refused rather than quietly
   * shredded — see the comment on the check below.
   */
  discardUnsafe?: readonly string[];
}

/** Prefix the routes and the UI match on to offer the stronger acknowledgement. */
export const UNSAFE_DISCARD_REASON = "the worktree has unsaved work";

/**
 * Move every movable task in `ids` into `projectId`, then announce it once.
 *
 * Runs under the per-task locks the turn-launch path takes, so no task in the
 * selection can start (and cut a worktree from the OLD repo) between the
 * eligibility check and the write. The abort registry is checked inside them
 * for the same reason the single-task route always has: POST /messages claims
 * the turn slot BEFORE it takes the lock, so a launch can be in flight with the
 * row still reading running=0. Those tasks are screened out here rather than in
 * the store, whose view is limited to the rows.
 *
 * A launch that claims the slot AFTER that screen is harmless, and that's not
 * an accident: it will block on the task lock we hold, then re-read the row and
 * its project (POST /messages does this explicitly) and cut its worktree from
 * whichever repo the task belongs to by then. Which is the point of clearing
 * the checkout columns.
 *
 * With `discardWorktree` the critical section is no longer synchronous — the
 * teardown is git — but the locks are what made it safe, not its shortness.
 * The order is deliberate: check the destination, screen for liveness, remove
 * the worktrees named in it, and only then write. Teardown before the write
 * means a crash between the two leaves a row pointing at a directory that
 * isn't there, which both launch paths already self-heal (they treat a missing
 * worktree_path as "cut a new one"); the other order would strand a worktree
 * and branch in the old repo with nothing left pointing at them, which nothing
 * cleans up.
 *
 * Returns null when the destination doesn't exist. Callers check the project up
 * front too (so a bad id fails without queueing behind anyone's lock), but it
 * can be deleted while this request waits its turn — and the answer to that is
 * still 404, not a crash. Anything about an INDIVIDUAL task comes back in
 * `skipped` instead; only the destination is fatal to the whole request.
 */
export async function moveTasksToProject(
  ids: string[],
  projectId: string,
  opts: MoveOptions = {}
): Promise<TaskMoveOutcome | null> {
  return withTaskLocks(ids, async () => {
    if (!getProject(projectId)) return null;
    // Only tasks that would actually CHANGE project are screened for liveness.
    // Re-filing a task under the project it already sits in has always been an
    // unconditional no-op — there is nothing to refuse — so a live turn on one
    // of those must not be turned into a refusal here.
    const live = new Set(ids.filter((id) => hasTurn(id) && getTask(id)?.project_id !== projectId));
    let candidates = ids.filter((id) => !live.has(id));

    // Only the tasks the caller answered for. Everything else keeps the plain
    // rules — a started one among them is still refused, with its checkout
    // untouched, which is what makes a partly-acknowledged selection safe to
    // send whole.
    const discardIds = new Set(opts.discardWorktree ?? []);
    const unsafeIds = new Set(opts.discardUnsafe ?? []);
    const discarded: WorktreeDiscard[] = [];
    const refused: { id: string; reason: string }[] = [];
    for (const id of candidates) {
      if (!discardIds.has(id)) continue;
      const outcome = await discardCheckout(id, projectId, { discardUnsafe: unsafeIds.has(id) });
      if (!outcome) continue;
      if ("reason" in outcome) refused.push({ id, reason: outcome.reason });
      else discarded.push(outcome);
    }
    const stuck = new Set(refused.map((r) => r.id));
    candidates = candidates.filter((id) => !stuck.has(id));

    // Asked again after the teardowns, which is the only part of this that
    // awaits: the destination was checked above while nothing had happened yet,
    // and a project deleted during a git subprocess would reach moveTasks as a
    // throw — a 500 where the contract, and the caller, expect 404. The
    // checkouts are gone either way; nothing can undo that. What this avoids is
    // answering with a crash.
    if (discarded.length > 0 && !getProject(projectId)) return null;

    const result = moveTasks(candidates, projectId, { resetCheckout: discardIds });
    const skipped = [
      ...result.skipped,
      ...refused,
      ...[...live].map((id) => ({ id, reason: "a task with a running turn can't be moved" })),
    ];
    // Nothing changed hands: no event, so a selection of started tasks doesn't
    // make every other tab reload its lists for nothing.
    if (result.moved.length > 0) {
      // Task-keyed on the bus like everything else, but the id is arbitrary —
      // the payload carries the whole set, which is the point: eleven tasks
      // re-parented is ONE re-sync in the other tabs, not eleven.
      publishGlobal(result.moved[0].id, {
        type: "tasks_moved",
        taskIds: result.moved.map((t) => t.id),
        // The distinct projects that LOST rows, not one per task: the moved rows
        // only remember where they landed, and a tray that lost a task has to
        // drop it. The store captures them before the write.
        fromProjectIds: result.from_project_ids,
        toProjectId: projectId,
      });
    }
    return { ...result, skipped, discarded };
  });
}

/**
 * Remove one task's worktree and branch so it can be re-parented. Returns what
 * was destroyed, a refusal, or null when there is nothing to tear down (which
 * includes every task the store is going to refuse or ignore anyway — those are
 * left for moveTasks to report, so the two halves can't disagree about why).
 *
 * Called only with the task's lock held.
 */
async function discardCheckout(
  id: string,
  projectId: string,
  opts: { discardUnsafe: boolean }
): Promise<WorktreeDiscard | { reason: string } | null> {
  const task = getTask(id);
  if (!task || task.project_id === projectId) return null;
  // A LIVE turn still refuses — nothing may delete a worktree an agent is
  // writing into — and the store reports it, so bail before touching git.
  if (moveTaskBlockedReason(task, { resetCheckout: true })) return null;
  if (!task.worktree_path && !task.work_branch) return null;
  const project = getProject(task.project_id);
  // Columns on record but no repo to remove them from (the project's repo_path
  // was cleared, or it never had one). Nothing to tear down; the store's reset
  // still clears the stale columns.
  if (!project?.repo_path) return null;

  return withRepoLock(project.repo_path, async () => {
    // The same read the "prune merged worktrees" cleanup gates on: merged is the
    // safe case, and merged_at only says a task was merged AT LEAST ONCE — work
    // added since is not in the base branch and dies with the branch.
    const safety = await worktreePruneSafety({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: resolveBaseBranch(task, project),
    });
    // Re-read here rather than trusting the caller's preview: between the modal
    // rendering "this worktree is clean" and the user confirming, the tree can
    // have been edited (no turn can run, but the user's own editor is right
    // there). The stronger acknowledgement is about work we can SEE, so it's
    // demanded from the state at teardown time, not from the state the user was
    // shown — which is the whole guarantee: nothing uncommitted is ever
    // discarded without having been named first.
    if (!safety.safe && !opts.discardUnsafe) return { reason: `${UNSAFE_DISCARD_REASON}: ${safety.reason}` };

    await removeWorktree(project.repo_path, task.worktree_path, task.work_branch);
    // removeWorktree is best-effort and never throws, and a surviving directory
    // is the one failure that must not be papered over: worktree paths are keyed
    // by TASK id, so the next launch would find the old repo's checkout sitting
    // at exactly the path it wants and reuse it — running the agent against the
    // project it just left. Refuse the move instead and leave the row intact.
    // (A branch that outlives its worktree is only a stale ref in a repo this
    // task no longer belongs to, so it doesn't block anything.)
    if (task.worktree_path && fs.existsSync(task.worktree_path))
      return { reason: `couldn't remove the task's worktree at ${task.worktree_path}${heldHandleHint()}` };

    return { id, branch: task.work_branch, dirty: safety.isDirty, ahead: safety.ahead };
  });
}

/**
 * What a discard-move WOULD destroy, for the confirmation the user is about to
 * give. Read-only; safe to call on any task.
 *
 * Separate from the move itself because the answer costs git subprocesses —
 * this is why it doesn't ride along on GET /api/tasks/[id], which every task
 * selection hits.
 */
export interface DiscardPreview {
  /** There's a checkout to tear down; false means the move needs no discard. */
  has_worktree: boolean;
  /** Removing it would lose nothing — a merged, clean worktree. */
  safe: boolean;
  dirty: boolean;
  ahead: number;
  /** What makes it unsafe, in the user's words. Null when it's safe. */
  reason: string | null;
  /** The branch that would be deleted with it. */
  branch: string;
}

/**
 * The same read for a whole selection, keyed by id — what the bulk modal needs
 * to put a cost beside each started row before any box is ticked. Unknown ids
 * are simply absent: a stale selection shouldn't cost the other ten their
 * preview, and the move itself reports them anyway.
 *
 * Sequential on purpose. Every started task costs a pair of git subprocesses,
 * and running a whole tray of them at once would fork a small army for a read
 * nobody is waiting on with their finger on a button; tasks with no checkout
 * (the common case in a selection) answer without touching git at all.
 */
export async function previewDiscards(ids: string[]): Promise<Record<string, DiscardPreview>> {
  const out: Record<string, DiscardPreview> = {};
  for (const id of new Set(ids)) {
    const preview = await previewDiscard(id);
    if (preview) out[id] = preview;
  }
  return out;
}

export async function previewDiscard(taskId: string): Promise<DiscardPreview | null> {
  const task = getTask(taskId);
  if (!task) return null;
  const empty: DiscardPreview = { has_worktree: false, safe: true, dirty: false, ahead: 0, reason: null, branch: "" };
  if (!task.worktree_path && !task.work_branch) return empty;
  const project = getProject(task.project_id);
  if (!project?.repo_path) return empty;
  const safety = await worktreePruneSafety({
    repoPath: project.repo_path,
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch: resolveBaseBranch(task, project),
  });
  return {
    has_worktree: true,
    safe: safety.safe,
    dirty: safety.isDirty,
    ahead: safety.ahead,
    reason: safety.reason ?? null,
    branch: task.work_branch,
  };
}
