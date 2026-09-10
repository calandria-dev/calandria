import { describe, it, expect } from "vitest";
import { planLoginBills } from "@/lib/agentEnv";
import type { AgentEnv } from "@/lib/agentEnv";
import { agentPlanScope } from "@/lib/planScope";
import type { Project } from "@/lib/types";

// Gateway address these tests describe an override against, passed explicitly
// to planLoginBills's third parameter so nothing here depends on
// CALANDRIA_LITELLM_BASE_URL being unset in the ambient environment.
const GW = "http://gw.example:4000";

const LOCAL = "http://localhost:11434/v1";
const CUSTOM = "https://openrouter.ai/api/v1";

describe("planLoginBills", () => {
  it("holds for every known agent against an empty env", () => {
    for (const agent of ["claude", "codex", "gemini"]) {
      expect(planLoginBills({}, agent, null)).toBe(true);
    }
  });

  it("holds for an unknown agent id even with an env full of overrides", () => {
    const env: AgentEnv = {
      ANTHROPIC_BASE_URL: LOCAL,
      OPENAI_BASE_URL: LOCAL,
      GOOGLE_GEMINI_BASE_URL: LOCAL,
    };
    // No known redirect key for this agent id, so the meter is left alone.
    expect(planLoginBills(env, "some-future-agent", null)).toBe(true);
  });

  it("drops for codex when OPENAI_BASE_URL points at a local endpoint", () => {
    expect(planLoginBills({ OPENAI_BASE_URL: LOCAL }, "codex", null)).toBe(false);
  });

  it("drops for codex when only CODEX_OSS_BASE_URL is set, the hand-typed CLI spelling", () => {
    expect(planLoginBills({ CODEX_OSS_BASE_URL: LOCAL }, "codex", null)).toBe(false);
  });

  it("holds for codex when only ANTHROPIC_BASE_URL is redirected, since the check is per agent", () => {
    // An override that redirects Claude says nothing about codex, which has no
    // OpenAI key set here at all.
    expect(planLoginBills({ ANTHROPIC_BASE_URL: LOCAL }, "codex", null)).toBe(true);
  });

  it("drops for claude when ANTHROPIC_BASE_URL points at a local endpoint", () => {
    expect(planLoginBills({ ANTHROPIC_BASE_URL: LOCAL }, "claude", null)).toBe(false);
  });

  it("holds for claude when only OPENAI_BASE_URL is redirected", () => {
    expect(planLoginBills({ OPENAI_BASE_URL: LOCAL }, "claude", null)).toBe(true);
  });

  it("drops for gemini when GOOGLE_GEMINI_BASE_URL points at a local endpoint", () => {
    expect(planLoginBills({ GOOGLE_GEMINI_BASE_URL: LOCAL }, "gemini", null)).toBe(false);
  });

  it("drops for a custom endpoint that is neither local nor the gateway", () => {
    expect(planLoginBills({ ANTHROPIC_BASE_URL: CUSTOM }, "claude", null)).toBe(false);
  });

  // The gateway arm restates planWindowApplies's rule (lib/agentEnv.ts): a
  // gateway that forwards a Claude login upstream does spend the plan, so the
  // two must stay in step. See the "planWindowApplies" describe block in
  // tests/agentEnv.test.ts for the sibling coverage.
  describe("the gateway arm", () => {
    it("holds for claude billed subscription on the gateway", () => {
      const env: AgentEnv = { ANTHROPIC_BASE_URL: GW, CALANDRIA_GATEWAY_BILLING: "subscription" };
      expect(planLoginBills(env, "claude", GW)).toBe(true);
    });

    it("drops for claude billed key on the gateway", () => {
      const env: AgentEnv = { ANTHROPIC_BASE_URL: GW, CALANDRIA_GATEWAY_BILLING: "key" };
      expect(planLoginBills(env, "claude", GW)).toBe(false);
    });

    it("drops for claude on the gateway with no billing marker, which defaults to key", () => {
      expect(planLoginBills({ ANTHROPIC_BASE_URL: GW }, "claude", GW)).toBe(false);
    });

    it("drops for codex on the gateway in both billing modes", () => {
      expect(planLoginBills({ OPENAI_BASE_URL: GW, CALANDRIA_GATEWAY_BILLING: "key" }, "codex", GW)).toBe(false);
      expect(planLoginBills({ OPENAI_BASE_URL: GW, CALANDRIA_GATEWAY_BILLING: "subscription" }, "codex", GW)).toBe(
        false
      );
    });
  });
});

// agent_env is stored as a JSON string on the project row (lib/agentEnv.ts's
// parseAgentEnv/serializeAgentEnv). Fixtures below use the same plain-object
// JSON form serializeAgentEnv produces, so these pin the real stored shape,
// not a convenient stand-in for it.
const onPlanRow = (): Pick<Project, "agent_env" | "deprecated"> => ({ agent_env: "", deprecated: 0 });
const redirectCodexRow = (): Pick<Project, "agent_env" | "deprecated"> => ({
  agent_env: '{"OPENAI_BASE_URL":"http://localhost:11434/v1"}',
  deprecated: 0,
});

describe("agentPlanScope", () => {
  it("reads all for an instance with no projects at all", () => {
    expect(agentPlanScope("claude", [])).toEqual({ kind: "all", onPlan: 0, redirected: 0 });
  });

  it("reads all when every project has an empty agent_env", () => {
    const rows = [onPlanRow(), onPlanRow(), onPlanRow()];
    expect(agentPlanScope("claude", rows)).toEqual({ kind: "all", onPlan: 3, redirected: 0 });
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "all", onPlan: 3, redirected: 0 });
  });

  it("reads none for codex and all for claude when every project redirects codex to a local endpoint", () => {
    const rows = [redirectCodexRow(), redirectCodexRow()];
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "none", onPlan: 0, redirected: 2 });
    // Same rows say nothing about claude: no ANTHROPIC_BASE_URL is set.
    expect(agentPlanScope("claude", rows)).toEqual({ kind: "all", onPlan: 2, redirected: 0 });
  });

  it("reads some with exact counts for a mix of on-plan and redirected projects", () => {
    const rows = [onPlanRow(), redirectCodexRow(), onPlanRow(), redirectCodexRow(), onPlanRow()];
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "some", onPlan: 3, redirected: 2 });
  });

  it("excludes a deprecated project from both counts, tipping the scope to none", () => {
    const rows = [
      redirectCodexRow(),
      { ...onPlanRow(), deprecated: 1 },
    ];
    // The only counted row redirects codex; the on-plan row is deprecated and
    // dropped before counting, so nothing keeps this from reading none.
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "none", onPlan: 0, redirected: 1 });
  });

  it("excludes a deprecated project from both counts, tipping the scope to all", () => {
    const rows = [
      onPlanRow(),
      { ...redirectCodexRow(), deprecated: 1 },
    ];
    // The only counted row is on-plan; the redirected row is deprecated and
    // dropped before counting, so nothing keeps this from reading all.
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "all", onPlan: 1, redirected: 0 });
  });

  it("treats malformed JSON in agent_env as no override, counting the project on-plan", () => {
    const rows = [{ agent_env: "{not json", deprecated: 0 }];
    // parseAgentEnv returns an empty env for garbage input, same as "".
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "all", onPlan: 1, redirected: 0 });
  });
});
