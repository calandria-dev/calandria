import { NextResponse } from "next/server";
import { getTask, getProject, updateTask, addMessage } from "@/lib/store";
import { repairWorktree } from "@/lib/git";
import { publish } from "@/lib/events";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";
import { worktreePrepNotice, classifyWorktreePrep } from "@/lib/worktreeFailure";
import { resolveBaseBranch } from "@/lib/baseBranch";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Recover a task whose worktree could not be prepared — the action behind the
 * "Repair worktree" button on the failure notice (issue #44). Clears the stale
 * lock a crashed git left behind, prunes a registration pointing at a directory
 * that's gone, and cuts the checkout again; the client then re-sends the
 * message that failed, so one click is the whole recovery.
 *
 * Never destructive: it deletes lock files and stale REGISTRATIONS only, and
 * re-cutting reattaches to the task's surviving branch (with its commits and
 * its real fork point) exactly as the launch paths' self-heal does. That's why
 * this needs no discard acknowledgement the way POST /move does.
 *
 * Runs under the same per-task lock the launch path holds, so the "not running"
 * check stays true for the whole repair and a turn can't start writing into the
 * worktree mid-prune.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonGuard(`repair-worktree ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    // A live turn owns the worktree; pruning under it would be exactly the
    // crashed-git-mid-write situation this route exists to clean up after.
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running. Wait for the session to finish before repairing" }, { status: 409 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });
    if (!project.repo_path.trim())
      return NextResponse.json({ error: "this project has no working directory to repair" }, { status: 400 });

    try {
      // The task's OWN base if it has one, not the project default — a repair
      // re-cuts, and re-cutting a task retargeted to `feature/auth` from `main`
      // would silently move the work it's meant to be restoring.
      const { actions, worktree } = await repairWorktree(project.repo_path, id, resolveBaseBranch(task, project));
      if (worktree) {
        updateTask(id, {
          worktree_path: worktree.path, work_branch: worktree.branch, base_sha: worktree.baseSha,
          // Pin the base at the cut, exactly as the launch paths do
          // (lib/baseBranch.ts). "" = the branch didn't exist and the cut fell
          // back to HEAD, which isn't a base to record.
          ...(worktree.baseBranch ? { base_branch: worktree.baseBranch } : {}),
        });
      }
      // Say what was done on the transcript, not just in the response: the
      // launch that failed left a durable ⚠ line there, and a repair that
      // leaves no trace beside it reads, on the next visit, like the failure
      // is still current.
      const note = `✓ Repaired this task's worktree: ${actions.join("; ").toLowerCase()}.`;
      try {
        const m = addMessage(id, task.generation, "system", note);
        publish(id, { type: "notice", content: note, msgId: m.id, generation: task.generation, ts: m.created_at });
      } catch (err) {
        console.error(`[repair-worktree] could not persist the repair note for task ${id}:`, err);
      }
      return NextResponse.json({ ok: true, actions, isolated: !!worktree, worktreePath: worktree?.path ?? "" });
    } catch (err) {
      // The repair ran and the re-cut still failed, so this is not the stale
      // bookkeeping we can clear. Hand back the classified failure: the client
      // shows it instead of silently re-sending a message that would fail the
      // same way, and `recoverable` says whether pressing the button again
      // could ever help.
      const detail = err instanceof Error ? err.message : String(err);
      const { kind, recoverable } = classifyWorktreePrep(detail);
      const notice = worktreePrepNotice(detail);
      return NextResponse.json(
        { ok: false, error: notice ? `${detail}\n\n${notice}` : detail, kind, recoverable },
        { status: 400 }
      );
    }
  }));
}
