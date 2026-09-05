// Tells a session, at the top of its opening turn, that its worktree was cut
// from a stale branch.
//
// A task under a tag with a `base_branch` has its worktree cut from that
// branch (resolveBaseBranch, lib/baseBranch.ts -> ensureWorktree, lib/git.ts).
// When that branch has fallen behind the project default, the checkout is
// missing everything that landed in between, and nothing in the session's
// context says so, so a PR it opens can read as reverting that work. The cut
// records a note and the opening turn's context states it
// (buildProjectContext, lib/agents/shared.ts):
//
//   - The drift number comes from `branchDriftStatus`, the same function the
//     tag UI reports from, so the two numbers can't disagree.
//   - No network: `ensureWorktree` already does a best-effort `fetchBase`
//     with a hard timeout and a per-repo cooldown just before the cut; this
//     rides it and reads local refs only.
//   - An answer that can't be established produces no note: unknown, missing
//     counts and any throw all produce nothing, since slowing down or
//     failing a launch over an advisory line is worse than the line being
//     absent.
//
// It never blocks or refuses the launch: being stacked on another branch is
// a legitimate reason to be behind the default. The point is that the
// session finds out.

import { branchDriftStatus } from "./git";

// Notes live in memory, keyed by task id, on globalThis so HMR doesn't drop them
// between the cut and the turn (the same reason lib/events.ts and lib/asks.ts do).
// Not persisted: the note describes one cut, the numbers in it go stale the
// moment anyone syncs, and a durable copy would keep re-asserting a drift
// that has since been fixed. It dies with the process, exactly like the cut
// it reports on.
interface DriftRegistry {
  notes: Map<string, string>;
}

function registry(): DriftRegistry {
  const g = globalThis as typeof globalThis & { __calandriaBaseCutNotes?: DriftRegistry };
  if (!g.__calandriaBaseCutNotes) g.__calandriaBaseCutNotes = { notes: new Map() };
  return g.__calandriaBaseCutNotes;
}

/** The requested base branch does not exist, so the cut fell back to
 *  whatever HEAD was. Said outright: a tag pinned to a deleted branch otherwise
 *  gives the task the wrong base with no error and no log line. */
export function missingBaseLine(requested: string, projectDefault: string): string {
  const fallback = projectDefault ? ` (probably ${projectDefault})` : "";
  return (
    `⚠ Base branch missing: this task is configured to branch from "${requested}", but no such branch ` +
    `exists in this repo, so the worktree was cut from whatever HEAD pointed at${fallback} instead. ` +
    `Nothing is broken, but the branch you are on is not the one the task's tag names — say so in your ` +
    `summary, and have the user clear or repoint that tag's base branch rather than trying to recreate ` +
    `the branch yourself.`
  );
}

/** The base branch exists but is behind the project default. */
export function staleBaseLine(base: string, projectDefault: string, behind: number, ahead: number): string {
  const commits = behind === 1 ? "1 commit" : `${behind} commits`;
  const own = ahead > 0 ? ` It also carries ${ahead === 1 ? "1 commit" : `${ahead} commits`} of its own.` : "";
  return (
    `⚠ Stale base branch: this worktree was cut from "${base}", which is ${commits} behind the project ` +
    `default "${projectDefault}".${own} Everything that landed on ${projectDefault} in between is MISSING ` +
    `from this checkout, so a pull request from here can read as REVERTING that work and will show up ` +
    `dirty. Do not rebase, reset or cherry-pick by hand to fix it — the supported fix is to Sync ` +
    `"${base}" with "${projectDefault}". If the missing work matters to what you were asked to do, say ` +
    `so and ask for that Sync before you write the PR; otherwise carry on and mention it in your summary.`
  );
}

/**
 * Record what the cut actually got, for the next `buildProjectContext` to state.
 * Called by every launch path right after `ensureWorktree`, whose result already
 * carries the base it USED (`baseBranch`, "" when the requested one didn't exist),
 * so the resolved-vs-requested mismatch needs no re-deriving here.
 *
 * Resolves to nothing at all in the overwhelmingly common case: a task on the
 * project default has no second branch to be behind, so the two local git reads
 * are only ever paid by a task that really is on a branch of its own.
 */
export async function recordBaseCut(input: {
  taskId: string;
  repoPath: string;
  /** What `resolveBaseBranch` asked for. */
  requestedBase: string;
  /** What `ensureWorktree` reports it cut from; "" means it fell back to HEAD. */
  cutBase: string;
  /** `project.branch`. */
  projectDefault: string;
}): Promise<void> {
  const { taskId, repoPath, requestedBase, cutBase, projectDefault } = input;
  try {
    if (!requestedBase) return; // nothing was asked for, so nothing was missed
    if (!cutBase) {
      registry().notes.set(taskId, missingBaseLine(requestedBase, projectDefault));
      return;
    }
    // On the project default there is no drift to report by definition, and this
    // is the path nearly every task takes; return before touching git.
    if (!projectDefault || cutBase === projectDefault) return;

    const drift = await branchDriftStatus(repoPath, cutBase, projectDefault);
    if (drift.unknown || !drift.exists || drift.behind <= 0) return;
    registry().notes.set(taskId, staleBaseLine(cutBase, projectDefault, drift.behind, drift.ahead));
  } catch {
    // Advisory only. A launch must never slow down or fail because the drift
    // check couldn't resolve.
  }
}

/**
 * Take the pending note for a task, if any, and clear it. Clearing it means
 * it lands in the OPENING turn after the cut and not in every turn
 * thereafter: the drift is a fact about that cut, its numbers age, and a
 * session that has already been told once doesn't need telling again on
 * every follow-up message.
 */
export function takeBaseCutNote(taskId: string): string {
  const notes = registry().notes;
  const note = notes.get(taskId) ?? "";
  notes.delete(taskId);
  return note;
}
