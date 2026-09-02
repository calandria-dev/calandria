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
] as const;

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
  project: Pick<Project, "port" | "agent_env"> | null | undefined,
  task?: Pick<Task, "agent_env"> | null,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  delete out.NODE_ENV;
  applyProviderEnv(out, providerEnvFor(project, task));
  if (project?.port) out.PORT = String(project.port);
  else delete out.PORT;
  return out;
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

/** A task-level override that puts a task back on the agent's own cloud login
 *  inside a project whose default is a local model: every allowlisted key set
 *  to `""`, which `applyProviderEnv` reads as "unset". */
export function cloudOverrideEnv(): AgentEnv {
  const env: AgentEnv = {};
  for (const k of AGENT_ENV_KEYS) env[k] = "";
  return env;
}

// ---- describing an override, for the badge, the usage ledger and the form ----

export type ProviderKind = "cloud" | "local" | "custom";

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
 */
export type ProviderPricing = "vendor" | "free" | "unknown";

export function providerPricing(kind: ProviderKind): ProviderPricing {
  return kind === "cloud" ? "vendor" : kind === "local" ? "free" : "unknown";
}

export interface AgentProvider {
  /** cloud = the agent's own login, nothing overridden. local = an endpoint on
   *  this machine / the Docker host / a private network. custom = any other
   *  base URL. Both non-cloud kinds are "not the vendor's spend" for billing,
   *  but they are not the same fact — see `pricing`. */
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
  /** The model the override pins (ANTHROPIC_MODEL / CODEX_MODEL), if any. */
  model: string | null;
  auth_token: string | null;
}

const LOCAL_HOST = /^(localhost|127\.(\d+\.){2}\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal|host\.containers\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

/** Whether a base URL's host is on this machine or a private network. */
export function isLocalEndpoint(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && LOCAL_HOST.test(host.replace(/:\d+$/, ""));
}

/** What an override (already merged, see `providerEnvFor`) amounts to. */
export function describeProvider(env: AgentEnv): AgentProvider {
  const anthropic = env.ANTHROPIC_BASE_URL || null;
  const openai = env.OPENAI_BASE_URL || null;
  const first = anthropic ?? openai;
  const model = env.ANTHROPIC_MODEL || env.CODEX_MODEL || null;
  const auth_token = env.ANTHROPIC_AUTH_TOKEN || null;
  if (!first) return { kind: "cloud", pricing: "vendor", host: "", anthropic_base_url: null, openai_base_url: null, model, auth_token };
  const kind: ProviderKind = isLocalEndpoint(first) ? "local" : "custom";
  return {
    kind,
    pricing: providerPricing(kind),
    host: hostOf(first) ?? first,
    anthropic_base_url: anthropic,
    openai_base_url: openai,
    model,
    auth_token,
  };
}

/** The provider a task's turns run against: the project's override with the
 *  task's laid over it, described. */
export function taskProvider(
  project: Pick<Project, "agent_env"> | null | undefined,
  task?: Pick<Task, "agent_env"> | null,
): AgentProvider {
  return describeProvider(providerEnvFor(project, task));
}
