import { NextResponse } from "next/server";
import { getProject, getTask, updateTask } from "@/lib/store";
import { retargetTaskBase, tagBaseBranch } from "@/lib/baseBranch";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Point this task at a different base branch — what it was cut from, what Sync
 * catches it up to, and what Merge lands it into.
 *
 * Deliberately NOT part of `PATCH /api/tasks/[id]`: that route is a synchronous
 * field write, and this can create a local ref, `reset --hard` a worktree and
 * fail halfway. All of the policy lives in `retargetTaskBase`, so this route and
 * the agent tool that arrives later cannot drift.
 *
 * Runs under the per-task lock shared with the turn-launch path, so the running
 * check inside stays true for the whole reconciliation — a turn can't start
 * writing into the worktree while it's being re-cut.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { branch?: unknown } | null;
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";

  return jsonGuard(`base-branch ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    // An empty branch is "go back to inheriting". What it inherits is the rest
    // of the chain below the task's own pin — a tag's default if one of its
    // tags sets one, else the project's — and it still has to RECONCILE, since
    // the task may be pinned to a branch it is now leaving. So it routes through
    // the same function under that inherited name rather than blanking the
    // column and leaving base_sha describing a branch the task is no longer on.
    // The one exception is nothing to inherit at all: there is nothing to
    // reconcile against, and refusing on the name check would make the field
    // impossible to clear.
    const inherited = (tagBaseBranch(id) || project.branch).trim();
    if (!branch && !inherited) {
      updateTask(id, { base_branch: "" });
      return NextResponse.json({ ok: true, inherited: true, baseBranch: "", message: "Now following the project, which has no base branch set." });
    }
    const result = await retargetTaskBase(task, project, branch || inherited);
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    // Inheriting again is stored as "" so a later change to the tag's or the
    // project's default still reaches an uncut task — the pin is for a cut
    // worktree, not for a user clearing the field.
    if (!branch) {
      updateTask(id, { base_branch: "" });
      return NextResponse.json({ ...result, baseBranch: inherited, inherited: true });
    }
    return NextResponse.json(result);
  }));
}
