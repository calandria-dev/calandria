import { readEnv } from "./env.mjs";
import type { Project, Task } from "./types";

/**
 * The environment a main-turn agent process runs with (issue #102), plus the
 * per-project / per-task PROVIDER OVERRIDE that lets a task run against a local
 * model (Ollama, LM Studio, any Anthropic- or OpenAI-compatible endpoint)
 * without a new driver.
 *
 * Three facts make this a whole-env builder rather than a two-key patch:
 *
 * 1. Both agent SDKs REPLACE the child's environment when `env` is set, rather
 *    than merging it. The Claude Agent SDK's `Options.env` says so outright —
 *    "this value REPLACES the subprocess environment entirely" —
 *    (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1367-1385`), and the
 *    Codex SDK's `CodexOptions.env` documents the same thing the other way
 *    round: "the SDK will not inherit variables from process.env". So this
 *    starts from the server's own environment and edits a few keys, rather than
 *    building a small object from scratch — a partial object would otherwise
 *    silently strip PATH, HOME and everything else a spawned CLI needs to run.
 *
 * 2. NODE_ENV is dropped. `npm start` (package.json), the Dockerfile and the
 *    desktop supervisor all set NODE_ENV=production for Next's own benefit, and
 *    a turn spawned from that process inherits it. Inside a user's project that
 *    makes `npm install` skip devDependencies and still exit 0, so test runners
 *    and linters silently vanish from a session working in that checkout
 *    (issue #102 §2) — Next is not involved in anything a turn spawns.
 *
 * 3. PORT is replaced. The server's own PORT is Calandria's listening port, but
 *    `buildProjectContext()` (`lib/agents/shared.ts`) tells every agent to bind
 *    its dev server to `$PORT` — inherited unchanged, that pointed a task's dev
 *    server straight at Calandria itself. The project's own deterministic port
 *    is the one `lib/services.ts` and `pty-server.js` already inject into
 *    managed services and the terminal, so setting it here makes that guidance
 *    true instead of false. A project with no port (0, or no project at all)
 *    gets PORT deleted rather than left pointing at the app.
 *
 * The provider override sits between 1 and 3: applied AFTER the server env is
 * copied (so it wins over an instance-wide ANTHROPIC_BASE_URL) and BEFORE the
 * PORT edit (so it can never repoint PORT). It is an ALLOWLIST, not a free env
 * block: `projects.agent_env` is written from a settings form and reachable
 * through PATCH /api/projects/[id], and a field that could carry PATH,
 * NODE_OPTIONS or LD_PRELOAD would be arbitrary code execution in every turn
 * spawned for that project. Only the keys the two CLIs read to pick a
 * provider, endpoint and model get through; everything else is dropped at
 * parse time, so nothing unlisted ever reaches the DB either.
 *
 * SDK-free and Node-free on purpose: the client imports the same helpers to
 * build the settings form and the task-header badge, so the two sides can't
 * disagree about what a stored override means.
 */

/**
 * Env keys a project or task override may set. Both CLIs read the ANTHROPIC_*
 * and OPENAI_* ones themselves; the CODEX_* ones are consumed by Calandria's
 * Codex driver (`lib/agents/codex/provider.ts`), because the codex CLI reads
 * its provider from config.toml rather than from the environment and with a
 * ChatGPT login ignores OPENAI_BASE_URL outright.
 *
 * `ANTHROPIC_AUTH_TOKEN` is here because Ollama's Anthropic-compatible endpoint
 * REQUIRES one (any value; `ollama` by convention), even though lib/env-keys.mjs
 * strips that same variable from the server's launch env at boot. The two
 * don't conflict: the strip guards against an inherited token silently
 * switching turns to per-token Anthropic billing, and `applyProviderEnv` keeps
 * an override's token only when the same override also points
 * ANTHROPIC_BASE_URL somewhere other than Anthropic — a token that cannot reach
 * api.anthropic.com cannot bill it, so it needs no instance-wide opt-in.
 */
