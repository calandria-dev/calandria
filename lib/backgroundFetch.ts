import { listProjectsPlain } from "@/lib/store";
import { backgroundJobsEnabled } from "@/lib/backgroundJobs";
import { BACKGROUND_FETCH_INTERVAL_MS, GIT_FETCH_ENABLED } from "@/lib/config";
import { advanceBaseBranch, fetchBase, remoteBaseStatus, worktreeForBranch, worktreeIsDirty } from "@/lib/git";
import type { Project } from "@/lib/types";

/**
 * The per-project "Fetch in the background" setting (`projects.background_fetch`).
 *
 * Rides the scheduler's ticker (lib/scheduler.ts). Each due project gets its
 * base branch fetched, and the local base branch fast-forwarded to the fetched
 * tip when that is safe: it is only behind, and the checkout holding it (if
 * any) has no uncommitted changes. A diverged or ahead branch is left alone;
 * the base-branch banner reports it.
 *
 * Gated by the instance's `background_jobs` setting and CALANDRIA_GIT_FETCH.
 * Every failure is logged and swallowed: a dead remote must not stop the
 * ticker or the next project's fetch.
 */

export type BackgroundFetchOutcome =
  | { project: string; fetched: false; reason: string }
  | { project: string; fetched: true; advanced: boolean; reason?: string };

interface FetchState {
  sweeping: boolean;
  lastRun: Map<string, number>;
}

const g = globalThis as unknown as { __calandriaBackgroundFetch?: FetchState };
function state(): FetchState {
  return (g.__calandriaBackgroundFetch ??= { sweeping: false, lastRun: new Map() });
}

/** Fetch one project's base branch and fast-forward it when that is safe. */
export async function backgroundFetchProject(project: Project): Promise<BackgroundFetchOutcome> {
  const id = project.id;
  if (!project.repo_path.trim() || !project.branch.trim()) return { project: id, fetched: false, reason: "no repository" };
  const fetched = await fetchBase(project.repo_path, project.branch, { force: true });
  if (!fetched.attempted) return { project: id, fetched: false, reason: "fetching is off" };
  if (!fetched.ok) return { project: id, fetched: false, reason: fetched.error || "fetch failed" };

  const status = await remoteBaseStatus(project.repo_path, project.branch);
  if (!status.canFastForward || !status.remoteTip) return { project: id, fetched: true, advanced: false };

  const holder = await worktreeForBranch(project.repo_path, project.branch);
  if (holder && !holder.isMain)
    return { project: id, fetched: true, advanced: false, reason: `${project.branch} is checked out in ${holder.path}` };
  if (holder && (await worktreeIsDirty(holder.path)))
    return { project: id, fetched: true, advanced: false, reason: "the checkout has uncommitted changes" };

  const res = await advanceBaseBranch(project.repo_path, project.branch, status.remoteTip);
  return res.ok
    ? { project: id, fetched: true, advanced: true }
    : { project: id, fetched: true, advanced: false, reason: res.error };
}

/**
 * One pass over every project with the setting on whose interval has elapsed.
 * Single-flight and sequential: fetches hit the network and take repo locks.
 */
export async function sweepBackgroundFetch(now = Date.now()): Promise<BackgroundFetchOutcome[]> {
  const s = state();
  if (s.sweeping) return [];
  if (!GIT_FETCH_ENABLED || BACKGROUND_FETCH_INTERVAL_MS <= 0 || !backgroundJobsEnabled()) return [];
  s.sweeping = true;
  const out: BackgroundFetchOutcome[] = [];
  try {
    for (const project of listProjectsPlain()) {
      if (project.background_fetch !== 1 || project.deprecated === 1) continue;
      const last = s.lastRun.get(project.id) ?? 0;
      if (now - last < BACKGROUND_FETCH_INTERVAL_MS) continue;
      s.lastRun.set(project.id, now);
      try {
        const res = await backgroundFetchProject(project);
        if (res.fetched && res.advanced) console.log(`[background-fetch] ${project.name}: fast-forwarded ${project.branch}`);
        out.push(res);
      } catch (err) {
        console.error(`[background-fetch] ${project.name} failed:`, err);
      }
    }
  } finally {
    s.sweeping = false;
  }
  return out;
}

/** Test seam: forget when each project last fetched. */
export function resetBackgroundFetchState(): void {
  state().lastRun.clear();
}
