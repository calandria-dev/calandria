// Keeping a task's GitHub PR state fresh.
//
// tasks.pr_url used to be write-once display data: "Create PR" stored a URL and
// nothing ever asked GitHub about it again, so the app could not tell you
// whether the PR was open, red, approved, merged or closed — and therefore
// could not do anything useful after the PR existed. This module is the other
// half: one `gh pr view` per task, run as a DETACHED job (never a held HTTP
// request, per CLAUDE.md), persisted, and announced on the bus so the board and
// the session rail update without polling.
//
// Three rules keep it cheap, in the order they bite:
//
//   1. FRESHNESS. Every trigger goes through refreshPrState(), which returns
//      early inside PR_STALE_MS unless forced. Opening the same task ten times
//      is one fetch, exactly like lib/git.ts's fetch cooldown.
//   2. TERMINAL STATES ARE NEVER RE-POLLED. A merged or closed PR cannot change
//      back, so the sweep's candidate set is bounded by OPEN work rather than by
//      how many PRs this instance has ever opened.
//   3. PRESENCE. The sweep skips a pass with no browser tab watching
//      (watcherCount()), the same heuristic the permission gate uses. Nobody can
//      see a chip nothing is rendering, and an idle instance must not fork gh
//      forever — the create/open/click triggers still work with no tab, because
//      each of them IS a client.
//
// Statically SDK-free, which is what the PR routes that call it need — they are
// ordinary sync-compiled route entries. It is in tests/importGraph.test.ts's
// DYNAMIC_ONLY set rather than PINNED for one edge: a merged PR hands off to
// lib/reclaim.ts, whose dependent auto-start sweep reaches the runner through
// `await import()`. Same guarantee (no static path to an SDK), reached the way
// lib/autoStart.ts's own importers reach it.

import { getProject, getTask, setTaskPrState, stalePrTasks, openPrTaskCount } from "./store";
import { fetchPrState, type PrSnapshot } from "./github";
import { maybeAutoReclaim } from "./reclaim";
import { publishGlobal, watcherCount } from "./events";
import { PR_POLL_BATCH, PR_POLL_MS, PR_STALE_MS } from "./config";
import type { Task } from "./types";

// Refreshes genuinely executing in THIS process, so a double click, a remount
// and the sweep landing on the same task at once cost one subprocess rather
// than three. Module-level = per server, like lib/contextRefresh.ts's.
const inFlight = new Set<string>();

/** Is a refresh for this task running right now? (The UI's spinner.) */
export function isRefreshingPr(taskId: string): boolean {
  return inFlight.has(taskId);
}

/** What the client renders — the persisted snapshot, nothing recomputed. */
export interface PrView {
  url: string;
  number: number;
  state: string;
  checks: string;
  review: string;
  merged_at: number;
  synced_at: number;
  refreshing: boolean;
}

/** The stored PR state for a task, or null when it has no PR. */
export function prView(task: Task): PrView | null {
  if (!task.pr_url) return null;
  return {
    url: task.pr_url,
    number: task.pr_number,
    state: task.pr_state,
    checks: task.pr_checks,
    review: task.pr_review,
    merged_at: task.pr_merged_at,
    synced_at: task.pr_synced_at,
    refreshing: inFlight.has(task.id),
  };
}

// Did GitHub actually tell us something new? pr_synced_at moves on EVERY
// refresh, so comparing whole rows would publish a "the task changed" event
// every five minutes forever and have every tab refetch its tray for nothing.
// Only the four facts a human can see count as a change.
function changed(task: Task, snap: PrSnapshot): boolean {
  return (
    task.pr_state !== snap.state ||
    task.pr_checks !== snap.checks ||
    task.pr_review !== snap.review ||
    task.pr_merged_at !== snap.mergedAt
  );
}

export type RefreshOutcome =
  | { ok: true; changed: boolean; view: PrView }
  | { ok: false; reason: "no_pr" | "busy" | "fresh" | "no_repo" | "failed"; error?: string };

/**
 * Re-read one task's PR from GitHub and persist what came back.
 *
 * Never throws: every caller is a fire-and-forget trigger, and a dead network,
 * a logged-out gh or a deleted PR must come back as a reported outcome rather
 * than an unhandled rejection in a detached job.
 *
 * `force` skips the freshness window — it is what the explicit Refresh button
 * and the sweep pass, since both have already decided the answer is stale.
 */
