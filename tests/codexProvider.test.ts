import { describe, it, expect } from "vitest";
import { codexProviderConfig, CODEX_LOCAL_PROVIDER_ID, CODEX_GATEWAY_PROVIDER_ID, CODEX_GATEWAY_KEY_VAR } from "@/lib/agents/codex/provider";
import { agentTurnEnv, gatewayPresetEnv, providerPresetEnv, serializeAgentEnv, cloudOverrideEnv } from "@/lib/agentEnv";
import type { Project, Task } from "@/lib/types";

// The Codex half of a provider override (lib/agents/codex/provider.ts): the
// codex CLI reads its provider from config.toml, not the environment, so the
// override becomes a `--config` provider entry the driver spreads into the
// SDK's `config`. Pure data, so this runs without the SDK or a codex binary.

const project = (agent_env: string) => ({ port: 0, agent_env }) as Pick<Project, "port" | "agent_env">;
const task = (agent_env: string) => ({ agent_env }) as Pick<Task, "agent_env">;

describe("codexProviderConfig", () => {
  it("emits nothing for the cloud", () => {
    expect(codexProviderConfig({})).toEqual({ config: {}, model: null });
    expect(codexProviderConfig({ ANTHROPIC_BASE_URL: "http://localhost:11434" })).toEqual({ config: {}, model: null });
  });

  it("maps OPENAI_BASE_URL onto a named provider entry on the Responses wire API, with the model beside it", () => {
    const out = codexProviderConfig({ OPENAI_BASE_URL: "http://localhost:11434/v1", CODEX_MODEL: "gpt-oss:20b" });
    expect(out.model).toBe("gpt-oss:20b");
    expect(out.config).toEqual({
      model_provider: CODEX_LOCAL_PROVIDER_ID,
      model_providers: {
        [CODEX_LOCAL_PROVIDER_ID]: { name: "Local model (Calandria)", base_url: "http://localhost:11434/v1", wire_api: "responses" },
      },
    });
  });

  it("adds /v1 to a bare host and tolerates a trailing slash", () => {
    const one = codexProviderConfig({ OPENAI_BASE_URL: "http://host.docker.internal:11434" });
    const two = codexProviderConfig({ OPENAI_BASE_URL: "http://host.docker.internal:11434/v1/" });
    const base = (c: typeof one) => (c.config.model_providers as Record<string, { base_url: string }>)[CODEX_LOCAL_PROVIDER_ID].base_url;
    expect(base(one)).toBe("http://host.docker.internal:11434/v1");
    expect(base(two)).toBe("http://host.docker.internal:11434/v1");
  });

  it("falls back to CODEX_OSS_BASE_URL for a hand-configured --oss user", () => {
    const out = codexProviderConfig({ CODEX_OSS_BASE_URL: "http://localhost:11434/v1" });
    expect(out.config.model_provider).toBe(CODEX_LOCAL_PROVIDER_ID);
  });

  it("reads the MERGED turn env, so a task-level cloud override wins over a local project", () => {
    const proj = project(serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" })));
    const local = codexProviderConfig(agentTurnEnv(proj, null, { PATH: "/usr/bin" }));
    expect(local.config.model_provider).toBe(CODEX_LOCAL_PROVIDER_ID);
    expect(local.model).toBe("qwen3-coder");
    const cloud = codexProviderConfig(agentTurnEnv(proj, task(serializeAgentEnv(cloudOverrideEnv())), { PATH: "/usr/bin" }));
    expect(cloud).toEqual({ config: {}, model: null });
  });
});

// The gateway half (docs/design/litellm.md, "Codex driver"). A LiteLLM proxy is
// the same Responses-wire mapping with three additions — a key the CLI reads
// from a named variable, the tag header LiteLLM attributes spend by, and an id
// of its own so a verdict earned against a local endpoint can't cover it.

const GATEWAY = "http://gw.example:4000";

describe("codexProviderConfig through the gateway", () => {
  const entryOf = (c: ReturnType<typeof codexProviderConfig>, id: string) =>
    (c.config.model_providers as Record<string, Record<string, unknown>>)[id];

  it("maps the gateway onto an entry of its own, keyed and tagged", () => {
    const out = codexProviderConfig(
      { OPENAI_BASE_URL: `${GATEWAY}/v1`, CALANDRIA_GATEWAY_TAGS: "calandria,project:p1,task:t1,agent:codex" },
      GATEWAY,
    );
    expect(out.config.model_provider).toBe(CODEX_GATEWAY_PROVIDER_ID);
    expect(entryOf(out, CODEX_GATEWAY_PROVIDER_ID)).toEqual({
      name: "Calandria gateway",
      base_url: `${GATEWAY}/v1`,
      env_key: CODEX_GATEWAY_KEY_VAR,
      wire_api: "responses",
      http_headers: { "x-litellm-tags": "calandria,project:p1,task:t1,agent:codex" },
    });
  });

  it("names the key VARIABLE rather than carrying its value — the documented Codex footgun", () => {
    const out = codexProviderConfig({ OPENAI_BASE_URL: `${GATEWAY}/v1`, CALANDRIA_GATEWAY_KEY: "sk-secret" }, GATEWAY);
    const entry = entryOf(out, CODEX_GATEWAY_PROVIDER_ID);
    expect(entry.env_key).toBe("CALANDRIA_GATEWAY_KEY");
    expect(JSON.stringify(out.config)).not.toContain("sk-secret");
  });

  it("falls back to the bare marker when no tags were composed", () => {
    const out = codexProviderConfig({ OPENAI_BASE_URL: `${GATEWAY}/v1` }, GATEWAY);
    expect(entryOf(out, CODEX_GATEWAY_PROVIDER_ID).http_headers).toEqual({ "x-litellm-tags": "calandria" });
  });

  it("stays the local entry for any other endpoint, and for no gateway at all", () => {
    const other = codexProviderConfig({ OPENAI_BASE_URL: "http://localhost:11434/v1" }, GATEWAY);
    expect(other.config.model_provider).toBe(CODEX_LOCAL_PROVIDER_ID);
    expect(entryOf(other, CODEX_LOCAL_PROVIDER_ID).env_key).toBeUndefined();
    const unconfigured = codexProviderConfig({ OPENAI_BASE_URL: `${GATEWAY}/v1` }, null);
    expect(unconfigured.config.model_provider).toBe(CODEX_LOCAL_PROVIDER_ID);
  });

  it("gives the two entries different base URLs, which is what keeps their cached verdicts apart", () => {
    const gw = codexProviderConfig({ OPENAI_BASE_URL: `${GATEWAY}/v1` }, GATEWAY);
    const local = codexProviderConfig({ OPENAI_BASE_URL: "http://localhost:11434/v1" }, GATEWAY);
    expect(entryOf(gw, CODEX_GATEWAY_PROVIDER_ID).base_url).not.toBe(entryOf(local, CODEX_LOCAL_PROVIDER_ID).base_url);
  });
});

describe("agentTurnEnv gateway key injection for Codex", () => {
  const gatewayProject = (billing: "key" | "subscription" = "key") =>
    project(serializeAgentEnv(gatewayPresetEnv({ baseUrl: GATEWAY, billing, model: "gpt-5-codex" })));

  it("sets CALANDRIA_GATEWAY_KEY and the tag list, and the entry picks both up", () => {
    const env = agentTurnEnv(
      { ...gatewayProject(), id: "p1" },
      { agent_env: "", id: "t1", agent: "codex" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-gw" },
      GATEWAY,
    );
    expect(env.CALANDRIA_GATEWAY_KEY).toBe("sk-gw");
    expect(env.CALANDRIA_GATEWAY_TAGS).toBe("calandria,project:p1,task:t1,agent:codex");
    // The instance key never travels under its own name, and never as one the
    // built-in `openai` provider would pick up.
    expect(env.CALANDRIA_LITELLM_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();

    const out = codexProviderConfig(env, GATEWAY);
    expect(out.config.model_provider).toBe(CODEX_GATEWAY_PROVIDER_ID);
    expect(out.model).toBe("gpt-5-codex");
    const entry = (out.config.model_providers as Record<string, Record<string, unknown>>)[CODEX_GATEWAY_PROVIDER_ID];
    expect(entry.http_headers).toEqual({ "x-litellm-tags": "calandria,project:p1,task:t1,agent:codex" });
  });

  it("keys Codex in both billing modes — `requires_openai_auth` is deliberately unimplemented", () => {
    const env = agentTurnEnv(
      { ...gatewayProject("subscription"), id: "p1" },
      { agent_env: "", id: "t1", agent: "codex" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-gw" },
      GATEWAY,
    );
    expect(env.CALANDRIA_GATEWAY_KEY).toBe("sk-gw");
    // Claude's half is unchanged: subscription billing sets no Anthropic credential.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("never leaves an inherited key or tag list on a non-gateway turn", () => {
    const env = agentTurnEnv(
      project(serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" }))),
      null,
      { PATH: "/usr/bin", CALANDRIA_GATEWAY_KEY: "stale", CALANDRIA_GATEWAY_TAGS: "stale" },
      GATEWAY,
    );
    expect(env.CALANDRIA_GATEWAY_KEY).toBeUndefined();
    expect(env.CALANDRIA_GATEWAY_TAGS).toBeUndefined();
  });
});
