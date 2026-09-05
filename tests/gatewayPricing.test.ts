import { describe, it, expect, afterEach } from "vitest";
import { recordGatewayRates, estimateCostUsd, clearGatewayRates } from "@/lib/gatewayPricing";

// lib/gatewayPricing.ts prices a gateway turn from the rate table the last
// catalog probe left behind (lib/gatewayModels.ts calls recordGatewayRates()
// on every successful /model/info read); it makes no network call of its own.

afterEach(() => clearGatewayRates());

describe("estimateCostUsd", () => {
  it("is null for a model the last probe never reported", () => {
    recordGatewayRates([{ model_name: "claude-sonnet-4-5", input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: null, cache_creation_input_token_cost: null }]);
    expect(estimateCostUsd("gpt-5-codex", { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeNull();
    expect(estimateCostUsd(null, { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeNull();
  });

  it("computes input × rate + cache_read × rate + cache_creation × rate + output × rate", () => {
    recordGatewayRates([
      {
        model_name: "claude-sonnet-4-5",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
      },
    ]);
    const cost = estimateCostUsd("claude-sonnet-4-5", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 2000,
      cache_creation_tokens: 300,
    });
    // 1000*0.000003 + 2000*0.0000003 + 300*0.00000375 + 500*0.000015
    expect(cost).toBeCloseTo(0.003 + 0.0006 + 0.001125 + 0.0075, 10);
  });

  it("prices a missing rate bucket at 0 rather than voiding the whole estimate", () => {
    recordGatewayRates([{ model_name: "no-cache-model", input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: null, cache_creation_input_token_cost: null }]);
    const cost = estimateCostUsd("no-cache-model", { input_tokens: 100, output_tokens: 100, cache_read_tokens: 50, cache_creation_tokens: 50 });
    expect(cost).toBeCloseTo(100 * 0.000002 + 100 * 0.00001, 10);
  });

  it("a fresh probe replaces the table wholesale — a dropped model stops pricing", () => {
    recordGatewayRates([{ model_name: "old-model", input_cost_per_token: 0.000001, output_cost_per_token: 0.000001, cache_read_input_token_cost: null, cache_creation_input_token_cost: null }]);
    expect(estimateCostUsd("old-model", { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 })).not.toBeNull();
    recordGatewayRates([{ model_name: "new-model", input_cost_per_token: 0.000001, output_cost_per_token: 0.000001, cache_read_input_token_cost: null, cache_creation_input_token_cost: null }]);
    expect(estimateCostUsd("old-model", { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBeNull();
  });

  it("clamps negative token counts to 0 rather than crediting them", () => {
    recordGatewayRates([{ model_name: "m", input_cost_per_token: 0.000001, output_cost_per_token: 0.000001, cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost: 0.000001 }]);
    const cost = estimateCostUsd("m", { input_tokens: -5, output_tokens: 10, cache_read_tokens: -5, cache_creation_tokens: 0 });
    expect(cost).toBeCloseTo(10 * 0.000001, 10);
  });
});
