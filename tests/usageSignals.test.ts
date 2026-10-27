import { describe, expect, it } from "vitest";
import {
  agentSignals,
  calmRing,
  chipLadder,
  fmtAgo,
  staleLadder,
  paceOf,
  roleText,
  summarizeUsage,
  windowLengthMs,
  type UsageAgent,
} from "@/app/shell/usageSignals";
import type { PlanUsageSnapshot, PlanUsageWindow } from "@/lib/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

function win(over: Partial<PlanUsageWindow> & Pick<PlanUsageWindow, "id">): PlanUsageWindow {
  return { label: "Current session", utilization: 0, resetsAt: null, kind: null, ...over };
}
const session = (utilization: number, resetsIn: number) =>
  win({ id: "five_hour", label: "Current session", kind: "session", utilization, resetsAt: NOW + resetsIn });
const week = (utilization: number, resetsIn: number, id = "seven_day", label = "Current week (all models)") =>
  win({ id, label, kind: id === "seven_day" ? "week" : null, utilization, resetsAt: NOW + resetsIn });

function snap(windows: PlanUsageWindow[], over: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  return {
    available: true, reason: null, plan: "max", windows,
    status: null, statusWindow: null, statusResetsAt: null,
    fetchedAt: NOW, stale: false, scope: null,
    role: { value: "primary", source: "auto", lastWeekPeak: 70 },
    ...over,
  };
}
const agent = (id: string, s: PlanUsageSnapshot, name = id[0].toUpperCase() + id.slice(1)): UsageAgent => ({ id, name, snap: s });
const occasional = { role: { value: "occasional" as const, source: "auto" as const, lastWeekPeak: 10 } };
const kinds = (a: UsageAgent, named = false) => agentSignals(a, NOW, named).map((s) => s.kind);

describe("windowLengthMs", () => {
  it("reads kinds, Claude per-model weeks, and a Codex label span", () => {
    expect(windowLengthMs(session(0, HOUR))).toBe(5 * HOUR);
    expect(windowLengthMs(week(0, DAY))).toBe(7 * DAY);
    expect(windowLengthMs(week(0, DAY, "seven_day_opus", "Current week (Opus)"))).toBe(7 * DAY);
    expect(windowLengthMs(win({ id: "primary", label: "Current session (2h)" }))).toBe(2 * HOUR);
    expect(windowLengthMs(win({ id: "budget", label: "Gateway budget", kind: "gateway_budget" }))).toBeNull();
  });

  it("does not read an Antigravity group name as a span", () => {
    expect(windowLengthMs(win({ id: "g:5h", label: "Current session (Gemini Pro)", kind: "session" }))).toBe(5 * HOUR);
  });
});

describe("paceOf", () => {
  it("computes elapsed, pace and projection", () => {
    // Half the week gone, 60% used: on pace for 120%.
    const p = paceOf(week(60, 3.5 * DAY), NOW)!;
    expect(p.elapsed).toBeCloseTo(0.5);
    expect(p.pace).toBeCloseTo(50);
    expect(p.projected).toBeCloseTo(120);
    // 100% is reached at 5/6 of the elapsed half: NOW - 3.5d + 7d * 0.5 * 100/60.
    expect(p.capAt).toBeCloseTo(NOW - 3.5 * DAY + (7 * DAY * 0.5 * 100) / 60, -2);
  });

  it("has no pace without a reset or a length, and no projection too early", () => {
    expect(paceOf(win({ id: "x", utilization: 50 }), NOW)).toBeNull();
    expect(paceOf(win({ id: "budget", label: "Gateway budget", kind: "gateway_budget", utilization: 50, resetsAt: NOW + DAY }), NOW)).toBeNull();
    const early = paceOf(week(3, 7 * DAY - HOUR), NOW)!;
    expect(early.projected).toBeNull();
  });
});

