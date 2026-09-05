// Probes a local model server (Ollama or LM Studio; see lib/agentEnv.ts,
// docs/AGENTS.md "Local models") for the model ids it can run, since the
// driver's built-in model list is the vendor's cloud catalog, not what is
// pulled locally. Tries Ollama's GET {base}/api/tags first, since its names
// match the ids its Anthropic endpoint expects, then falls back to the
// OpenAI-compatible GET {base}/v1/models.
//
// Server-side only: the endpoint is loopback on the machine Calandria runs on
// (or the Docker host) and is not reachable from the browser directly.
// SDK-free and pinned by tests/importGraph.test.ts, since GET /api/agents
// probes on every load and that route entry compiles synchronously.

import { normalizeBaseUrl } from "./agentEnv";
import { MODEL_PROBE_MS } from "./config";

/** Which API answered. LM Studio, llama.cpp, vLLM and Ollama's own /v1 all
 *  answer the OpenAI shape, so this identifies the response shape, not the
 *  product. "gateway" is set by the LiteLLM gateway branch in
 *  app/api/projects/[id]/models/route.ts (lib/gatewayModels.ts), which shares
 *  this type instead of probing here. */
export type EndpointApi = "ollama" | "openai" | "gateway";

export interface EndpointModels {
  /** The normalized base URL that was probed ("" when there was none to probe). */
  base_url: string;
  reachable: boolean;
  api: EndpointApi | null;
  /** Model ids exactly as the server names them, in its own order, deduped. */
  models: string[];
  /** Why it isn't reachable, in words a person can act on. null when it is. */
  error: string | null;
}

/** The same fact without the list: what GET /api/agents carries for the
 *  instance-wide default endpoint, which only needs a count. */
export interface EndpointStatus {
  base_url: string;
  reachable: boolean;
  api: EndpointApi | null;
  model_count: number;
  error: string | null;
}

export function summarizeEndpoint(m: EndpointModels): EndpointStatus {
  return { base_url: m.base_url, reachable: m.reachable, api: m.api, model_count: m.models.length, error: m.error };
}

const unreachable = (base_url: string, error: string): EndpointModels => ({ base_url, reachable: false, api: null, models: [], error });

// A fetch failure from Node carries the useful detail on `cause.code`; the
// error message alone is generic ("fetch failed") and is what reaches the user.
function reason(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  if (typeof code === "string") {
    if (code === "ECONNREFUSED") return "connection refused — is the server running?";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
    if (code === "ECONNRESET") return "connection reset";
    return code;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|aborted/i.test(msg) ? "timed out" : msg;
}

function record(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

// Ids in server order, blanks and duplicates dropped. Duplicates are real:
// Ollama lists `name` and `model` for the same entry, and a server may repeat
// an alias.
function ids(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const v of raw) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// null means "this isn't that API's answer" and falls through to the next
// shape. An empty list means the server answered with nothing pulled, and is
// reported as reachable-but-empty.
function ollamaShape(body: unknown): string[] | null {
  const list = record(body)?.models;
  if (!Array.isArray(list)) return null;
  return ids(list.map((m) => record(m)?.name ?? record(m)?.model));
}

function openaiShape(body: unknown): string[] | null {
  const list = record(body)?.data;
  if (!Array.isArray(list)) return null;
  return ids(list.map((m) => record(m)?.id));
}

const SHAPES = [
  { api: "ollama" as const, path: "/api/tags", pick: ollamaShape },
  { api: "openai" as const, path: "/v1/models", pick: openaiShape },
];

async function readJson(url: string, timeoutMs: number): Promise<unknown> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText || "error"}`);
  return r.json();
}

/**
 * Every model `baseUrl` reports, or why it couldn't be asked. Never throws:
 * an unreachable endpoint is an ordinary answer here, since both callers
 * (the picker, the Settings status line) exist to SHOW that state.
 */
export async function listEndpointModels(baseUrl: string | null | undefined, timeoutMs = MODEL_PROBE_MS): Promise<EndpointModels> {
  const base = normalizeBaseUrl(String(baseUrl ?? "").trim());
  if (!base) return unreachable("", "no base URL");
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return unreachable(base, "not an http(s) URL");
  } catch {
    return unreachable(base, "not a URL");
  }
  const errors: string[] = [];
  for (const { api, path, pick } of SHAPES) {
    try {
      const models = pick(await readJson(base + path, timeoutMs));
      if (models) return { base_url: base, reachable: true, api, models, error: null };
      errors.push(`${path} answered in a shape neither Ollama nor the OpenAI API uses`);
    } catch (e) {
      errors.push(reason(e));
    }
  }
  // A bare HTTP status is the LEAST informative of the two: LM Studio 404s
  // /api/tags on a perfectly healthy server, so if /v1/models also failed it is
  // that failure that says what's wrong.
  return unreachable(base, errors.find((m) => !/^\d{3} /.test(m)) ?? errors[0] ?? "unreachable");
}

// ---------- a short cache, because /api/agents probes on every page load ----------

/** How long a probe result is reused. Short enough that starting the server and
 *  reopening Settings shows it, long enough that four tabs loading /api/agents
 *  don't each open a socket. */
export const ENDPOINT_CACHE_MS = 10_000;

// On globalThis, like lib/events.ts and lib/abort.ts: HMR reloads this
// module, so state that must survive a reload has to live outside it.
const store = (globalThis as { __calandriaEndpointProbes?: Map<string, { at: number; value: EndpointModels }> });
const probes = (store.__calandriaEndpointProbes ??= new Map());

/** `listEndpointModels` behind that cache, keyed by the normalized URL. */
export async function endpointModels(baseUrl: string | null | undefined): Promise<EndpointModels> {
  const key = normalizeBaseUrl(String(baseUrl ?? "").trim());
  const hit = probes.get(key);
  if (hit && Date.now() - hit.at < ENDPOINT_CACHE_MS) return hit.value;
  const value = await listEndpointModels(key);
  probes.set(key, { at: Date.now(), value });
  return value;
}

/** Drop every cached probe. Used to reset state between tests. */
export function clearEndpointProbeCache(): void {
  probes.clear();
}
