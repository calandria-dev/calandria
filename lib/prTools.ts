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
 * `adoptExistingPr` is the repair for the case where neither of them ran: a
 * session whose `create_pr` call was cut off falls back to `git push` +
 * `gh pr create`, which opens a real PR that this row knows nothing about. It
 * lives here because linking a PR to a task is this module's job either way.
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
import { commitWorktree, remoteBranchExists, taskCommitMessage } from "./git";
import { resolveBaseBranch } from "./baseBranch";
import { buildPrBody, createTaskPr, findOpenPrForBranch, parsePrNumber, type CreatePrResult } from "./github";
import { publishGlobal } from "./events";
import { createLogger } from "./log.mjs";
import type { Project, Task } from "./types";

const log = createLogger("pr");

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

  // Name the PR by NUMBER as well as URL. This tool is the one way a session says
  // in git that its work is finished, and it has twice come back empty mid-turn
  // while the session went on to report a PR that did not exist. A success the
  // model can only relay by quoting a number and a link it was given is a success
  // it cannot claim by accident. 0 = no number in the URL, which shouldn't happen
  // for a GitHub PR link, so say "the pull request" rather than "#0".
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
 * Link a pull request the SESSION opened by hand.
 *
 * `create_pr` is the supported path, but it can be cut off before it reaches
 * Calandria at all (lib/agents/CLAUDE.md, "Tool results the CLI answers on its
 * own behalf"), and a session that sees that failure falls back to `git push` +
 * `gh pr create`. That works — the PR is real and CI runs on it — but the task
 * row never hears about it: pr_url and pr_number stay empty, the session header
 * shows no PR, lib/prState.ts never watches it, and auto-reclaim can never fire,
 * so the user relinks it by hand. This closes that gap by asking GitHub the one
 * question that settles it: does an open PR exist whose head is this task's
 * branch?
 *
 * Called at the end of every turn (lib/runner.ts), which is where the fallback
 * has just happened. Three screens keep that cheap and safe, in the order they
 * bite:
 *
 *   1. THE ROW. A task that already has a pr_url, has no work branch, or whose
 *      project lands by merging is answered without touching git — a merge
 *      project's branch is not supposed to become a PR, and adopting one there
 *      would put a chip on a task whose work lands another way.
 *   2. THE LOCAL REF. `refs/remotes/origin/<branch>` is a rev-parse of a ref the
 *      repo already has. Nobody pushed the branch means nobody opened a PR for
 *      it, and that is the common case: without this gate every turn of every
 *      un-pushed task would fork gh and call github.com for a "no".
 *   3. THE EXACT HEAD. findOpenPrForBranch re-checks headRefName itself.
 *
 * Best-effort throughout, like the network git in lib/git.ts: bounded by gh's
 * own 30s timeout, never prompting, and every failure is silence rather than a
 * throw — this runs in a turn's finally, where the turn is already over and
 * there is nobody to tell.
 */
export async function adoptExistingPr(
  taskId: string,
  onOpened?: (taskId: string) => void
): Promise<{ url: string; number: number } | null> {
  // Re-read rather than trusting a caller's snapshot: a turn's task row is
  // minutes old by the time its finally runs, and pr_url is exactly the field
  // create_pr may have filled in while it ran.
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

    // Somebody may have raced us (create_pr landing late, the user pasting the
    // URL in). Re-read before writing so the adopt can't overwrite a link that
    // arrived while gh was talking to github.com.
    const fresh = getTask(taskId);
    if (!fresh || fresh.pr_url) return null;

    updateTask(taskId, { pr_url: found.url, pr_number: found.number });
    log.info(`linked task ${taskId} to PR #${found.number} (${found.url}), opened outside Calandria on ${task.work_branch}`);
    // Same wire event a background PR refresh publishes: the payload can't carry
    // a PR, so listeners are told to re-read the row.
    publishGlobal(taskId, { type: "task_edited" });
    // And the same kick create_pr's own success does — first state read, and it
    // restarts the sweep that stopped itself when the last open PR landed.
    onOpened?.(taskId);
    return found;
  } catch (e) {
    log.warn(`could not check task ${taskId} for a pull request opened outside Calandria: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