export const AGENT_ENV_KEYS = [
  // Claude Code — endpoint, credential, model the bare aliases resolve to.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  // A local session has no business phoning home for update checks, telemetry
  // or error reports; the local preset sets it, the user can unset it.
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  // Codex — the OpenAI-compatible endpoint (mapped onto a config.toml provider
  // entry by the driver) and the model to run when the task doesn't pick one.
  "OPENAI_BASE_URL",
  "CODEX_MODEL",
  // Pass-through knobs the codex CLI's own `--oss` / built-in `ollama` provider
  // read, for a user whose ~/.codex/config.toml already selects one of those.
  "OLLAMA_HOST",
  "CODEX_OSS_BASE_URL",
  // Antigravity — the Gemini-native endpoint its CLI takes (docs/design/litellm.md
  // measured `agy` sending POST /v1beta/models/<model>:streamGenerateContent
  // there) and the model to run. Written by the gateway preset; the Antigravity
  // half of the gateway lands with that driver's step.
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_MODEL",
  // Which account a LiteLLM-gateway turn bills. A marker, not a credential:
  // "key" bills the gateway key's own API spend, "subscription" leaves the
  // CLI's own login in place and lets the gateway forward it. See
  // `gatewayPresetEnv` and the gateway block in `agentTurnEnv`.
  "CALANDRIA_GATEWAY_BILLING",
] as const;

// `ANTHROPIC_CUSTOM_HEADERS` is deliberately NOT on that list, and must not
// join it. It is Claude Code's only knob for arbitrary request headers, so a
// project row that could set it would be a way to make every turn in that
// project send anything at all to whatever endpoint the same row names.
// `agentTurnEnv()` composes it per turn instead, for the gateway kind only,
// from the instance's own key and the ids of the project and task actually
// running — which also keeps those ids current, where a stored header would go
// stale the moment a task moved project.

export type AgentEnvKey = (typeof AGENT_ENV_KEYS)[number];
export type AgentEnv = Partial<Record<AgentEnvKey, string>>;

const KEY_SET: ReadonlySet<string> = new Set(AGENT_ENV_KEYS);

export function isAgentEnvKey(key: string): key is AgentEnvKey {
  return KEY_SET.has(key);
}

/**
 * The stored form (`projects.agent_env` / `tasks.agent_env`) → the allowlisted
 * record. Tolerates the JSON text, an already-parsed object, null and garbage,
 * because it is reached from a PATCH body, a DB column and the client alike.
 * Unknown keys and non-string values are dropped, never rejected: the allowlist
 * is the policy and this is the one place it is enforced. An EMPTY string value
 * is kept — in `applyProviderEnv` it means "unset this key", which is how a
 * task-level override says "cloud" over a local project.
 */
export function parseAgentEnv(input: unknown): AgentEnv {
  let obj: unknown = input;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return {};
    try {
      obj = JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: AgentEnv = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!isAgentEnvKey(k)) continue;
    if (typeof v !== "string") continue;
    // A control character would reach a spawned process's environment; an
    // unbounded value has no legitimate form for any of these keys.
    if (v.length > 2048 || /[\0-\x1f\x7f]/.test(v)) continue;
    out[k] = v.trim();
  }
  return out;
}

/** The allowlisted record → the stored form: `""` for "no override", else
 *  compact JSON with keys in allowlist order so equal overrides compare equal. */
export function serializeAgentEnv(input: unknown): string {
  const env = parseAgentEnv(input);
  const ordered: Record<string, string> = {};
  for (const k of AGENT_ENV_KEYS) if (k in env) ordered[k] = env[k] as string;
  return Object.keys(ordered).length ? JSON.stringify(ordered) : "";
}

/** The override a turn runs under: the project's, with the task's keys laid
 *  over it. A task that sets nothing inherits its project whole. */
export function providerEnvFor(
  project: Pick<Project, "agent_env"> | null | undefined,
  task?: Pick<Task, "agent_env"> | null,
): AgentEnv {
  return { ...parseAgentEnv(project?.agent_env), ...parseAgentEnv(task?.agent_env) };
}

const ANTHROPIC_HOST = /(^|\.)anthropic\.com$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** True when a base URL points somewhere other than Anthropic's own API — the
 *  condition under which an override's ANTHROPIC_AUTH_TOKEN is honoured. */
export function redirectsAnthropic(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const host = hostOf(baseUrl);
  return !!host && !ANTHROPIC_HOST.test(host.replace(/:\d+$/, ""));
}

// ---- the LiteLLM gateway (docs/design/litellm.md) ----

