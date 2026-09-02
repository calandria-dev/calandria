// The usage chip used to read "3.8M tok · $4.20" for a session whose actual
// work was a few hundred thousand tokens on a Max plan that billed nothing —
// accurate numbers, terrifying presentation. Two things keep it honest, and
// both are pinned here: the token total is split (cache READS are context
// re-sent every turn at ~10% of the input rate, not work), and a dollar figure
// is only presented as money when the agent is signed in with an API key.
import { describe, it, expect } from "vitest";
import { usageSplit, costDisplay, usageTooltip, fmtJobCost } from "@/app/shell/format";
import type { AgentInfo, TaskRow } from "@/app/shell/types";
import { CLAUDE_CAPABILITIES } from "@/lib/agents/claude/capabilities";
import { CODEX_CAPABILITIES } from "@/lib/agents/codex/capabilities";
import { providerPricing } from "@/lib/agentEnv";
import { addUsage, createProject, createTask, listTasks } from "@/lib/store";
import { tmpDir } from "./helpers";

// The shape from the investigation: 13k in/out, 240k cache writes, 3.5M reads.
const real: Pick<TaskRow, "total_tokens" | "cache_read_tokens" | "cache_creation_tokens"> = {
  total_tokens: 3_753_000,
  cache_read_tokens: 3_500_000,
  cache_creation_tokens: 240_000,
};

const agent = (over: Partial<AgentInfo>): AgentInfo => ({
  id: "claude", label: "Claude Code", capabilities: CLAUDE_CAPABILITIES, authenticated: true, ...over,
});

describe("usageSplit", () => {
  it("leads with fresh work, not the cache-read-dominated total", () => {
    const s = usageSplit(real);
    expect(s.total).toBe(3_753_000);
    expect(s.cacheRead).toBe(3_500_000);
    expect(s.cacheWrite).toBe(240_000);
    expect(s.inOut).toBe(13_000);
    // The headline: everything the model saw for the first time.
    expect(s.fresh).toBe(253_000);
    // …which is the whole point — a fraction of the raw number.
    expect(s.fresh / s.total).toBeLessThan(0.1);
  });

  it("never goes negative on odd rows (fields absent, buckets over-summed)", () => {
    const legacy = { total_tokens: 500 } as TaskRow;
    expect(usageSplit(legacy)).toMatchObject({ total: 500, fresh: 500, inOut: 500, cacheRead: 0, cacheWrite: 0 });
    const skewed = { total_tokens: 100, cache_read_tokens: 200, cache_creation_tokens: 50 } as TaskRow;
    expect(usageSplit(skewed).inOut).toBe(0);
    expect(usageSplit(skewed).fresh).toBe(0);
  });
});

describe("fmtJobCost", () => {
  it("keeps the point-of-action estimate compact", () => {
    expect(fmtJobCost({ tokens: 38_000, cost_usd: 0.11, source: "project_latest" }))
      .toBe("~38k tokens (~$0.11)");
  });
});

describe("listTasks", () => {
  it("carries the cache buckets, so the split survives a page load", () => {
    const project = createProject({ name: `p-${Math.random().toString(36).slice(2, 8)}`, repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "t", description: "" });
    const turn = { cost_usd: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 9_000, cache_creation_tokens: 400 };
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: turn });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: turn });

    const row = listTasks(project.id).find((t) => t.id === task.id)!;
    expect(row.total_tokens).toBe(19_100);
    expect(row.cache_read_tokens).toBe(18_000);
    expect(row.cache_creation_tokens).toBe(800);
    expect(usageSplit(row).fresh).toBe(1_100);
    // Never measured on these turns: SUM over NULLs coalesces to 0, and the
    // grand total is unchanged from what it was before the column existed.
    expect(row.subagent_tokens).toBe(0);
    expect(usageSplit(row).total).toBe(19_100);
  });

  it("sums sidechain tokens across turns, leaving unmeasured rows at zero", () => {
    const project = createProject({ name: `p-${Math.random().toString(36).slice(2, 8)}`, repo_path: tmpDir() });
    const task = createTask({ project_id: project.id, title: "t", description: "" });
    const turn = { cost_usd: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 9_000, cache_creation_tokens: 400 };
    // One turn fanned out, one didn't, one predates the measurement (NULL).
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: { ...turn, subagent_tokens: 50_000 } });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: { ...turn, subagent_tokens: 7_000 } });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, usage: turn });

    const row = listTasks(project.id).find((t) => t.id === task.id)!;
    expect(row.subagent_tokens).toBe(57_000);
    // The four buckets stay main-session-only; the split is additional.
    expect(row.total_tokens).toBe(28_650);
    expect(usageSplit(row).total).toBe(85_650);
  });
});

