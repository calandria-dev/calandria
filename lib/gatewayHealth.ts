import { MODEL_PROBE_MS } from "./config";
import { normalizeBaseUrl } from "./agentEnv";

/**
 * What Settings → Agents can say about the instance's LiteLLM gateway, and how
 * it finds out. Three calls, measured against LiteLLM 1.101.0
 * (docs/design/litellm.md, "LiteLLM surface"):
 *
 * - `GET /health/readiness` needs no key, so an instance with the address but
 *   no key still gets a reachability answer rather than a blank card.
 * - `x-litellm-version` comes back on ANY response, the readiness probe
 *   included, so the version is free and does not need a second call.
 * - `GET /model/info` is the catalog, filtered to the calling key's allowed
 *   models. Counting it is the honest form of "what can this instance run".
 * - `GET /key/info` answers 500 `Database not connected` on a proxy with no
 *   Postgres behind it. That is not a failure to report as one: it is the
 *   whole answer to "why are there no budgets here", and the card says so
 *   instead of showing blanks where spend would go. When it DOES answer, its
 *   body is the budget readout (docs/design/litellm.md, "Attribution, budgets
 *   and failures") — spend, max_budget and budget_reset_at for the instance
 *   key, read here rather than a second call.
 *
 * Never throws. Every caller exists to SHOW the unreachable state, the same
 * contract lib/modelEndpoint.ts keeps for a local model server, and the two are
 * separate cards for the same reason an agent's `connected` is separate from
 * either: a Claude login says nothing about whether the gateway is up.
 */
export interface GatewayHealth {
  base_url: string;
  /** Did /health/readiness answer. */
  reachable: boolean;
  /** `x-litellm-version` off whichever response carried one. */
  version: string | null;
  /** Entries in /model/info; null when it could not be read (no key, or the
   *  key may not see the catalog) — distinct from a gateway serving none. */
  model_count: number | null;
  /** False when /key/info reported the no-database 500. Null when nothing was
   *  learned either way, which is what no key looks like. */
  database: boolean | null;
  /** Whether this instance has a key to send at all. */
  has_key: boolean;
  error: string | null;
  /** The instance key's budget readout — all four null together whenever
   *  `database` isn't `true` (no Postgres, no key, or the read failed), never
   *  a mix, so the card can gate on one field. `max_budget` is null for a key
   *  with no budget set at all (unlimited), which is distinct from a spent
   *  one. `budget_reset_at` is LiteLLM's own ISO timestamp, unparsed. */
  spend: number | null;
  max_budget: number | null;
  budget_reset_at: string | null;
  /** The key's own model allowlist, for the same readout — null alongside the
   *  three above, `[]` for a key allowed every model LiteLLM knows about. */
  key_models: string[] | null;
  /** `agy models` diffed against this catalog (lib/agents/gemini/gatewayCheck.ts)
   *  — the models the CLI needs that this gateway doesn't serve. Null when
   *  nothing has been checked yet or agy isn't signed in; not set by
   *  probeGateway itself, since that stays agy-unaware, but filled in by
   *  GET /api/agents before this reaches the client. */
  gemini_missing_models?: string[] | null;
}

function unreachable(base: string, error: string): GatewayHealth {
  return {
    base_url: base, reachable: false, version: null, model_count: null, database: null, has_key: false, error,
    spend: null, max_budget: null, budget_reset_at: null, key_models: null,
  };
}

function reason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return /timed? ?out|abort/i.test(m) ? "timed out" : m.replace(/^TypeError: /, "");
}

async function call(url: string, key: string, timeoutMs: number): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    // LiteLLM accepts the virtual key either way; `x-litellm-api-key` is the
    // one the proxy layer reads without also being forwarded upstream.
    headers: { accept: "application/json", ...(key ? { "x-litellm-api-key": `Bearer ${key}` } : {}) },
    cache: "no-store",
  });
}

