import { readEnv } from "./env.mjs";
import type { Project, Task } from "./types";

/**
 * The environment a main-turn agent process runs with, plus the per-project /
 * per-task PROVIDER OVERRIDE that lets a task run against a local model
 * (Ollama, LM Studio, any Anthropic- or OpenAI-compatible endpoint) without a
 * new driver.
 *
 * This is a whole-env builder, not a two-key patch: both agent SDKs REPLACE
 * the child's environment whenever `env` is set, so a partial object would
 * strip PATH, HOME and everything else a spawned CLI needs. It starts from
 * the server's own environment, then: drops
 * NODE_ENV, since `npm start`, the Dockerfile and the desktop supervisor all
 * set NODE_ENV=production for Next's benefit, and inheriting it makes
 * `npm install` inside a user's project skip devDependencies while exiting 0,
 * dropping test runners and linters with no error; and replaces PORT, since
 * `buildProjectContext()` (`lib/agents/shared.ts`) tells every agent to bind
 * its dev server to `$PORT`, and the project's own deterministic port is the
 * one `lib/services.ts` and `pty-server.js` already inject into managed
 * services and the terminal. A project with no port (0, or no project at all)
 * gets PORT deleted: left in place, it would point at Calandria itself.
 *
 * The provider override is applied after the server env is copied (so it wins
 * over an instance-wide ANTHROPIC_BASE_URL) and before the PORT edit (so it
 * can never repoint PORT). It is an ALLOWLIST, not a free env block:
 * `projects.agent_env` is written from a settings form and reachable through
 * PATCH /api/projects/[id], and a field that could carry PATH, NODE_OPTIONS or
 * LD_PRELOAD would be arbitrary code execution in every turn spawned for that
 * project. Only the keys the two CLIs read to pick a provider, endpoint and
 * model get through; everything else is dropped at parse time, so nothing
 * unlisted ever reaches the DB either.
 *
 * SDK-free and Node-free: the client imports the same helpers to build the
 * settings form and the task-header badge, so the two sides agree on what a
 * stored override means.
 */

/**
 * Env keys a project or task override may set. Both CLIs read the ANTHROPIC_*
 * and OPENAI_* ones themselves; the CODEX_* ones are consumed by Calandria's
 * Codex driver (`lib/agents/codex/provider.ts`), because the codex CLI reads
 * its provider from config.toml, not the environment, and ignores
 * OPENAI_BASE_URL outright with a ChatGPT login.
 *
 * `ANTHROPIC_AUTH_TOKEN` is here because Ollama's Anthropic-compatible endpoint
 * requires one (any value; `ollama` by convention), even though lib/env-keys.mjs
 * strips that same variable from the server's launch env at boot. The two
 * don't conflict: the strip guards against an inherited token switching turns
 * to per-token Anthropic billing, and `applyProviderEnv` keeps an override's
 * token only when the same override also points ANTHROPIC_BASE_URL somewhere
 * other than Anthropic, since a token that cannot reach api.anthropic.com
 * cannot bill it and needs no instance-wide opt-in.
 */
export const AGENT_ENV_KEYS = [
  // Claude Code: endpoint, credential, model the bare aliases resolve to.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  // Suppresses update checks, telemetry and error reports for a local session;
  // the local preset sets it, the user can unset it.
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  // Codex: the OpenAI-compatible endpoint (mapped onto a config.toml provider
  // entry by the driver) and the model to run when the task doesn't pick one.
  "OPENAI_BASE_URL",
  "CODEX_MODEL",
  // Pass-through knobs the codex CLI's own `--oss` / built-in `ollama` provider
  // read, for a user whose ~/.codex/config.toml already selects one of those.
  "OLLAMA_HOST",
  "CODEX_OSS_BASE_URL",
  // Antigravity: the Gemini-native endpoint its CLI takes (docs/AGENTS.md:
  // `agy` sends POST /v1beta/models/<model>:streamGenerateContent there) and
  // the model to run. Written by the gateway preset; the Antigravity half of
  // the gateway lands with that driver's step.
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_MODEL",
  // Which account a LiteLLM-gateway turn bills. A marker, not a credential:
  // "key" bills the gateway key's own API spend, "subscription" leaves the
  // CLI's own login in place and lets the gateway forward it. See
  // `gatewayPresetEnv` and the gateway block in `agentTurnEnv`.
  "CALANDRIA_GATEWAY_BILLING",
] as const;