/** Which account a gateway turn bills. */
export type GatewayBilling = "key" | "subscription";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The instance's LiteLLM gateway (`CALANDRIA_LITELLM_BASE_URL`), or null when
 * none is configured — which is what hides the Gateway preset everywhere.
 *
 * Read here rather than taken from `lib/config.ts` because this module is
 * imported by the client too (the settings form and the session badge both
 * describe a stored override), and `lib/config.ts` reaches for `node:path` and
 * `node:os`. Same crossing as `lib/features.ts`: the server reads the env, and
 * `app/layout.tsx` hands the browser the answer on `window`, so both sides
 * classify a stored override identically and SSR and hydration agree.
 * `lib/config.ts` re-exports this as `LITELLM_BASE_URL` so server code has one
 * name for it.
 */
export function gatewayBaseUrl(): string | null {
  const raw =
    typeof window !== "undefined"
      ? (window as { __GATEWAY_BASE_URL?: string }).__GATEWAY_BASE_URL
      : readEnv("CALANDRIA_LITELLM_BASE_URL");
  return normalizeBaseUrl(String(raw ?? "")) || null;
}

/**
 * Whether a base URL IS the configured gateway. Origin equality rather than a
 * string compare, so `http://gw:4000`, `http://gw:4000/` and `http://gw:4000/v1`
 * are all the one gateway — which they have to be, since the preset writes the
 * OpenAI surface as `<gateway>/v1` and the Anthropic one as `<gateway>`.
 */
export function isGatewayEndpoint(url: string | null | undefined, gateway: string | null = gatewayBaseUrl()): boolean {
  if (!url || !gateway) return false;
  const a = originOf(url);
  return !!a && a === originOf(gateway);
}

/**
 * Lay a provider override over an env, in place. Three rules beyond "copy the
 * keys in", each one about credentials:
 *
 * - `""` UNSETS the key. That is how a task says "cloud" inside a local project
 *   (`cloudOverrideEnv()`), and how a user blanks one key of a preset.
 * - Redirecting ANTHROPIC_BASE_URL away from Anthropic drops the INHERITED
 *   Anthropic credentials (ANTHROPIC_API_KEY from the persisted key file, an
 *   ANTHROPIC_AUTH_TOKEN kept via CALANDRIA_ALLOW_API_KEY_ENV) before the
 *   override's own token is applied. A "custom base URL" is a third party by
 *   definition, and the user's real key must not be sent there because it
 *   happened to be in the server's environment; an endpoint that needs a
 *   credential gets it from the override's own ANTHROPIC_AUTH_TOKEN. Same for
 *   OPENAI_BASE_URL and OPENAI_API_KEY.
 * - An override's ANTHROPIC_AUTH_TOKEN is dropped unless the SAME override
 *   redirects ANTHROPIC_BASE_URL. Without a redirect the token would go to
 *   api.anthropic.com and bill it per-token — exactly what the boot strip in
 *   lib/env-keys.mjs exists to prevent, and a project field must not be the
 *   way around it. The instance-wide opt-in stays the only door to that.
 */
export function applyProviderEnv(out: Record<string, string>, override: AgentEnv): void {
  const anthropicUrl = override.ANTHROPIC_BASE_URL;
  if (anthropicUrl !== undefined && redirectsAnthropic(anthropicUrl)) {
    delete out.ANTHROPIC_API_KEY;
    delete out.ANTHROPIC_AUTH_TOKEN;
  }
  if (override.OPENAI_BASE_URL !== undefined && override.OPENAI_BASE_URL) {
    delete out.OPENAI_API_KEY;
  }
  for (const k of AGENT_ENV_KEYS) {
    const v = override[k];
    if (v === undefined) continue;
    if (k === "ANTHROPIC_AUTH_TOKEN" && v && !redirectsAnthropic(anthropicUrl)) continue;
    if (v === "") delete out[k];
    else out[k] = v;
  }
}

