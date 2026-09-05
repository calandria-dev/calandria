// Estimated dollar cost for turns against the LiteLLM gateway (docs/AGENTS.md).
// No CLI exposes LiteLLM's own x-litellm-response-cost header, so Calandria
// computes the estimate from the per-model rates GET /model/info reports,
// the same approach lib/agents/codex/pricing.ts uses for a ChatGPT-plan Codex
// turn. The table here is the gateway's own and stays current from every
// catalog probe (lib/gatewayModels.ts).

import type { TurnUsage } from "./types";

interface GatewayModelRate {
  input: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  output: number | null;
}

// Lives on globalThis, like the other probe caches (lib/modelEndpoint.ts,
// lib/gatewayHealth.ts), so an HMR reload doesn't blank the table a
// mid-flight turn is pricing against.
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
 * Replace the rate table wholesale with the latest `/model/info` probe. A
 * model dropped from the gateway's catalog stops pricing turns against a
 * rate it no longer offers.
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

/** Drop every recorded rate. Used to reset state between tests. */
export function clearGatewayRates(): void {
  rates.clear();
}

/**
 * Estimate the dollar cost of a gateway turn from its token counts and the
 * last probe's rate for the model it ran:
 * `input × input_cost + cache_read × cache_read_cost + cache_creation ×
 * cache_creation_cost + output × output_cost`. LiteLLM's `model_info` prices
 * are already per-token, unlike lib/agents/codex/pricing.ts's per-1M static
 * table, so there is no division here.
 *
 * Returns `null` when the model never appeared in a probe; the caller
 * records it as unpriced, the same as a `custom` endpoint. A rate the
 * catalog left unset for one bucket (many models don't support prompt
 * caching) prices that bucket at 0 instead of voiding the whole estimate.
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