// `ANTHROPIC_CUSTOM_HEADERS` is NOT on that list and must not join it. It is
// Claude Code's only knob for arbitrary request headers, so a project row that
// could set it would let every turn in that project send anything to whatever
// endpoint the same row names. `agentTurnEnv()` composes it per turn instead,
// for the gateway kind only, from the instance's own key and the ids of the
// project and task actually running, which also keeps those ids current where
// a stored header would go stale the moment a task moved project.

export type AgentEnvKey = (typeof AGENT_ENV_KEYS)[number];
export type AgentEnv = Partial<Record<AgentEnvKey, string>>;

const KEY_SET: ReadonlySet<string> = new Set(AGENT_ENV_KEYS);

export function isAgentEnvKey(key: string): key is AgentEnvKey {
  return KEY_SET.has(key);
}

/**
 * The stored form (`projects.agent_env` / `tasks.agent_env`) to the allowlisted
 * record. Tolerates the JSON text, an already-parsed object, null and garbage,
 * because it is reached from a PATCH body, a DB column and the client alike.
 * Unknown keys and non-string values are dropped, never rejected, since the
 * allowlist is enforced here. An EMPTY string value is kept: in
 * `applyProviderEnv` it means "unset this key", which is how a task-level
 * override says "cloud" over a local project.
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
    // Reject control characters, which would reach a spawned process's
    // environment, and unbounded values, which have no legitimate form here.
    if (v.length > 2048 || /[\0-\x1f\x7f]/.test(v)) continue;
    out[k] = v.trim();
  }
  return out;
}

/** The allowlisted record to the stored form: `""` for "no override", else
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

/** True when a base URL points somewhere other than Anthropic's own API: the
 *  condition under which an override's ANTHROPIC_AUTH_TOKEN is honoured. */
export function redirectsAnthropic(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  const host = hostOf(baseUrl);
  return !!host && !ANTHROPIC_HOST.test(host.replace(/:\d+$/, ""));
}

// ---- the LiteLLM gateway (docs/AGENTS.md) ----

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
 * none is configured, which is what hides the Gateway preset everywhere.
 *
 * Read here, not from `lib/config.ts`, because this module is imported
 * by the client too (the settings form and the session badge both describe a
 * stored override), and `lib/config.ts` reaches for `node:path` and `node:os`.
 * Same crossing as `lib/features.ts`: the server reads the env, and
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
 * Whether a base URL IS the configured gateway. Compares origins, not
 * strings, so `http://gw:4000`, `http://gw:4000/` and `http://gw:4000/v1` all
 * count as the one gateway, since the preset writes the OpenAI surface as
 * `<gateway>/v1` and the Anthropic one as `<gateway>`.
 */
export function isGatewayEndpoint(url: string | null | undefined, gateway: string | null = gatewayBaseUrl()): boolean {
  if (!url || !gateway) return false;
  const a = originOf(url);
  return !!a && a === originOf(gateway);
}