export function agentTurnEnv(
  project: (Pick<Project, "port" | "agent_env"> & Partial<Pick<Project, "id">>) | null | undefined,
  task?: (Pick<Task, "agent_env"> & Partial<Pick<Task, "id" | "agent">>) | null,
  base: Readonly<Record<string, string | undefined>> = process.env,
  gateway: string | null = gatewayBaseUrl(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  delete out.NODE_ENV;
  const override = providerEnvFor(project, task);
  applyProviderEnv(out, override);
  // The instance's gateway key never reaches a spawned CLI under its own name.
  // It is an instance credential that no agent process has any use for, and the
  // one place it belongs in a turn's environment — the gateway header below —
  // is composed here. Read before the delete so the block can still use it.
  const gatewayKey = (out.CALANDRIA_LITELLM_KEY ?? "").trim();
  delete out.CALANDRIA_LITELLM_KEY;
  applyGatewayEnv(out, describeProvider(override, gateway), {
    key: gatewayKey,
    project: project?.id,
    task: task?.id,
    agent: task?.agent,
  });
  if (project?.port) out.PORT = String(project.port);
  else delete out.PORT;
  return out;
}

/**
 * The part of a gateway turn's environment that is composed rather than stored
 * (docs/design/litellm.md, "The gateway provider kind"). Nothing here can come
 * from `agent_env`: the header carries a credential and the ids of the project
 * and task actually running, and the credential variable decides who pays.
 *
 * - `x-litellm-api-key` is how Claude Code authenticates to LiteLLM's proxy
 *   layer while its own `Authorization` header carries whatever the billing
 *   mode below put there. `ANTHROPIC_CUSTOM_HEADERS` is the CLI's only knob for
 *   it, measured landing on every request (Claude Code 2.1.257).
 * - `x-litellm-tags` is what makes LiteLLM's own spend views break down by
 *   project and task without Calandria writing anything.
 * - Billing `key` sends the gateway key as `ANTHROPIC_AUTH_TOKEN`, so the turn
 *   bills that key's account. Billing `subscription` sets NO credential
 *   variable: the CLI keeps its own `/login` and the gateway forwards it
 *   (`forward_client_headers_to_llm_api: true`, measured working through
 *   LiteLLM 1.101.0). Either way the inherited Anthropic credentials are
 *   already gone — the gateway is a redirect away from Anthropic, so
 *   `applyProviderEnv` dropped them before this runs.
 */
function applyGatewayEnv(
  out: Record<string, string>,
  provider: AgentProvider,
  ctx: { key: string; project?: string; task?: string; agent?: string },
): void {
  if (provider.kind !== "gateway") return;
  // The headers are newline-separated, so a key carrying one would append a
  // header of its own. Nothing should be able to write such a key — the setter
  // refuses it — but this is the line where it would matter, so it is checked
  // here rather than trusted from three callers away.
  const key = /[\0-\x1f\x7f]/.test(ctx.key) ? "" : ctx.key;
  const headers: string[] = [];
  if (key) headers.push(`x-litellm-api-key: Bearer ${key}`);
  const tags = ["calandria"];
  if (ctx.project) tags.push(`project:${ctx.project}`);
  if (ctx.task) tags.push(`task:${ctx.task}`);
  if (ctx.agent) tags.push(`agent:${ctx.agent}`);
  headers.push(`x-litellm-tags: ${tags.join(",")}`);
  out.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
  if (provider.gateway_billing === "subscription") {
    delete out.ANTHROPIC_AUTH_TOKEN;
    delete out.ANTHROPIC_API_KEY;
  } else if (key) {
    out.ANTHROPIC_AUTH_TOKEN = key;
  }
}

// ---- presets: what the settings form and `suggest_task` write ----

/** Strip a trailing slash and a trailing `/v1`, so one typed URL serves both
 *  CLIs: Ollama and LM Studio mount Anthropic Messages at `<base>/v1/messages`
 *  and the OpenAI surface at `<base>/v1/…`. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * The override for a local or custom endpoint. `model` is written to every key
 * a bare alias resolves through, so a task whose picker says `sonnet` or
 * `haiku` still lands on the local model instead of a Claude id Ollama has
 * never heard of. `token` is what the endpoint wants in `Authorization`; Ollama
 * and LM Studio require one and ignore its value (`ollama` by convention).
 */
export function providerPresetEnv(input: { baseUrl: string; model?: string; token?: string }): AgentEnv {
  const base = normalizeBaseUrl(input.baseUrl);
  if (!base) return {};
  const model = input.model?.trim() ?? "";
  const env: AgentEnv = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: input.token?.trim() || "ollama",
    OPENAI_BASE_URL: `${base}/v1`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.ANTHROPIC_SMALL_FAST_MODEL = model;
    env.CODEX_MODEL = model;
  }
  return env;
}

