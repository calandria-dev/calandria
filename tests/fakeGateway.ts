import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in LiteLLM proxy for the suite, answering the three routes the
 * gateway health card reads. The bodies and status codes are the ones recorded
 * against `ghcr.io/berriai/litellm:main-latest` reporting
 * `x-litellm-version: 1.101.0` — see the appendix of docs/design/litellm.md.
 * Two of them are load-bearing and easy to get wrong from memory:
 *
 * - `/health/readiness` takes NO key. An instance with an address but no key
 *   still gets a reachability answer, and the tests have to be able to prove it.
 * - `/key/info` answers **500** `Database not connected` on a proxy with no
 *   Postgres, not 404 and not an empty 200. That is the sentence the card turns
 *   into "keys, budgets and spend need LiteLLM's database", so a helper that
 *   returned a tidy error would test nothing.
 *
 * `x-litellm-version` rides on every response, including the keyless one, which
 * is why the card can show a version without a second call.
 */

export interface FakeGatewayOptions {
  /** Model names in `/model/info`. */
  models?: string[];
  /** With no LiteLLM database, `/key/info` 500s and there are no budgets. */
  database?: boolean;
  version?: string;
  /** When set, `/model/info` and `/key/info` 401 unless this key is presented. */
  requireKey?: string;
}

export interface FakeGateway {
  url: string;
  /** Every request seen, in order: path plus the key header it carried. */
  calls: { path: string; key: string | null }[];
  close(): Promise<void>;
}

function modelEntry(name: string) {
  return {
    model_name: name,
    litellm_params: { model: `anthropic/${name}` },
    model_info: {
      max_input_tokens: 200000,
      max_output_tokens: 64000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
      cache_creation_input_token_cost: 0.00000375,
      mode: "chat",
      litellm_provider: "anthropic",
      supports_function_calling: true,
      supports_prompt_caching: true,
      supports_vision: true,
    },
  };
}

export async function startFakeGateway(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const models = opts.models ?? ["claude-sonnet-4-5", "gpt-5-codex"];
  const version = opts.version ?? "1.101.0";
  const calls: { path: string; key: string | null }[] = [];

  const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    const key = (req.headers["x-litellm-api-key"] as string | undefined) ?? null;
    calls.push({ path, key });
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
    const authorized = !opts.requireKey || key === `Bearer ${opts.requireKey}`;
    if (!authorized) return send(401, { error: { message: "Invalid proxy server token passed", type: "auth_error" } });
    if (path === "/model/info") return send(200, { data: models.map(modelEntry) });
    if (path === "/key/info") {
      if (!opts.database) {
        return send(500, { error: { message: "Database not connected. Check your database URL.", type: "internal_server_error" } });
      }
      return send(200, { key: "sk-test", info: { spend: 1.25, max_budget: 10, budget_reset_at: "2026-10-01T00:00:00Z", models } });
    }
    return send(404, { error: { message: `no route ${path}` } });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