describe("agentSignals", () => {
  it("at limit: rejected status, with the agent name dropped when alone", () => {
    const a = agent("claude", snap([session(100, 18 * MIN), week(40, 3 * DAY)], { status: "rejected", statusWindow: "five_hour", statusResetsAt: NOW + 18 * MIN }));
    const [s] = agentSignals(a, NOW, false);
    expect(s.kind).toBe("limit");
    expect(s.what).toBe("limit · 18m");
    expect(s.who).toBe("");
    expect(agentSignals(a, NOW, true)[0]).toMatchObject({ who: "Claude", what: "limit · 18m" });
  });

  it("ignores a rejection whose reset already passed", () => {
    const a = agent("claude", snap([session(20, 4 * HOUR)], { status: "rejected", statusWindow: "five_hour", statusResetsAt: NOW - MIN }));
    expect(kinds(a)).toEqual([]);
  });

  it("near limit at 80%, limit tone at 95%", () => {
    expect(agentSignals(agent("claude", snap([session(86, 40 * MIN)])), NOW, false)[0]).toMatchObject({ kind: "near", tone: "warn", what: "5h 86% · 40m" });
    expect(agentSignals(agent("claude", snap([session(96, 40 * MIN)])), NOW, false)[0]).toMatchObject({ kind: "near", tone: "limit" });
    expect(kinds(agent("claude", snap([session(79, 40 * MIN)])))).toEqual([]);
  });

  it("on pace to cap fires only after the one-day grace", () => {
    // 1.5 days in, 30% used: on pace for 140%.
    expect(kinds(agent("codex", snap([week(30, 5.5 * DAY)], occasional)))).toContain("pace");
    // 0.5 days in, 15% used: also over 100% projected, but inside the grace.
    expect(kinds(agent("codex", snap([week(15, 6.5 * DAY)], occasional)))).not.toContain("pace");
  });

  it("session and week underuse fire for primary agents only", () => {
    const windows = [session(30, 40 * MIN), week(50, 30 * HOUR)];
    expect(kinds(agent("claude", snap(windows)))).toEqual(["session_under", "week_under"]);
    expect(kinds(agent("codex", snap(windows, occasional)))).toEqual([]);
    expect(agentSignals(agent("claude", snap(windows)), NOW, false)[0].what).toBe("70% left · 40m");
  });

  it("underuse respects its thresholds", () => {
    expect(kinds(agent("claude", snap([session(51, 40 * MIN)])))).toEqual([]); // 49% unused
    expect(kinds(agent("claude", snap([session(30, 61 * MIN)])))).toEqual([]); // resets past 60m
    expect(kinds(agent("claude", snap([week(71, 30 * HOUR)])))).toEqual([]); // 29% unused
    expect(kinds(agent("claude", snap([week(50, 37 * HOUR)])))).toEqual([]); // resets past 36h
  });

  it("week underuse reads every weekly window and reports the soonest reset", () => {
    // The all-models week is busy; the Opus week resets sooner with room left.
    const windows = [week(75, 30 * HOUR), week(40, 20 * HOUR, "seven_day_opus", "Current week (Opus)")];
    const [s] = agentSignals(agent("claude", snap(windows)), NOW, false);
    expect(s).toMatchObject({ kind: "week_under", what: expect.stringMatching(/^wk 60% left · /) });
    expect(s.window!.id).toBe("seven_day_opus");
    expect(s.note).toMatch(/^60% of the Opus week unused\./);
  });

  it("week underuse ties go to the all-models window", () => {
    const windows = [week(40, 20 * HOUR, "seven_day_opus", "Current week (Opus)"), week(50, 20 * HOUR)];
    const [s] = agentSignals(agent("claude", snap(windows)), NOW, false);
    expect(s.window!.id).toBe("seven_day");
    expect(agentSignals(agent("claude", snap(windows)), NOW, false).filter((x) => x.kind === "week_under")).toHaveLength(1);
  });

  it("week underuse on a per-model week is primary only", () => {
    const windows = [week(75, 30 * HOUR), week(40, 20 * HOUR, "seven_day_opus", "Current week (Opus)")];
    expect(kinds(agent("codex", snap(windows, occasional)))).toEqual([]);
    expect(kinds(agent("claude", snap(windows)))).toEqual(["week_under"]);
  });

  it("a gateway budget fires near limit at 80%", () => {
    const budget = (utilization: number) => win({ id: "budget", label: "Gateway budget", kind: "gateway_budget", utilization });
    const g = (u: number) => agent("gateway", snap([budget(u)], { role: null }), "Gateway");
    expect(agentSignals(g(80), NOW, true)[0]).toMatchObject({ kind: "near", tone: "warn", who: "Gateway", what: "budget 80%" });
    expect(agentSignals(g(96), NOW, true)[0]).toMatchObject({ kind: "near", tone: "limit" });
    expect(kinds(g(79))).toEqual([]);
  });

  it("the gateway is never primary", () => {
    const g = agent("gateway", snap([win({ id: "budget", label: "Gateway budget", kind: "gateway_budget", utilization: 10, resetsAt: NOW + 30 * MIN })]), "Gateway");
    expect(kinds(g)).toEqual([]);
  });

  it("an unavailable agent raises nothing", () => {
    expect(kinds(agent("claude", snap([session(99, MIN)], { available: false })))).toEqual([]);
  });
});

