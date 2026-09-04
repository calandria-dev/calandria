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
// default). Used to resolve pricing and the resolved-model badge.
//
// KNOWN WRONG for some accounts, and deliberately still a constant. Read the
// next three paragraphs before touching it, because both values are wrong for
// somebody and flipping it just moves who.
//
// The `priority` rule holds up: the CLI ranks models by it, 1 is the top, and
// the top entry is the default. What that rule returns depends on WHICH
// catalog is in force, and there are two. The fallback catalog compiled into
// the binary is one; the catalog the CLI fetches per ACCOUNT at startup is the
// other, and it wins when it is there. They disagree about the answer:
//
//   embedded fallback, 0.153.0    gpt-5.6-sol priority 1, no gpt-6-astra at all
//   account catalog,   0.153.0    gpt-6-astra priority 1, gpt-5.6-sol at 6
//
// So the default is gpt-6-astra on an account that has Astra, and gpt-5.6-sol
// on one that doesn't, offline, or on any pin that can't run it. Astra shipped
// Daybreak-gated (the embedded catalog still carries two hidden
// gpt-daybreak-*-latest rows), so both kinds of account are real right now.
// Setting this to Astra would misprice every account without it by the same 2x
// this currently misprices every account with it, in the other direction. One
// hardcoded id cannot be right for both, which is the actual finding: the fix
// is to READ the catalog (~/.codex/models_cache.json, the sibling task that
// already owns parsing that file), not to re-guess this string. Until then
// this holds the value that is right for the account that has fetched no
// catalog, because that is also the value the CLI itself falls back to.
//
// To re-check, cheapest first:
//   1. Offline, no login. The binary embeds that fallback catalog as readable
//      JSON. Find `{\n  "models": [`, brace-match it, and read `slug` and
//      `priority`; a slug that appears zero times in the binary is one the
//      fallback has never heard of.
//   2. End-to-end, needs a live login, and this is the only check that sees
//      the ACCOUNT catalog. Run `codex exec` with no `--model` under a scratch
//      CODEX_HOME (no config.toml to override the default) and read the model
//      off the rollout in $CODEX_HOME/sessions. Copy credentials in from
//      wherever the CLI keeps them; there is no ~/.codex/auth.json on a 0.146
//      or 0.153 install, and a recipe that cp's one fails silently, then 401s
//      five times, then exits 0 with an empty rollout that reads like a
//      missing answer rather than a broken run.
//
// Measured 2026-09-03 by step 1 against both the old 0.146.0 pin and the
// current 0.153.0 one, which agree. Step 2 has never been run: `codex login
// status` reports "Not logged in" on the machine this was checked from.

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
