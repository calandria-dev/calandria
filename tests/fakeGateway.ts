import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in LiteLLM proxy for the suite, answering the routes the gateway
 * health card, the model picker, and lib/gatewayKeys.ts's per-task virtual
 * keys read. The bodies and status codes are the ones recorded against
 * `ghcr.io/berriai/litellm:main-latest` reporting `x-litellm-version:
 * 1.101.0` — see the appendix of docs/design/litellm.md. A few are
 * load-bearing and easy to get wrong from memory:
 *
 * - `/health/readiness` takes NO key. An instance with an address but no key
 *   still gets a reachability answer, and the tests have to be able to prove it.
 * - `/key/info` answers **500** `Database not connected` on a proxy with no
 *   Postgres, not 404 and not an empty 200. That is the sentence the card turns
 *   into "keys, budgets and spend need LiteLLM's database", so a helper that
 *   returned a tidy error would test nothing. `/key/generate` and `/key/delete`
 *   share that: key management needs the same database.
 * - `/key/generate` and `/key/delete` take the ADMIN/master key as
 *   `Authorization: Bearer …`, a different header and a different credential
 *   from the `x-litellm-api-key` a virtual key presents on every other route.
 *
 * `x-litellm-version` rides on every response, including the keyless one, which
 * is why the card can show a version without a second call.
 */

/** A model spec richer than a bare name — provider, window and mode, for
 *  testing the picker's per-driver fit filter (lib/gatewayModels.ts). A plain
 *  string is shorthand for `{ name }` (anthropic, 200k, chat). */
export interface FakeGatewayModelSpec {
  name: string;
  provider?: string;
  max_input_tokens?: number;
  mode?: string;
}

/** A key minted via `/key/generate`, tracked server-side so `/key/info` and
 *  `/key/delete` can answer per-key rather than with one fixed readout. */
export interface FakeGatewayKey {
  spend: number;
  max_budget: number | null;
  models: string[];
  key_alias: string;
  metadata: unknown;
  tags: string[];
  budget_reset_at: string;
}

export interface FakeGatewayOptions {
  /** Model entries in `/model/info`. */
  models?: (string | FakeGatewayModelSpec)[];
  /** With no LiteLLM database, `/key/info`, `/key/generate` and `/key/delete`
   *  all 500 and there are no budgets. */
  database?: boolean;
  version?: string;
  /** When set, `/model/info` and `/key/info` 401 unless this key is presented
   *  as `x-litellm-api-key`. */
  requireKey?: string;
  /** When set, `/key/generate` and `/key/delete` 401 unless this key is
   *  presented as `Authorization: Bearer <adminKey>` — LiteLLM's key-management
   *  surface takes the master/admin key, never a virtual key. */
  adminKey?: string;
}

export interface FakeGateway {
  url: string;
  /** Every request seen, in order: path, the x-litellm-api-key it carried (not
   *  the admin Authorization header), and its HTTP method. */
  calls: { path: string; key: string | null; method: string }[];
  /** Every key minted so far via `/key/generate`, keyed by the key string —
   *  live server-side state, not a snapshot, so a test can assert counts and
   *  contents after acting. */
  mintedKeys: Map<string, FakeGatewayKey>;
  /** Advance a minted key's spend between two reads, simulating LiteLLM's own
   *  ledger moving between two `reconcileTaskGatewaySpend` calls. No-op (but
   *  harmless) for a key that was never minted or has since been deleted. */
  setKeySpend(key: string, spend: number): void;
  close(): Promise<void>;
}

function modelEntry(spec: FakeGatewayModelSpec) {
  const provider = spec.provider ?? "anthropic";
  return {
    model_name: spec.name,
    litellm_params: { model: `${provider}/${spec.name}` },
    model_info: {
      max_input_tokens: spec.max_input_tokens ?? 200000,
      max_output_tokens: 64000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
      cache_creation_input_token_cost: 0.00000375,
      mode: spec.mode ?? "chat",
      litellm_provider: provider,
      supports_function_calling: true,
      supports_prompt_caching: true,
      supports_vision: true,
    },
  };
}