/**
 * Lays a provider override over an env, in place. Three rules beyond "copy the
 * keys in", each about credentials:
 *
 * - `""` UNSETS the key. That is how a task says "cloud" inside a local project
 *   (`cloudOverrideEnv()`), and how a user blanks one key of a preset.
 * - Redirecting ANTHROPIC_BASE_URL away from Anthropic drops the INHERITED
 *   Anthropic credentials (ANTHROPIC_API_KEY from the persisted key file, an
 *   ANTHROPIC_AUTH_TOKEN kept via CALANDRIA_ALLOW_API_KEY_ENV) before the
 *   override's own token is applied: a custom base URL is a third party, and
 *   the user's real key must not be sent there just because it was in the
 *   server's environment. An endpoint that needs a credential gets it from the
 *   override's own ANTHROPIC_AUTH_TOKEN. Same for OPENAI_BASE_URL and
 *   OPENAI_API_KEY.
 * - An override's ANTHROPIC_AUTH_TOKEN is dropped unless the SAME override
 *   redirects ANTHROPIC_BASE_URL. Without a redirect the token would go to
 *   api.anthropic.com and bill it per-token, which is what the boot strip in
 *   lib/env-keys.mjs prevents; a project field must not be a way around it.
 *   The instance-wide opt-in stays the only door to that.
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
  task?: (Pick<Task, "agent_env"> & Partial<Pick<Task, "id" | "agent" | "gateway_key">>) | null,
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
  // The instance's gateway key never reaches a spawned CLI under its own name;
  // it is composed into the gateway header below instead. Read before the
  // delete so that block can still use it.
  //
  // A task's own minted key (lib/gatewayKeys.ts, docs/AGENTS.md "Per-task
  // virtual keys") takes priority over the instance key when present.
  // `task.gateway_key` is populated by lib/runner.ts on its in-memory `task`
  // object just before a turn's driver call, never a value getTask() or
  // listTasks() themselves return, so this decides which credential a gateway
  // turn actually bills.
  const gatewayKey = (task?.gateway_key || out.CALANDRIA_LITELLM_KEY || "").trim();
  delete out.CALANDRIA_LITELLM_KEY;
  // Composed below for a gateway turn and never inherited, so a stale pair in
  // the server's own environment can't hand a cloud turn a credential and the
  // wrong task's tags.
  delete out.CALANDRIA_GATEWAY_KEY;
  delete out.CALANDRIA_GATEWAY_TAGS;
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
 * The part of a gateway turn's environment that is composed per turn, not
 * stored (docs/AGENTS.md, "The gateway provider kind"). Nothing here can come from
 * `agent_env`: the header carries a credential and the ids of the project and
 * task actually running, and the credential variable decides who pays.
 *
 * - `x-litellm-api-key` is how Claude Code authenticates to LiteLLM's proxy
 *   layer while its own `Authorization` header carries whatever the billing
 *   mode below put there. `ANTHROPIC_CUSTOM_HEADERS` is the CLI's only knob
 *   for it.
 * - `x-litellm-tags` is what makes LiteLLM's own spend views break down by
 *   project and task without Calandria writing anything.
 * - Billing `key` sends the gateway key as `ANTHROPIC_AUTH_TOKEN`, so the turn
 *   bills that key's account. Billing `subscription` sets NO credential
 *   variable: the CLI keeps its own `/login` and the gateway forwards it
 *   (`forward_client_headers_to_llm_api: true`). Either way the inherited
 *   Anthropic credentials are already gone, since the gateway is a redirect
 *   away from Anthropic and `applyProviderEnv` dropped them before this runs.
 *
 * The billing choice is Claude's alone. Codex gets the key either way: its
 * ChatGPT-forwarding equivalent (`requires_openai_auth`) sends no
 * `Authorization` header, so key billing is the only mode its gateway support
 * ships (docs/AGENTS.md, "Codex driver").
 */
function applyGatewayEnv(
  out: Record<string, string>,
  provider: AgentProvider,
  ctx: { key: string; project?: string; task?: string; agent?: string },
): void {
  if (provider.kind !== "gateway") return;
  // The headers are newline-separated, so a key carrying one would append a
  // header of its own. The setter already refuses such a key, but this is the
  // line where it would matter, so it is checked here too; the setter's guard
  // lives three callers away.
  const key = /[\0-\x1f\x7f]/.test(ctx.key) ? "" : ctx.key;
  // Antigravity: the Go GenAI SDK inside `agy` reads GEMINI_API_KEY directly,
  // so the credential travels under its own name instead of a header. There is
  // no ANTHROPIC_CUSTOM_HEADERS equivalent for it, so a gateway turn on this
  // agent carries no attribution tags (docs/AGENTS.md, "Antigravity driver").
  // Always key-billed, since `agy` has no subscription-forwarding mode. None
  // of the Claude/Codex-specific composition below applies, so this returns
  // early.
  if (ctx.agent === "gemini") {
    if (key) out.GEMINI_API_KEY = key;
    return;
  }
  const headers: string[] = [];
  if (key) headers.push(`x-litellm-api-key: Bearer ${key}`);
  const tags = ["calandria"];
  if (ctx.project) tags.push(`project:${ctx.project}`);
  if (ctx.task) tags.push(`task:${ctx.task}`);
  if (ctx.agent) tags.push(`agent:${ctx.agent}`);
  headers.push(`x-litellm-tags: ${tags.join(",")}`);
  out.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
  // The Codex half of the same two facts. Codex takes its headers from a
  // provider ENTRY (lib/agents/codex/provider.ts), not the environment, and
  // `env_key` there names a VARIABLE the CLI reads; it does not carry the
  // value, so the key has to exist in the turn's env under a name of our own,
  // never `OPENAI_API_KEY`, which the built-in `openai` provider would pick up
  // and bill a cloud turn against. The tag list is exported here so one
  // function composes it for both CLIs.
  out.CALANDRIA_GATEWAY_TAGS = tags.join(",");
  if (key) out.CALANDRIA_GATEWAY_KEY = key;
  if (provider.gateway_billing === "subscription") {
    delete out.ANTHROPIC_AUTH_TOKEN;
    delete out.ANTHROPIC_API_KEY;
  } else if (key) {
    out.ANTHROPIC_AUTH_TOKEN = key;
  }
}

