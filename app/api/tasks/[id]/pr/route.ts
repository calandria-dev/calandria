import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, listSummaries } from "@/lib/store";
import { commitWorktree, taskCommitMessage } from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { createTaskPr, buildPrBody, parsePrNumber } from "@/lib/github";
import { prView, schedulePrRefresh, startPrPolling } from "@/lib/prState";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// The task's stored PR state, plus the OPEN-THE-TASK refresh trigger: the chip
// reads this when a session is selected, and a snapshot older than PR_STALE_MS
// kicks a background re-read. The GET itself never waits on github.com — it
// answers from the row and the fresher answer arrives over /api/events as a
// task_edited, the same way every other lifecycle fact does.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const pr = prView(task);
  if (pr) {
    schedulePrRefresh(id);
    startPrPolling();
  }
  return NextResponse.json({ pr });
}

// The review-on-GitHub complement to merge: push the task's work branch to
// origin and open a PR against the project's base branch (gh pr create), with
// title/body prefilled from the task. Idempotent — clicking again re-pushes and
// returns the already-open PR's URL, so it doubles as "Update PR".
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (task.running)
    return NextResponse.json({ error: "task is running. Wait for the session to finish before opening a PR" }, { status: 409 });
  if (!task.worktree_path || !task.work_branch)
    return NextResponse.json({ error: "this task has no isolated branch to open a PR from" }, { status: 400 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

  // Commit whatever's still uncommitted first (same as merge does), so the PR
  // shows the same diff the Changes tab does.
  try {
    await commitWorktree(task.worktree_path, taskCommitMessage(task));
  } catch (e) {
    return NextResponse.json({ ok: false, error: `commit failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 409 });
  }

  // Latest session summary (generations are ordered; last = most recent /clear).
  const summaries = listSummaries(id);
  const result = await createTaskPr({
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch: resolveBaseBranch(task, project),
    title: task.title,
    body: buildPrBody({ description: task.description, summary: summaries[summaries.length - 1]?.summary, taskId: id }),
  });

  if (result.ok && result.url) {
    // Parse the number ONCE, here, instead of re-deriving it from the URL on
    // every render. This write is a user action, so it goes through updateTask
    // and stamps updated_at — unlike the background refreshes, which must not
    // reorder the board (setTaskPrState).
    updateTask(id, { pr_url: result.url, pr_number: parsePrNumber(result.url) });
    // First read of the PR's actual state, detached: the response returns now,
    // and the chip fills in over /api/events. startPrPolling restarts a sweep
    // that stopped itself when the last open PR landed.
    schedulePrRefresh(id, { force: true });
    startPrPolling();
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
