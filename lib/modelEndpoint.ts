// Asking a local model server what it can actually run.
//
// A project pointed at Ollama or LM Studio (lib/agentEnv.ts, docs/AGENTS.md
// "Local models") has no catalog worth showing: the driver's model list is the
// vendor's cloud line-up, and the ids on THIS machine are whatever was pulled.
// So the picker asks the endpoint. Two response shapes cover both servers and
// everything that imitates one of them:
//
//   GET {base}/api/tags   -> { models: [{ name: "qwen3-coder:latest" }] }   (Ollama)
//   GET {base}/v1/models  -> { data:   [{ id:   "qwen/qwen3-coder" }] }     (OpenAI-compatible)
//
// Ollama serves BOTH, and the names its /api/tags returns are the ids its
// Anthropic endpoint wants (`qwen3-coder:latest`, tag included), so it is tried
// first and only a server that doesn't answer it falls through to /v1/models.
//
// Always server-side, never from the browser: the endpoint is loopback on the
// machine Calandria runs on (or the Docker host), which the browser generally
// cannot reach — on a hosted instance it is a different machine entirely, and
// on a local one a page served over a tunnel would be making a cross-origin
// request the model server doesn't allow.
//
// SDK-free and pinned (tests/importGraph.test.ts): GET /api/agents probes on
// every load and that route entry compiles sync.

import { normalizeBaseUrl } from "./agentEnv";
import { MODEL_PROBE_MS } from "./config";

/** Which API answered. Not "which product": LM Studio, llama.cpp, vLLM and
 *  Ollama's own /v1 all answer the OpenAI shape. "gateway" is never returned
 *  by this module — it's the LiteLLM gateway branch in
 *  app/api/projects/[id]/models/route.ts, which answers from
 *  lib/gatewayModels.ts instead of probing here — but lives on the shared
 *  type so the one response shape covers both branches. */
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

/** The same fact without the list — what GET /api/agents carries for the
 *  instance-wide default endpoint, where a count is the whole story. */
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

// A fetch failure from Node carries the useful part on `cause`, not the message
// ("fetch failed"), and the message is what ends up in front of a person.
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

// null = "this isn't that API's answer", which is different from an empty list
// (a running server with nothing pulled) and has to fall through to the next
// shape rather than being reported as a reachable-but-empty endpoint.
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

// On globalThis for the reason lib/events.ts and lib/abort.ts are: HMR reloads
// the module, and a probe cache that resets on every edit isn't one.
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

/** Drop every cached probe — the suite's between-tests reset. */
export function clearEndpointProbeCache(): void {
  probes.clear();
}
