/* Opens a pull request: the operation shared by POST /api/tasks/[id]/pr and
 * the `create_pr` agent tool. `openTaskPr` commits the worktree, pushes the
 * branch, runs `gh pr create` (or returns the existing PR), and persists
 * pr_url/pr_number. `createPrForAgent` is a server-side tool because the
 * sandbox classifier blocks `git push` and `gh pr create` from a task
 * session. `adoptExistingPr` links a PR opened by a `git push` + `gh pr
 * create` fallback, since the row otherwise never learns about it. There is
 * no merge_pr: opening is proposing, merging is a human decision. DB + git +
 * gh only, no driver or agent SDK (pinned SDK-free). The post-open refresh
 * is an injected `onOpened` callback to avoid an import cycle through the
 * registry and runner.
 */
import { getProject, getTask, listSummaries, updateTask } from "./store";
import { commitWorktree, remoteBranchExists, taskCommitMessage } from "./git";
import { resolveBaseBranch } from "./baseBranch";
import { buildPrBody, createTaskPr, findOpenPrForBranch, parsePrNumber, type CreatePrResult } from "./github";
import { publishGlobal } from "./events";
import { createLogger } from "./log.mjs";
import type { Project, Task } from "./types";

const log = createLogger("pr");

/**
 * Commits, pushes and opens (or updates) the task's PR, then records it on
 * the row.
 *
 * Never throws: a failed commit returns `{ ok: false }`, same as a
 * createTaskPr failure, since both are the same 409 to the caller.
 *
 * `title`/`body` override the task's default title and body. The user-facing
 * route passes neither; the agent tool may pass both, since the session that
 * did the work can describe it more precisely than the stored description.
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
    // Parses the number once, here, instead of re-deriving it from the URL on
    // every render. This write goes through updateTask and stamps updated_at,
    // unlike the background refreshes (setTaskPrState), which must not
    // reorder the board.
    updateTask(task.id, { pr_url: result.url, pr_number: parsePrNumber(result.url) });
    // First read of the PR's actual state, detached: the caller returns now, and
    // the chip fills in over /api/events. The callback also restarts the sweep
    // that stopped itself when the last open PR landed.
    onOpened?.(task.id);
  }
  return result;
}

/**
 * The `create_pr` tool: lets a session mark its work finished in git, instead
 * of landing depending entirely on a human click.
 *
 * Own row only, no `task` parameter. Pushing another task's branch would
 * commit a checkout this session never touched, and only the session that
 * did the work can judge whether it's finished.
 *
 * `task.running` is not a refusal here, unlike the route's 409: the caller's
 * own turn is what's running. That guard exists to stop a human clicking
 * Merge/PR while a session is mid-edit, and this call is the session.
 */
export async function createPrForAgent(
  caller: Task,
  input: { title?: string; body?: string },
  onOpened?: (taskId: string) => void
): Promise<{ url: string | null; number: number | null; text: string }> {
  const fail = (text: string) => ({ url: null, number: null, text });

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

  // Names the PR by number as well as URL. A success the model can only
  // relay by quoting a number and a link it was given cannot be claimed by
  // accident. 0 means no number was found in the URL, so report "the pull
  // request" instead of "#0".
  const number = parsePrNumber(result.url);
  const named = number ? `pull request #${number}` : "the pull request";
  return {
    url: result.url,
    number: number || null,
    text: result.existing
      ? `Pushed ${task.work_branch}, updating ${named}, which was already open: ${result.url}\n\n` +
        `The user reviews and merges it — you cannot, and there is no tool that can.`
      : `Pushed ${task.work_branch} and opened ${named} against ${resolveBaseBranch(task, project)}: ${result.url}\n\n` +
        `It is now waiting on review. Merging is the user's call — you cannot merge it, and there is no tool that can.`,
  };
}

/**
 * Links a pull request a session opened by hand.
 *
 * `create_pr` is the supported path, but it can be cut off before it reaches
 * Calandria (lib/agents/CLAUDE.md). A session that sees that failure falls
 * back to `git push` + `gh pr create`, which opens a real PR the task row
 * never learns about: pr_url and pr_number stay empty, the session header
 * shows no PR, lib/prState.ts never watches it, and auto-reclaim never
 * fires. This closes that gap by asking GitHub whether an open PR exists
 * whose head is this task's branch.
 *
 * Called at the end of every turn (lib/runner.ts). Three checks keep it
 * cheap and safe, in order:
 *
 *   1. THE ROW. A task with a pr_url, no work branch, or a merge-landing
 *      project is answered without touching git.
 *   2. THE LOCAL REF. `refs/remotes/origin/<branch>` is a rev-parse of a ref
 *      the repo already has; an unpushed branch has no PR to find, and this
 *      is the common case.
 *   3. THE EXACT HEAD. findOpenPrForBranch re-checks headRefName itself.
 *
 * Best-effort, like the network git in lib/git.ts: bounded by gh's own 30s
 * timeout, never prompting, and every failure returns null instead of
 * throwing, since this runs in a turn's finally, after the turn is already
 * over.
 */
export async function adoptExistingPr(
  taskId: string,
  onOpened?: (taskId: string) => void
): Promise<{ url: string; number: number } | null> {
  // Re-reads instead of trusting the caller's snapshot: a turn's task row is
  // minutes old by the time its finally runs, and pr_url is exactly the
  // field create_pr may have filled in while it ran.
  const task = getTask(taskId);
  if (!task || task.pr_url || !task.work_branch) return null;
  const project = getProject(task.project_id);
  if (!project || project.landing_mode !== "pr") return null;

  // The project's repo, with the worktree as the fallback, for the reason
  // lib/prState.ts gives: gh resolves the repo from origin, and refs/remotes is
  // in the common git dir, so either checkout answers both questions.
  const cwd = project.repo_path || task.worktree_path;
  if (!cwd) return null;

  try {
    if (!(await remoteBranchExists(cwd, task.work_branch))) return null;
    const found = await findOpenPrForBranch(cwd, task.work_branch);
    if (!found) return null;

    // A race is possible (create_pr landing late, or the user pasting the URL
    // in). Re-reads before writing so the adopt can't overwrite a link that
    // arrived while gh was querying github.com.
    const fresh = getTask(taskId);
    if (!fresh || fresh.pr_url) return null;

    updateTask(taskId, { pr_url: found.url, pr_number: found.number });
    log.info(`linked task ${taskId} to PR #${found.number} (${found.url}), opened outside Calandria on ${task.work_branch}`);
    // Same wire event a background PR refresh publishes: the payload can't carry
    // a PR, so listeners are told to re-read the row.
    publishGlobal(taskId, { type: "task_edited" });
    // The same kick create_pr's own success does: first state read, and it
    // restarts the sweep that stopped itself when the last open PR landed.
    onOpened?.(taskId);
    return found;
  } catch (e) {
    log.warn(`could not check task ${taskId} for a pull request opened outside Calandria: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
