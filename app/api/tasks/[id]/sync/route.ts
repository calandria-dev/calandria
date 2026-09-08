import { NextResponse } from "next/server";
import { getTask, getProject, updateTask } from "@/lib/store";
import {
  worktreeSyncStatus, fastForwardWorktree, prepareWorktreeMerge, syncCommitMessage, fetchBase, remoteBaseStatus,
  rebaseWorktreeOntoBase, continueWorktreeRebase, abortWorktreeRebase,
} from "@/lib/git";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { buildConflictPrompt, buildRebaseConflictPrompt } from "@/lib/agents/shared";
import { hasTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { jsonGuard } from "@/lib/apiGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET: read-only divergence + conflict prediction for the sync banner. Computed on
// task open; mutates NOTHING (merge-tree predicts conflicts without a trial merge).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  const project = getProject(task.project_id);
  if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });
  if (!task.worktree_path || !task.work_branch) return NextResponse.json({ isolated: false });

  // The task's own base when it has one, since this response is what the
  // session's sync banner renders, so a task on feature/auth says feature/auth.
  const baseBranch = resolveBaseBranch(task, project);
  const status = await worktreeSyncStatus({
    repoPath: project.repo_path,
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch,
    baseSha: task.base_sha || undefined,
  });

  // How the task's OWN base branch stands against its remote. The project banner
  // does this for `project.branch` only, so a task based on an integration branch
  // had nothing watching origin for it. A force-push there leaves the local ref,
  // and therefore every number above, describing history that no longer exists
  // upstream. Best-effort and cooldown-coalesced, exactly as the project route
  // does it; a repo with no remote reports hasRemote: false and nothing renders.
  await fetchBase(project.repo_path, baseBranch).catch(() => {});
  const remote = await remoteBaseStatus(project.repo_path, baseBranch).catch(() => null);
  const baseRemote = remote && remote.hasRemote && !remote.unknown
    ? { label: remote.label, behind: remote.behind, ahead: remote.ahead, diverged: remote.diverged }
    : undefined;

  return NextResponse.json({
    isolated: true, baseBranch, projectBranch: project.branch,
    workBranch: task.work_branch, baseSha: task.base_sha || "",
    // The rebase offer has to warn about an open pull request before it
    // rewrites the branch under it, and the banner reads only this response.
    prState: task.pr_state, prNumber: task.pr_number,
    baseRemote, ...status,
  });
}

// The tiers this route can be asked for. `sync` is the ordinary Sync button
// (fast-forward, else merge). The three `rebase` ones are the remedy for a base
// branch whose history was rewritten under the task, where a merge is the wrong
// operation and reconciles two copies of the same work: see
// docs/design/specs/2026-09-08-rebase-onto-rewritten-base.md.
const SYNC_ACTIONS = ["sync", "rebase", "rebase-continue", "rebase-abort"] as const;
type SyncAction = (typeof SYNC_ACTIONS)[number];

