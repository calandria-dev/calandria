import type { TurnUsage } from "../../types";
import { estimateCostUsd } from "./pricing";

export interface CodexTokenUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cached_input_tokens: number;
}

/** Normalize and price the token-only usage emitted by Codex. */
export function codexUsage(u: CodexTokenUsage, model: string): TurnUsage {
  const usage = {
    cost_usd: 0,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens + u.reasoning_output_tokens,
    cache_read_tokens: u.cached_input_tokens,
    cache_creation_tokens: 0,
  };
  usage.cost_usd = estimateCostUsd(model, usage);
  return usage;
}
