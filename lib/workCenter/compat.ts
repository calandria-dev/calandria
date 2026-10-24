// Compatibility adapters over the Work Center snapshot (contract work-center/1).
//
// `/api/needs-you` rows and the per-project awaiting badges are derived from
// the snapshot's VISIBLE counts (amendment 1), so the title-bar pill, the
// project badges and the Work Center agree and today's snooze filter keeps
// working. The default scope applies: deprecated projects never count here.

import { getTask, listProjectsForWorkCenter } from "@/lib/store";
import { workCenterSequence } from "./execution";
import { assembleSnapshot } from "./snapshot";
import type { Count, Snapshot } from "./types";

export interface NeedsYouRow {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
  reason: "input" | "ci";
  pr_number: number;
  pr_url: string;
}

// Global events arrive in bursts and each one asks for a count; reuse a
// snapshot while the sequence is unchanged and the call stack that built it is
// still running. A later turn of the event loop always reassembles, because a
// source can change after the sequence it was stamped with was read, and a
// count reused past that point stays stale until the next unrelated event.
let cache: { sequence: number; snap: Snapshot } | null = null;

function globalSnapshot(): Snapshot {
  const seq = workCenterSequence();
  if (cache && cache.sequence === seq) return cache.snap;
  const snap = assembleSnapshot({ now: Date.now(), recentLimit: 1 });
  const entry = { sequence: snap.sequence, snap };
  cache = entry;
  queueMicrotask(() => {
    if (cache === entry) cache = null;
  });
  return snap;
}

const shown = (c: Count): number => c.value ?? c.known;

/** The project's visible needs-you task count: known when the exact count is unavailable. */
export function awaitingCountFor(projectId: string): number {
  const p = globalSnapshot().projects.find((x) => x.projectId === projectId);
  return p ? shown(p.summary.visibleNeedsYouTaskCount) : 0;
}

/**
 * False when the project's visible count is unavailable (value null): the
 * number from awaitingCountFor() is then only a lower bound, and a consumer
 * that kept a last known count (the desktop badge) should keep it.
 */
export function awaitingCountExactFor(projectId: string): boolean {
  const p = globalSnapshot().projects.find((x) => x.projectId === projectId);
  return p ? p.summary.visibleNeedsYouTaskCount.value !== null : true;
}

/** Visible counts for every in-scope project, for the project list. */
export function awaitingCounts(): Map<string, number> {
  return new Map(globalSnapshot().projects.map((p) => [p.projectId, shown(p.summary.visibleNeedsYouTaskCount)]));
}

/** The `/api/needs-you` rows: visible tasks with at least one unresolved item, longest-waiting first. */
export function needsYouRows(): NeedsYouRow[] {
  const snap = assembleSnapshot({ recentLimit: 1 });
  const meta = new Map(listProjectsForWorkCenter().map((p) => [p.id, p]));
  const rows: NeedsYouRow[] = [];
  for (const t of snap.tasks) {
    if (!t.attention.length) continue;
    const task = getTask(t.taskId);
    const p = meta.get(t.projectId);
    if (!task || !p) continue;
    rows.push({
      id: t.taskId,
      project_id: t.projectId,
      title: t.title,
      project_name: t.projectName,
      project_color: p.color,
      project_icon: p.icon,
      waiting_since: Math.min(...t.attention.map((a) => a.firstOccurredAt)),
      reason: t.attention.every((a) => a.kind === "ci") ? "ci" : "input",
      pr_number: task.pr_number,
      pr_url: task.pr_url,
    });
  }
  return rows.sort((a, b) => a.waiting_since - b.waiting_since);
}

/** Project ids whose visible count is unavailable right now. */
export function inexactProjectIds(): Set<string> {
  return new Set(globalSnapshot().projects.filter((p) => p.summary.visibleNeedsYouTaskCount.value === null).map((p) => p.projectId));
}
