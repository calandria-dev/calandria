import type { Project, Task } from "@/lib/types";
import { listTasks, getTask, updateTask, addMessage } from "@/lib/store";
import { resolveBaseBranch } from "@/lib/baseBranch";
import { baseShaRewritten, fetchBase, remoteBaseStatus } from "@/lib/git";
import { publishGlobal } from "@/lib/events";

// A landing task rebases an integration branch onto main and force-pushes it.
// Every other task cut from that branch is left pinned to history that no
// longer exists, and nothing tells them: the sync banner detects the rewrite
// (docs/design/specs/2026-09-06-rewritten-base-branch-sync.md) and the rebase
// button fixes it (2026-09-08-rebase-onto-rewritten-base.md), but both only
// mount for the task the user has open. A sibling stays silent on the board
// until somebody happens to select it.
//
// This module is the landing task's last step: it names the branch it
// rewrote, and every task still based on that branch is verified against the
// new tip and flagged. It never rebases a sibling. See
// docs/design/specs/2026-09-09-landing-task-catch-up.md for why.

/** Why a task that shares the base branch was passed over. */
export type SkipReason =
  | "terminal" //     done or cancelled: nothing left to catch up
  | "suggested" //    still in the tray, no checkout, no cut point
  | "no-checkout" //  never started, so its first launch cuts from the new tip
  | "no-cut-point" // no base_sha recorded, so nothing can be tested or replayed
  | "not-rewritten"; // its cut point is still reachable: the base moved forward

export interface RewriteSkip {
  task: Task;
  reason: SkipReason;
}

export interface RewriteSweep {
  branch: string;
  flagged: Task[];
  skipped: RewriteSkip[];
}

const TERMINAL = new Set(["done", "cancelled"]);

/**
 * Is this task's cut point gone from the base branch as it now exists?
 *
 * Both sides are asked, and either one orphans the task. The local ref alone
 * is not enough: a force-push another checkout made leaves the local branch
 * pointing at the pre-rewrite tip, and `fetchBase` writes only the tracking
 * ref, so a local-only test reports "not rewritten" in exactly the case this
 * whole feature exists for (shape 1 in
 * docs/design/specs/2026-09-06-rewritten-base-branch-sync.md). The remote
 * alone is not enough either: a repository with no remote at all still has
 * branches somebody can rebase.
 *
 * The remote side is tested against the resolved tracking tip, never the ref
 * name. A branch that was never fetched has no tracking ref, and asking
 * `merge-base --is-ancestor` about a ref that does not resolve exits the same
 * way "not an ancestor" does, which would orphan every task on a branch whose
 * remote this box has simply never seen.
 *
 * The sync banner's own `baseRewritten` stays a local-ref question, because it
 * decides whether a merge would reconcile two copies of the same work, and a
 * merge merges the local ref. This is the wider question: has this task been
 * left behind by a rewrite anywhere. Both must agree before the flag clears,
 * or a chip raised off the remote would vanish on the first read.
 */
export async function cutPointOrphaned(repoPath: string, baseSha: string, baseBranch: string): Promise<boolean> {
  if (!baseSha) return false;
  const local = await baseShaRewritten(repoPath, baseSha, baseBranch).catch(() => undefined);
  if (local === true) return true;
  const remote = await remoteBaseStatus(repoPath, baseBranch).catch(() => null);
  if (!remote?.remoteTip) return false;
  return (await baseShaRewritten(repoPath, baseSha, remote.remoteTip).catch(() => undefined)) === true;
}

const SKIP_TEXT: Record<SkipReason, string> = {
  terminal: "already finished",
  suggested: "still a suggestion, never started",
  "no-checkout": "never started, so its first launch cuts from the new tip",
  "no-cut-point": "no recorded cut point to replay from",
  "not-rewritten": "its cut point is still in the branch's history",
};

/**
 * Every task in the project that resolves to `baseBranch` and is not the
 * caller. Membership goes through resolveBaseBranch, so a task that inherits
 * the branch from its tag's `base_branch` is included by construction, which
 * is the other way tasks end up sharing a base.
 */
export function tasksOnBase(project: Project, baseBranch: string, excludeTaskId: string): Task[] {
  const want = baseBranch.trim();
  if (!want) return [];
  return listTasks(project.id).filter((t) => t.id !== excludeTaskId && resolveBaseBranch(t, project) === want);
}

/**
 * Flag every task the rewrite of `baseBranch` orphaned.
 *
 * Detection, not repair. Each flagged task keeps its own rebase decision,
 * behind its own banner and the guards that come with it: uncommitted work
 * refused, an open pull request acknowledged once, a stopped replay resolved
 * in that task's own session. Those are per-task answers, and one
 * acknowledgement cannot stand in for several.
 *
 * The caller's word is only ever which branch was rewritten. Whether a given
 * task was actually orphaned is re-derived from git, per task, with the same
 * ancestor test the sync banner uses, so a wrong or stale branch name flags
 * nothing.
 */
