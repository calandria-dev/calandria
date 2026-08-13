// Re-parenting tasks, as an operation rather than an endpoint.
//
// Both move routes — POST /api/tasks/[id]/move for one task and
// POST /api/tasks/move for a selection — are the same operation with different
// error manners, so the rules live here once: which tasks are eligible, what
// has to be held while that's decided, and the single event the change
// announces. The routes only translate the result into HTTP.
//
// The store half (lib/store.ts moveTasks) is the DB write and knows nothing
// about turns; this half owns the liveness screen and the locks that make it
// mean something.

import { getProject, getTask, moveTasks, type TaskMoveBatch } from "./store";
import { withTaskLocks } from "./taskLock";
import { hasTurn } from "./abort";
import { publishGlobal } from "./events";

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
 * Everything between acquiring the locks and committing is synchronous — the
 * store's write is one better-sqlite3 transaction and there is no await for a
 * launch to slip through.
 *
 * Returns null when the destination doesn't exist. Callers check the project up
 * front too (so a bad id fails without queueing behind anyone's lock), but it
 * can be deleted while this request waits its turn — and the answer to that is
 * still 404, not a crash. Anything about an INDIVIDUAL task comes back in
 * `skipped` instead; only the destination is fatal to the whole request.
 */
export async function moveTasksToProject(ids: string[], projectId: string): Promise<TaskMoveBatch | null> {
  return withTaskLocks(ids, () => {
    if (!getProject(projectId)) return null;
    // Only tasks that would actually CHANGE project are screened for liveness.
    // Re-filing a task under the project it already sits in has always been an
    // unconditional no-op — there is nothing to refuse — so a live turn on one
    // of those must not be turned into a refusal here.
    const live = new Set(ids.filter((id) => hasTurn(id) && getTask(id)?.project_id !== projectId));
    const result = moveTasks(ids.filter((id) => !live.has(id)), projectId);
    const skipped = [
      ...result.skipped,
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
    return { ...result, skipped };
  });
}
