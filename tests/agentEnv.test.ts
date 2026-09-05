import { describe, it, expect } from "vitest";
import {
  AGENT_ENV_KEYS,
  agentTurnEnv,
  applyProviderEnv,
  cloudOverrideEnv,
  describeProvider,
  gatewayInsecureForGemini,
  gatewayPresetEnv,
  isGatewayEndpoint,
  isLoopbackHost,
  providerPricing,
  parseAgentEnv,
  planWindowApplies,
  providerEnvFor,
  providerPresetEnv,
  recordedCostUsd,
  serializeAgentEnv,
  taskProvider,
} from "@/lib/agentEnv";
import type { ProviderKind } from "@/lib/agentEnv";
import type { Project, Task } from "@/lib/types";

// Pins that a main-turn agent process does not inherit the server's own
// NODE_ENV=production (it makes `npm install` in the user's project skip
// devDependencies and still exit 0) or its PORT (buildProjectContext tells
// every agent to bind its dev server to $PORT, so an unedited PORT would
// point a task's server at Calandria itself). Issue #102.
//
// Also pins the provider override: projects.agent_env and tasks.agent_env
// are layered over the copied env through an allowlist, after the copy and
// before the PORT edit, per the credential rules applyProviderEnv documents.

const project = (port: number, agent_env = "") => ({ port, agent_env }) as Pick<Project, "port" | "agent_env">;
const task = (agent_env: string) => ({ agent_env }) as Pick<Task, "agent_env">;

// Gateway address every case below describes an override against. Passed
// explicitly instead of set in the environment, keeping these tests pure:
// the default is the instance's own CALANDRIA_LITELLM_BASE_URL, which a
// hermetic run does not have.
const GW = "http://gw.example.com:4000";

