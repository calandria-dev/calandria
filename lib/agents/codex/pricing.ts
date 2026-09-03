// Estimated dollar cost for Codex turns. ChatGPT-plan auth reports token
// counts only (no dollar figure), so we estimate spend as token counts ×
// OpenAI's published API prices for the resolved model — the same
// "API-equivalent" framing the Insights dashboard already uses. The estimate
// flows into the ordinary usage/cost pipeline (task_usage.cost_usd), and the
// capability descriptor's costIsEstimated flag tells the UI to label it as
// an estimate rather than a billed amount.

import type { TurnUsage } from "../../types";

// Published API prices in USD per 1M tokens (developers.openai.com/api/docs/
// pricing). Cached input is OpenAI's standard 90% discount on input. Matched
// by longest prefix so dated/suffixed model ids ("gpt-5.4-mini-…") hit their
// family row; keep more-specific prefixes above shorter ones — "gpt-5.4-mini"
// MUST sit above "gpt-5.4", and the bare "gpt-5" catch-all stays last.
// Retired models keep their rows: historical turns still price against the
// model they actually ran on, even once the picker stops offering it.
const PRICES: { prefix: string; input: number; cachedInput: number; output: number }[] = [
  // GPT-6 Astra (released 2026-09-03). Priced here ahead of the picker, which
  // still doesn't offer it — see the note in ./capabilities.ts. A row costs
  // nothing while nothing runs on it, and without one a turn that reaches the
  // id out of band (a project-level override, an update_task setting
  // tasks.model) falls through to the Sol fallback below and under-reports by
  // 2x on input. These are the STANDARD rates; Fast mode doubles all three, and
  // nothing in the turn's usage tells us which one served it, so a Fast turn
  // reads half its true cost.
  { prefix: "gpt-6-astra", input: 10.0, cachedInput: 1.0, output: 50.0 },
  { prefix: "gpt-5.6-sol", input: 5.0, cachedInput: 0.5, output: 30.0 },
  { prefix: "gpt-5.6-terra", input: 2.0, cachedInput: 0.2, output: 12.0 },
  { prefix: "gpt-5.6-luna", input: 0.2, cachedInput: 0.02, output: 1.2 },
  // The bare "gpt-5.6" alias routes to Sol, so it prices as Sol. Must sit
  // BELOW the suffixed rows — it's a prefix of all three.
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

// The codex CLI's own default model, assumed when a task doesn't pick one
// (tasks.model = null → we omit the model override and the CLI runs its
// default). Used to resolve pricing and the resolved-model badge; bump when
// upstream changes its default. Verify rather than guess: it's the
// lowest-`priority` entry in the catalog embedded in the CLI binary, and can be
// confirmed end-to-end by running `codex exec` under a scratch CODEX_HOME (no
// config.toml to override it) and reading the model off the session rollout.
//
// SUSPECTED STALE, deliberately not changed here. A 0.153.0 account catalog
// ranks gpt-6-astra `priority: 1` against Sol's 6, and by the rule above that
// makes Astra the CLI default. If it is, every task that never picked a model
// runs Astra and is costed as Sol — half price — and the "(default)" note on
// Sol's picker entry reads wrong too. It isn't flipped on that evidence alone
// because `priority` is the catalog's ORDERING field and this constant claims
// something stronger, the check above is the one that settles it, and guessing
// wrong mis-prices the same turns in the other direction. Settle it with a
// no-`--model` run under a scratch CODEX_HOME, then change both places.
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/** The model a codex turn effectively runs: the task's choice, else the CLI default. */
export function resolveCodexModel(taskModel: string | null | undefined): string {
  return taskModel || DEFAULT_CODEX_MODEL;
}

/**
 * Estimate the dollar cost of a turn from its token counts. Takes the buckets in
 * the app's DISJOINT form (the shape lib/agents/codex/events.ts emits, matching
 * Claude's): `input_tokens` is fresh prompt only, cache reads and cache writes
 * are counted separately. Cache writes bill at the plain input rate (OpenAI adds
 * no write surcharge); cache reads at the 90%-off rate. Unknown models price at
 * the CLI-default family so the estimate degrades gracefully instead of silently
 * reporting $0.
 */
export function estimateCostUsd(
  model: string,
  usage: Pick<TurnUsage, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens">
): number {
  const p = PRICES.find((r) => model.startsWith(r.prefix)) ?? PRICES.find((r) => DEFAULT_CODEX_MODEL.startsWith(r.prefix))!;
  const fresh = Math.max(0, usage.input_tokens) + Math.max(0, usage.cache_creation_tokens);
  return (fresh * p.input + Math.max(0, usage.cache_read_tokens) * p.cachedInput + usage.output_tokens * p.output) / 1_000_000;
}
