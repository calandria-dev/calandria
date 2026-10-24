import { NextResponse } from "next/server";
import { reviewRefusal } from "@/lib/reviews/gate";
import { acceptedCodePins, baseTipBefore, recordLocalLanding } from "@/lib/reviews/landing";
import { getTask, getProject, updateTask, recordTaskMerge } from "@/lib/store";
import { mergeTask, taskCommitMessage } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { maybeAutoReclaim } from "@/lib/reclaim";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Optional body: the paths of the main checkout's uncommitted changes the user
  // was shown and agreed to have stashed for the duration of the merge. Always a
  // list, not a flag: the merge re-checks it against the tree it actually finds,
  // so dirt that appeared after the card was rendered is refused instead of
  // swept up. A bodyless POST (the ordinary Merge click) parses to undefined.
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
    // Required reviews must be accepted for the exact artifact before it lands.
    const reviewRefusal409 = await reviewRefusal(id);
    if (reviewRefusal409) return NextResponse.json({ error: reviewRefusal409, code: "review_required" }, { status: 409 });

    const baseBranch = resolveBaseBranch(task, project);
    const baseBeforeSha = await baseTipBefore(project.repo_path, baseBranch);
    // An accepted code review pins the landing to the commit a person approved;
    // mergeTask then commits nothing on the way and refuses with nothing written
    // if the branch or the base moved. A task without an accepted review passes no pins.
    const pins = acceptedCodePins(id);
    const result = await mergeTask({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch,
      message: taskCommitMessage(task),
      // Allows the merge to fast-forward the base past any remote commits the
      // task was cut from, so the merge commit holds only the task's own work.
      baseSha: task.base_sha,
      stashDirty,
      expectedHeadSha: pins?.headCommitSha,
      expectedBaseSha: pins?.baseTipSha,
    });

    if (result.ok) {
      // The accepted head is now in the base: record it so the task keeps
      // passing the required-review guard (lib/reviews/landing.ts).
      await recordLocalLanding({ taskId: id, repoPath: project.repo_path, baseBranch, baseBeforeSha, mergedSha: result.mergedSha });
      // Record the merge and advance the diff base to the merged tip so a later
      // round in the same task shows only changes made after this merge. Status
      // remains user-owned when auto_reclaim is off. An opted-in project closes
      // the landed task through maybeAutoReclaim below.
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
      // The mirror of a merged PR: this task's work is now in the base branch, so
      // its checkout is disposable. A no-op unless the project opted in, and not
      // awaited, since the reclaim fetches origin (lib/reclaim.ts).
      maybeAutoReclaim(id);
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }));
}
