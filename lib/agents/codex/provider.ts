// How a provider override (lib/agentEnv.ts) reaches the codex CLI. SDK-free:
// pure data in, pure data out, so it can be pinned and tested without spawning
// anything.
//
// Claude Code reads its endpoint from the environment, so for it the override
// is the env and the driver has nothing to add. Codex doesn't: `model_provider`
// comes from ~/.codex/config.toml (a project-scoped config can't override it),
// and the built-in `openai` provider only honours OPENAI_BASE_URL under API-key
// auth; with the ChatGPT login Calandria recommends, requests go to the
// chatgpt.com backend whatever the env says. So the override is mapped onto a
// provider entry of its own, passed through the SDK's `config` option (which it
// flattens to `--config key=value` overrides, the one channel that outranks the
// user's config.toml), and selected by name:
//
//   model_provider = "calandria-local"
//   model_providers.calandria-local = { name, base_url, wire_api = "responses" }
//
// `wire_api = "responses"` because it is the only wire API the CLI still
// speaks: Chat Completions support was removed upstream, and Ollama (0.13+)
// and LM Studio both serve `/v1/responses`. No `env_key`, so the CLI doesn't
// demand an API key for a local server, and `requires_openai_auth` stays at
// its default of false, so the ChatGPT login is left alone.
//
// The entry is named for Calandria rather than reusing the CLI's built-in
// `ollama` / `lmstudio` ids: those assume localhost (openai/codex #8240), and
// the override exists to carry a URL the user chose; a Docker instance reaches
// its host as host.docker.internal.
//
// A LiteLLM gateway is the same mapping with three additions, so it gets an
// entry of its own rather than a conditional inside the local one: the id is
// what `codex doctor` reports back, and a shared id would let a gateway turn
// pass a verdict earned by a local endpoint (docs/AGENTS.md, "Codex driver"):
//
//   model_provider = "calandria-gateway"
//   model_providers.calandria-gateway = {
//     name, base_url, env_key = "CALANDRIA_GATEWAY_KEY", wire_api = "responses",
//     http_headers = { "x-litellm-tags" = "calandria,project:…,task:…,agent:codex" }
//   }
//
// `env_key` names the variable, not the value: the documented Codex footgun,
// and the reason `agentTurnEnv()` puts the instance's gateway key in the turn's
// environment under that name. The tags are the same list Claude Code sends as
// `x-litellm-tags`, composed once in `applyGatewayEnv` and read back off the
// merged env here, so LiteLLM's spend views break down a Codex task exactly as
// they do a Claude one.

import type { AgentEnv } from "../../agentEnv";
import { normalizeBaseUrl, isGatewayEndpoint, gatewayBaseUrl } from "../../agentEnv";

export const CODEX_LOCAL_PROVIDER_ID = "calandria-local";
export const CODEX_GATEWAY_PROVIDER_ID = "calandria-gateway";

/** The variable `env_key` names on the gateway entry, set by `agentTurnEnv()`. */
export const CODEX_GATEWAY_KEY_VAR = "CALANDRIA_GATEWAY_KEY";

// The SDK's CodexConfigValue, restated so this module stays free of the SDK
// (tests/importGraph.test.ts pins it): what `--config` can carry.
export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | { [key: string]: CodexConfigValue };

export interface CodexProviderConfig {
  /** Config overrides to spread into the SDK's `config`; `{}` for the cloud. */
  config: Record<string, CodexConfigValue>;
  /** The override's model for when the task and Settings pick none; null otherwise. */
  model: string | null;
}

/**
 * The override's Codex half. Reads the MERGED turn env (the output of
 * `agentTurnEnv`, not the raw override), so a task-level `""` that unset the
 * project's OPENAI_BASE_URL is seen as "cloud" here too. OPENAI_BASE_URL is
 * the endpoint the settings form and the presets write; CODEX_OSS_BASE_URL is
 * honoured as a fallback for a user who set it by hand for the CLI's `--oss`.
 *
 * The kind is decided from the URL Codex will actually call rather than from
 * `describeProvider`'s first-non-null base URL: those agree for every override
 * the presets write, and this way the entry can never claim a gateway the
 * requests don't go to.
 */
export function codexProviderConfig(
  env: Readonly<Record<string, string | undefined>> & AgentEnv,
  gateway: string | null = gatewayBaseUrl(),
): CodexProviderConfig {
  const raw = env.OPENAI_BASE_URL || env.CODEX_OSS_BASE_URL || "";
  const model = env.CODEX_MODEL?.trim() || null;
  if (!raw.trim()) return { config: {}, model };
  // The OpenAI surface lives under /v1 on Ollama and LM Studio; the presets
  // already write it that way, and a hand-typed bare host gets it added. It is
  // also where LiteLLM serves `/v1/responses`.
  const base = `${normalizeBaseUrl(raw)}/v1`;
  const id = isGatewayEndpoint(raw, gateway) ? CODEX_GATEWAY_PROVIDER_ID : CODEX_LOCAL_PROVIDER_ID;
  const entry: Record<string, CodexConfigValue> =
    id === CODEX_GATEWAY_PROVIDER_ID
      ? {
          name: "Calandria gateway",
          base_url: base,
          env_key: CODEX_GATEWAY_KEY_VAR,
          wire_api: "responses",
          // Falls back to the bare marker when the caller built the env by hand:
          // a turn always arrives with the composed list, and an untagged
          // gateway request is still better attributed than an unmarked one.
          http_headers: { "x-litellm-tags": env.CALANDRIA_GATEWAY_TAGS?.trim() || "calandria" },
        }
      : {
          name: "Local model (Calandria)",
          base_url: base,
          wire_api: "responses",
        };
  return {
    config: {
      model_provider: id,
      model_providers: { [id]: entry },
    },
    model,
  };
}
