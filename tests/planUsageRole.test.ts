// Weekly peak history and primary/occasional role inference
// (lib/planUsageRole.ts), plus the role GET /api/plan-usage attaches. The route
// is driven against a mocked driver registry, as tests/planUsageScope.test.ts does.

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockDrivers: Array<{ id: string; label: string; planUsage?: () => Promise<unknown> }> = [];
vi.mock("@/lib/agents/registry", () => ({
  listDrivers: () => mockDrivers,
}));

import { GET } from "@/app/api/plan-usage/route";
import { getDb } from "@/lib/db";
import { setSetting } from "@/lib/store";
import {
  PRIMARY_PEAK_THRESHOLD,
  lastCompletedWeekPeak,
  prunePlanUsageWeeks,
  recordWeeklyPeaks,
  resolvePlanUsageRole,
} from "@/lib/planUsageRole";
import type { PlanUsageSnapshot } from "@/lib/types";

const WEEK = 7 * 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

const snap = (weeks: Array<{ u: number; resetsAt: number | null }>, over: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot => ({
  available: true,
  reason: null,
  plan: "max",
  windows: weeks.map((w, i) => ({
    id: `w${i}`, label: "Current week", utilization: w.u, resetsAt: w.resetsAt, kind: "week" as const,
  })),
  status: "allowed",
  statusWindow: null,
  statusResetsAt: null,
  fetchedAt: NOW,
  stale: false,
  ...over,
});

const rows = (agent: string) =>
  getDb().prepare("SELECT reset_at, peak FROM plan_usage_weeks WHERE agent = ? ORDER BY reset_at").all(agent) as {
    reset_at: number; peak: number;
  }[];

beforeEach(() => {
  getDb().prepare("DELETE FROM plan_usage_weeks").run();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'plan_usage_role:%'").run();
  mockDrivers = [];
});

describe("resolvePlanUsageRole", () => {
  it("a pin wins over history", () => {
    expect(resolvePlanUsageRole({ pin: "occasional", lastWeekPeak: 90, currentWeekUtilization: 90 })).toEqual({
      value: "occasional", source: "pinned", lastWeekPeak: 90,
    });
    expect(resolvePlanUsageRole({ pin: "primary", lastWeekPeak: 1, currentWeekUtilization: 1 }).value).toBe("primary");
  });
  it("uses the completed week's peak against the threshold", () => {
    const hi = resolvePlanUsageRole({ pin: null, lastWeekPeak: PRIMARY_PEAK_THRESHOLD, currentWeekUtilization: 0 });
    expect(hi).toEqual({ value: "primary", source: "auto", lastWeekPeak: 40 });
    expect(resolvePlanUsageRole({ pin: null, lastWeekPeak: 39.9, currentWeekUtilization: 99 }).value).toBe("occasional");
  });
  it("falls back to the current week on a cold start", () => {
    expect(resolvePlanUsageRole({ pin: null, lastWeekPeak: null, currentWeekUtilization: 40 })).toEqual({
      value: "primary", source: "auto", lastWeekPeak: null,
    });
    expect(resolvePlanUsageRole({ pin: null, lastWeekPeak: null, currentWeekUtilization: 12 }).value).toBe("occasional");
    expect(resolvePlanUsageRole({ pin: null, lastWeekPeak: null, currentWeekUtilization: null }).value).toBe("occasional");
  });
});

describe("recordWeeklyPeaks", () => {
  it("keeps the max per reset and rolls a reset into a new row", () => {
    const r1 = NOW + WEEK;
    recordWeeklyPeaks("claude", snap([{ u: 30, resetsAt: r1 }]), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 55, resetsAt: r1 }]), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 20, resetsAt: r1 }]), NOW);
    expect(rows("claude")).toEqual([{ reset_at: r1, peak: 55 }]);
    recordWeeklyPeaks("claude", snap([{ u: 5, resetsAt: r1 + WEEK }]), NOW + WEEK);
    expect(rows("claude")).toEqual([{ reset_at: r1, peak: 55 }, { reset_at: r1 + WEEK, peak: 5 }]);
  });
  it("takes the max across several weekly windows sharing a reset", () => {
    const r = NOW + WEEK;
    recordWeeklyPeaks("gemini", snap([{ u: 10, resetsAt: r }, { u: 70, resetsAt: r }]), NOW);
    expect(rows("gemini")).toEqual([{ reset_at: r, peak: 70 }]);
  });
  it("skips null resets, stale and unavailable snapshots, and the gateway", () => {
    recordWeeklyPeaks("claude", snap([{ u: 50, resetsAt: null }]), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 50, resetsAt: NOW + WEEK }], { stale: true }), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 50, resetsAt: NOW + WEEK }], { available: false }), NOW);
    recordWeeklyPeaks("gateway", snap([{ u: 50, resetsAt: NOW + WEEK }]), NOW);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM plan_usage_weeks").get()).toEqual({ n: 0 });
  });
  it("lastCompletedWeekPeak reads the latest reset at or before now", () => {
    recordWeeklyPeaks("claude", snap([{ u: 60, resetsAt: NOW - 2 * WEEK }]), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 25, resetsAt: NOW - WEEK }]), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 99, resetsAt: NOW + WEEK }]), NOW);
    expect(lastCompletedWeekPeak("claude", NOW)).toBe(25);
    expect(lastCompletedWeekPeak("codex", NOW)).toBeNull();
  });
  it("prunes rows older than eight weeks", () => {
    recordWeeklyPeaks("claude", snap([{ u: 60, resetsAt: NOW - 9 * WEEK }]), NOW);
    recordWeeklyPeaks("claude", snap([{ u: 60, resetsAt: NOW - 2 * WEEK }]), NOW);
    expect(prunePlanUsageWeeks(NOW)).toBe(1);
    expect(rows("claude")).toHaveLength(1);
  });
});

describe("GET /api/plan-usage role", () => {
  const getAgents = async () =>
    ((await (await GET()).json()) as { agents: Record<string, PlanUsageSnapshot> }).agents;
  const driver = (id: string, s: PlanUsageSnapshot) => ({ id, label: id, planUsage: vi.fn(async () => s) });

  it("returns an auto role from history, a pin override, and none for the gateway", async () => {
    const now = Date.now();
    recordWeeklyPeaks("claude", snap([{ u: 80, resetsAt: now - 1000 }]), now);
    mockDrivers = [
      driver("claude", snap([{ u: 5, resetsAt: now + WEEK }], { fetchedAt: now })),
      driver("codex", snap([{ u: 90, resetsAt: now + WEEK }], { fetchedAt: now })),
    ];
    let agents = await getAgents();
    expect(agents.claude.role).toEqual({ value: "primary", source: "auto", lastWeekPeak: 80 });
    expect(agents.codex.role).toEqual({ value: "primary", source: "auto", lastWeekPeak: null });
    expect(agents.gateway?.role ?? null).toBeNull();

    setSetting("plan_usage_role:claude", "occasional");
    agents = await getAgents();
    expect(agents.claude.role).toEqual({ value: "occasional", source: "pinned", lastWeekPeak: 80 });
    expect(rows("codex")).toHaveLength(1);
  });
});