// POST: actually bring the worktree up to date with the base branch. Triggered by
// the Sync button (clean merge). The fast-forward tier resolves with no separate
// step on the next follow-up message (see the messages route).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Optional body. A bodyless POST is the plain Sync click, which is what every
  // caller before the rebase tiers sent, so it has to keep meaning that.
  const body = (await req.json().catch(() => null)) as { action?: unknown; acknowledgePr?: unknown } | null;
  const action = (typeof body?.action === "string" ? body.action : "sync") as SyncAction;
  if (!SYNC_ACTIONS.includes(action))
    return NextResponse.json({ ok: false, error: `unknown sync action ${String(body?.action)}` }, { status: 400 });
  // The user was shown that this branch has an open pull request and that
  // rewriting it makes the branch non-fast-forward against its remote, and said
  // go ahead. A flag rather than a list because there is exactly one PR per
  // task, so one answer cannot stand in for several.
  const acknowledgePr = body?.acknowledgePr === true;
  // Runs under the per-task lock shared with the turn-launch path so the
  // running check stays true for the whole sync, and a turn cannot start
  // writing into the worktree while the fast-forward/merge below is
  // rewriting it.
  return jsonGuard(`sync ${id}`, () => withTaskLock(id, async () => {
    const task = getTask(id);
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (task.running || hasTurn(id))
      return NextResponse.json({ error: "task is running. Wait for the session to finish before syncing" }, { status: 409 });
    if (!task.worktree_path || !task.work_branch)
      return NextResponse.json({ error: "this task has no isolated worktree to sync" }, { status: 400 });
    const project = getProject(task.project_id);
    if (!project) return NextResponse.json({ error: "no project" }, { status: 400 });

    const baseBranch = resolveBaseBranch(task, project);

    // Discard a stopped replay. Ahead of the status read on purpose: this is
    // the way out of whatever state the worktree is in, so it must not depend
    // on that state being readable, and it is a true no-op when nothing is
    // paused.
    if (action === "rebase-abort") {
      const res = await abortWorktreeRebase(task.worktree_path);
      return NextResponse.json(res, { status: res.ok ? 200 : 409 });
    }

    const status = await worktreeSyncStatus({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      workBranch: task.work_branch,
      baseBranch,
      baseSha: task.base_sha || undefined,
    });
    // Nothing was compared, so "up to date" would be a lie, and every tier below
    // would fail against a branch git doesn't have. Refuse and name it.
    if (status.baseMissing)
      return NextResponse.json(
        { ok: false, baseMissing: true, error: `base branch ${baseBranch} not found in this repository` },
        { status: 409 }
      );
    // A stopped replay owns the worktree until it is finished or discarded.
    // Merging on top of it would commit a half-replayed tree full of markers,
    // so every other tier is refused while one is paused, and named so the
    // banner can offer the two that aren't.
    if (status.rebaseInProgress && action === "sync")
      return NextResponse.json(
        { ok: false, rebaseInProgress: true, error: "a rebase is paused in this worktree. Finish or discard it before syncing" },
        { status: 409 }
      );

    // Finish a replay whose conflicts have been resolved. The work branch now
    // holds the task's own commits rebuilt on the new base tip, so the diff
    // base moves there: everything the replay landed on came from the base, and
    // showing it as the task's own work would be wrong the same way it is after
    // a merge lands.
    if (action === "rebase-continue") {
      const res = await continueWorktreeRebase(task.worktree_path);
      if (res.done && status.baseTip) updateTask(id, { base_sha: status.baseTip });
      if (!res.ok) return NextResponse.json(res, { status: 409 });
      return NextResponse.json(
        res.done
          ? { ...res, rebased: true }
          : { ...res, rebaseInProgress: true, prompt: buildRebaseConflictPrompt(baseBranch, res.conflicts) },
        { status: 200 }
      );
    }

    if (action === "rebase") {
      // A rebase makes the branch non-fast-forward against its remote, so an
      // open PR's head can only be updated by a force-push. Nothing here
      // pushes, forced or otherwise: the branch is rewritten locally and the
      // response says what it will take to publish. But the user has to be
      // told before it happens rather than after, so an open PR refuses once
      // and carries what it would cost, and the second click acknowledges it.
      const prOpen = task.pr_state === "open" && !!task.pr_url;
      // Not asked again over a replay already stopped in the worktree: the
      // branch is mid-rewrite, so there is nothing left to consent to, and the
      // banner's "Fix with AI" comes back through here to re-read its conflicts.
      if (prOpen && !acknowledgePr && !status.rebaseInProgress)
        return NextResponse.json(
          {
            ok: false, prOpen: true, prNumber: task.pr_number, prUrl: task.pr_url,
            error: `pull request #${task.pr_number} is open on this branch. Rebasing rewrites its commits, so the PR won't update until the branch is force-pushed. Rebase anyway to go ahead`,
          },
          { status: 409 }
        );

      const res = await rebaseWorktreeOntoBase({
        repoPath: project.repo_path,
        worktreePath: task.worktree_path,
        workBranch: task.work_branch,
        baseBranch,
        baseSha: task.base_sha,
      });
      if (!res.ok) return NextResponse.json(res, { status: 409 });

      // Replayed cleanly: the task's commits now sit on the new base tip, so
      // that tip is the diff base, and `baseRewritten` stops firing because the
      // recorded cut point is reachable from the base again.
      if (res.clean) {
        if (res.onto) updateTask(id, { base_sha: res.onto });
        return NextResponse.json({
          ...res, rebased: true, baseBranch,
          ...(prOpen ? { forcePushNeeded: true, forcePushCommand: `git push --force-with-lease origin ${task.work_branch}` } : {}),
        });
      }

      // Stopped on a conflict, left in the worktree for a resolution turn. Same
      // shape the merge tier below hands back, so the client escalates the same
      // way; only the prompt and the command that finishes it differ.
      return NextResponse.json({
        ...res, rebaseInProgress: true, baseBranch,
        prompt: buildRebaseConflictPrompt(baseBranch, res.conflicts),
      });
    }

    if (status.behind === 0) return NextResponse.json({ ok: true, upToDate: true, behind: 0 });

    // Tier 1: fast-forward (no divergent work + clean tree). After it, the work
    // branch == base tip, so reset the diff base there too: the branch's changes
    // are all in the base now, so there is nothing task-specific to show.
    if (status.canFastForward) {
      const ok = await fastForwardWorktree(task.worktree_path, baseBranch);
      if (ok && status.baseTip) updateTask(id, { base_sha: status.baseTip });
      return NextResponse.json(
        { ok, fastForwarded: ok, behind: status.behind, ...(ok ? {} : { error: "fast-forward failed" }) },
        { status: ok ? 200 : 409 }
      );
    }

    // Tier 2/3: merge the base branch into the work branch inside the isolated
    // worktree, using the same prepareWorktreeMerge as conflict resolution, but
    // without the auto-land step (a sync brings the worktree up to date; it does
    // not push the task's work into main).
    const message = syncCommitMessage(baseBranch, task);
    const prep = await prepareWorktreeMerge({
      repoPath: project.repo_path,
      worktreePath: task.worktree_path,
      baseBranch,
      message,
    });
    if (!prep.ok) return NextResponse.json({ ok: false, error: prep.error }, { status: 409 });

    if (prep.clean) {
      // Merge committed cleanly: base tip is now an ancestor of HEAD, so advance the
      // diff base to it. The Changes view then shows only the task's own work on top
      // of main, not all of main's intervening commits.
      if (status.baseTip) updateTask(id, { base_sha: status.baseTip });
      return NextResponse.json({ ok: true, synced: true, behind: status.behind });
    }

    // Conflicts (prediction can be wrong at the margin): markers are now in the
    // worktree. Hand back the file lists plus a resolution prompt so the client
    // can escalate to the existing Fix-with-AI flow.
    return NextResponse.json(
      { ok: true, conflicts: prep.conflicts, binaryConflicts: prep.binaryConflicts, prompt: buildConflictPrompt(baseBranch, prep.conflicts) },
      { status: 200 }
    );
  }));
}