describe("summarizeUsage", () => {
  it("ranks by signal, then primary, then soonest", () => {
    const claude = agent("claude", snap([session(85, 2 * HOUR)]));
    const codex = agent("codex", snap([session(90, HOUR)], occasional));
    const s = summarizeUsage([codex, claude], NOW);
    expect(s.signals.map((x) => x.agentId)).toEqual(["claude", "codex"]);
    expect(s.order.map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(s.signals[0].who).toBe("Claude");
    expect(s.spoken).toMatch(/^Usage: Claude session 85% used, resets in 2 hours\. 1 more notice\.$/);
  });

  it("a limit beats every lower signal", () => {
    const claude = agent("claude", snap([session(30, 40 * MIN)]));
    const codex = agent("codex", snap([session(100, 2 * HOUR)], occasional));
    expect(summarizeUsage([claude, codex], NOW).signals[0]).toMatchObject({ kind: "limit", agentId: "codex" });
  });

  it("calm ring follows the busiest primary session", () => {
    const claude = agent("claude", snap([session(40, 2 * HOUR), week(40, 3 * DAY)]));
    const codex = agent("codex", snap([session(60, 2 * HOUR)], occasional));
    const s = summarizeUsage([claude, codex], NOW);
    expect(s.signals).toEqual([]);
    expect(s.ring).toMatchObject({ agentId: "claude", tone: "" });
    expect(s.ring!.window.id).toBe("five_hour");
    expect(s.spoken).toContain("No notices.");
  });

  it("with no primary the ring follows any session, then any window", () => {
    const codex = agent("codex", snap([session(20, 2 * HOUR)], occasional));
    const gem = agent("gemini", snap([session(35, 2 * HOUR)], occasional));
    expect(calmRing([codex, gem])).toMatchObject({ agentId: "gemini" });
    const g = agent("gateway", snap([win({ id: "budget", label: "Gateway budget", kind: "gateway_budget", utilization: 12 })]), "Gateway");
    expect(calmRing([g])).toMatchObject({ agentId: "gateway" });
  });

  it("stale data is announced with the agents and the oldest read", () => {
    const s = summarizeUsage([agent("claude", snap([session(10, 2 * HOUR)], { stale: true, fetchedAt: NOW - 47 * MIN }))], NOW);
    expect(s).toMatchObject({ stale: true, allStale: true, staleSince: NOW - 47 * MIN });
    expect(s.spoken).toContain("Data is stale (every agent, last read 47 minutes ago).");
    const some = summarizeUsage([
      agent("claude", snap([session(10, 2 * HOUR)])),
      agent("codex", snap([session(10, 2 * HOUR)], { ...occasional, stale: true, fetchedAt: NOW - 20 * MIN })),
      agent("gemini", snap([session(10, 2 * HOUR)], { ...occasional, stale: true, fetchedAt: NOW - 47 * MIN })),
    ], NOW);
    expect(some).toMatchObject({ allStale: false, staleSince: NOW - 47 * MIN });
    expect(some.staleAgents.map((a) => a.id)).toEqual(["codex", "gemini"]);
  });

  it("unavailable: every agent, or named when only some are", () => {
    const down = (id: string) => agent(id, snap([], { available: false, reason: "signed out" }));
    expect(summarizeUsage([down("claude"), down("codex")], NOW)).toMatchObject({ unavailable: true, spoken: "Usage: unavailable." });
    const s = summarizeUsage([agent("claude", snap([session(10, 2 * HOUR)])), down("gemini")], NOW);
    expect(s.unavailable).toBe(false);
    expect(s.signals).toEqual([]);
    expect(s.spoken).toMatch(/ Gemini unavailable\.$/);
  });
});

describe("truncation ladder", () => {
  it("steps from full text to no reset, no name, then neither", () => {
    const a = agent("claude", snap([session(100, 18 * MIN)], { status: "rejected", statusWindow: "five_hour", statusResetsAt: NOW + 18 * MIN }));
    expect(chipLadder(agentSignals(a, NOW, true)[0])).toEqual([
      { who: "Claude", what: "limit · 18m" },
      { who: "Claude", what: "limit" },
      { who: "", what: "limit · 18m" },
      { who: "", what: "limit" },
    ]);
  });

  it("drops duplicate steps when there is no name or no reset", () => {
    const a = agent("codex", snap([week(30, 5.5 * DAY)], occasional));
    const pace = agentSignals(a, NOW, false)[0];
    expect(pace.kind).toBe("pace");
    expect(chipLadder(pace)).toEqual([{ who: "", what: pace.what }]);
  });

  it("the stale label: with the age, then the bare word", () => {
    expect(staleLadder(NOW - 47 * MIN, true, NOW).map((x) => x.what)).toEqual(["stale 47m", "stale"]);
    expect(staleLadder(NOW - 47 * MIN, false, NOW).map((x) => x.what)).toEqual(["stale · 47m", "stale"]);
    expect(staleLadder(null, true, NOW).map((x) => x.what)).toEqual(["stale"]);
    expect(fmtAgo(NOW - 3 * HOUR, NOW)).toBe("3h");
  });
});

describe("roleText", () => {
  it("states automatic, cold start and pinned roles", () => {
    expect(roleText(snap([]))).toBe("Auto (primary, last week 70%)");
    expect(roleText(snap([week(45, DAY)], { role: { value: "primary", source: "auto", lastWeekPeak: null } }))).toBe("Auto (primary, no completed week yet, this week 45%)");
    expect(roleText(snap([], { role: { value: "occasional", source: "pinned", lastWeekPeak: 80 } }))).toBe("Pinned occasional");
  });
});
