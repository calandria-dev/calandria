// Keeps a task's GitHub PR state fresh: polls `gh pr view` per task as a
// detached job (per CLAUDE.md), persists the result, and publishes it on the
// bus so the board and session rail update without client polling.
//
// refreshPrState() returns early inside PR_STALE_MS unless forced. Terminal
// states (merged/closed) are never re-polled. With no watchers, the sweep
// continues for auto_reclaim projects and skips other projects. Statically SDK-free (DYNAMIC_ONLY in
// tests/importGraph.test.ts): a merged PR reaches the runner via
// lib/reclaim.ts's `await import()`.

import { getProject, getTask, setTaskPrState, setTaskPrEvidence, setTaskPrAttempt, stalePrTasks, openPrTaskCount, openAutoReclaimPrTaskCount } from "./store";
import { fetchPrState, fetchCheckEvidence, type PrFailingCheck, type PrSnapshot } from "./github";
import { maybeAutoReclaim } from "./reclaim";
import { onPrSettled } from "./reviews/landing";
import { publishGlobal, watcherCount } from "./events";
import { PR_POLL_BATCH, PR_POLL_MS, PR_STALE_MS } from "./config";
import type { Task } from "./types";
import { canonicalJson, selectLatest, stepEpisode } from "./workCenter/ciEvidence";

// Tracks refreshes running in this process, so a double click, a remount and
// the sweep landing on the same task at once share one subprocess. Module
// scoped per server, like lib/contextRefresh.ts.
const inFlight = new Set<string>();

/** Is a refresh for this task running right now? (The UI's spinner.) */
export function isRefreshingPr(taskId: string): boolean {
  return inFlight.has(taskId);
}

/** What the client renders: the persisted snapshot, nothing recomputed. */
export interface PrView {
  url: string;
  number: number;
  state: string;
  checks: string;
  review: string;
  merged_at: number;
  synced_at: number;
  /** 1 while the PR is a draft: open, but not mergeable. */
  draft: number;
  /** gh's mergeStateStatus (CLEAN / BLOCKED / DIRTY / BEHIND / UNSTABLE; "" = unknown). */
  merge_state: string;
  refreshing: boolean;
  /** The red checks, parsed out of tasks.pr_failing. Empty unless checks = "failing". */
  failing: PrFailingCheck[];
}

/**
 * The red checks stored on a task row. The column may be missing (an older
 * build never wrote it) or malformed (a hand-edited database), so a bad
 * value returns an empty list instead of throwing inside a task list render.
 */
export function parseFailingChecks(json: string): PrFailingCheck[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as PrFailingCheck[]) : [];
  } catch {
    return [];
  }
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
    draft: task.pr_draft,
    merge_state: task.pr_merge_state,
    refreshing: inFlight.has(task.id),
    failing: parseFailingChecks(task.pr_failing),
  };
}

// The red-check list as it is stored: gh's own order, so a rollup that hasn't
// moved serializes identically and `changed()` returns false.
function serializeFailing(snap: PrSnapshot): string {
  return snap.failing.length ? JSON.stringify(snap.failing) : "";
}

// pr_synced_at moves on every refresh, so comparing whole rows would publish
// a "task changed" event on every poll. Only facts visible to the user count
// as a change: PR state, checks, review, merge time, draft flag, merge
// state, and which specific checks are failing.
function changed(task: Task, snap: PrSnapshot): boolean {
  return (
    task.pr_state !== snap.state ||
    task.pr_checks !== snap.checks ||
    task.pr_review !== snap.review ||
    task.pr_merged_at !== snap.mergedAt ||
    task.pr_draft !== (snap.draft ? 1 : 0) ||
    task.pr_merge_state !== snap.mergeState ||
    task.pr_failing !== serializeFailing(snap)
  );
}

export type RefreshOutcome =
  | { ok: true; changed: boolean; view: PrView }
  | { ok: false; reason: "no_pr" | "busy" | "fresh" | "no_repo" | "failed"; error?: string };

