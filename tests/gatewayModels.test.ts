import { describe, it, expect, afterEach } from "vitest";
import {
  gatewayModelCatalog,
  gatewayModelOptions,
  lastGatewayModelCatalog,
  gatewayContextWindow,
  clearGatewayModelCache,
  type GatewayModelInfo,
} from "@/lib/gatewayModels";
import { clearGatewayRates, estimateCostUsd } from "@/lib/gatewayPricing";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

afterEach(async () => {
  clearGatewayModelCache();
  clearGatewayRates();
});

function entry(over: Partial<GatewayModelInfo> = {}): GatewayModelInfo {
  return {
    model_name: "claude-sonnet-4-5",
    litellm_provider: "anthropic",
    max_input_tokens: 200_000,
    max_output_tokens: 64_000,
    mode: "chat",
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
    ...over,
  };
}

describe("gatewayModelOptions — mapping", () => {
  it("maps value/contextWindow/group and folds provider + price into sub", () => {
    const [opt] = gatewayModelOptions([entry()], "claude");
    expect(opt.value).toBe("claude-sonnet-4-5");
    expect(opt.contextWindow).toBe(200_000);
    expect(opt.group).toBe("anthropic");
    expect(opt.sub).toContain("anthropic");
    expect(opt.sub).toContain("/1M");
  });

  it("drops entries whose mode isn't chat, for every driver", () => {
    const embed = entry({ model_name: "text-embedding-3", mode: "embedding" });
    expect(gatewayModelOptions([embed], "claude")).toEqual([]);
    expect(gatewayModelOptions([embed], "codex")).toEqual([]);
    expect(gatewayModelOptions([embed], "gemini")).toEqual([]);
  });

  it("collapses a wildcard route into one labelled row instead of the raw pattern", () => {
    const wildcard = entry({ model_name: "anthropic/*" });
    const [opt] = gatewayModelOptions([wildcard], "claude");
    expect(opt.value).toBe("anthropic/*");
    expect(opt.label).toBe("Any anthropic model id");
  });

  describe("per-driver fit", () => {
    const anthropic = entry({ model_name: "claude-sonnet-4-5", litellm_provider: "anthropic" });
    const openai = entry({ model_name: "gpt-5-codex", litellm_provider: "openai" });
    const gemini = entry({ model_name: "gemini-3-flash", litellm_provider: "gemini" });
    const vertex = entry({ model_name: "claude-on-vertex", litellm_provider: "vertex_ai" });
    const bedrock = entry({ model_name: "claude-on-bedrock", litellm_provider: "bedrock" });
    const catalog = [anthropic, openai, gemini, vertex, bedrock];

    it("claude shows every chat entry and marks non-Anthropic providers translated", () => {
      const opts = gatewayModelOptions(catalog, "claude");
      expect(opts.map((o) => o.value).sort()).toEqual(
        ["claude-on-bedrock", "claude-on-vertex", "claude-sonnet-4-5", "gemini-3-flash", "gpt-5-codex"].sort(),
      );
      const anthropicOpt = opts.find((o) => o.value === "claude-sonnet-4-5")!;
      expect(anthropicOpt.sub).not.toContain("translated");
      const openaiOpt = opts.find((o) => o.value === "gpt-5-codex")!;
      expect(openaiOpt.sub).toContain("translated");
    });

    it("codex shows only Responses-capable providers", () => {
      const opts = gatewayModelOptions(catalog, "codex");
      expect(opts.map((o) => o.value)).toEqual(["gpt-5-codex"]);
    });

    it("antigravity (gemini) shows only gemini/vertex_ai", () => {
      const opts = gatewayModelOptions(catalog, "gemini");
      expect(opts.map((o) => o.value).sort()).toEqual(["claude-on-vertex", "gemini-3-flash"].sort());
    });
  });

  describe("[1m] variant synthesis", () => {
    it("adds a [1m] sibling row only when max_input_tokens >= 1,000,000, and only for claude", () => {
      const wide = entry({ model_name: "claude-sonnet-4-5", max_input_tokens: 1_000_000 });
      const claudeOpts = gatewayModelOptions([wide], "claude");
      expect(claudeOpts.map((o) => o.value)).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-5[1m]"]);
      expect(claudeOpts[1].contextWindow).toBe(1_000_000);

      // Same catalog through the gemini fit filter never sees this model at all
      // (it's anthropic), which is a cheap way to confirm the synthesis is
      // gated on `agent === "claude"` and not run unconditionally.
      const geminiEntry = entry({ model_name: "gemini-3-flash", litellm_provider: "gemini", max_input_tokens: 1_000_000 });
      expect(gatewayModelOptions([geminiEntry], "gemini").map((o) => o.value)).toEqual(["gemini-3-flash"]);
    });

    it("does not synthesize [1m] under 1,000,000, or for an already-[1m] id, or for a translated entry", () => {
      const narrow = entry({ model_name: "claude-haiku-4-5", max_input_tokens: 200_000 });
      expect(gatewayModelOptions([narrow], "claude").length).toBe(1);

      const already1m = entry({ model_name: "claude-sonnet-4-5[1m]", max_input_tokens: 1_000_000 });
      expect(gatewayModelOptions([already1m], "claude").map((o) => o.value)).toEqual(["claude-sonnet-4-5[1m]"]);

      const translatedWide = entry({ model_name: "gpt-5-codex", litellm_provider: "openai", max_input_tokens: 1_000_000 });
      expect(gatewayModelOptions([translatedWide], "claude").map((o) => o.value)).toEqual(["gpt-5-codex"]);
    });
  });
});

describe("gatewayContextWindow", () => {
  it("is 0 until a catalog has been probed", () => {
    expect(gatewayContextWindow("claude-sonnet-4-5", "http://127.0.0.1:1")).toBe(0);
  });

  it("reads the window off the probed catalog once one lands, [1m] included", async () => {
    const gw = await startFakeGateway({ models: [{ name: "claude-sonnet-4-5", max_input_tokens: 1_000_000 }] });
    try {
      await gatewayModelCatalog(gw.url, "");
      expect(gatewayContextWindow("claude-sonnet-4-5", gw.url)).toBe(1_000_000);
      expect(gatewayContextWindow("claude-sonnet-4-5[1m]", gw.url)).toBe(1_000_000);
      expect(gatewayContextWindow("some-other-model", gw.url)).toBe(0);
    } finally {
      await gw.close();
    }
  });
});

describe("gatewayModelCatalog probe + cache", () => {
  let gw: FakeGateway;
  afterEach(async () => {
    await gw?.close();
  });

  it("parses /model/info and feeds lib/gatewayPricing.ts's rate table", async () => {
    gw = await startFakeGateway({ models: ["claude-sonnet-4-5"] });
    const catalog = await gatewayModelCatalog(gw.url, "");
    expect(catalog.reachable).toBe(true);
    expect(catalog.models.map((m) => m.model_name)).toEqual(["claude-sonnet-4-5"]);
    expect(lastGatewayModelCatalog(gw.url)?.map((m) => m.model_name)).toEqual(["claude-sonnet-4-5"]);
    // The same probe already primed the estimator, so no separate wiring is needed.
    expect(estimateCostUsd("claude-sonnet-4-5", { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })).not.toBeNull();
  });

  it("reports an unreachable gateway as an answer, and lastGatewayModelCatalog stays null", async () => {
    const catalog = await gatewayModelCatalog("http://127.0.0.1:1", "", 200);
    expect(catalog.reachable).toBe(false);
    expect(catalog.error).toBeTruthy();
    expect(lastGatewayModelCatalog("http://127.0.0.1:1")).toBeNull();
  });
});
