// Estimated dollar cost for Codex turns. ChatGPT-plan auth reports token
// counts only (no dollar figure), so spend is estimated as token counts ×
// OpenAI's published API prices for the resolved model, the same
// "API-equivalent" framing the Insights dashboard already uses. The estimate
// flows into the ordinary usage/cost pipeline (task_usage.cost_usd), and the
// capability descriptor's costIsEstimated flag tells the UI to label it as
// an estimate rather than a billed amount.

import type { TurnUsage } from "../../types";
import { codexDefaultModel } from "./catalog";

// Published API prices in USD per 1M tokens (developers.openai.com/api/docs/
// pricing). Cached input is OpenAI's standard 90% discount on input. Matched
// by longest prefix so dated/suffixed model ids ("gpt-5.4-mini-…") hit their
// family row; keep more-specific prefixes above shorter ones: "gpt-5.4-mini"
// must sit above "gpt-5.4", and the bare "gpt-5" catch-all stays last.
// Retired models keep their rows: historical turns still price against the
// model they actually ran on, even once the picker stops offering it.
const PRICES: { prefix: string; input: number; cachedInput: number; output: number }[] = [
  // GPT-6 Astra. Priced here ahead of the picker, which still doesn't offer it
  // (see the note in ./capabilities.ts). A row costs nothing while nothing
  // runs on it, and without one a turn that reaches the id out of band (a
  // project-level override, an update_task setting tasks.model) falls through
  // to the Sol fallback below and under-reports by 2x on input. These are the
  // standard rates; Fast mode doubles all three, and nothing in the turn's
  // usage says which one served it, so a Fast turn reads half its true cost.
  { prefix: "gpt-6-astra", input: 10.0, cachedInput: 1.0, output: 50.0 },
  { prefix: "gpt-5.6-sol", input: 5.0, cachedInput: 0.5, output: 30.0 },
  { prefix: "gpt-5.6-terra", input: 2.0, cachedInput: 0.2, output: 12.0 },
  { prefix: "gpt-5.6-luna", input: 0.2, cachedInput: 0.02, output: 1.2 },
  // The bare "gpt-5.6" alias routes to Sol, so it prices as Sol. Must sit
  // below the suffixed rows, since it's a prefix of all three.
  { prefix: "gpt-5.6", input: 5.0, cachedInput: 0.5, output: 30.0 },
  { prefix: "gpt-5.5", input: 5.0, cachedInput: 0.5, output: 30.0 },
  { prefix: "gpt-5.4-mini", input: 0.75, cachedInput: 0.075, output: 4.5 },
  { prefix: "gpt-5.4", input: 2.5, cachedInput: 0.25, output: 15.0 },
  { prefix: "gpt-5.3-codex", input: 1.75, cachedInput: 0.175, output: 14.0 },
  { prefix: "gpt-5.2", input: 1.75, cachedInput: 0.175, output: 14.0 },
  { prefix: "gpt-5.1-codex-mini", input: 0.25, cachedInput: 0.025, output: 2.0 },
  { prefix: "gpt-5.1-codex-max", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5.1-codex", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5.1", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5-codex", input: 1.25, cachedInput: 0.125, output: 10.0 },
  { prefix: "gpt-5-mini", input: 0.25, cachedInput: 0.025, output: 2.0 },
  { prefix: "gpt-5", input: 1.25, cachedInput: 0.125, output: 10.0 },
];

// The model a codex turn runs when nothing picks one (tasks.model = null means
// the model override is omitted and the CLI runs its own default). It
// resolves pricing and the resolved-model badge. This constant is the
// fallback for that resolution rather than the answer; see resolveCodexModel
// below.
//
// One hardcoded id could never be right, because the default is per account.
// The `priority` rule holds up (the CLI ranks models by it, 1 is the top, and
// the top entry is the default), but what it returns depends on which catalog
// is in force, and there are two: the fallback catalog compiled into the
// binary, and the catalog the CLI fetches per account at startup, which wins
// when it is there. The two can disagree on both which model ranks first and
// whether a model is listed at all, and since prices vary by model, guessing
// wrong misprices every default turn. ./catalog.ts reads the account catalog
// instead of guessing. What stays here is the value for an account that has
// fetched no catalog, which is also the value the CLI itself falls back to.
//
// To re-check the embedded half, offline and with no login: the binary embeds
// that fallback catalog as readable JSON. Find `{\n  "models": [`, brace-match
// it, and read `slug` and `priority`; a slug that appears zero times in the
// binary is one the fallback has never heard of.

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/**
 * The model a codex turn effectively runs: the task's choice, else whatever the
 * local CLI would default to (config.toml's `model`, else the top-`priority`
 * listed entry in the account catalog, else DEFAULT_CODEX_MODEL). Reads
 * ~/.codex through a cache; an absent or unreadable one returns the constant.
 */
export function resolveCodexModel(taskModel: string | null | undefined): string {
  return taskModel || codexDefaultModel(DEFAULT_CODEX_MODEL);
}

/**
 * Estimate the dollar cost of a turn from its token counts. Takes the buckets in
 * the app's disjoint form (the shape lib/agents/codex/events.ts emits, matching
 * Claude's): `input_tokens` is fresh prompt only, cache reads and cache writes
 * are counted separately. Cache writes bill at the plain input rate (OpenAI adds
 * no write surcharge); cache reads at the 90%-off rate. Unknown models price at
 * the CLI-default family, using the resolved default, so the estimate degrades
 * gracefully instead of reporting $0, and an Astra account's unpriceable ids
 * fall back to Astra's rates rather than to Sol's.
 */
export function estimateCostUsd(
  model: string,
  usage: Pick<TurnUsage, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens">
): number {
  // Three steps, because the resolved default is catalog data and a catalog
  // may name a model this table has no row for. The constant is the last resort
  // and always matches, which is what makes the assertion safe.
  const fallbackModel = resolveCodexModel(null);
  const p =
    PRICES.find((r) => model.startsWith(r.prefix)) ??
    PRICES.find((r) => fallbackModel.startsWith(r.prefix)) ??
    PRICES.find((r) => DEFAULT_CODEX_MODEL.startsWith(r.prefix))!;
  const fresh = Math.max(0, usage.input_tokens) + Math.max(0, usage.cache_creation_tokens);
  return (fresh * p.input + Math.max(0, usage.cache_read_tokens) * p.cachedInput + usage.output_tokens * p.output) / 1_000_000;
}