describe("agentTurnEnv", () => {
  it("drops NODE_ENV even when the base env carries it", () => {
    const out = agentTurnEnv(project(4301), null, { NODE_ENV: "production", PATH: "/usr/bin" });
    expect("NODE_ENV" in out).toBe(false);
    expect(out.PATH).toBe("/usr/bin");
  });

  it("sets PORT from the project's own port", () => {
    const out = agentTurnEnv(project(4301), null, { PATH: "/usr/bin" });
    expect(out.PORT).toBe("4301");
  });

  it("deletes PORT when the project's port is 0", () => {
    const out = agentTurnEnv(project(0), null, { PORT: "3000", PATH: "/usr/bin" });
    expect("PORT" in out).toBe(false);
  });

  it("deletes PORT when there is no project at all", () => {
    const out = agentTurnEnv(null, null, { PORT: "3000", PATH: "/usr/bin" });
    expect("PORT" in out).toBe(false);
  });

  it("drops entries whose value is undefined", () => {
    const out = agentTurnEnv(project(4301), null, { PATH: "/usr/bin", GHOST: undefined });
    expect("GHOST" in out).toBe(false);
  });

  it("preserves PATH and other ordinary vars untouched", () => {
    const out = agentTurnEnv(project(4301), null, { PATH: "/usr/bin:/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-x" });
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.HOME).toBe("/home/x");
    expect(out.ANTHROPIC_API_KEY).toBe("sk-x");
  });

  it("never mutates the base object", () => {
    const base = { NODE_ENV: "production", PORT: "3000", PATH: "/usr/bin" };
    const snapshot = { ...base };
    agentTurnEnv(project(4301), null, base);
    expect(base).toEqual(snapshot);
  });

  // ---- the provider override ----

  it("lays the project's override over the copied env, after the copy and before PORT", () => {
    const env = JSON.stringify({ ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_MODEL: "qwen3-coder" });
    const out = agentTurnEnv(project(4301, env), null, {
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "https://proxy.example.com", // instance-wide value loses to the project's
      PORT: "3000",
    });
    expect(out.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(out.ANTHROPIC_MODEL).toBe("qwen3-coder");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.PORT).toBe("4301");
  });

  it("cannot smuggle PATH, NODE_OPTIONS, PORT or NODE_ENV through the override", () => {
    const env = JSON.stringify({
      PATH: "/evil",
      NODE_OPTIONS: "--require /evil.js",
      LD_PRELOAD: "/evil.so",
      PORT: "1",
      NODE_ENV: "production",
      ANTHROPIC_BASE_URL: "http://localhost:11434",
    });
    const out = agentTurnEnv(project(4301, env), null, { PATH: "/usr/bin" });
    expect(out.PATH).toBe("/usr/bin");
    expect("NODE_OPTIONS" in out).toBe(false);
    expect("LD_PRELOAD" in out).toBe(false);
    expect("NODE_ENV" in out).toBe(false);
    expect(out.PORT).toBe("4301");
    expect(out.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
  });

  it("lays the task's override over the project's, key by key", () => {
    const proj = JSON.stringify({ ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_MODEL: "qwen3-coder" });
    const out = agentTurnEnv(project(0, proj), task(JSON.stringify({ ANTHROPIC_MODEL: "gemma3" })), { PATH: "/usr/bin" });
    expect(out.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(out.ANTHROPIC_MODEL).toBe("gemma3");
  });

  it("reads an empty-string value as 'unset', which is how a task goes back to the cloud", () => {
    const proj = serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" }));
    const out = agentTurnEnv(project(0, proj), task(serializeAgentEnv(cloudOverrideEnv())), { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-real" });
    for (const k of AGENT_ENV_KEYS) expect(k in out, k).toBe(false);
    // Nothing redirected in the end, so the inherited credential survives.
    expect(out.ANTHROPIC_API_KEY).toBe("sk-real");
  });
});

describe("applyProviderEnv credential rules", () => {
  it("keeps an override's ANTHROPIC_AUTH_TOKEN only when the same override redirects the base URL", () => {
    const redirected: Record<string, string> = {};
    applyProviderEnv(redirected, { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama" });
    expect(redirected.ANTHROPIC_AUTH_TOKEN).toBe("ollama");

    const bare: Record<string, string> = {};
    applyProviderEnv(bare, { ANTHROPIC_AUTH_TOKEN: "sk-ant-real" });
    expect("ANTHROPIC_AUTH_TOKEN" in bare).toBe(false);

    // A base URL that still points at Anthropic is not a redirect.
    const anthropic: Record<string, string> = {};
    applyProviderEnv(anthropic, { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_AUTH_TOKEN: "sk-ant-real" });
    expect("ANTHROPIC_AUTH_TOKEN" in anthropic).toBe(false);
    expect(anthropic.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("drops the inherited Anthropic credentials when the base URL is redirected", () => {
    const out: Record<string, string> = { ANTHROPIC_API_KEY: "sk-real", ANTHROPIC_AUTH_TOKEN: "kept-by-opt-in" };
    applyProviderEnv(out, { ANTHROPIC_BASE_URL: "https://gateway.example.com" });
    expect("ANTHROPIC_API_KEY" in out).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in out).toBe(false);
  });

  it("drops the inherited OPENAI_API_KEY when OPENAI_BASE_URL is redirected", () => {
    const out: Record<string, string> = { OPENAI_API_KEY: "sk-real" };
    applyProviderEnv(out, { OPENAI_BASE_URL: "http://localhost:11434/v1" });
    expect("OPENAI_API_KEY" in out).toBe(false);
    expect(out.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
  });

  it("leaves inherited credentials alone when nothing is redirected", () => {
    const out: Record<string, string> = { ANTHROPIC_API_KEY: "sk-real", OPENAI_API_KEY: "sk-o" };
    applyProviderEnv(out, { ANTHROPIC_MODEL: "claude-opus-5" });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-real");
    expect(out.OPENAI_API_KEY).toBe("sk-o");
  });
});

describe("parseAgentEnv / serializeAgentEnv", () => {
  it("accepts JSON text or an object, keeps only allowlisted string values", () => {
    const obj = { ANTHROPIC_BASE_URL: " http://localhost:11434 ", PATH: "/x", CODEX_MODEL: 7, OPENAI_BASE_URL: null };
    expect(parseAgentEnv(obj)).toEqual({ ANTHROPIC_BASE_URL: "http://localhost:11434" });
    expect(parseAgentEnv(JSON.stringify(obj))).toEqual({ ANTHROPIC_BASE_URL: "http://localhost:11434" });
  });

  it("returns {} for null, blank, garbage and non-object JSON", () => {
    expect(parseAgentEnv(null)).toEqual({});
    expect(parseAgentEnv("")).toEqual({});
    expect(parseAgentEnv("   ")).toEqual({});
    expect(parseAgentEnv("{not json")).toEqual({});
    expect(parseAgentEnv("[1,2]")).toEqual({});
    expect(parseAgentEnv(42)).toEqual({});
  });

  it("refuses control characters and oversized values", () => {
    expect(parseAgentEnv({ ANTHROPIC_MODEL: "a\nb" })).toEqual({});
    expect(parseAgentEnv({ ANTHROPIC_MODEL: "x".repeat(3000) })).toEqual({});
  });

  it("serializes to '' when empty and to key-ordered compact JSON otherwise", () => {
    expect(serializeAgentEnv(null)).toBe("");
    expect(serializeAgentEnv({ PATH: "/x" })).toBe("");
    const a = serializeAgentEnv({ OPENAI_BASE_URL: "http://h/v1", ANTHROPIC_BASE_URL: "http://h" });
    const b = serializeAgentEnv({ ANTHROPIC_BASE_URL: "http://h", OPENAI_BASE_URL: "http://h/v1" });
    expect(a).toBe(b);
    expect(a).toBe('{"ANTHROPIC_BASE_URL":"http://h","OPENAI_BASE_URL":"http://h/v1"}');
  });

  it("round-trips an empty-string 'unset' value", () => {
    expect(parseAgentEnv(serializeAgentEnv({ ANTHROPIC_BASE_URL: "" }))).toEqual({ ANTHROPIC_BASE_URL: "" });
  });
});

describe("presets", () => {
  it("writes both CLIs' endpoints, the token, the model aliases and the quiet flag from one base URL", () => {
    const env = providerPresetEnv({ baseUrl: "http://host.docker.internal:11434/v1/", model: "qwen3-coder" });
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "http://host.docker.internal:11434",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      OPENAI_BASE_URL: "http://host.docker.internal:11434/v1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "qwen3-coder",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3-coder",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-coder",
      ANTHROPIC_SMALL_FAST_MODEL: "qwen3-coder",
      CODEX_MODEL: "qwen3-coder",
    });
  });

  it("omits the model keys when no model is given and takes a custom token", () => {
    const env = providerPresetEnv({ baseUrl: "https://gw.example.com", token: "secret" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
    expect("ANTHROPIC_MODEL" in env).toBe(false);
    expect("CODEX_MODEL" in env).toBe(false);
  });

  it("is empty for a blank base URL", () => {
    expect(providerPresetEnv({ baseUrl: "  " })).toEqual({});
  });

  it("cloudOverrideEnv unsets every allowlisted key", () => {
    const env = cloudOverrideEnv();
    expect(Object.keys(env).sort()).toEqual([...AGENT_ENV_KEYS].sort());
    expect(Object.values(env).every((v) => v === "")).toBe(true);
  });
});

describe("describeProvider / taskProvider", () => {
  it("is cloud with nothing set, with the model still reported", () => {
    expect(describeProvider({})).toMatchObject({ kind: "cloud", host: "", model: null });
    expect(describeProvider({ ANTHROPIC_MODEL: "claude-opus-5" })).toMatchObject({ kind: "cloud", model: "claude-opus-5" });
  });

  it("is local for loopback, docker-host and private-network endpoints", () => {
    for (const url of ["http://localhost:11434", "http://127.0.0.1:11434", "http://host.docker.internal:11434", "http://192.168.1.50:1234", "http://10.0.0.7:11434", "http://mac-studio.local:11434"]) {
      expect(describeProvider({ ANTHROPIC_BASE_URL: url }).kind, url).toBe("local");
    }
    expect(describeProvider({ ANTHROPIC_BASE_URL: "http://localhost:11434" }).host).toBe("localhost:11434");
  });

  it("is custom for any other host, and reads the OpenAI URL when only that is set", () => {
    expect(describeProvider({ ANTHROPIC_BASE_URL: "https://gw.example.com" })).toMatchObject({ kind: "custom", host: "gw.example.com" });
    expect(describeProvider({ OPENAI_BASE_URL: "http://localhost:1234/v1" })).toMatchObject({ kind: "local", host: "localhost:1234", anthropic_base_url: null });
  });

  // `pricing` is what the usage ledger keys off (lib/runner.ts) and must
  // never be derived a second time elsewhere: cloud is the driver's own
  // figure, a local server is free, and a custom base URL is a price nobody
  // has stated, which is not the same as free. This field exists so the call
  // site never needs its own `kind !== "cloud"` test.
  it("prices cloud by the vendor, local as free and custom as unknown", () => {
    expect(describeProvider({}).pricing).toBe("vendor");
    expect(describeProvider({ ANTHROPIC_BASE_URL: "http://localhost:11434" }).pricing).toBe("free");
    expect(describeProvider({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }).pricing).toBe("unknown");
    // Every kind maps, so a fifth one added later cannot fall through to
    // being billed as the vendor's spend.
    const expected: Record<ProviderKind, string> = { cloud: "vendor", local: "free", custom: "unknown", gateway: "gateway" };
    for (const kind of Object.keys(expected) as ProviderKind[]) {
      expect(providerPricing(kind), kind).toBe(expected[kind]);
    }
  });

  // The ledger's cost decision, kept in one place because the runner writes
  // it from two paths (the live usage event and the finally-flush) that must
  // not drift. A gateway prices its own turns but hands no CLI the figure, so
  // it records NULL and counts as unpriced, the same row a custom endpoint
  // gets for a different reason.
  it("records the vendor's figure, a measured zero, or NULL", () => {
    expect(recordedCostUsd("vendor", 0.42)).toBe(0.42);
    expect(recordedCostUsd("vendor", null)).toBe(null);
    expect(recordedCostUsd("free", 0.42)).toBe(0);
    expect(recordedCostUsd("unknown", 0.42)).toBe(null);
    expect(recordedCostUsd("gateway", 0.42)).toBe(null);
  });

  it("taskProvider merges project and task the way the turn env does", () => {
    const proj = project(0, serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" })));
    expect(taskProvider(proj, null)).toMatchObject({ kind: "local", model: "qwen3-coder" });
    expect(taskProvider(proj, task(serializeAgentEnv(cloudOverrideEnv()))).kind).toBe("cloud");
    expect(providerEnvFor(proj, task(JSON.stringify({ CODEX_MODEL: "gpt-oss:20b" }))).CODEX_MODEL).toBe("gpt-oss:20b");
  });
});

// ---- the LiteLLM gateway preset (docs/AGENTS.md) ----
//
// The gateway is the fourth provider kind, and the first whose credential and
// headers are composed per turn instead of stored. Two facts matter here: a
// project row must never be able to name a request header, and the key must
// never be reachable through a project row at all.

describe("the gateway preset", () => {
  const gwEnv = (billing: "key" | "subscription" = "key", model?: string) =>
    serializeAgentEnv(gatewayPresetEnv({ baseUrl: GW, billing, model }));

  it("writes the three base URLs and the billing marker, and never a credential", () => {
    expect(gatewayPresetEnv({ baseUrl: `${GW}/v1/`, billing: "key" })).toEqual({
      ANTHROPIC_BASE_URL: GW,
      OPENAI_BASE_URL: `${GW}/v1`,
      GOOGLE_GEMINI_BASE_URL: GW,
      CALANDRIA_GATEWAY_BILLING: "key",
    });
    const withModel = gatewayPresetEnv({ baseUrl: GW, billing: "subscription", model: "claude-sonnet-4-5" });
    expect(withModel.CALANDRIA_GATEWAY_BILLING).toBe("subscription");
    // Claude Code's own /model list cannot see a LiteLLM catalog, so the bare
    // aliases are pinned too, following the same rule as the local preset.
    expect(withModel.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-sonnet-4-5");
    expect(withModel.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4-5");
    expect(withModel.GEMINI_MODEL).toBe("claude-sonnet-4-5");
    // The key lives in lib/litellm-key.ts. agent_env is served to the browser
    // by GET /api/projects, so a token here would be a token anyone with the
    // app open could read.
    expect("ANTHROPIC_AUTH_TOKEN" in withModel).toBe(false);
    expect(gatewayPresetEnv({ baseUrl: "  ", billing: "key" })).toEqual({});
  });

  it("is the gateway kind by ORIGIN, whatever path or port form the URL takes", () => {
    for (const url of [GW, `${GW}/`, `${GW}/v1`]) {
      expect(describeProvider({ ANTHROPIC_BASE_URL: url }, GW).kind, url).toBe("gateway");
    }
    expect(isGatewayEndpoint(`${GW}/v1`, GW)).toBe(true);
    // A different port or host is a different endpoint, not this gateway.
    expect(describeProvider({ ANTHROPIC_BASE_URL: "http://gw.example.com:4001" }, GW).kind).toBe("custom");
    // With no gateway configured, the preset does not exist and nothing is one.
    expect(describeProvider({ ANTHROPIC_BASE_URL: GW }, null).kind).toBe("custom");
    expect(isGatewayEndpoint(GW, null)).toBe(false);
  });

  it("outranks local: a LiteLLM proxy on loopback is still a gateway", () => {
    const local = "http://127.0.0.1:4000";
    expect(describeProvider({ ANTHROPIC_BASE_URL: local }, local)).toMatchObject({ kind: "gateway", pricing: "gateway" });
    // Without the gateway configured, the same address is an ordinary local one.
    expect(describeProvider({ ANTHROPIC_BASE_URL: local }, null).kind).toBe("local");
  });

  it("reads the billing marker, defaulting an unmarked override to the key", () => {
    expect(describeProvider(parseAgentEnv(gwEnv("subscription")), GW).gateway_billing).toBe("subscription");
    expect(describeProvider(parseAgentEnv(gwEnv("key")), GW).gateway_billing).toBe("key");
    // An unmarked gateway base URL defaults to billing "key", the token it carries.
    expect(describeProvider({ ANTHROPIC_BASE_URL: GW }, GW).gateway_billing).toBe("key");
    // Not a gateway, so there is nothing to say.
    expect(describeProvider({ ANTHROPIC_BASE_URL: "http://localhost:11434" }, GW).gateway_billing).toBe(null);
  });

  it("composes ANTHROPIC_CUSTOM_HEADERS per turn from the key and the live ids", () => {
    const out = agentTurnEnv(
      { id: "p1", port: 0, agent_env: gwEnv("key") },
      { id: "t1", agent: "claude", agent_env: "" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-litellm" },
      GW,
    );
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe("x-litellm-api-key: Bearer sk-litellm\nx-litellm-tags: calandria,project:p1,task:t1,agent:claude");
    // Billing "key": the gateway key is the credential, so the turn bills it.
    expect(out.ANTHROPIC_AUTH_TOKEN).toBe("sk-litellm");
    // The key itself never reaches the spawned CLI under its own name.
    expect("CALANDRIA_LITELLM_KEY" in out).toBe(false);
  });

  it("sets no credential variable under subscription billing", () => {
    const out = agentTurnEnv(
      { id: "p1", port: 0, agent_env: gwEnv("subscription") },
      { id: "t1", agent: "claude", agent_env: "" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-litellm", ANTHROPIC_API_KEY: "sk-ant-real" },
      GW,
    );
    // The CLI keeps its own /login and the gateway forwards it.
    expect("ANTHROPIC_AUTH_TOKEN" in out).toBe(false);
    expect("ANTHROPIC_API_KEY" in out).toBe(false);
    // The proxy-layer key still authenticates to LiteLLM itself.
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toContain("x-litellm-api-key: Bearer sk-litellm");
  });

  it("still tags the turn when the instance has no key", () => {
    const out = agentTurnEnv({ id: "p1", port: 0, agent_env: gwEnv("key") }, { id: "t1", agent: "claude", agent_env: "" }, { PATH: "/usr/bin" }, GW);
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe("x-litellm-tags: calandria,project:p1,task:t1,agent:claude");
    expect("ANTHROPIC_AUTH_TOKEN" in out).toBe(false);
  });

  // Antigravity carries the credential under its own name instead of a
  // header: the Go GenAI SDK inside `agy` reads GEMINI_API_KEY directly, and
  // there is no ANTHROPIC_CUSTOM_HEADERS equivalent for it.
  it("sets GEMINI_API_KEY for a gateway turn on the gemini agent, and no attribution header", () => {
    const out = agentTurnEnv(
      { id: "p1", port: 0, agent_env: gwEnv("key") },
      { id: "t1", agent: "gemini", agent_env: "" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-litellm" },
      GW,
    );
    expect(out.GEMINI_API_KEY).toBe("sk-litellm");
    expect("ANTHROPIC_CUSTOM_HEADERS" in out).toBe(false);
    // The gateway base URL is the ordinary allowlisted key, already copied
    // through applyProviderEnv from gatewayPresetEnv's own write.
    expect(out.GOOGLE_GEMINI_BASE_URL).toBe(GW);
  });

  it("leaves GEMINI_API_KEY unset for a gateway turn with no instance key", () => {
    const out = agentTurnEnv({ id: "p1", port: 0, agent_env: gwEnv("key") }, { id: "t1", agent: "gemini", agent_env: "" }, { PATH: "/usr/bin" }, GW);
    expect("GEMINI_API_KEY" in out).toBe(false);
  });

  it("never sets GEMINI_API_KEY for a non-gateway turn", () => {
    const out = agentTurnEnv(
      project(0, serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" }))),
      { id: "t1", agent: "gemini", agent_env: "" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-litellm" },
      GW,
    );
    expect("GEMINI_API_KEY" in out).toBe(false);
  });

  // ANTHROPIC_CUSTOM_HEADERS is composed instead of stored because it is
  // Claude Code's only knob for arbitrary request headers: a project row that
  // could set it would let every turn in that project send anything to
  // whatever endpoint the same row names.
  it("cannot be told what headers to send by a project row", () => {
    expect(AGENT_ENV_KEYS).not.toContain("ANTHROPIC_CUSTOM_HEADERS");
    const smuggled = JSON.stringify({ ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_CUSTOM_HEADERS: "x-evil: 1" });
    const out = agentTurnEnv(project(0, smuggled), null, { PATH: "/usr/bin" }, GW);
    expect("ANTHROPIC_CUSTOM_HEADERS" in out).toBe(false);
    expect(parseAgentEnv(smuggled)).toEqual({ ANTHROPIC_BASE_URL: "http://localhost:11434" });
  });

  it("leaves a non-gateway turn's headers and the instance key alone in every other respect", () => {
    const out = agentTurnEnv(project(0, serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" }))), null, {
      PATH: "/usr/bin",
      CALANDRIA_LITELLM_KEY: "sk-litellm",
      ANTHROPIC_CUSTOM_HEADERS: "x-instance: 1",
    }, GW);
    // Composed only for the gateway kind; an instance-wide header survives.
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe("x-instance: 1");
    // The key is stripped from every turn, gateway or not.
    expect("CALANDRIA_LITELLM_KEY" in out).toBe(false);
  });

  it("carries a task's own override, so one task can be sent to the gateway", () => {
    const proj = project(0, serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" })));
    const t = { id: "t9", agent: "claude", agent_env: gwEnv("key", "claude-sonnet-4-5") };
    expect(taskProvider(proj, t, GW)).toMatchObject({ kind: "gateway", model: "claude-sonnet-4-5" });
    const out = agentTurnEnv({ id: "p9", ...proj }, t, { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-litellm" }, GW);
    expect(out.ANTHROPIC_BASE_URL).toBe(GW);
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toContain("task:t9");
  });
});

// A key is interpolated into a newline-separated header list, so a control
// character in it would append a header of its own to every turn. The setter
// refuses one (lib/litellm-key.ts); this is the line where it would matter.
describe("the gateway header is not injectable", () => {
  it("drops a key carrying a newline rather than composing a second header", () => {
    const env = serializeAgentEnv(gatewayPresetEnv({ baseUrl: GW, billing: "key" }));
    const out = agentTurnEnv(
      { id: "p1", port: 0, agent_env: env },
      { id: "t1", agent: "claude", agent_env: "" },
      { PATH: "/usr/bin", CALANDRIA_LITELLM_KEY: "sk-good\nx-evil: 1" },
      GW,
    );
    expect(out.ANTHROPIC_CUSTOM_HEADERS).toBe("x-litellm-tags: calandria,project:p1,task:t1,agent:claude");
    expect("ANTHROPIC_AUTH_TOKEN" in out).toBe(false);
  });
});

// Which tasks the plan meter's reset time may be offered for (SessionView's
// queue-at-reset). A window nobody is spending is not a window to wait on.
describe("planWindowApplies", () => {
  const gw = (billing: "key" | "subscription") =>
    describeProvider(gatewayPresetEnv({ baseUrl: "http://gw.example:4000", billing }), "http://gw.example:4000");

  it("holds for every non-gateway task", () => {
    for (const agent of ["claude", "codex", "gemini"]) {
      expect(planWindowApplies(describeProvider({}), agent)).toBe(true);
      expect(planWindowApplies(describeProvider({ ANTHROPIC_BASE_URL: "http://localhost:11434" }), agent)).toBe(true);
    }
  });

  it("drops for a key-billed gateway task on any routed agent", () => {
    expect(planWindowApplies(gw("key"), "claude")).toBe(false);
    expect(planWindowApplies(gw("key"), "codex")).toBe(false);
    expect(planWindowApplies(gw("key"), "gemini")).toBe(false);
  });

  it("holds for Claude on a subscription-billed gateway, and never for Codex or Antigravity", () => {
    expect(planWindowApplies(gw("subscription"), "claude")).toBe(true);
    // `requires_openai_auth` is unimplemented, so Codex bills the key here
    // too and its ChatGPT window is untouched.
    expect(planWindowApplies(gw("subscription"), "codex")).toBe(false);
    // `agy` has no equivalent of Claude Code's own-plan forwarding, so it
    // always bills the gateway's key regardless of the billing marker.
    expect(planWindowApplies(gw("subscription"), "gemini")).toBe(false);
  });
});

// Gemini CLI source refuses a plain-http endpoint unless it is loopback, and
// Antigravity's own docs state the same rule (docs/AGENTS.md, "Antigravity
// CLI"). A gateway is reachable from anywhere the app runs, so this is
// narrower than isLocalEndpoint's "on this machine or a private network": a
// LAN address is local but not loopback, and `agy` refuses it.
describe("isLoopbackHost", () => {
  it("accepts localhost, 127.x and ::1", () => {
    expect(isLoopbackHost("http://localhost:4000")).toBe(true);
    expect(isLoopbackHost("http://127.0.0.1:4000")).toBe(true);
    expect(isLoopbackHost("http://127.5.5.5:4000")).toBe(true);
    expect(isLoopbackHost("http://[::1]:4000")).toBe(true);
  });

  it("rejects a private-network or public address, unlike isLocalEndpoint", () => {
    expect(isLoopbackHost("http://192.168.1.5:4000")).toBe(false);
    expect(isLoopbackHost("http://10.0.0.5:4000")).toBe(false);
    expect(isLoopbackHost("http://gw.example.com:4000")).toBe(false);
  });

  it("rejects garbage and empty input", () => {
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("not a url")).toBe(false);
  });
});

describe("gatewayInsecureForGemini", () => {
  it("refuses plain http on a non-loopback gateway", () => {
    // GW itself ("http://gw.example.com:4000") is plain http and not loopback.
    const provider = describeProvider({ GOOGLE_GEMINI_BASE_URL: GW }, GW);
    expect(provider.kind).toBe("gateway");
    expect(gatewayInsecureForGemini(provider)).toBe(true);
  });

  it("allows plain http on a loopback gateway", () => {
    const loopback = "http://127.0.0.1:4000";
    const provider = describeProvider({ GOOGLE_GEMINI_BASE_URL: loopback }, loopback);
    expect(provider.kind).toBe("gateway");
    expect(gatewayInsecureForGemini(provider)).toBe(false);
  });

  it("allows https on any host", () => {
    const secure = "https://gw.example.com:4000";
    const provider = describeProvider({ GOOGLE_GEMINI_BASE_URL: secure }, secure);
    expect(gatewayInsecureForGemini(provider)).toBe(false);
  });

  it("is false for every non-gateway kind", () => {
    expect(gatewayInsecureForGemini(describeProvider({ GOOGLE_GEMINI_BASE_URL: "http://localhost:11434" }, GW))).toBe(false);
    expect(gatewayInsecureForGemini(describeProvider({}, GW))).toBe(false);
  });
});
