// How a provider override (lib/agentEnv.ts) reaches the codex CLI. SDK-free:
// pure data in, pure data out, so it can be pinned and tested without spawning
// anything.
//
// Claude Code reads its endpoint from the environment, so for it the override
// IS the env and the driver has nothing to add. Codex doesn't: `model_provider`
// comes from ~/.codex/config.toml (a project-scoped config can't override it),
// and the built-in `openai` provider only honours OPENAI_BASE_URL under API-key
// auth — with the ChatGPT login Calandria recommends, requests go to the
// chatgpt.com backend whatever the env says. So the override is mapped onto a
// provider ENTRY of our own, passed through the SDK's `config` option (which it
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
// `ollama` / `lmstudio` ids on purpose: those assume localhost (openai/codex
// #8240), and the whole point of the override is a URL the user chose — a
// Docker instance reaches its host as host.docker.internal.

import type { AgentEnv } from "../../agentEnv";
import { normalizeBaseUrl } from "../../agentEnv";

export const CODEX_LOCAL_PROVIDER_ID = "calandria-local";

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
 */
export function codexProviderConfig(env: Readonly<Record<string, string | undefined>> & AgentEnv): CodexProviderConfig {
  const raw = env.OPENAI_BASE_URL || env.CODEX_OSS_BASE_URL || "";
  const model = env.CODEX_MODEL?.trim() || null;
  if (!raw.trim()) return { config: {}, model };
  // The OpenAI surface lives under /v1 on Ollama and LM Studio; the presets
  // already write it that way, and a hand-typed bare host gets it added.
  const base = `${normalizeBaseUrl(raw)}/v1`;
  return {
    config: {
      model_provider: CODEX_LOCAL_PROVIDER_ID,
      model_providers: {
        [CODEX_LOCAL_PROVIDER_ID]: {
          name: "Local model (Calandria)",
          base_url: base,
          wire_api: "responses",
        },
      },
    },
    model,
  };
}
