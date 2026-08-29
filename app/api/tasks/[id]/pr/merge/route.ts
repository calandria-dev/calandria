import { NextResponse } from "next/server";
import { getTask, getProject } from "@/lib/store";
import { mergeTaskPr } from "@/lib/github";
import { prMergeBlocker } from "@/lib/prMerge";
import { prView, refreshPrState, schedulePrRefresh, startPrPolling } from "@/lib/prState";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Squash & merge this task's PR on GitHub — the other end of the loop
 * `POST /api/tasks/[id]/pr` opens. Landing reviewed work used to mean leaving
 * Calandria for github.com; this is the one click that doesn't.
 *
 * Three things this route is careful about:
 *
 *  1. It re-screens against a FRESH answer. The button is already enabled off
 *     real PR state, but that snapshot can be up to PR_STALE_MS old and a check
 *     can go red while the rail is on screen, so the route forces a refresh and
 *     runs the same `prMergeBlocker()` the button did before it shells out.
 *     One predicate, two callers, no chance of them disagreeing.
 *  2. It refuses while a turn is running, in the same words every merge route
 *     uses. The agent could be pushing more commits into the branch this PR is
 *     built from, and "merge whatever is there right now" is not a question a
 *     mid-turn task can answer.
 *  3. It cleans nothing up. A merged PR means the worktree is reclaimable and
 *     the task is finished, but that policy belongs to the reclaim path, which
 *     keys off `pr_state` becoming "merged". So the last thing this route does
 *     is force the refresh that writes it — the handoff — rather than growing a
 *     second copy of the teardown rules.
 *
 * WHO may click is settled deliberately and narrowly: a person, in a browser.
 * `.github/CLAUDE.md` holds this repo to a hard rule for release merges — an
 * agent may merge only on an explicit affirmative through its ask tool, never
 * on its own initiative and never in an unattended run — and a POST here that
 * an agent or a schedule could reach would be exactly that gate's back door.
 * There is therefore no agent tool for this and no scheduled caller. A user
 * click needs no ask; nothing else gets to make it.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same lock the local merge and the turn-launch path take, for the same
  // reason: it makes the running check atomic with the act it is guarding.
  return jsonGuard(`pr merge ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running. Wait for the session to finish before merging" }, { status: 409 });
    if (!task.pr_url || !task.pr_number)
      return NextResponse.json({ error: "this task has no pull request to merge" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    // The project's repo, not the worktree: gh resolves the repo from origin,
    // and a task's checkout is reclaimable while its PR is still landable.
    const cwd = project.repo_path || task.worktree_path;
    if (!cwd) return NextResponse.json({ error: "this project has no working directory" }, { status: 400 });

    // Ask GitHub once more before acting on what we think we know. A failed
    // refresh is not a refusal on its own — it leaves the last good snapshot in
    // place and the screen below decides on that, which is still stricter than
    // merging blind.
    await refreshPrState(id, { force: true });
    const fresh = getTask(id) ?? task;
    const blocked = prMergeBlocker(fresh);
    if (blocked) return NextResponse.json({ ok: false, error: blocked, pr: prView(fresh) }, { status: 409 });

    const result = await mergeTaskPr({ repoPath: cwd, number: fresh.pr_number });
    if (!result.ok) return NextResponse.json({ ...result, pr: prView(fresh) }, { status: 409 });

    // The handoff. An immediate merge is worth waiting one `gh pr view` for, so
    // the response and the event both say "merged" and whatever watches for that
    // can act. A queued merge has nothing new to report yet — GitHub lands it
    // later — so its refresh is detached and the sweep carries it from here.
    if (result.merged) await refreshPrState(id, { force: true });
    else schedulePrRefresh(id, { force: true });
    startPrPolling();

    return NextResponse.json({ ...result, pr: prView(getTask(id) ?? fresh) });
  }));
}
