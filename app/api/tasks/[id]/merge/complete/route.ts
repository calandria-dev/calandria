import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, recordTaskMerge } from "@/lib/store";
import { completeWorktreeMerge, taskCommitMessage } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { maybeAutoReclaim } from "@/lib/reclaim";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Accept a resolved conflict: commit the merge in the worktree and land the
// now conflict-free work branch into the base branch. With `resolveOnly`,
// stop at the commit, which is all a PR-landing project can honestly offer.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Optional body, same contract as the plain merge route: the main checkout's
  // uncommitted paths the user was shown and agreed to have stashed aside for
  // the merge. Accepting a resolution lands through `mergeTask` too, so it hits
  // the same clean-tree requirement and deserves the same way out.
  const body = (await req.json().catch(() => null)) as { stashDirty?: unknown; resolveOnly?: unknown } | null;
  const stashDirty =
    Array.isArray(body?.stashDirty) && body.stashDirty.every((p) => typeof p === "string")
      ? (body.stashDirty as string[])
      : undefined;
  const resolveOnly = body?.resolveOnly === true;
  // Locked against the turn-launch path: committing the resolved merge stages
  // the whole worktree, so no turn may start writing into it mid-commit.
  return jsonGuard(`merge/complete ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running. Wait for the session to finish before merging" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated branch to merge" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const result = await completeWorktreeMerge({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: resolveBaseBranch(task, project),
      message: taskCommitMessage(task),
      stashDirty,
      resolveOnly,
    });

    // A resolve-only accept moved the WORK branch, not the base: nothing landed,
    // so nothing is merged and no insight row is owed. Recording either would put
    // a merge on the board that the base branch has never seen.
    if (result.ok && !resolveOnly) {
      // Record the merge and advance the diff base, but do not change status.
      // Merging (even after resolving conflicts) is a git action, not a sign the
      // task is finished; the user owns the "done" status and sets it manually.
      updateTask(id, {
        merged_at: Date.now(),
        ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
      });
      // Insights: persist what this merge landed (see merge/route.ts).
      if (!result.alreadyMerged)
        recordTaskMerge({
          project_id: project.id, task_id: id, agent: task.agent,
          additions: result.additions ?? 0, deletions: result.deletions ?? 0,
        });
      // The mirror of a merged PR: this task's work is now in the base branch, so
      // its checkout is disposable. A no-op unless the project opted in, and not
      // awaited, since the reclaim fetches origin (lib/reclaim.ts).
      maybeAutoReclaim(id);
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }));
}