describe("costDisplay", () => {
  it("calls a subscription figure an equivalent, not a bill", () => {
    const c = costDisplay(agent({ account: { email: "a@b.c", plan: "Max", method: "subscription" } }));
    expect(c).toMatchObject({ show: true, approx: true });
    expect(c.note).toContain("API-price equivalent");
    expect(c.note).toContain("your Max plan");
    expect(c.note).not.toContain("estimated");
  });

  it("keeps the plain billed presentation for an API key", () => {
    const c = costDisplay(agent({ account: { email: null, plan: "API", method: "api_key" } }));
    expect(c).toEqual({ show: true, approx: false, note: "" });
  });

  it("labels a tokens-only driver estimated, and doubly so on a subscription", () => {
    const codex = (over: Partial<AgentInfo>) =>
      costDisplay(agent({ id: "codex", label: "Codex", capabilities: CODEX_CAPABILITIES, ...over }));
    expect(codex({}).note).toBe("estimated from token counts × published API prices");
    expect(codex({}).approx).toBe(true);
    const sub = codex({ account: { email: null, plan: null, method: "subscription" } });
    expect(sub.note).toContain("estimated from token counts");
    expect(sub.note).toContain("your plan");
  });

  it("still shows a cost when the bundle hasn't loaded — but claims nothing about a plan", () => {
    expect(costDisplay(undefined)).toEqual({ show: true, approx: false, note: "" });
  });

  // A turn against a provider override carries no price the vendor charged, and
  // the chip shows no figure for either non-cloud kind. What the LEDGER records
  // does differ between them (0 for local, NULL for custom — see
  // providerPricing), but neither reads honestly on screen: "$0.00" reads as a
  // measured price rather than an inapplicable one, and the API-price
  // equivalent would be the list price of a model that didn't run.
  it("shows no figure at all for a task on a local or custom endpoint", () => {
    const cloudAgent = agent({ account: { email: "a@b.c", plan: "Max", method: "subscription" } });
    const provider = { kind: "local" as const, pricing: providerPricing("local"), host: "localhost:11434", anthropic_base_url: "http://localhost:11434", openai_base_url: null, model: "qwen3-coder", auth_token: "ollama" };
    const c = costDisplay(cloudAgent, provider);
    expect(c.show).toBe(false);
    expect(c.approx).toBe(false);
    expect(c.note).toContain("localhost:11434");
    // …and the tooltip says so where the dollar line used to be.
    expect(usageTooltip(usageSplit(real), 0, c)).toContain("no cost to report");
    // A custom base URL is unpriced rather than free, and reads the same here.
    const custom = { ...provider, kind: "custom" as const, pricing: providerPricing("custom"), host: "models.example.com" };
    expect(costDisplay(cloudAgent, custom).show).toBe(false);
    expect(costDisplay(cloudAgent, custom).note).toContain("models.example.com");
    // An explicit cloud provider changes nothing.
    expect(costDisplay(cloudAgent, { ...provider, kind: "cloud", pricing: providerPricing("cloud"), host: "", anthropic_base_url: null, model: null, auth_token: null }))
      .toEqual(costDisplay(cloudAgent));
  });
});

describe("usageTooltip", () => {
  it("spells out where every token went, and what the dollars mean", () => {
    const sub = costDisplay(agent({ account: { email: null, plan: "Max", method: "subscription" } }));
    const text = usageTooltip(usageSplit(real), 4.2, sub);
    expect(text).toContain("253,000 new tokens");
    expect(text).toContain("13,000 in/out");
    expect(text).toContain("240,000 written to cache");
    expect(text).toContain("3,500,000 cache reads");
    expect(text).toContain("3,753,000 tokens total");
    expect(text).toContain("~$4.20");
    expect(text).toContain("plan quota, not a bill");
  });

  it("drops the cache lines when nothing was cached", () => {
    const text = usageTooltip(usageSplit({ total_tokens: 900, cache_read_tokens: 0, cache_creation_tokens: 0 }), 0, costDisplay(undefined));
    expect(text).toBe("900 new tokens this task: 900 in/out · 0 written to cache");
  });

  // A turn that fans out to five Explore agents used to read as if this session
  // had burned the lot: the sidechains' tokens were in the dollar figure and
  // nowhere in the token figure, so the two described different turns.
  it("names the sidechain share and folds it into the grand total", () => {
    const text = usageTooltip(usageSplit({ ...real, subagent_tokens: 1_200_000 }), 4.2, costDisplay(undefined));
    // The headline stays this session's own work — subagents have their own windows.
    expect(text).toContain("253,000 new tokens");
    // The total grows by exactly the sidechain share, so "of those" is true.
    expect(text).toContain("4,953,000 tokens total");
    expect(text).toContain("1,200,000 of those in subagents");
    expect(text).toContain("not this session's context");
  });

  it("states the total for a fan-out even when nothing was cached", () => {
    const text = usageTooltip(
      usageSplit({ total_tokens: 900, cache_read_tokens: 0, cache_creation_tokens: 0, subagent_tokens: 100 }),
      0, costDisplay(undefined)
    );
    // No cache-read line, but the total line still has to precede the subagent
    // one or "of those" refers to nothing.
    expect(text).not.toContain("cache reads");
    expect(text.split("\n")).toEqual([
      "900 new tokens this task: 900 in/out · 0 written to cache",
      "1,000 tokens total",
      "100 of those in subagents (their own windows, not this session's context)",
    ]);
  });

  // Codex and the mock driver never report the split. Absent means unmeasured,
  // so the line is omitted rather than claiming a measured zero.
  it("says nothing at all when the driver doesn't report a split", () => {
    expect(usageTooltip(usageSplit(real), 4.2, costDisplay(undefined))).not.toContain("subagents");
    expect(usageSplit(real).subagent).toBe(0);
    expect(usageSplit(real).total).toBe(3_753_000);
  });
});
