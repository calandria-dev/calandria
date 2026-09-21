// Does a task's checkout still hold the only copy of its work?
//
// The gate behind `update_task`'s status write: an agent marking a task done
// declares the work finished, and the session that made it is usually the last
// thing that will ever open that worktree. Uncommitted edits, or commits on the
// work branch that no pull request and no merge covers, are then stranded: the
// board says done, the code is on one disk in one checkout, and the worktree
// sweep (lib/worktreeSweep.ts) is allowed to delete it once the task is
// terminal and cold.
//
// The reading is the same git question lib/reclaim.ts asks before it removes a
// checkout, on the same worktreePruneSafety verdict, with one difference in
// what counts as covered. Reclaim runs only on a task that already landed, so
// it knows which of the two landings to judge against. This runs on a task that
// usually has not landed at all, where pushed-and-in-a-PR is the finished
// state, so an open PR is accepted and the remote is what gets checked.
//
// Read-only, and SDK-free like lib/agentTools.ts which calls it
// (tests/importGraph.test.ts).

import { getProject } from "./store";
import { unpushedCommits, worktreePruneSafety } from "./git";
import { resolveBaseBranch } from "./baseBranch";
import type { Task } from "./types";

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/**
 * Why marking this task done would strand work, as a sentence fragment a
 * refusal can carry, or null when nothing would be stranded.
 *
 * Null for a task with no checkout of its own: there is no second copy of
 * anything to lose. A project whose repo path is gone reads the same way,
 * since git can answer nothing about it and a status write is not the place
 * to report a broken project.
 */
export async function strandedWorkReason(task: Task): Promise<string | null> {
  if (!task.worktree_path && !task.work_branch) return null;
  const project = getProject(task.project_id);
  if (!project?.repo_path) return null;

  const baseBranch = resolveBaseBranch(task, project);
  const safety = await worktreePruneSafety({
    repoPath: project.repo_path,
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch,
  });

  if (safety.isDirty)
    return (
      "the worktree still has uncommitted changes, so marking it done would leave that work stranded there. " +
      "Run create_pr to commit and push it, or discard it, then set the status"
    );

  // Everything the branch carries is already in the base branch, so the
  // checkout holds no copy of anything the repo lacks.
  if (safety.ahead === 0) return null;

  // A closed PR covers nothing: its branch was abandoned with the commits
  // still only local. A merged one is judged on the remote below, the same
  // way reclaim judges a squash it cannot see locally.
  const covered = task.pr_number > 0 && task.pr_state !== "closed";
  if (!covered) {
    const unlanded =
      safety.ahead === null
        ? `${baseBranch} has no ref in this repository, so unlanded commits on ${task.work_branch} cannot be ruled out`
        : `${commits(safety.ahead)} on ${task.work_branch} ${safety.ahead === 1 ? "is" : "are"} not in ${baseBranch}, ` +
          `and no pull request covers ${safety.ahead === 1 ? "it" : "them"}`;
    return `${unlanded}, so marking it done would leave that work stranded in this checkout. Run create_pr to push the branch and open one, then set the status`;
  }

  const unpushed = await unpushedCommits(project.repo_path, task.work_branch, baseBranch);
  // Null is "nothing to compare against" (no upstream, no remote, offline).
  // The PR is the record that the work left this machine, and second-guessing
  // it from an unreadable remote would refuse every offline session.
  if (unpushed === null || unpushed === 0) return null;
  return (
    `${commits(unpushed)} on ${task.work_branch} ${unpushed === 1 ? "was" : "were"} never pushed, so pull request #${task.pr_number} ` +
    `does not include ${unpushed === 1 ? "it" : "them"}. Run create_pr to push ${unpushed === 1 ? "it" : "them"}, then set the status`
  );
}