/** Drain a request body and parse it as JSON, tolerating an empty or
 *  unparseable one (an empty object) rather than throwing — a malformed call
 *  is a 4xx from the route logic, not a crashed test server. */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export async function startFakeGateway(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const models = (opts.models ?? ["claude-sonnet-4-5", "gpt-5-codex"]).map((m): FakeGatewayModelSpec => (typeof m === "string" ? { name: m } : m));
  const version = opts.version ?? "1.101.0";
  const calls: { path: string; key: string | null; method: string }[] = [];
  const mintedKeys = new Map<string, FakeGatewayKey>();
  let keyCounter = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const path = (req.url || "").split("?")[0];
      const key = (req.headers["x-litellm-api-key"] as string | undefined) ?? null;
      calls.push({ path, key, method: req.method || "GET" });
      res.setHeader("content-type", "application/json");
      res.setHeader("x-litellm-version", version);

      const send = (status: number, body: unknown) => {
        res.writeHead(status);
        res.end(JSON.stringify(body));
      };
      // Keyless on purpose — see the note above.
      if (path === "/health/readiness" || path === "/health/liveliness") {
        return send(200, { status: "connected", db: opts.database ? "connected" : "Not connected", litellm_version: version });
      }

      // Key management: the admin/master key as a bearer token, never the
      // x-litellm-api-key a virtual key presents elsewhere.
      if (path === "/key/generate" || path === "/key/delete") {
        const authHeader = (req.headers["authorization"] as string | undefined) ?? null;
        const adminAuthorized = !!opts.adminKey && authHeader === `Bearer ${opts.adminKey}`;
        if (!adminAuthorized) return send(401, { error: { message: "Invalid proxy server token passed", type: "auth_error" } });
        if (!opts.database) {
          return send(500, { error: { message: "Database not connected. Check your database URL.", type: "internal_server_error" } });
        }
        const body = await readJsonBody(req);
        if (path === "/key/generate") {
          const mintedKey = `sk-fake-${++keyCounter}`;
          const entry: FakeGatewayKey = {
            spend: 0,
            max_budget: typeof body.max_budget === "number" ? body.max_budget : null,
            models: Array.isArray(body.models) ? (body.models as string[]) : [],
            key_alias: typeof body.key_alias === "string" ? body.key_alias : "",
            metadata: body.metadata ?? {},
            tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
            budget_reset_at: "2026-10-01T00:00:00Z",
          };
          mintedKeys.set(mintedKey, entry);
          return send(200, {
            key: mintedKey,
            key_alias: entry.key_alias,
            max_budget: entry.max_budget,
            models: entry.models,
            metadata: entry.metadata,
            tags: entry.tags,
          });
        }
        // /key/delete — idempotent, like LiteLLM's own: a key never minted (or
        // already deleted) is not an error.
        const toDelete = Array.isArray(body.keys) ? (body.keys as string[]) : [];
        for (const k of toDelete) mintedKeys.delete(k);
        return send(200, { deleted_keys: toDelete });
      }

      const authorized = !opts.requireKey || key === `Bearer ${opts.requireKey}`;
      if (!authorized) return send(401, { error: { message: "Invalid proxy server token passed", type: "auth_error" } });
      if (path === "/model/info") return send(200, { data: models.map(modelEntry) });
      if (path === "/key/info") {
        if (!opts.database) {
          return send(500, { error: { message: "Database not connected. Check your database URL.", type: "internal_server_error" } });
        }
        const presented = key?.replace(/^Bearer\s+/i, "") ?? "";
        const minted = presented ? mintedKeys.get(presented) : undefined;
        if (minted) {
          return send(200, {
            key: presented,
            info: {
              spend: minted.spend,
              max_budget: minted.max_budget,
              budget_reset_at: minted.budget_reset_at,
              models: minted.models,
            },
          });
        }
        // Fallback: the fixed instance-key readout every pre-existing test
        // asserts on — reached whenever the presented key (any key, including
        // none, when requireKey is unset) isn't one this server minted.
        return send(200, {
          key: "sk-test",
          info: { spend: 1.25, max_budget: 10, budget_reset_at: "2026-10-01T00:00:00Z", models: models.map((m) => m.name) },
        });
      }
      return send(404, { error: { message: `no route ${path}` } });
    })();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    mintedKeys,
    setKeySpend(key: string, spend: number) {
      const entry = mintedKeys.get(key);
      if (entry) entry.spend = spend;
      else mintedKeys.set(key, { spend, max_budget: null, models: [], key_alias: "", metadata: {}, tags: [], budget_reset_at: "2026-10-01T00:00:00Z" });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