// ---- presets: what the settings form and `suggest_task` write ----

/** Strips a trailing slash and a trailing `/v1`, so one typed URL serves both
 *  CLIs: Ollama and LM Studio mount Anthropic Messages at `<base>/v1/messages`
 *  and the OpenAI surface at `<base>/v1/...`. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * The override for a local or custom endpoint. `model` is written to every key
 * a bare alias resolves through, so a task whose picker says `sonnet` or
 * `haiku` still lands on the local model instead of a Claude id Ollama has
 * never heard of. `token` is what the endpoint wants in `Authorization`;
 * Ollama and LM Studio require one and ignore its value (`ollama` by
 * convention).
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
 * preset minus NO credential. The gateway key is an instance secret
 * (`CALANDRIA_LITELLM_KEY`, or the persisted file behind Settings > Agents)
 * and `agent_env` is served to the browser by `GET /api/projects`, so a key
 * stored here would be readable by anyone with the app open.
 * `agentTurnEnv()` resolves it at turn time instead.
 *
 * `billing` is the marker that decides who pays, and it is stored, not
 * derived, because both modes are legitimate against the same URL: a key-billed
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
    // picked id is written to the bare aliases as well as ANTHROPIC_MODEL,
    // same as the local preset.
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
 *  inside a project whose default is a local model. Sets every allowlisted key
 *  to `""`, which `applyProviderEnv` reads as "unset". */
export function cloudOverrideEnv(): AgentEnv {
  const env: AgentEnv = {};
  for (const k of AGENT_ENV_KEYS) env[k] = "";
  return env;
}

// ---- describing an override, for the badge, the usage ledger and the form ----

export type ProviderKind = "cloud" | "local" | "custom" | "gateway";

/**
 * What a turn against this endpoint is worth, a different question from where
 * the endpoint is:
 *
 * - `vendor`: the driver's own figure is the answer. Claude Code and Codex
 *   price the model they actually ran against the catalog they actually bill.
 * - `free`: the endpoint charges nothing. A model served by Ollama or LM
 *   Studio on this machine or this network costs electricity, not dollars, so
 *   a recorded 0 is a measurement, not a placeholder.
 * - `unknown`: nobody has told us what this endpoint charges. A custom base
 *   URL is free text plus an optional token, as likely to be OpenRouter,
 *   Together, Fireworks or a Bedrock proxy as anything free. The driver's
 *   figure prices a model id it was merely told, against the vendor's own
 *   catalog, so it is not a measurement of this endpoint: recording it
 *   over-reports and recording 0 under-reports. The ledger records neither;
 *   `task_usage.cost_usd` is NULL here and left out of every total instead of
 *   folded in as a fake zero.
 * - `gateway`: the endpoint states its own prices (`GET /model/info`), so the
 *   figure is computable, but Calandria has to compute it, since no CLI
 *   exposes the `x-litellm-response-cost` header LiteLLM answers with.
 *   `lib/gatewayPricing.ts` keeps the rate table the catalog probe last
 *   reported and prices the turn's own token counts against it; a model the
 *   last probe never saw still records NULL and counts as unpriced, the same
 *   as `custom`.
 */
export type ProviderPricing = "vendor" | "free" | "unknown" | "gateway";

/** Every kind maps explicitly. A cascading ternary would hand a kind added
 *  later whatever the last arm happened to be, which for the first three was
 *  "unpriced" and could as easily have been "bill it as the vendor's". */
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
 * measured zero, the gateway's own computed estimate, or NULL for "nobody has
 * stated a price". The runner asks here from both of its ledger writes so they
 * agree, and so a fifth pricing value has one place to be decided.
 *
 * `gatewayEstimate` is the runner's own call into `lib/gatewayPricing.ts`'s
 * `estimateCostUsd()`, passed in here, not computed: it needs the
 * turn's resolved model id and token counts, which keeps this module free of
 * the usage-shape import that would otherwise pull in. Only read when
 * `pricing` is `"gateway"`.
 */
export function recordedCostUsd(
  pricing: ProviderPricing,
  vendorFigure: number | null | undefined,
  gatewayEstimate?: number | null,
): number | null {
  switch (pricing) {
    case "vendor":
      return vendorFigure ?? null;
    case "free":
      return 0;
    case "gateway":
      return gatewayEstimate ?? null;
    case "unknown":
      return null;
  }
}

