// The LiteLLM gateway's own model catalog (docs/AGENTS.md): GET
// <gateway>/model/info, which states each model's context window and price,
// unlike a driver's hardcoded catalog (lib/agents/claude/capabilities.ts and
// friends) or the Ollama/OpenAI-shaped probe in lib/modelEndpoint.ts (the
// gateway 404s /api/tags and /v1/models instead of answering those).
//
// SDK-free and Node-free beyond fetch, mirroring lib/gatewayHealth.ts, so
// lib/agents/claude/capabilities.ts (itself SDK-free) can read the last
// probe synchronously without dragging an SDK into the graph.
// tests/importGraph.test.ts pins the SDK-free set this belongs to.

import { MODEL_PROBE_MS } from "./config";
import { gatewayBaseUrl, normalizeBaseUrl } from "./agentEnv";
import { recordGatewayRates } from "./gatewayPricing";
import type { AgentModelOption } from "./agents/types";

/** One `/model/info` entry, the fields this app reads out of its `model_info`. */
export interface GatewayModelInfo {
  model_name: string;
  litellm_provider: string;
  max_input_tokens: number;
  max_output_tokens: number;
  mode: string | null;
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cache_read_input_token_cost: number | null;
  cache_creation_input_token_cost: number | null;
}

export interface GatewayCatalog {
  base_url: string;
  reachable: boolean;
  models: GatewayModelInfo[];
  error: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseEntry(raw: unknown): GatewayModelInfo | null {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const name = typeof rec?.model_name === "string" ? rec.model_name.trim() : "";
  if (!name) return null;
  const info = rec?.model_info && typeof rec.model_info === "object" ? (rec.model_info as Record<string, unknown>) : {};
  return {
    model_name: name,
    litellm_provider: typeof info.litellm_provider === "string" ? info.litellm_provider : "",
    max_input_tokens: num(info.max_input_tokens) ?? 0,
    max_output_tokens: num(info.max_output_tokens) ?? 0,
    mode: typeof info.mode === "string" ? info.mode : null,
    input_cost_per_token: num(info.input_cost_per_token),
    output_cost_per_token: num(info.output_cost_per_token),
    cache_read_input_token_cost: num(info.cache_read_input_token_cost),
    cache_creation_input_token_cost: num(info.cache_creation_input_token_cost),
  };
}

function unreachable(base: string, error: string): GatewayCatalog {
  return { base_url: base, reachable: false, models: [], error };
}

// Mirrors lib/gatewayHealth.ts / lib/modelEndpoint.ts: a Node fetch
// failure's useful text is on `message`/`cause`, and "timed out" reads
// better than an AbortError's default message.
function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /timed? ?out|abort/i.test(m) ? "timed out" : m.replace(/^TypeError: /, "");
}

async function probe(base: string, key: string, timeoutMs: number): Promise<GatewayCatalog> {
  try {
    const r = await fetch(`${base}/model/info`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", ...(key ? { "x-litellm-api-key": `Bearer ${key}` } : {}) },
      cache: "no-store",
    });
    if (!r.ok) return unreachable(base, `${r.status} ${r.statusText || "error"}`);
    const body = (await r.json()) as { data?: unknown[] };
    const models: GatewayModelInfo[] = [];
    for (const raw of Array.isArray(body?.data) ? body.data : []) {
      const parsed = parseEntry(raw);
      if (parsed) models.push(parsed);
    }
    // The same response feeds pricing (docs/AGENTS.md): every caller of this
    // probe, not just the picker route, keeps lib/gatewayPricing.ts's rate
    // table current.
    recordGatewayRates(models);
    return { base_url: base, reachable: true, models, error: null };
  } catch (e) {
    return unreachable(base, reason(e));
  }
}

// ---------- cache: last probe per base URL, held for a sync read too ----------

/** Same window as ENDPOINT_CACHE_MS / GATEWAY_CACHE_MS: short enough that
 *  reopening the model picker sees a change, long enough that several tabs
 *  loading it at once don't each open a socket. */
export const GATEWAY_MODELS_CACHE_MS = 10_000;

// On globalThis so an HMR reload doesn't reset it; see lib/modelEndpoint.ts.
const store = globalThis as { __calandriaGatewayModels?: Map<string, { at: number; value: GatewayCatalog }> };
const cache = (store.__calandriaGatewayModels ??= new Map());

/** The gateway's catalog, cached and bounded by MODEL_PROBE_MS. Never throws:
 *  an unreachable gateway is an ordinary answer, the same contract every other
 *  probe in this codebase keeps. */
export async function gatewayModelCatalog(
  baseUrl: string | null | undefined = gatewayBaseUrl(),
  key = "",
  timeoutMs = MODEL_PROBE_MS,
): Promise<GatewayCatalog> {
  const base = normalizeBaseUrl(String(baseUrl ?? ""));
  if (!base) return unreachable("", "no base URL");
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < GATEWAY_MODELS_CACHE_MS) return hit.value;
  const value = await probe(base, key, timeoutMs);
  cache.set(base, { at: Date.now(), value });
  return value;
}