/**
 * The override for the instance's LiteLLM gateway. Same shape as the local
 * preset minus the one thing that matters: NO credential. The gateway key is
 * an instance secret (`CALANDRIA_LITELLM_KEY`, or the persisted file behind
 * Settings → Agents) and `agent_env` is served to the browser by
 * `GET /api/projects`, so a key stored here would be a key anyone with the app
 * open could read. `agentTurnEnv()` resolves it at turn time instead.
 *
 * `billing` is the marker that decides who pays, and it is stored rather than
 * derived because both modes are legitimate against the same URL: a key-billed
 * project and a subscription-billed one differ in nothing else.
 */
export function gatewayPresetEnv(input: { baseUrl: string; billing: GatewayBilling; model?: string }): AgentEnv {
  const base = normalizeBaseUrl(input.baseUrl);
  if (!base) return {};
  const env: AgentEnv = {
    ANTHROPIC_BASE_URL: base,
    OPENAI_BASE_URL: `${base}/v1`,
    GOOGLE_GEMINI_BASE_URL: base,
    CALANDRIA_GATEWAY_BILLING: input.billing === "subscription" ? "subscription" : "key",
  };
  const model = input.model?.trim() ?? "";
  if (model) {
    // Claude Code's own `/model` list cannot see a LiteLLM catalog, so the
    // picked id is written to the bare aliases as well as ANTHROPIC_MODEL —
    // the same reason the local preset does it.
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.CODEX_MODEL = model;
    env.GEMINI_MODEL = model;
  }
  return env;
}

/** A task-level override that puts a task back on the agent's own cloud login
 *  inside a project whose default is a local model: every allowlisted key set
 *  to `""`, which `applyProviderEnv` reads as "unset". */
export function cloudOverrideEnv(): AgentEnv {
  const env: AgentEnv = {};
  for (const k of AGENT_ENV_KEYS) env[k] = "";
  return env;
}

// ---- describing an override, for the badge, the usage ledger and the form ----

export type ProviderKind = "cloud" | "local" | "custom" | "gateway";

/**
 * What a turn against this endpoint is worth, which is a different question
 * from where the endpoint is:
 *
 * - `vendor` — the driver's own figure IS the answer. Claude Code and Codex
 *   price the model they actually ran against the catalog they actually bill.
 * - `free` — the endpoint charges nothing. A model served by Ollama or LM
 *   Studio on this machine or this network costs electricity, not dollars, so
 *   a recorded 0 is a measurement rather than a placeholder.
 * - `unknown` — nobody has told us what this endpoint charges. A custom base
 *   URL is free text plus an optional token, and it is just as likely to be
 *   OpenRouter, Together, Fireworks or a Bedrock proxy as anything free. The
 *   driver's figure prices a model id it was merely TOLD, against the vendor's
 *   own catalog, so it is not a measurement of this endpoint at all: recording
 *   it over-reports and recording 0 under-reports. Neither number is defensible,
 *   so the ledger records neither — see `task_usage.cost_usd`, which is NULL
 *   here and is left out of every total rather than folded in as a fake zero.
 * - `gateway` — the endpoint states its own prices (`GET /model/info`), so the
 *   figure is computable, but Calandria has to compute it: no CLI exposes the
 *   `x-litellm-response-cost` header LiteLLM answers with. Until the catalog
 *   step lands that table, a gateway turn records NULL and counts as unpriced,
 *   exactly like `custom` — the difference is that this one has an answer
 *   coming, and the ledger marks it `≈` rather than `+` when it does.
 */
export type ProviderPricing = "vendor" | "free" | "unknown" | "gateway";

/** Every kind maps explicitly. A cascading ternary would quietly hand a kind
 *  added later whatever the last arm happened to be, which for the first three
 *  was "unpriced" and could as easily have been "bill it as the vendor's". */
const PRICING: Record<ProviderKind, ProviderPricing> = {
  cloud: "vendor",
  local: "free",
  custom: "unknown",
  gateway: "gateway",
};

export function providerPricing(kind: ProviderKind): ProviderPricing {
  return PRICING[kind];
}

/**
 * What `task_usage.cost_usd` records for one turn: the driver's own figure, a
 * measured zero, or NULL for "nobody has stated a price". The runner asks here
 * from both of its ledger writes so they cannot drift, and so a fifth pricing
 * value has one place to be decided rather than two.
 */
