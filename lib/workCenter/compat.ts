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
// snapshot while neither the sequence nor a second of wall time has moved.
let cache: { sequence: number; at: number; snap: Snapshot } | null = null;

function globalSnapshot(): Snapshot {
  const now = Date.now();
  const seq = workCenterSequence();
  if (cache && cache.sequence === seq && now - cache.at < 1000) return cache.snap;
  const snap = assembleSnapshot({ now, recentLimit: 1 });
  cache = { sequence: snap.sequence, at: now, snap };
  return snap;
}

const shown = (c: Count): number => c.value ?? c.known;

/** The project's visible needs-you task count: known when the exact count is unavailable. */
export function awaitingCountFor(projectId: string): number {
  const p = globalSnapshot().projects.find((x) => x.projectId === projectId);
  return p ? shown(p.summary.visibleNeedsYouTaskCount) : 0;
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
