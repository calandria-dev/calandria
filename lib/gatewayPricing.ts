// Estimated dollar cost for turns against the LiteLLM gateway
// (docs/design/litellm.md, "Model catalog, context windows and prices"). No
// CLI exposes LiteLLM's own x-litellm-response-cost header, so Calandria
// computes the estimate itself from the per-model rates GET /model/info
// reports — the same "recompute from a published price table" shape
// lib/agents/codex/pricing.ts uses for a ChatGPT-plan Codex turn, except the
// table here is the gateway's OWN and kept current by every catalog probe
// (lib/gatewayModels.ts) rather than hand-maintained.

import type { TurnUsage } from "./types";

interface GatewayModelRate {
  input: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  output: number | null;
}

// On globalThis for the reason every other probe cache in this codebase is
// (lib/modelEndpoint.ts, lib/gatewayHealth.ts): an HMR reload must not blank
// the table a mid-flight turn is about to price against.
const store = globalThis as { __calandriaGatewayRates?: Map<string, GatewayModelRate> };
const rates = (store.__calandriaGatewayRates ??= new Map());

interface RateSource {
  model_name: string;
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cache_read_input_token_cost: number | null;
  cache_creation_input_token_cost: number | null;
}

/**
 * Replace the rate table with what the latest `/model/info` probe reported.
 * Wholesale, not merged: a model dropped from the gateway's catalog must stop
 * pricing turns against a rate it no longer offers.
 */
export function recordGatewayRates(entries: readonly RateSource[]): void {
  rates.clear();
  for (const e of entries) {
    rates.set(e.model_name, {
      input: e.input_cost_per_token,
      cache_read: e.cache_read_input_token_cost,
      cache_creation: e.cache_creation_input_token_cost,
      output: e.output_cost_per_token,
    });
  }
}

/** Drop every recorded rate — the suite's between-tests reset. */
export function clearGatewayRates(): void {
  rates.clear();
}

/**
 * Estimate the dollar cost of a gateway turn from its token counts and the
 * last probe's rate for the model it ran:
 * `input × input_cost + cache_read × cache_read_cost + cache_creation ×
 * cache_creation_cost + output × output_cost`. LiteLLM's `model_info` prices
 * are already per-token (unlike lib/agents/codex/pricing.ts's per-1M static
 * table), so there is no division here.
 *
 * `null` when the model never appeared in a probe — recorded as unpriced by
 * the caller, exactly like a `custom` endpoint today. A rate the catalog left
 * unset for one bucket (many models don't support prompt caching at all)
 * prices that bucket at 0 rather than voiding the whole estimate.
 */
export function estimateCostUsd(
  model: string | null | undefined,
  usage: Pick<TurnUsage, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens">,
): number | null {
  const r = model ? rates.get(model) : undefined;
  if (!r) return null;
  return (
    Math.max(0, usage.input_tokens) * (r.input ?? 0) +
    Math.max(0, usage.cache_read_tokens) * (r.cache_read ?? 0) +
    Math.max(0, usage.cache_creation_tokens) * (r.cache_creation ?? 0) +
    Math.max(0, usage.output_tokens) * (r.output ?? 0)
  );
}