export async function flagBaseRewrite(opts: {
  project: Project;
  baseBranch: string;
  caller: Task;
}): Promise<RewriteSweep> {
  const { project, caller } = opts;
  const branch = opts.baseBranch.trim();
  const flagged: Task[] = [];
  const skipped: RewriteSkip[] = [];
  if (!branch) return { branch, flagged, skipped };

  // The rewrite usually reaches this box as a force-push the landing task made
  // from a scratch worktree, so the tracking ref cutPointOrphaned reads is
  // stale until this runs. Forced, because the landing task's own fetches leave
  // the per-repo cooldown warm, and a coalesced skip here would read the very
  // ref the rewrite replaced. Best-effort: a repo with no remote, or a fetch
  // that cannot reach one, falls back to the local ref alone.
  await fetchBase(project.repo_path, branch, { force: true }).catch(() => {});

  const now = Date.now();
  for (const t of tasksOnBase(project, branch, caller.id)) {
    if (t.suggested) { skipped.push({ task: t, reason: "suggested" }); continue; }
    if (TERMINAL.has(t.status)) { skipped.push({ task: t, reason: "terminal" }); continue; }
    if (!t.worktree_path || !t.work_branch) { skipped.push({ task: t, reason: "no-checkout" }); continue; }
    if (!t.base_sha) { skipped.push({ task: t, reason: "no-cut-point" }); continue; }

    if (!(await cutPointOrphaned(project.repo_path, t.base_sha, branch))) {
      skipped.push({ task: t, reason: "not-rewritten" });
      continue;
    }

    const updated = updateTask(t.id, { base_rewritten_at: now });
    // The chip says which tasks; the transcript says who did it and what to
    // run, where there is room for the command. Written at the task's current
    // generation so the note sits at the end of the session that will read it.
    addMessage(
      t.id,
      t.generation,
      "system",
      `${branch} was rewritten by the task "${caller.title}" (${caller.id}). The commit this task was cut from ` +
        `(${t.base_sha.slice(0, 12)}) is no longer in that branch's history, so syncing would merge two copies of ` +
        `the same work. Rebase instead, from the banner above or with:\n\n` +
        `git rebase --onto ${branch} ${t.base_sha.slice(0, 12)} ${t.work_branch}`
    );
    publishGlobal(t.id, { type: "task_edited" });
    flagged.push(updated ?? t);
  }
  return { branch, flagged, skipped };
}

/**
 * Drop the flag once the task is no longer behind a rewrite: it rebased, or it
 * was retargeted onto another branch. Called from the sync route's read, which
 * is the one place that already knows `baseRewritten` for this task, so the
 * chip clears itself the first time anybody looks, with no acknowledgement
 * of its own.
 *
 * Writes only when the value changes: updateTask stamps `updated_at`, the
 * board's sort key, and a status read must not float a task to the top of its
 * column every time it is opened.
 */
export function clearBaseRewriteFlag(taskId: string): void {
  const t = getTask(taskId);
  if (!t || !t.base_rewritten_at) return;
  updateTask(taskId, { base_rewritten_at: 0 });
  publishGlobal(taskId, { type: "task_edited" });
}

/** What the agent tool reports back: which tasks were flagged, and which were passed over and why. */
export function describeSweep(sweep: RewriteSweep): string {
  const { branch, flagged, skipped } = sweep;
  if (!flagged.length && !skipped.length)
    return `No other task in this project is based on ${branch}, so there was nothing to catch up.`;

  const lines: string[] = [];
  if (flagged.length) {
    lines.push(
      `Flagged ${flagged.length} task${flagged.length === 1 ? "" : "s"} still based on the pre-rewrite ${branch}:`
    );
    for (const t of flagged) lines.push(`  ${t.id}  ${t.title}`);
    lines.push(
      "",
      "Each one now shows a base-rewritten chip on the board and carries the rebase command in its transcript. " +
        "Their branches were NOT touched: a rebase rewrites history under whoever owns that task, and it has to " +
        "decide what happens to uncommitted work and to an open pull request, so each task runs its own from its " +
        "own banner."
    );
  } else {
    lines.push(`Nothing to flag: no task based on ${branch} is pinned to pre-rewrite history.`);
  }
  if (skipped.length) {
    lines.push("", `Passed over (${skipped.length}):`);
    for (const s of skipped) lines.push(`  ${s.task.id}  ${s.task.title} - ${SKIP_TEXT[s.reason]}`);
  }
  return lines.join("\n");
}