export function recordedCostUsd(pricing: ProviderPricing, vendorFigure: number | null | undefined): number | null {
  switch (pricing) {
    case "vendor":
      return vendorFigure ?? null;
    case "free":
      return 0;
    // Both unpriced, for different reasons — see ProviderPricing above.
    case "gateway":
    case "unknown":
      return null;
  }
}

export interface AgentProvider {
  /** cloud = the agent's own login, nothing overridden. local = an endpoint on
   *  this machine / the Docker host / a private network. gateway = the
   *  instance's own LiteLLM gateway, whatever address that is. custom = any
   *  other base URL. None of the three non-cloud kinds is "the vendor's spend"
   *  for billing, but they are not the same fact — see `pricing`. */
  kind: ProviderKind;
  /** How the ledger should treat this turn's dollar figure. Derived from
   *  `kind` so the badge, the ledger and the settings form can never disagree
   *  about which endpoints are free and which are merely unpriced. */
  pricing: ProviderPricing;
  /** The endpoint's host[:port], "" for cloud — what `task_usage.provider`
   *  stores, so Insights can tell endpoints apart without a second column. */
  host: string;
  anthropic_base_url: string | null;
  openai_base_url: string | null;
  gemini_base_url: string | null;
  /** The model the override pins (ANTHROPIC_MODEL / CODEX_MODEL / GEMINI_MODEL),
   *  if any. */
  model: string | null;
  auth_token: string | null;
  /** Who a gateway turn bills, from the stored `CALANDRIA_GATEWAY_BILLING`
   *  marker; null for every other kind. An unmarked override that happens to
   *  name the gateway address — the "type the URL into Custom" baseline that
   *  worked before this preset existed — reads as `key`, which is what it was
   *  doing. */
  gateway_billing: GatewayBilling | null;
}

const LOCAL_HOST = /^(localhost|127\.(\d+\.){2}\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal|host\.containers\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

/** Whether a base URL's host is on this machine or a private network. */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && LOCAL_HOST.test(host.replace(/:\d+$/, ""));
}

/**
 * What an override (already merged, see `providerEnvFor`) amounts to.
 *
 * `gateway` outranks `local`, since a LiteLLM proxy on this machine is still a
 * gateway: the interesting fact about it is that it meters and prices what it
 * forwards, not where it is listening. `gateway` is passed in rather than read
 * inside so the suite can describe an override against a stated gateway
 * without touching the process env; the default is the instance's own.
 */
export function describeProvider(env: AgentEnv, gateway: string | null = gatewayBaseUrl()): AgentProvider {
  const anthropic = env.ANTHROPIC_BASE_URL || null;
  const openai = env.OPENAI_BASE_URL || null;
  const gemini = env.GOOGLE_GEMINI_BASE_URL || null;
  const first = anthropic ?? openai ?? gemini;
  const model = env.ANTHROPIC_MODEL || env.CODEX_MODEL || env.GEMINI_MODEL || null;
  const auth_token = env.ANTHROPIC_AUTH_TOKEN || null;
  const bare = { anthropic_base_url: null, openai_base_url: null, gemini_base_url: null, gateway_billing: null };
  if (!first) return { kind: "cloud", pricing: "vendor", host: "", ...bare, model, auth_token };
  const kind: ProviderKind = isGatewayEndpoint(first, gateway) ? "gateway" : isLocalEndpoint(first) ? "local" : "custom";
  return {
    kind,
    pricing: providerPricing(kind),
    host: hostOf(first) ?? first,
    anthropic_base_url: anthropic,
    openai_base_url: openai,
    gemini_base_url: gemini,
    model,
    auth_token,
    gateway_billing: kind !== "gateway" ? null : env.CALANDRIA_GATEWAY_BILLING === "subscription" ? "subscription" : "key",
  };
}

/** The provider a task's turns run against: the project's override with the
 *  task's laid over it, described. */
export function taskProvider(
  project: Pick<Project, "agent_env"> | null | undefined,
  task?: Pick<Task, "agent_env"> | null,
  gateway: string | null = gatewayBaseUrl(),
): AgentProvider {
  return describeProvider(providerEnvFor(project, task), gateway);
}