export async function refreshPrState(taskId: string, opts: { force?: boolean } = {}): Promise<RefreshOutcome> {
  const task = getTask(taskId);
  if (!task || !task.pr_url || !task.pr_number) return { ok: false, reason: "no_pr" };
  if (inFlight.has(taskId)) return { ok: false, reason: "busy" };
  if (!opts.force && task.pr_synced_at && Date.now() - task.pr_synced_at < PR_STALE_MS)
    return { ok: true, changed: false, view: prView(task)! };

  // The PROJECT's repo, not the task's worktree: gh resolves the repo from the
  // origin remote, and a task's checkout is reclaimable (lib/worktreeSweep.ts)
  // while its PR is still worth tracking. The worktree is the fallback for a
  // project whose repo_path has moved out from under it.
  const project = getProject(task.project_id);
  const cwd = project?.repo_path || task.worktree_path;
  if (!cwd) return { ok: false, reason: "no_repo" };

  inFlight.add(taskId);
  try {
    const res = await fetchPrState(cwd, task.pr_number);
    const now = Date.now();
    if (!res.ok) {
      // Stamp the clock even on failure, so a repo GitHub can't answer for
      // (no network, a deleted PR) backs off to the sweep's interval instead of
      // being retried by every tick. The last good snapshot is left intact —
      // "we couldn't ask" is not the same as "the PR changed".
      setTaskPrState(taskId, {
        state: task.pr_state,
        checks: task.pr_checks,
        review: task.pr_review,
        merged_at: task.pr_merged_at,
        synced_at: now,
      });
      return { ok: false, reason: "failed", error: res.error };
    }

    const snap = res.snapshot;
    const moved = changed(task, snap);
    const row = setTaskPrState(taskId, {
      state: snap.state,
      checks: snap.checks,
      review: snap.review,
      merged_at: snap.mergedAt,
      synced_at: now,
    });
    // task_edited is the "refetch the row" event, which is exactly right here:
    // the coarse wire payload can't carry pr_state or a check rollup, so
    // listeners are told to re-read rather than handed a field they'd have to
    // learn. Published only on a real change (see changed()).
    if (moved) publishGlobal(taskId, { type: "task_edited" });
    // A PR reporting `merged` is the definitive signal that this task's checkout
    // is disposable (lib/reclaim.ts). Fire-and-forget, and a no-op unless the
    // project opted in — this must not turn a poll into a git teardown for
    // everybody. Guarded on the SNAPSHOT rather than on `moved`, since a forced
    // refresh of an already-merged PR should still finish an interrupted
    // reclaim; rule 2 above means it can never become a loop.
    if (snap.state === "merged") maybeAutoReclaim(taskId);
    return { ok: true, changed: moved, view: prView(row ?? task)! };
  } finally {
    inFlight.delete(taskId);
  }
}

/**
 * Kick a refresh and return immediately. This is the shape every trigger wants:
 * creating a PR, opening a task and the sweep all want the fetch to happen
 * without a request waiting on a network round trip to github.com.
 */
export function schedulePrRefresh(taskId: string, opts: { force?: boolean } = {}): void {
  void refreshPrState(taskId, opts).catch((e) => {
    console.error(`[pr] refresh for task ${taskId} failed:`, e);
  });
}

// ---------- the bounded sweep ----------

interface PollState {
  timer: ReturnType<typeof setInterval> | null;
  sweeping: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __calandriaPrPoll: PollState | undefined;
}

function state(): PollState {
  if (!global.__calandriaPrPoll) global.__calandriaPrPoll = { timer: null, sweeping: false };
  return global.__calandriaPrPoll;
}

/** Is the sweep ticking? (Exported for tests and for the health surface.) */
export function prPollingActive(): boolean {
  return state().timer !== null;
}

/**
 * Start the sweep if it isn't already running and there is anything to sweep.
 * Idempotent, so every trigger can call it: the boot self-ping starts it for
 * PRs that already existed, and creating one restarts a ticker that stopped
 * itself when the last open PR landed.
 */
export function startPrPolling(): void {
  if (PR_POLL_MS <= 0) return; // explicitly disabled
  const s = state();
  if (s.timer) return;
  if (openPrTaskCount() === 0) return; // nothing to watch — start again when a PR appears
  s.timer = setInterval(() => { void sweepPrs(); }, PR_POLL_MS);
  // Never hold the process open on the ticker alone (same rule as the scheduler).
  s.timer.unref?.();
}

export function stopPrPolling(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/**
 * One pass: refresh up to PR_POLL_BATCH open PRs that nobody has looked at
 * within PR_POLL_MS, oldest first. Sequential — each is a subprocess and a
 * network call, and a board with forty open PRs should spread them over passes
 * rather than fork forty gh processes at once.
 *
 * Exported so a test can drive a pass without waiting on the interval.
 */
export async function sweepPrs(): Promise<number> {
  const s = state();
  if (s.sweeping) return 0; // a slow pass must not overlap the next tick
  s.sweeping = true;
  try {
    if (openPrTaskCount() === 0) {
      stopPrPolling(); // every PR has landed; the next one restarts us
      return 0;
    }
    // Rule 3: nobody is watching, so nothing would render the answer. The clock
    // keeps ticking (cheap: two counting queries) and the first tab to open
    // triggers its own refresh on the task it selects.
    if (watcherCount() === 0) return 0;
    const due = stalePrTasks(Date.now() - PR_POLL_MS, PR_POLL_BATCH);
    let n = 0;
    for (const task of due) {
      const res = await refreshPrState(task.id, { force: true });
      if (res.ok) n++;
    }
    return n;
  } finally {
    s.sweeping = false;
  }
}
