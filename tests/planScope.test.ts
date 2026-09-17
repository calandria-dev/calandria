import { describe, it, expect } from "vitest";
import { agentPlanScope } from "@/lib/planScope";
import { createProvider } from "@/lib/providers/store";
import type { Project } from "@/lib/types";

// A null default provider inherits the environment's bundled login. A local
// provider row redirects turns away from that login.
const onPlanRow = (): Pick<Project, "default_provider_id" | "deprecated"> => ({
  default_provider_id: null,
  deprecated: 0,
});
const redirectCodexRow = (): Pick<Project, "default_provider_id" | "deprecated"> => ({
  default_provider_id: createProvider({ type: "openai_key" }).id,
  deprecated: 0,
});

describe("agentPlanScope", () => {
  it("reads all for an instance with no projects at all", () => {
    expect(agentPlanScope("claude", [])).toEqual({ kind: "all", onPlan: 0, redirected: 0 });
  });

  it("reads all when every project inherits its bundled provider", () => {
    const rows = [onPlanRow(), onPlanRow(), onPlanRow()];
    expect(agentPlanScope("claude", rows)).toEqual({ kind: "all", onPlan: 3, redirected: 0 });
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "all", onPlan: 3, redirected: 0 });
  });

  it("reads none for codex and all for claude when every project redirects codex to a local provider", () => {
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

  it("treats a missing provider row as the bundled login, counting the project on-plan", () => {
    const rows = [{ default_provider_id: "missing-provider", deprecated: 0 }];
    // A deleted provider falls back to the environment's bundled provider.
    expect(agentPlanScope("codex", rows)).toEqual({ kind: "all", onPlan: 1, redirected: 0 });
  });
});
