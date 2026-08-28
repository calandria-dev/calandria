import { NextResponse } from "next/server";
import { listReclaimableWorktrees, getTask, getProject, updateTask } from "@/lib/store";
import { removeWorktree, worktreeDiskUsage, worktreePruneSafety } from "@/lib/git";
import { worktreesDiskUsage } from "@/lib/worktreeSweep";
import { WORKTREES_DIR, WORKTREES_DISK_WARN_BYTES } from "@/lib/config";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";

export const dynamic = "force-dynamic";

// GET: merged tasks plus completed-but-unmerged tasks whose worktrees are still
// on disk, with the disk each would reclaim. Clean/merged work can be pruned
// while retaining its branch. A task marked Done may instead be explicitly
// discarded even when that destroys uncommitted edits or unmerged commits.
export async function GET() {
  const rows = listReclaimableWorktrees();
  const candidates = (
    await Promise.all(
      rows.map(async (r) => {
        const sizeBytes = await worktreeDiskUsage(r.worktree_path);
        // worktree_path set but gone from disk (pruned out-of-band, or removed
        // manually) — nothing to reclaim, so drop it from the list.
        if (sizeBytes <= 0) return null;
        const safety = await worktreePruneSafety({
          repoPath: r.repo_path,
          worktreePath: r.worktree_path,
          workBranch: r.work_branch,
          baseBranch: r.base_branch,
        });
        return {
          taskId: r.id,
          title: r.title,
          projectId: r.project_id,
          projectName: r.project_name,
          branch: r.work_branch,
          mergedAt: r.merged_at,
          cleanupAt: r.merged_at || r.updated_at,
          status: r.status,
          sizeBytes,
          running: hasTurn(r.id),
          unsafe: !safety.safe,
          unsafeReason: safety.reason ?? null,
          canDiscard: r.status === "done",
        };
      })
    )
  ).filter((c): c is NonNullable<typeof c> => c !== null);

  const totalBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
  // The WHOLE directory, not just the reclaimable share of it: the same reading
  // the scheduled sweep warns on (lib/worktreeSweep.ts), reported here because
  // this panel is where a human acts on it. It counts the checkouts of tasks
  // still in flight too, which is the point — "you have 40 GB of worktrees" is
  // the fact, and "6 GB of it is reclaimable right now" is the offer below.
  const dirBytes = await worktreesDiskUsage();
  return NextResponse.json({
    candidates,
    totalBytes,
    disk: {
      dir: WORKTREES_DIR,
      bytes: dirBytes,
      warnBytes: WORKTREES_DISK_WARN_BYTES,
      over: WORKTREES_DISK_WARN_BYTES > 0 && dirBytes >= WORKTREES_DISK_WARN_BYTES,
    },
  });
}

// POST: reclaim selected worktrees. Safe worktrees keep their branches unless
// `deleteBranch` is set. Destructive removal requires BOTH a Done task and the
// explicit `discardChanges` acknowledgement; its branch is always deleted so a
// later reopen starts clean instead of resurrecting commits the user discarded.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    taskIds?: unknown;
    deleteBranch?: unknown;
    discardChanges?: unknown;
  };
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((x): x is string => typeof x === "string") : [];
  const deleteBranch = body.deleteBranch === true;
  const discardChanges = body.discardChanges === true;
  if (taskIds.length === 0) return NextResponse.json({ error: "no tasks selected" }, { status: 400 });

  let reclaimedBytes = 0;
  const pruned: string[] = [];
  const discarded: string[] = [];
  const skipped: { taskId: string; reason: string }[] = [];

  for (const id of taskIds) {
    await withTaskLock(id, async () => {
      const task = getTask(id);
      if (!task || !task.worktree_path) {
        skipped.push({ taskId: id, reason: "not found or already removed" });
        return;
      }
      // The lock closes the race with turn launch/merge/sync; re-check running
      // after acquiring it so a worktree can never disappear under an agent.
      if (hasTurn(id)) {
        skipped.push({ taskId: id, reason: "a turn is currently running" });
        return;
      }
      if (!task.merged_at && task.status !== "done") {
        skipped.push({ taskId: id, reason: "task is neither merged nor done" });
        return;
      }
      const project = getProject(task.project_id);
      if (!project?.repo_path) {
        skipped.push({ taskId: id, reason: "project has no repo" });
        return;
      }
      // Re-check at execution time: the list may be stale or a follow-up turn
      // may have added work after it loaded.
      const safety = await worktreePruneSafety({
        repoPath: project.repo_path,
        worktreePath: task.worktree_path,
        workBranch: task.work_branch,
        baseBranch: resolveBaseBranch(task, project),
      });
      const destructive = !safety.safe;
      if (destructive && (task.status !== "done" || !discardChanges)) {
        skipped.push({ taskId: id, reason: `has unmerged work: ${safety.reason}` });
        return;
      }
      reclaimedBytes += await worktreeDiskUsage(task.worktree_path);
      const removeBranch = destructive || deleteBranch;
      await removeWorktree(project.repo_path, task.worktree_path, task.work_branch, { keepBranch: !removeBranch });
      updateTask(id, {
        worktree_path: "",
        ...(removeBranch ? { work_branch: "", base_sha: "" } : {}),
      });
      pruned.push(id);
      if (destructive) discarded.push(id);
    });
  }

  return NextResponse.json({ pruned, discarded, skipped, reclaimedBytes });
}