export interface AgentProvider {
  /** cloud = the agent's own login, nothing overridden. local = an endpoint on
   *  this machine, the Docker host or a private network. gateway = the
   *  instance's own LiteLLM gateway, whatever address that is. custom = any
   *  other base URL. None of the three non-cloud kinds counts as "the vendor's
   *  spend" for billing, but they are not the same fact; see `pricing`. */
  kind: ProviderKind;
  /** How the ledger should treat this turn's dollar figure. Derived from
   *  `kind` so the badge, the ledger and the settings form can never disagree
   *  about which endpoints are free and which are merely unpriced. */
  pricing: ProviderPricing;
  /** The endpoint's host[:port], "" for cloud. What `task_usage.provider`
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
   *  name the gateway address reads as `key`. */
  gateway_billing: GatewayBilling | null;
}

const LOCAL_HOST = /^(localhost|127\.(\d+\.){2}\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal|host\.containers\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

/** Whether a base URL's host is on this machine or on a private network. */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && LOCAL_HOST.test(host.replace(/:\d+$/, ""));
}

// Narrower than LOCAL_HOST above: strictly loopback, matching the Gemini CLI's
// own source rule (docs/AGENTS.md, "Antigravity CLI"), not Calandria's
// broader "on this machine or a private network" definition. A gateway on a
// LAN address is `isLocalEndpoint` but not loopback, and `agy` refuses it over
// plain HTTP.
const LOOPBACK_HOST = /^(localhost|127\.(\d+\.){2}\d+|\[?::1\]?)$/i;

/** Whether a base URL's host is strictly loopback. */
export function isLoopbackHost(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && LOOPBACK_HOST.test(host.replace(/:\d+$/, ""));
}

/**
 * Whether a gateway address would fail every Antigravity turn before `agy`
 * even sends one. Gemini CLI source enforces HTTPS for any non-loopback host,
 * and Antigravity's own docs state the same rule (docs/AGENTS.md, "Antigravity
 * CLI"): plain HTTP is fine only on loopback. Used to refuse the combination
 * in the task form, before the turn can fail inside the CLI with an
 * opaque error.
 */
export function gatewayInsecureForGemini(provider: Pick<AgentProvider, "kind" | "gemini_base_url">): boolean {
  if (provider.kind !== "gateway" || !provider.gemini_base_url) return false;
  let protocol: string;
  try {
    protocol = new URL(provider.gemini_base_url).protocol;
  } catch {
    return false;
  }
  return protocol === "http:" && !isLoopbackHost(provider.gemini_base_url);
}

/**
 * What an override (already merged, see `providerEnvFor`) amounts to.
 *
 * `gateway` outranks `local`, since a LiteLLM proxy on this machine is still a
 * gateway: the interesting fact about it is that it meters and prices what it
 * forwards, not where it is listening. The `gateway` argument is passed in
 * as a parameter so tests can describe an override against a stated
 * gateway without touching the process env; the default is the instance's own.
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

/**
 * Whether the agent's own subscription plan window says anything about THIS
 * task's turns, which decides if the plan meter's reset time may be offered as
 * "resume when the window rolls" (`lib/usageReset.ts`).
 *
 * Behind a gateway it usually does not, since the meter would describe a quota
 * the turn never touches:
 *
 * - Billed to the gateway's key, the turn draws on that key's account and no
 *   subscription is consumed at all.
 * - Billed to your own plan, only Claude Code forwards its login for the
 *   gateway to pass upstream. Codex's equivalent (`requires_openai_auth`)
 *   sends no `Authorization` header, so its gateway support bills the key in
 *   both modes, its ChatGPT window stays untouched, and its rate-limit
 *   snapshot behind a gateway is empty besides (docs/AGENTS.md, "Codex").
 *
 * Every other kind is left alone. A local endpoint consumes no plan either,
 * but that is a separate question from this one, and an agent whose driver
 * does not route through the gateway at all keeps its meter, since a gateway
 * project changes nothing about the turns it runs.
 */
export function planWindowApplies(provider: AgentProvider, agent?: string | null): boolean {
  if (provider.kind !== "gateway") return true;
  // Add an agent here only once its driver honours the gateway address; until
  // then a gateway project's tasks on that agent run on its own login and
  // spend its own plan.
  const routed = agent === "claude" || agent === "codex" || agent === "gemini";
  if (!routed) return true;
  return agent === "claude" && provider.gateway_billing === "subscription";
}

/** The provider a task's turns run against: the project's override with the
 *  task's laid over it, then described. */
export function taskProvider(
  project: Pick<Project, "agent_env"> | null | undefined,
  task?: Pick<Task, "agent_env"> | null,
  gateway: string | null = gatewayBaseUrl(),
): AgentProvider {
  return describeProvider(providerEnvFor(project, task), gateway);
}
