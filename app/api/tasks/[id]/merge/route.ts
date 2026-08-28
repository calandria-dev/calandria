import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, recordTaskMerge } from "@/lib/store";
import { mergeTask, taskCommitMessage } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Optional body: the paths of the main checkout's uncommitted changes the user
  // was shown and agreed to have stashed for the duration of the merge. A LIST,
  // never a flag — the merge re-checks it against the tree it actually finds, so
  // dirt that appeared after the card was rendered is refused rather than swept
  // up. A bodyless POST (the ordinary Merge click) parses to undefined.
  const body = (await req.json().catch(() => null)) as { stashDirty?: unknown } | null;
  const stashDirty =
    Array.isArray(body?.stashDirty) && body.stashDirty.every((p) => typeof p === "string")
      ? (body.stashDirty as string[])
      : undefined;
  // The whole check-then-commit sequence runs under the per-task lock shared
  // with the turn-launch path (messages route + queue drain), making the
  // running check atomic with the git operation: a turn can't start writing
  // into the worktree while `git add -A` + commit are staging it.
  return jsonGuard(`merge ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running. Wait for the session to finish before merging" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated branch to merge" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const result = await mergeTask({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch: resolveBaseBranch(task, project),
      message: taskCommitMessage(task),
      // Lets the merge fast-forward the base past any remote commits the task
      // was cut from, so the merge commit holds only the task's own work.
      baseSha: task.base_sha,
      stashDirty,
    });

    if (result.ok) {
      // Record the merge and advance the diff base to the merged tip so a later
      // round in the same task shows only changes made after this merge. Status
      // is deliberately NOT changed — merging is a git action, not a declaration
      // that the task is finished. The user owns the "done" status (you may merge
      // several rounds while still iterating). They mark it done manually.
      updateTask(id, {
        merged_at: Date.now(),
        ...(result.mergedSha ? { base_sha: result.mergedSha } : {}),
      });
      // Insights: persist what this merge landed (line stats die with the
      // worktree, so merge time is the only chance). Re-merges that landed
      // nothing (alreadyMerged) don't record.
      if (!result.alreadyMerged)
        recordTaskMerge({
          project_id: project.id, task_id: id, agent: task.agent,
          additions: result.additions ?? 0, deletions: result.deletions ?? 0,
        });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }));
}
