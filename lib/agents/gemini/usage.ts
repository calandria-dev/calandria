import type { TurnUsage } from "../../types";
import { estimateCostUsd } from "./pricing";

/**
 * The `usage` object on an `agy` `result` event, exactly as the CLI reports it.
 * Every counter is optional: the app drives a CLI binary the user installed,
 * which may be older or newer than this driver.
 *
 * Shape:
 *   "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,
 *            "cache_read_tokens":0,"total_tokens":0}
 * What is absent, and what the app therefore cannot report: no
 * cache-write/creation counter, and no cost field of any kind. Hence
 * capabilities.reportsCostUsd = false and the estimate in ./pricing.ts.
 */
export interface GeminiTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/**
 * Normalize and price the token-only usage an `agy` turn reports.
 *
 * The app's contract keeps the input buckets disjoint (matching Claude's), so
 * cached reads must not also be counted inside `input_tokens`, or they are
 * double-charged in the task total and inflate the context gauge.
 *
 * Whether the CLI's `input_tokens` includes `cache_read_tokens` is decided
 * per-report instead of assumed, because the two conventions are
 * indistinguishable from the field names and getting it wrong produces no
 * visible error: if netting them out would go negative, the counters were
 * already disjoint and are taken at face value. Codex reports the inclusive
 * form, which is why that is the branch tried first.
 *
 * `thinking_tokens` folds into output: reasoning bills as output, the same
 * treatment `reasoning_output_tokens` gets on the Codex side. `total_tokens`
 * is the CLI's own sum and is ignored: the app derives its total from the
 * disjoint buckets, and trusting a sum computed under the other convention
 * would reintroduce the double-count this function exists to remove.
 */
export function geminiUsage(u: GeminiTokenUsage, model: string, atMs?: number): TurnUsage {
  const rawInput = Math.max(0, u.input_tokens ?? 0);
  const cacheRead = Math.max(0, u.cache_read_tokens ?? 0);
  const usage: TurnUsage = {
    cost_usd: 0,
    input_tokens: rawInput >= cacheRead ? rawInput - cacheRead : rawInput,
    output_tokens: Math.max(0, u.output_tokens ?? 0) + Math.max(0, u.thinking_tokens ?? 0),
    cache_read_tokens: cacheRead,
    // The CLI reports no cache-write counter, so this stays zero instead of
    // guessing. It is priced at the plain input rate if a future CLI adds one.
    cache_creation_tokens: 0,
  };
  usage.cost_usd = estimateCostUsd(model, usage, atMs);
  return usage;
}
