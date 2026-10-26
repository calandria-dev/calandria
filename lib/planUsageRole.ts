import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/store";
import { GATEWAY_PLAN_ID, type PlanUsageSnapshot } from "@/lib/types";

// Weekly peak history behind an agent's primary/occasional role. A primary
// agent is one the person depends on and gets underuse nudges; an occasional
// one is only told about limits and pace. SDK-free: the route and the
// retention sweep both reach it.

/** Peak weekly utilization (percent) at or above which an agent counts as primary. */
export const PRIMARY_PEAK_THRESHOLD = 40;

/** Rows older than this are pruned per agent (lib/retention.ts). */
export const PLAN_USAGE_WEEKS_KEEP_MS = 8 * 7 * 24 * 60 * 60 * 1000;

export type PlanUsageRole = NonNullable<PlanUsageSnapshot["role"]>;
export type PlanUsageRolePin = "primary" | "occasional";

export function planUsageRoleKey(agent: string): string {
  return `plan_usage_role:${agent}`;
}

/** The user's pin for an agent, or null when the role is automatic. */
export function readRolePin(agent: string): PlanUsageRolePin | null {
  const v = getSetting(planUsageRoleKey(agent));
  return v === "primary" || v === "occasional" ? v : null;
}

/**
 * Pure role resolution. A pin wins; else the last completed week's peak decides;
 * with no completed week yet (cold start) the current week's utilization does.
 */
export function resolvePlanUsageRole(input: {
  pin: PlanUsageRolePin | null;
  lastWeekPeak: number | null;
  currentWeekUtilization: number | null;
}): PlanUsageRole {
  const { pin, lastWeekPeak, currentWeekUtilization } = input;
  if (pin) return { value: pin, source: "pinned", lastWeekPeak };
  const basis = lastWeekPeak ?? currentWeekUtilization ?? 0;
  return {
    value: basis >= PRIMARY_PEAK_THRESHOLD ? "primary" : "occasional",
    source: "auto",
    lastWeekPeak,
  };
}

/**
 * Raise the stored peak of each weekly window in a fresh snapshot, keyed by the
 * window's reset time so a reset rolls into a new row. Skips stale snapshots,
 * unavailable ones, the gateway, and windows with no reset time.
 */
export function recordWeeklyPeaks(agent: string, snap: PlanUsageSnapshot, now = Date.now()): void {
  if (agent === GATEWAY_PLAN_ID || !snap.available || snap.stale) return;
  const peaks = new Map<number, number>();
  for (const w of snap.windows) {
    if (w.kind !== "week" || w.resetsAt == null || !Number.isFinite(w.utilization)) continue;
    peaks.set(w.resetsAt, Math.max(peaks.get(w.resetsAt) ?? 0, w.utilization));
  }
  if (!peaks.size) return;
  const upsert = getDb().prepare(
    `INSERT INTO plan_usage_weeks (agent, reset_at, peak, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent, reset_at) DO UPDATE SET
       peak = MAX(peak, excluded.peak), updated_at = excluded.updated_at`,
  );
  getDb().transaction(() => {
    for (const [resetAt, peak] of peaks) upsert.run(agent, resetAt, peak, now);
  })();
}

/** Peak of the most recent completed week (greatest reset_at <= now), or null. */
export function lastCompletedWeekPeak(agent: string, now = Date.now()): number | null {
  const row = getDb()
    .prepare("SELECT peak FROM plan_usage_weeks WHERE agent = ? AND reset_at <= ? ORDER BY reset_at DESC LIMIT 1")
    .get(agent, now) as { peak: number } | undefined;
  return row ? row.peak : null;
}

/** Highest utilization among the snapshot's weekly windows, or null when it has none. */
export function currentWeekUtilization(snap: PlanUsageSnapshot): number | null {
  let max: number | null = null;
  for (const w of snap.windows) {
    if (w.kind === "week" && Number.isFinite(w.utilization)) max = Math.max(max ?? 0, w.utilization);
  }
  return max;
}

/** Delete rows whose week ended more than ~8 weeks ago. Returns rows removed. */
export function prunePlanUsageWeeks(now = Date.now()): number {
  return getDb()
    .prepare("DELETE FROM plan_usage_weeks WHERE reset_at <= ?")
    .run(now - PLAN_USAGE_WEEKS_KEEP_MS).changes;
}
