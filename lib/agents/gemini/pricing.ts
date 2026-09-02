// Estimated dollar cost for Antigravity (Gemini) turns. The CLI reports token
// counts only — `result.usage` carries no dollar figure and the subscription
// draws quota rather than billing per turn — so spend is estimated as token
// counts × Google's published API prices for the resolved model, the same
// "API-equivalent" framing the Codex driver uses (./ ../codex/pricing.ts).
// The estimate flows into the ordinary usage pipeline (task_usage.cost_usd) and
// capabilities.costIsEstimated tells the UI to label it with a ~.

import type { TurnUsage } from "../../types";

// Google tiers the Pro models by PROMPT SIZE: prompts over 200k tokens bill at
// a higher rate on every bucket. The Flash models have no such split, so their
// rows repeat one price in both slots rather than carrying a special case.
const LARGE_PROMPT_TOKENS = 200_000;

interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

interface Row {
  prefix: string;
  /** Price for prompts at or under LARGE_PROMPT_TOKENS. */
  small: Price;
  /** Price for prompts above it; identical to `small` where Google doesn't tier. */
  large: Price;
  /**
   * Introductory pricing that ends on a date. Google is running the 3.7/3.6
   * Flash line at half price "through Dec 31 2026", after which `small`/`large`
   * above (the standard rate) applies. Encoded rather than hardcoded to the
   * promo so the estimate doesn't silently halve every turn from 2027 on.
   */
  promoUntil?: { endsAtMs: number; small: Price; large: Price };
}

// 2027-01-01T00:00:00Z — when the 3.7/3.6 Flash introductory rate lapses.
const PROMO_END_MS = Date.UTC(2027, 0, 1);

// Published API prices in USD per 1M tokens, verified 2026-09-01 against
// ai.google.dev/gemini-api/docs/pricing and cloud.google.com's Agent Platform
// pricing page (both stamped 2026-09-01). Cached input is Google's flat 90%
// discount on input across every model in the catalog.
//
// Matched by LONGEST PREFIX, so dated/suffixed ids hit their family row — keep
// more-specific prefixes above shorter ones ("gemini-3.5-flash-lite" MUST sit
// above "gemini-3.5-flash", and the bare "gemini" catch-all stays last).
// Retired models keep their rows: a historical turn prices against the model it
// actually ran on, even once the picker stops offering it.
//
// Two things NOT priced here, both deliberate. Context-cache STORAGE is billed
// per token-hour ($4.50/1M tok-hr on Pro, $1.00 on Flash) and the CLI reports
// no cache lifetime, so there is nothing to multiply. And the audio input rate
// (higher on the 2.5/3.1 Flash rows) is ignored because a coding turn's input
// is text; the text rate is the one every turn actually pays.
const PRICES: Row[] = [
  {
    prefix: "gemini-3.7-flash",
    small: { input: 1.5, cachedInput: 0.15, output: 7.5 },
    large: { input: 1.5, cachedInput: 0.15, output: 7.5 },
    promoUntil: {
      endsAtMs: PROMO_END_MS,
      small: { input: 0.75, cachedInput: 0.075, output: 3.75 },
      large: { input: 0.75, cachedInput: 0.075, output: 3.75 },
    },
  },
  {
    prefix: "gemini-3.6-flash",
    small: { input: 1.5, cachedInput: 0.15, output: 7.5 },
    large: { input: 1.5, cachedInput: 0.15, output: 7.5 },
    promoUntil: {
      endsAtMs: PROMO_END_MS,
      small: { input: 0.75, cachedInput: 0.075, output: 3.75 },
      large: { input: 0.75, cachedInput: 0.075, output: 3.75 },
    },
  },
  {
    prefix: "gemini-3.5-flash-lite",
    small: { input: 0.3, cachedInput: 0.03, output: 2.5 },
    large: { input: 0.3, cachedInput: 0.03, output: 2.5 },
  },
  {
    prefix: "gemini-3.5-flash",
    small: { input: 1.5, cachedInput: 0.15, output: 9.0 },
    large: { input: 1.5, cachedInput: 0.15, output: 9.0 },
  },
  {
    prefix: "gemini-3.1-flash-lite",
    small: { input: 0.25, cachedInput: 0.025, output: 1.5 },
    large: { input: 0.25, cachedInput: 0.025, output: 1.5 },
  },
  {
    // The only Pro model in the 3.x line as of 2026-09-01, and still Preview:
    // there is no `gemini-3.1-pro` GA slug. The bare prefix covers both the
    // plain id and the `-customtools` variant.
    prefix: "gemini-3.1-pro",
    small: { input: 2.0, cachedInput: 0.2, output: 12.0 },
    large: { input: 4.0, cachedInput: 0.4, output: 18.0 },
  },
  {
    prefix: "gemini-2.5-pro",
    small: { input: 1.25, cachedInput: 0.125, output: 10.0 },
    large: { input: 2.5, cachedInput: 0.25, output: 15.0 },
  },
  {
    prefix: "gemini-2.5-flash-lite",
    small: { input: 0.1, cachedInput: 0.01, output: 0.4 },
    large: { input: 0.1, cachedInput: 0.01, output: 0.4 },
  },
  {
    prefix: "gemini-2.5-flash",
    small: { input: 0.3, cachedInput: 0.03, output: 2.5 },
    large: { input: 0.3, cachedInput: 0.03, output: 2.5 },
  },
  // Catch-all, and the fallback for a model that matches no prefix at all.
  //
  // Two real populations land here, both deliberately. `gemini-3.8-flash-*` is
  // what `agy models` serves by default, and Google has not published prices for
  // the 3.8 line — inventing one would put a fabricated number on every turn, so
  // it estimates at the 3.5 Flash rate instead. And the Antigravity catalog is
  // not Gemini-only: it also serves `claude-sonnet-4-6`, `claude-opus-4-6-thinking`
  // and `gpt-oss-120b-medium`, which don't start with "gemini" and so reach this
  // row through the `??` fallback below rather than by prefix.
  //
  // Both cases are honest under costIsEstimated: the subscription draws quota
  // rather than billing per token, so every figure this file produces is an
  // API-equivalent approximation, not an invoice.
  {
    prefix: "gemini",
    small: { input: 1.5, cachedInput: 0.15, output: 9.0 },
    large: { input: 1.5, cachedInput: 0.15, output: 9.0 },
  },
];

