// Whether the LiteLLM gateway's catalog covers every model `agy` needs
// (docs/AGENTS.md), including the flash-lite side call it makes on every
// turn, which `agy models` lists as an ordinary selectable entry instead of
// something hidden. A model missing from the gateway's /model/info list
// fails the turn deep inside `agy`, with an opaque "Agent execution
// terminated due to error" and no clue which model was the problem, so the
// health card names the gap up front instead.
//
// A real CLI spawn (agyModelSlugs), so this is polled far less often than the
// gateway probe itself and, like GET /api/agents' other gateway reads, fired
// without blocking the response: the answer lands in time for the next read
// of the same route.

import { agyModelSlugs } from "./auth";
import { gatewayModelCatalog } from "../../gatewayModels";
import { normalizeBaseUrl } from "../../agentEnv";

export interface GeminiGatewayModelCheck {
  /** What `agy models` reported when this last ran. */
  checked: string[];
  /** The subset of `checked` absent from the gateway's own catalog. */
  missing: string[];
}

const CHECK_CACHE_MS = 60_000;

// On globalThis so an HMR reload doesn't reset it; see lib/gatewayHealth.ts.
const store = globalThis as { __calandriaGeminiGatewayCheck?: Map<string, { at: number; value: GeminiGatewayModelCheck | null }> };
const cache = (store.__calandriaGeminiGatewayCheck ??= new Map());

/**
 * Run the check (or return the cached answer). Null when there is nothing to
 * report: `agy` isn't signed in, isn't installed, or the gateway's own
 * catalog didn't answer. Any of those means the comparison can't be made,
 * not that every model is missing.
 */
export async function geminiGatewayModelCheck(baseUrl: string, key: string): Promise<GeminiGatewayModelCheck | null> {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return null;
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < CHECK_CACHE_MS) return hit.value;
  const [slugs, catalog] = await Promise.all([agyModelSlugs(), gatewayModelCatalog(base, key)]);
  const value: GeminiGatewayModelCheck | null =
    slugs && catalog.reachable
      ? { checked: slugs, missing: slugs.filter((s) => !catalog.models.some((m) => m.model_name === s)) }
      : null;
  cache.set(base, { at: Date.now(), value });
  return value;
}

/** The last computed check for this base URL, synchronously. What the
 *  GET /api/agents route reads for whichever tab's request triggered the
 *  fire-and-forget probe above. */
export function lastGeminiGatewayModelCheck(baseUrl: string): GeminiGatewayModelCheck | null {
  const base = normalizeBaseUrl(baseUrl);
  return (base && cache.get(base)?.value) ?? null;
}

/** Drop every cached check, the suite's between-tests reset. */
export function clearGeminiGatewayModelCheckCache(): void {
  cache.clear();
}