/** Probe the gateway once. `key` may be empty — readiness still answers. */
export async function probeGateway(
  baseUrl: string | null | undefined,
  key = "",
  timeoutMs = MODEL_PROBE_MS,
): Promise<GatewayHealth> {
  const base = normalizeBaseUrl(String(baseUrl ?? ""));
  if (!base) return unreachable("", "no base URL");
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return unreachable(base, "not an http(s) URL");
  } catch {
    return unreachable(base, "not a URL");
  }

  const out: GatewayHealth = {
    base_url: base, reachable: false, version: null, model_count: null, database: null, has_key: !!key, error: null,
    spend: null, max_budget: null, budget_reset_at: null, key_models: null,
  };
  // One round trip each, in parallel: three serial probes would multiply the
  // budget by three inside a route every tab loads.
  const [ready, models, keyInfo] = await Promise.allSettled([
    call(`${base}/health/readiness`, "", timeoutMs),
    call(`${base}/model/info`, key, timeoutMs),
    call(`${base}/key/info`, key, timeoutMs),
  ]);

  const version = (r: PromiseSettledResult<Response>) => (r.status === "fulfilled" ? r.value.headers.get("x-litellm-version") : null);
  out.version = version(ready) || version(models) || version(keyInfo);

  if (ready.status === "fulfilled") {
    out.reachable = ready.value.ok;
    if (!ready.value.ok) out.error = `${ready.value.status} ${ready.value.statusText || "error"} from /health/readiness`;
  } else {
    out.error = reason(ready.reason);
  }

  if (models.status === "fulfilled" && models.value.ok) {
    try {
      const body = (await models.value.json()) as { data?: unknown };
      if (Array.isArray(body?.data)) out.model_count = body.data.length;
    } catch {
      /* a shape we don't recognise is not a count */
    }
  }

  // A 500 here is the documented no-database answer, not an outage; anything
  // else (401, 400) means the key is wrong or absent and says nothing about
  // the database, so it stays null rather than claiming one way or the other.
  if (keyInfo.status === "fulfilled") {
    if (keyInfo.value.ok) {
      out.database = true;
      // The budget readout rides the same call: {key, info: {spend, max_budget,
      // budget_reset_at, models}} (docs/design/litellm.md's appendix). An
      // unrecognised shape leaves the four fields null rather than throwing —
      // this is still a reachable, database-backed gateway either way.
      try {
        const body = (await keyInfo.value.json()) as {
          info?: { spend?: unknown; max_budget?: unknown; budget_reset_at?: unknown; models?: unknown };
        };
        const info = body?.info;
        if (info) {
          out.spend = typeof info.spend === "number" ? info.spend : null;
          out.max_budget = typeof info.max_budget === "number" ? info.max_budget : null;
          out.budget_reset_at = typeof info.budget_reset_at === "string" ? info.budget_reset_at : null;
          out.key_models = Array.isArray(info.models) ? info.models.filter((m): m is string => typeof m === "string") : null;
        }
      } catch {
        /* a shape we don't recognise leaves the budget fields null */
      }
    } else if (keyInfo.value.status >= 500) {
      const text = await keyInfo.value.text().catch(() => "");
      if (/database not connected|db not connected/i.test(text)) out.database = false;
    }
  }
  return out;
}

// ---------- a short cache, because /api/agents probes on every page load ----------

/** Same window and the same reason as ENDPOINT_CACHE_MS in lib/modelEndpoint.ts. */
export const GATEWAY_CACHE_MS = 10_000;

// On globalThis so an HMR reload doesn't reset it — see lib/modelEndpoint.ts.
const store = globalThis as { __calandriaGatewayProbes?: Map<string, { at: number; value: GatewayHealth }> };
const probes = (store.__calandriaGatewayProbes ??= new Map());

/** `probeGateway` behind that cache, keyed by the normalized URL. */
export async function gatewayHealth(baseUrl: string | null | undefined, key = ""): Promise<GatewayHealth> {
  const url = normalizeBaseUrl(String(baseUrl ?? ""));
  const hit = probes.get(url);
  if (hit && Date.now() - hit.at < GATEWAY_CACHE_MS) return hit.value;
  const value = await probeGateway(url, key);
  probes.set(url, { at: Date.now(), value });
  return value;
}

/** Drop every cached probe — the suite's between-tests reset, and what Settings
 *  needs after saving a key so the card re-reads with it. */
export function clearGatewayProbeCache(): void {
  probes.clear();
}