/**
 * The last successfully probed catalog, synchronously: what
 * claudeCapabilities() reads, since it must stay synchronous like every other
 * branch of that descriptor. `null` means nothing has been probed yet, or
 * the last probe failed; callers treat that as "fall back to the static
 * catalog", the same "absent is a supported state" contract every other
 * probe-backed descriptor branch follows (lib/agents/claude/modelProbe.ts).
 */
export function lastGatewayModelCatalog(baseUrl: string | null | undefined = gatewayBaseUrl()): GatewayModelInfo[] | null {
  const base = normalizeBaseUrl(String(baseUrl ?? ""));
  if (!base) return null;
  const hit = cache.get(base);
  return hit?.value.reachable ? hit.value.models : null;
}

/** The window for one model id from the gateway's last-probed catalog, or 0
 *  for "unknown", the same contract lib/contextWindow.ts's callers read. A
 *  `[1m]` suffix (the beta variant gatewayModelOptions() below synthesizes)
 *  resolves against its bare id. */
export function gatewayContextWindow(model: string | null | undefined, baseUrl: string | null | undefined = gatewayBaseUrl()): number {
  if (!model) return 0;
  const catalog = lastGatewayModelCatalog(baseUrl);
  if (!catalog) return 0;
  const bare = model.replace(/\[1m\]$/i, "");
  const hit = catalog.find((e) => e.model_name === model) ?? catalog.find((e) => e.model_name === bare);
  if (!hit) return 0;
  return /\[1m\]$/i.test(model) ? Math.max(hit.max_input_tokens, 1_000_000) : hit.max_input_tokens;
}

/** Drop every cached probe. Used to reset state between tests. */
export function clearGatewayModelCache(): void {
  cache.clear();
}

// ---------- catalog entry -> picker option, filtered by driver fit ----------

/** Which driver a gateway model list is being built for. The picker route
 *  (GET /api/projects/[id]/models) serves all three, since a project can
 *  point any agent's task at the gateway preset. */
export type GatewayFitAgent = "claude" | "codex" | "gemini";

// LiteLLM's own Responses-API passthrough providers. Not exhaustive; a
// conservative starting set, extended as it's checked against real gateway
// instances.
const RESPONSES_CAPABLE_PROVIDERS = new Set(["openai", "azure"]);

// Providers LiteLLM routes through its Gemini-shaped surface (docs/AGENTS.md).
const GEMINI_PROVIDERS = new Set(["gemini", "vertex_ai"]);

function fitsDriver(agent: GatewayFitAgent, e: GatewayModelInfo): boolean {
  if (e.mode !== "chat") return false;
  if (agent === "claude") return true; // every chat entry; non-Anthropic ones are marked "translated" below
  if (agent === "codex") return RESPONSES_CAPABLE_PROVIDERS.has(e.litellm_provider);
  return GEMINI_PROVIDERS.has(e.litellm_provider);
}

function fmtPrice(perToken: number | null): string | null {
  if (perToken == null) return null;
  const per1m = perToken * 1_000_000;
  return `$${per1m.toFixed(per1m < 10 ? 2 : 0)}/1M`;
}

function priceLabel(e: GatewayModelInfo): string | null {
  const inp = fmtPrice(e.input_cost_per_token);
  const out = fmtPrice(e.output_cost_per_token);
  if (inp && out) return `${inp} in, ${out} out`;
  return inp ?? out;
}

/**
 * Catalog entries to the picker's AgentModelOption[], filtered to what fits
 * `agent` (docs/AGENTS.md: Claude shows every chat entry and marks
 * non-Anthropic providers translated; Codex shows Responses-capable
 * providers; Antigravity shows gemini/vertex_ai). `group` is the provider, so
 * the picker sections the same way a driver's own static catalog does.
 *
 * A LiteLLM wildcard route (`anthropic/*`) arrives as exactly one entry (the
 * proxy doesn't expand it into every model it would match), so it needs no
 * collapsing, only a label that says what it is instead of the raw pattern.
 */
export function gatewayModelOptions(catalog: readonly GatewayModelInfo[], agent: GatewayFitAgent): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  for (const e of catalog) {
    if (!fitsDriver(agent, e)) continue;
    const wildcard = e.model_name.endsWith("/*");
    const translated = agent === "claude" && e.litellm_provider !== "anthropic";
    const price = priceLabel(e);
    const sub = [e.litellm_provider || "unknown provider", price, translated ? "translated" : null].filter(Boolean).join(" · ");
    const group = e.litellm_provider || "other";
    out.push({
      value: e.model_name,
      label: wildcard ? `Any ${e.litellm_provider || "gateway"} model id` : e.model_name,
      sub,
      contextWindow: e.max_input_tokens,
      group,
    });
    // The [1m] beta variant, synthesized only where the catalog itself claims
    // the window: never offered for a model the gateway reports as 200k, the
    // same reasoning the Vertex correction applies to an alias's window
    // (lib/agents/claude/capabilities.ts).
    if (agent === "claude" && !wildcard && !translated && e.max_input_tokens >= 1_000_000 && !e.model_name.endsWith("[1m]")) {
      out.push({ value: `${e.model_name}[1m]`, label: `${e.model_name} (1M)`, sub, contextWindow: e.max_input_tokens, group });
    }
  }
  return out;
}
