import type { TurnUsage } from "../../types";

/** Normalize the token/cost fields shared by Claude SDK and CLI result JSON. */
export function claudeUsage(message: {
  total_cost_usd?: number;
  usage?: Record<string, number> | null;
}): TurnUsage {
  const u = message.usage ?? {};
  return {
    cost_usd: message.total_cost_usd ?? 0,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
  };
}
