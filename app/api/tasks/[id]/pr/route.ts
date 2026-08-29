import { NextResponse } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { openTaskPr } from "@/lib/prTools";
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
//
// The guards are here because they are HTTP statuses; everything after them is
// in lib/prTools.openTaskPr, shared with the `create_pr` agent tool so a human's
// PR and a session's cannot mean two different things.
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

  const result = await openTaskPr(task, project);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
