import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getTask, getProject, updateTask } from "@/lib/store";
import { taskDiff, worktreeMergeStatus } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";

export const dynamic = "force-dynamic";

const run = promisify(execFile);

// The worktree's current HEAD, stamped onto the diff response so a posted
// comment can record which diff it was written against (see TaskComment's
// anchor_sha). Best-effort and cheap: one subprocess, short timeout, never
// throws, since a comment anchor is worth having even when this fails.
// Known gap: a dirty worktree can change the diff's content without moving
// HEAD, so this alone does not catch every case of the diff changing.
async function currentHead(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", worktreePath, "rev-parse", "HEAD"], { timeout: 5000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  // Tasks without an isolated worktree ran directly in the repo, so there is
  // nothing branch-scoped to diff.
  if (!task.worktree_path) {
    return NextResponse.json({
      isolated: false,
      files: [],
      patch: "",
      isDirty: false,
      ahead: 0,
      reason: "This task runs in the main repo (no isolated branch).",
    });
  }

  const baseBranch = resolveBaseBranch(task, project);

  try {
    // An in-progress trial merge (conflict resolution) means the branch is not
    // really "already merged" yet, so report its state and let the UI show the
    // accept/discard review instead of a done badge. Both are read-only, so
    // they run concurrently.
    const [diff, mergeState, head] = await Promise.all([
      taskDiff(project.repo_path, task.worktree_path, task.base_sha, baseBranch),
      worktreeMergeStatus(task.worktree_path),
      currentHead(task.worktree_path),
    ]);
    // Self-heal: taskDiff advances the diff base past the recorded snapshot
    // when the worktree was caught up to the base branch outside the app
    // (out-of-band merge/ff in the terminal). Persist the advanced sha so the
    // stored state agrees with what the panel shows and later reads do not
    // re-derive it. resolveBase only moves forward when the recorded sha is an
    // ancestor of the live merge-base, so this never rewrites a rebased base.
    if (task.base_sha && diff.base !== task.base_sha && /^[0-9a-f]{40}$/.test(diff.base)) {
      updateTask(id, { base_sha: diff.base });
    }
    // Self-heal: if the branch is already in the base branch but the merge was
    // never recorded (e.g. merged via CLI), backfill merged_at so the DB stays
    // the source of truth. Status is left untouched: viewing the Changes tab
    // must never mark a task done. The user owns that.
    let merged_at = task.merged_at;
    if (diff.alreadyMerged && !mergeState.mergeInProgress && !merged_at) {
      merged_at = updateTask(id, { merged_at: Date.now() })?.merged_at ?? Date.now();
    } else if (merged_at && diff.ahead > 0 && !mergeState.mergeInProgress) {
      // The task was merged, but new commits have since landed on the work branch
      // (the diff base was advanced to the merged tip, so ahead>0 means post-merge
      // work). "Merged" no longer reflects reality, so clear the flag so the badge
      // stays honest and the task drops out of the prune candidate list. Status is
      // left untouched; the user still owns "done".
      merged_at = updateTask(id, { merged_at: 0 })?.merged_at ?? 0;
    }
    return NextResponse.json({
      isolated: true,
      branch: task.work_branch,
      // The base in force, and the project's default beside it: the Changes tab
      // badges a task's own base only when the two differ, since a task showing
      // `main` needs no callout but one showing `feature/auth` does.
      baseBranch,
      projectBranch: project.branch,
      merged_at,
      head,
      ...diff,
      mergeInProgress: mergeState.mergeInProgress,
      unresolved: mergeState.unresolved,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
