// GET /api/plan-usage fans out over every registered driver's optional
// planUsage() hook, attaching agentPlanScope() to each snapshot and hiding a
// driver whose scope is "none" (lib/planScope.ts: no project on this instance
// still bills that agent's own login). These tests drive the route's real
// GET export against a mocked driver registry, matching the mocking style
// tests/scheduleRunner.test.ts uses for @/lib/agents/registry: the mock call
// sits above the imports it replaces, and the drivers it returns are plain
// scripted objects, not real CLIs.

import { describe, expect, it, beforeEach, vi } from "vitest";

let mockDrivers: Array<{ id: string; label: string; planUsage?: () => Promise<unknown> }> = [];
vi.mock("@/lib/agents/registry", () => ({
  listDrivers: () => mockDrivers,
}));

import { createProject, updateProject, listProjectsPlain, deleteProject } from "@/lib/store";
import { GET } from "@/app/api/plan-usage/route";
import type { PlanUsageSnapshot } from "@/lib/types";

const REDIRECT_CODEX = '{"OPENAI_BASE_URL":"http://localhost:11434/v1"}';

// A project with an empty agent_env still bills every agent's own login
// (agentPlanScope's "onPlan" case).
const onPlanProject = () => createProject({ name: `plan-${Math.random().toString(36).slice(2)}` });

// A project whose agent_env redirects codex's turns to a local endpoint, the
// shape planLoginBills reads off OPENAI_BASE_URL (lib/agentEnv.ts).
const codexRedirectedProject = () => {
  const p = createProject({ name: `plan-${Math.random().toString(36).slice(2)}` });
  return updateProject(p.id, { agent_env: REDIRECT_CODEX })!;
};

const fakeSnapshot = (): PlanUsageSnapshot => ({
  available: true,
  reason: null,
  plan: "max",
  windows: [{ id: "five_hour", label: "5 hour", utilization: 37, resetsAt: null, kind: "session" }],
  status: "allowed",
  statusWindow: "five_hour",
  statusResetsAt: null,
  fetchedAt: Date.now(),
  stale: false,
});

// A driver with a planUsage hook that records every call, so a test can
// assert the route never paid for a real read when the scope is "none".
const driverWithPlanUsage = (id: string, snap: PlanUsageSnapshot = fakeSnapshot()) => ({
  id,
  label: id,
  planUsage: vi.fn(async () => snap),
});

const getAgents = async () => {
  const body = (await (await GET()).json()) as { now: number; agents: Record<string, PlanUsageSnapshot> };
  return body.agents;
};

describe("GET /api/plan-usage: per-agent scope wiring", () => {
  beforeEach(() => {
    mockDrivers = [];
    // The route reads listProjectsPlain() for the whole instance, not one
    // project, and lib/db.ts seeds a built-in "Welcome" project on first init.
    // Both would corrupt the exact onPlan/redirected counts below unless every
    // test starts from an empty project table.
    for (const p of listProjectsPlain()) deleteProject(p.id);
  });

  it("reports scope 'all' when no project redirects the agent, keeping the driver's own snapshot fields", async () => {
    onPlanProject();
    onPlanProject();
    const codex = driverWithPlanUsage("codex");
    mockDrivers = [codex];

    const agents = await getAgents();

    expect(agents.codex).toBeDefined();
    expect(agents.codex.scope).toEqual({ kind: "all", onPlan: 2, redirected: 0 });
    // The driver's own fields survive the { ...snap, scope } spread untouched.
    expect(agents.codex.available).toBe(true);
    expect(agents.codex.plan).toBe("max");
    expect(agents.codex.windows).toEqual(fakeSnapshot().windows);
  });

  it("drops the agent from the map, and never calls its planUsage hook, when every project redirects it", async () => {
    codexRedirectedProject();
    codexRedirectedProject();
    const codex = driverWithPlanUsage("codex");
    mockDrivers = [codex];

    const agents = await getAgents();

    expect(agents.codex).toBeUndefined();
    expect("codex" in agents).toBe(false);
    // Short-circuited before the read: for real Codex, planUsage() spawns a
    // process, and a fully-redirected agent must never pay that cost.
    expect(codex.planUsage).toHaveBeenCalledTimes(0);
  });

  it("reports scope 'some' with exact counts for a mix of on-plan and redirected projects", async () => {
    onPlanProject();
    codexRedirectedProject();
    const codex = driverWithPlanUsage("codex");
    mockDrivers = [codex];

    const agents = await getAgents();

    expect(agents.codex).toBeDefined();
    expect(agents.codex.scope).toEqual({ kind: "some", onPlan: 1, redirected: 1 });
    // The driver's own numbers are unchanged by having a scope attached.
    expect(agents.codex.status).toBe("allowed");
    expect(agents.codex.windows).toEqual(fakeSnapshot().windows);
  });

  it("scopes each agent independently: a project that redirects only codex hides codex but leaves claude at 'all'", async () => {
    // This is the case the whole change exists for: one project's override
    // must not blank every OTHER agent's meter along with the one it redirects.
    codexRedirectedProject();
    const codex = driverWithPlanUsage("codex");
    const claude = driverWithPlanUsage("claude");
    mockDrivers = [codex, claude];

    const agents = await getAgents();

    expect(agents.codex).toBeUndefined();
    expect(agents.claude).toBeDefined();
    expect(agents.claude.scope).toEqual({ kind: "all", onPlan: 1, redirected: 0 });
  });

  it("leaves a driver with no planUsage hook out of the map regardless of scope", async () => {
    onPlanProject();
    // No planUsage property at all, same as a driver that hasn't implemented
    // the optional hook (lib/agents/types.ts).
    mockDrivers = [{ id: "gemini", label: "gemini" }];

    const agents = await getAgents();

    expect(agents.gemini).toBeUndefined();
  });
});
