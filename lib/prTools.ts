/* Opening a pull request, as one operation two callers share.
 *
 * `openTaskPr` is the machinery behind POST /api/tasks/[id]/pr — commit the
 * worktree, push the work branch, `gh pr create` (or return the PR the push just
 * updated), persist pr_url/pr_number and kick the first state read. The route
 * used to hold it inline; it moved here so the `create_pr` agent tool runs the
 * SAME code rather than a second implementation that drifts.
 *
 * `createPrForAgent` is the tool's policy on top of it. The reason this is a
 * server-side tool at all, rather than the model shelling out, is that the
 * sandbox classifier blocks `git push` and `gh pr create` from inside a task
 * session: the model literally cannot do it itself. The server already owns the
 * network git (lib/git.ts, plus createTaskPr's push), so this fits that seam.
 *
 * There is deliberately no merge_pr. Opening a PR is proposing; merging is
 * deciding, and .github/CLAUDE.md reserves that for a recorded human answer.
 *
 * DB + git + gh only — no driver, no agent SDK. Pinned SDK-free in
 * tests/importGraph.test.ts, because the internal agent-tools route sits on it.
 *
 * That pin is why the post-open state refresh is an INJECTED callback rather
 * than a call into lib/prState.ts. prState reaches lib/reclaim.ts (a landed PR
 * is a reclaimable checkout), reclaim reaches a launcher, and the Claude driver
 * imports this module for `create_pr` — so importing prState here would close
 * the registry → driver → … → runner → registry cycle that killed auto-start
 * in prod while dev and vitest stayed green. Each caller passes `onOpened`:
 * the two route entries their own kick, the driver `TurnHooks.onPrOpened`.
 */
import { getProject, getTask, listSummaries, updateTask } from "./store";
import { commitWorktree, taskCommitMessage } from "./git";
import { resolveBaseBranch } from "./baseBranch";
import { buildPrBody, createTaskPr, parsePrNumber, type CreatePrResult } from "./github";
import type { Project, Task } from "./types";

/**
 * Commit, push and open (or update) the task's PR, then record it on the row.
 *
 * Never throws: a failed commit comes back as `{ ok: false }` the same way every
 * createTaskPr failure does, since both are the same 409 to the caller.
 *
 * `title`/`body` override what the task would otherwise say about itself. The
 * user-facing route passes neither; the agent tool may pass both, because a
 * session that just did the work can describe it better than its own brief can.
 */
export async function openTaskPr(
  task: Task,
  project: Project,
  overrides: { title?: string; body?: string } = {},
  onOpened?: (taskId: string) => void
): Promise<CreatePrResult> {
  if (!task.worktree_path || !task.work_branch)
    return { ok: false, error: "this task has no isolated branch to open a PR from" };

  // Commit whatever's still uncommitted first (same as merge does), so the PR
  // shows the same diff the Changes tab does.
  try {
    await commitWorktree(task.worktree_path, taskCommitMessage(task));
  } catch (e) {
    return { ok: false, error: `commit failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Latest session summary (generations are ordered; last = most recent /clear).
  const summaries = listSummaries(task.id);
  const result = await createTaskPr({
    worktreePath: task.worktree_path,
    workBranch: task.work_branch,
    baseBranch: resolveBaseBranch(task, project),
    title: overrides.title?.trim() || task.title,
    body:
      overrides.body?.trim() ||
      buildPrBody({ description: task.description, summary: summaries[summaries.length - 1]?.summary, taskId: task.id }),
  });

  if (result.ok && result.url) {
    // Parse the number ONCE, here, instead of re-deriving it from the URL on
    // every render. This write is a deliberate action, so it goes through
    // updateTask and stamps updated_at — unlike the background refreshes, which
    // must not reorder the board (setTaskPrState).
    updateTask(task.id, { pr_url: result.url, pr_number: parsePrNumber(result.url) });
    // First read of the PR's actual state, detached: the caller returns now, and
    // the chip fills in over /api/events. The callback also restarts the sweep
    // that stopped itself when the last open PR landed.
    onOpened?.(task.id);
  }
  return result;
}

/**
 * The `create_pr` tool: a session says its work is finished in git, instead of
 * landing being entirely a human click.
 *
 * Own row only — no `task` parameter. Pushing another task's branch would commit
 * a checkout this session has never seen, and the "is it finished?" judgement is
 * only available from inside the session that did the work.
 *
 * `task.running` is NOT a refusal here, unlike the route's 409. The caller's own
 * turn is what's running; that guard exists to stop a human clicking Merge/PR
 * while a session is mid-edit, and this call IS the session.
 */
export async function createPrForAgent(
  caller: Task,
  input: { title?: string; body?: string },
  onOpened?: (taskId: string) => void
): Promise<{ url: string | null; text: string }> {
  const fail = (text: string) => ({ url: null, text });

  // Re-read: a detached turn's snapshot predates its own worktree cut and
  // outlives deletions, and work_branch is exactly the field that gets filled in
  // after the row was read.
  const task = getTask(caller.id);
  if (!task) return fail("Could not open a PR: this task's row no longer exists.");
  const project = getProject(task.project_id);
  if (!project) return fail("Could not open a PR: this task's project no longer exists.");

  // Gate on the landing policy. The tool isn't registered at all on a project
  // that lands by merging (lib/agents/claude/driver.ts, scripts/calandria-mcp.mjs),
  // so reaching this is either a stale registration or a direct call at the
  // endpoint; either way the answer is the same one the project's context block
  // already gave the session.
  if (project.landing_mode !== "pr")
    return fail(
      `"${project.name}" lands work by merging, not by pull request, so there is no PR to open. ` +
        `Finish the work and leave it for the user to review and merge. Nothing was pushed.`
    );

  if (!task.worktree_path || !task.work_branch)
    return fail(
      "Could not open a PR: this task has no isolated branch to open one from. Nothing was pushed."
    );

  const result = await openTaskPr(task, project, input, onOpened);
  if (!result.ok || !result.url)
    return fail(
      `Could not open a PR: ${result.error || "gh reported no URL."}${result.detail ? `\n\n${result.detail}` : ""}`
    );

  return {
    url: result.url,
    text: result.existing
      ? `Pushed ${task.work_branch}, updating the pull request that was already open: ${result.url}\n\n` +
        `The user reviews and merges it — you cannot, and there is no tool that can.`
      : `Pushed ${task.work_branch} and opened a pull request against ${resolveBaseBranch(task, project)}: ${result.url}\n\n` +
        `It is now waiting on review. Merging is the user's call — you cannot merge it, and there is no tool that can.`,
  };
}