/**
 * The `agy` CLI's own default model, assumed when a task doesn't pick one (the
 * driver then omits `--model` entirely and the CLI runs its default). Used to
 * resolve pricing and the resolved-model badge.
 *
 * Measured on a signed-in host: `agy models` lists this first and the
 * interactive CLI's status bar reads "Gemini 3.8 Flash · high". Note the
 * REASONING EFFORT IS PART OF THE SLUG in this catalog — there is no bare
 * `gemini-3.8-flash` — which is why ./capabilities.ts offers no separate
 * reasoning picker.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-high";

/** The model an Antigravity turn effectively runs: the task's choice, else the CLI default. */
export function resolveGeminiModel(taskModel: string | null | undefined): string {
  return taskModel || DEFAULT_GEMINI_MODEL;
}

function priceFor(model: string, promptTokens: number, atMs: number): Price {
  const row = PRICES.find((r) => model.startsWith(r.prefix)) ?? PRICES[PRICES.length - 1];
  const table = row.promoUntil && atMs < row.promoUntil.endsAtMs ? row.promoUntil : row;
  return promptTokens > LARGE_PROMPT_TOKENS ? table.large : table.small;
}

/**
 * Estimate the dollar cost of one turn from its token counts. Takes the buckets
 * in the app's DISJOINT form (what ./usage.ts emits, matching Claude's):
 * `input_tokens` is fresh prompt only, cache reads counted separately.
 *
 * The Pro tier boundary is decided on the whole PROMPT — fresh input plus what
 * was served from cache — because that is what Google measures, not the fresh
 * remainder after a cache hit. `atMs` is injectable so the promo-rate boundary
 * is testable without waiting for 2027.
 */
export function estimateCostUsd(
  model: string,
  usage: Pick<TurnUsage, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens">,
  atMs: number = Date.now()
): number {
  const fresh = Math.max(0, usage.input_tokens) + Math.max(0, usage.cache_creation_tokens);
  const cached = Math.max(0, usage.cache_read_tokens);
  const p = priceFor(model, fresh + cached, atMs);
  return (fresh * p.input + cached * p.cachedInput + Math.max(0, usage.output_tokens) * p.output) / 1_000_000;
}
