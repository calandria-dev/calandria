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

// Per-model rollup the CLI attaches to its result message. Optional in practice
// (older CLIs, the `--print` JSON path), so every read of it is defensive.
type ModelUsage = Record<string, {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}>;

/**
 * The model a message says the run is ACTUALLY on, or null if it doesn't say.
 *
 * Two sources, in the order they arrive. The init message's `model` is the one
 * the SDK resolved — the same field a task turn badges as `resolved_model` —
 * and is authoritative even when the caller passed no model at all, which is
 * exactly the case a job-tier setting can't describe. The result message has no
 * scalar model field, but its per-model rollup keys are model ids, so it is the
 * fallback for a stream that never announced an init (the CLI's `--print` JSON
 * path is one). One-shots mount no Task tool, so that map holds a single key in
 * practice; the busiest wins if a future one ever fans out.
 */
export function claudeMessageModel(message: unknown): string | null {
  const msg = message as { type?: string; model?: string; modelUsage?: ModelUsage | null };
  if (msg.type === "system") return msg.model || null;
  if (msg.type !== "result") return null;
  const models = msg.modelUsage;
  if (!models || typeof models !== "object") return null;
  let best: string | null = null;
  let most = -1;
  for (const [id, m] of Object.entries(models)) {
    if (!m || typeof m !== "object") continue;
    const n = (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
    if (n > most) {
      most = n;
      best = id;
    }
  }
  return best;
}

/**
 * Tokens this turn spent inside SUBAGENT sidechains — Task-tool fan-outs, each
 * running in its own context window.
 *
 * Verified against the live CLI (two scripted turns, one fanning out to two
 * Explore agents and one to three): the result message's own `usage` counts
 * ONLY the main session's API requests. Its input/cache figures equal the sum
 * over exactly the assistant messages with `parent_tool_use_id == null`, to the
 * token (18/36,808/4,957 against 18/36,808/4,957). Subagents are absent from it
 * entirely — so the task's stored token total has never included them, while
 * `total_cost_usd` always has (measured 0.06117225 = the haiku sidechains'
 * 0.0198921 + the sonnet main session's 0.04128015, exactly). Tokens and
 * dollars on the same chip were describing different turns.
 *
 * `modelUsage` is the whole turn, subagents included — that cost identity is
 * the proof — so the difference between it and `usage` is precisely sidechain
 * spend. Subtracting is also model-agnostic: a subagent running the SAME model
 * as its parent still nets out, where reading "the non-main model's row" would
 * silently report zero.
 *
 * Summing the subagent assistant messages instead does NOT work, which is worth
 * recording because it's the obvious approach. They arrive one message per
 * content block, sharing a `message.id` and repeating identical usage on every
 * copy (five copies of one 16,318-token cache read in the measured turn), so
 * any sum needs deduping by id first; `output_tokens` on them is a partial
 * mid-stream snapshot (4 against the 773 actually billed); and only a
 * sidechain's last message per tool call reaches the stream at all — 29,089
 * cache-read tokens visible against 56,876 billed. It undercounts by half.
 */
export function claudeSubagentTokens(message: {
  usage?: Record<string, number> | null;
  modelUsage?: ModelUsage | null;
}): number {
  const models = message.modelUsage;
  if (!models || typeof models !== "object") return 0;
  let all = 0;
  for (const m of Object.values(models)) {
    if (!m || typeof m !== "object") continue;
    all += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
  }
  const u = message.usage ?? {};
  const main =
    (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  // A turn that never fanned out nets to 0. Clamped because a CLI that ever
  // folds the main session into neither side must not bill it as subagent work.
  return Math.max(0, all - main);
}