/**
 * Re-read one task's PR from GitHub and persist what came back.
 *
 * Never throws: every caller is a fire-and-forget trigger. A dead network, a
 * logged-out gh, or a deleted PR comes back as a reported outcome instead of
 * an unhandled rejection in a detached job.
 *
 * `force` skips the freshness window. The explicit Refresh button and the
 * sweep pass it, since both have already decided the answer is stale.
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
      // A failed ask is not a changed PR: the last coherent snapshot stays,
      // and pr_synced_at stays the last SUCCESSFUL observation. The attempt
      // and its error are recorded separately, which backs a repo GitHub
      // can't answer for off to the sweep interval (stalePrTasks reads the
      // attempt stamp) and marks the Work Center's CI freshness stale at once.
      setTaskPrAttempt(taskId, now, res.error.slice(0, 500));
      if (task.pr_refresh_error !== res.error.slice(0, 500)) publishGlobal(taskId, { type: "task_edited" });
      return { ok: false, reason: "failed", error: res.error };
    }

    const snap = res.snapshot;
    const moved = changed(task, snap);
    const evidenceMoved = await recordCiEvidence(task, cwd, snap.checks, now);
    setTaskPrAttempt(taskId, now, null);
    const row = setTaskPrState(taskId, {
      state: snap.state,
      checks: snap.checks,
      review: snap.review,
      merged_at: snap.mergedAt,
      synced_at: now,
      draft: snap.draft ? 1 : 0,
      merge_state: snap.mergeState,
      failing: serializeFailing(snap),
    });
    // A merged PR whose head is the head a person accepted proves that landing;
    // a closed one fails any review merge still waiting on it. Awaited so the
    // receipt exists before reclaim (below) asks whether the task may complete.
    if (snap.state === "merged" || snap.state === "closed") {
      await onPrSettled(taskId, { state: snap.state, headSha: snap.headSha ?? "", mergeCommitSha: snap.mergeCommitSha ?? "", baseRef: snap.baseRef ?? "" });
    }
    // task_edited tells listeners to re-read the row, since the coarse wire
    // payload can't carry pr_state or a check rollup. Published only on a
    // real change (see changed()).
    if (moved || evidenceMoved || task.pr_refresh_error) publishGlobal(taskId, { type: "task_edited" });
    // A PR reporting `merged` signals that this task's checkout is disposable
    // (lib/reclaim.ts). Fire-and-forget and a no-op unless the project opted
    // in. Guarded on the snapshot, so a forced refresh of an already-merged
    // PR still finishes an interrupted reclaim; terminal states are never
    // re-polled, so this cannot loop.
    if (snap.state === "merged") maybeAutoReclaim(taskId);
    return { ok: true, changed: moved, view: prView(row ?? task)! };
  } finally {
    inFlight.delete(taskId);
  }
}

/**
 * Persist the structured check evidence and step the CI episode (Work Center).
 * A rollup that is not failing settles the episode outright. A failing one
 * reads the structured checks; a read that fails or is incomplete keeps
 * whatever episode was stored, because a torn response must never clear a red
 * episode. Returns whether the stored episode identity moved.
 */
async function recordCiEvidence(task: Task, cwd: string, checks: string, now: number): Promise<boolean> {
  const prev = { episodeId: task.pr_ci_episode_id, fingerprint: task.pr_ci_episode_fingerprint, startedAt: task.pr_ci_episode_started_at };
  if (checks !== "failing") {
    if (!prev.episodeId) return false;
    setTaskPrEvidence(task.id, { head_sha: task.pr_head_sha, repository_id: task.pr_repository_id, episode_id: null, episode_fingerprint: null, snapshot_json: null, episode_started_at: null });
    return true;
  }
  const ev = await fetchCheckEvidence(cwd, task.pr_number);
  if (!ev.ok) return false;
  const step = stepEpisode(prev, { headSha: ev.headSha, checks: ev.checks, complete: ev.complete }, now);
  if (!step.authoritative) {
    // Keep the episode, learn the head.
    if (ev.headSha !== task.pr_head_sha) setTaskPrEvidence(task.id, { head_sha: ev.headSha, repository_id: ev.repositoryId || task.pr_repository_id, episode_id: prev.episodeId, episode_fingerprint: prev.fingerprint, snapshot_json: task.pr_ci_snapshot_json, episode_started_at: prev.startedAt });
    return false;
  }
  setTaskPrEvidence(task.id, {
    head_sha: ev.headSha,
    repository_id: ev.repositoryId,
    episode_id: step.episodeId,
    episode_fingerprint: step.fingerprint,
    snapshot_json: canonicalJson(selectLatest(ev.checks)),
    episode_started_at: step.startedAt,
  });
  return step.episodeId !== prev.episodeId;
}

/**
 * Kicks a refresh and returns immediately, so a request never waits on a
 * network round trip to github.com. Used by PR creation, opening a task, and
 * the sweep.
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
  if (openPrTaskCount() === 0) return; // nothing to watch; starts again when a PR appears
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
 * One pass: refreshes up to PR_POLL_BATCH open PRs that nobody has looked at
 * within PR_POLL_MS, oldest first. Sequential, since each refresh is a
 * subprocess and a network call and a pass should spread the load instead of
 * forking every gh process at once.
 *
 * Exported so a test can drive a pass without waiting on the interval.
 */
export async function sweepPrs(): Promise<number> {
  const s = state();
  if (s.sweeping) return 0; // a slow pass must not overlap the next tick
  s.sweeping = true;
  try {
    if (openPrTaskCount() === 0) {
      stopPrPolling(); // every PR has landed; the next one restarts polling
      return 0;
    }
    // With no browser open, only projects that opted into automatic reclaim
    // need an answer. Keep the no-watcher optimization for every other PR.
    const unattended = watcherCount() === 0;
    if (unattended && openAutoReclaimPrTaskCount() === 0) return 0;
    const due = stalePrTasks(Date.now() - PR_POLL_MS, PR_POLL_BATCH, { autoReclaimOnly: unattended });
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
