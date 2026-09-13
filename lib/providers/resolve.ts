/*
 * Server-side provider resolution for a turn.
 *
 * Client components import lib/agentEnv.ts, so database and provider-secret
 * access stays in this server-only module. Callers must keep the returned
 * `extras` in the spawned turn's environment and must never serialize them
 * into a row or API response.
 */

import type { AgentEnv } from "../agentEnv";
import { agentTurnEnv, describeProvider, gatewayPresetEnv, providerPresetEnv, type AgentProvider } from "../agentEnv";
import { bundledProviderFor, getProvider, firstProviderOfType, listProviders } from "./store";
import type { ModelProvider } from "./rows";
import type { EnvironmentId } from "./types";
import { getProviderSecret } from "../providerSecrets";
import type { Project, Task } from "../types";

const OPENAI_BASE_URL = "https://api.openai.com";

export interface ProviderResolutionInput {
  project: Partial<Pick<Project, "default_provider_id">> | null | undefined;
  task?: Partial<Pick<Task, "provider_id">> | null;
  environment: string;
}

export interface ResolvedProviderEnv {
  provider: ModelProvider | null;
  /** The allowlisted provider override consumed by applyProviderEnv(). */
  env: AgentEnv;
  /** Secrets and vendor-specific variables that do not belong in AgentEnv. */
  extras: Record<string, string>;
}

/** Resolve task -> project -> the environment's bundled provider. */
export function resolveProvider(input: ProviderResolutionInput): ModelProvider | null {
  const taskId = input.task?.provider_id ?? null;
  if (taskId) {
    const provider = getProvider(taskId);
    if (provider) return provider;
  }
  const projectId = input.project?.default_provider_id ?? null;
  if (projectId) {
    const provider = getProvider(projectId);
    if (provider) return provider;
  }
  return bundledProviderFor(input.environment);
}

/** Build the turn's provider environment. Secrets only appear in `extras`. */
export function resolveProviderEnv(input: ProviderResolutionInput): ResolvedProviderEnv {
  const provider = resolveProvider(input);
  if (!provider) return { provider: null, env: {}, extras: {} };

  const model = provider.config.default_model;
  switch (provider.type) {
    case "litellm":
      return {
        provider,
        env: gatewayPresetEnv({
          baseUrl: provider.config.base_url ?? "",
          billing: provider.config.billing ?? "key",
          model,
        }),
        extras: { CALANDRIA_LITELLM_KEY: getProviderSecret(provider.id, "key") },
      };
    case "ollama":
    case "lmstudio":
    case "custom":
      return {
        provider,
        env: providerPresetEnv({
          baseUrl: provider.config.base_url ?? "",
          model,
          token: getProviderSecret(provider.id, "key"),
        }),
        extras: {},
      };
    case "openai_key":
      return {
        provider,
        env: {
          OPENAI_BASE_URL: `${OPENAI_BASE_URL}/v1`,
          ...(model ? { CODEX_MODEL: model } : {}),
        },
        extras: { OPENAI_API_KEY: getProviderSecret(provider.id, "key") },
      };
    case "gemini_key":
      return {
        provider,
        env: model ? { GEMINI_MODEL: model } : {},
        extras: { GEMINI_API_KEY: getProviderSecret(provider.id, "key") },
      };
    case "anthropic":
    case "openai":
    case "google":
      return { provider, env: {}, extras: {} };
  }
}

/** Build a turn environment after resolving its provider row. */
export function resolvedAgentTurnEnv(
  project: (Pick<Project, "port" | "id" | "default_provider_id">) | null | undefined,
  task: (Pick<Task, "id" | "agent" | "provider_id" | "gateway_key">) | null | undefined,
  environment: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const resolved = resolveProviderEnv({ project, task, environment });
  const gateway = resolved.provider?.type === "litellm" ? resolved.provider.config.base_url ?? null : null;
  return agentTurnEnv(project, task ?? { agent: environment }, base, gateway, resolved);
}

/** Describe the row-selected provider with the legacy badge and pricing shape. */
export function resolvedTaskProvider(
  project: Pick<Project, "default_provider_id"> | null | undefined,
  task: Pick<Task, "provider_id"> | null | undefined,
  environment: string,
): AgentProvider {
  const resolved = resolveProviderEnv({ project, task, environment });
  const gateway = resolved.provider?.type === "litellm" ? resolved.provider.config.base_url ?? null : null;
  const described = describeProvider(resolved.env, gateway);
  if (resolved.provider?.type === "openai_key") {
    return { ...described, kind: "cloud", pricing: "vendor", auth_token: null };
  }
  return { ...described, auth_token: null };
}

/** The provider row's model fallback, below task and environment settings. */
export function resolvedProviderDefaultModel(
  project: Pick<Project, "default_provider_id"> | null | undefined,
  task: Pick<Task, "provider_id"> | null | undefined,
  environment: string,
): string | null {
  return resolveProvider({ project, task, environment })?.config.default_model?.trim() || null;
}

/** The selected provider when it is a gateway, otherwise the oldest gateway. */
export function litellmProviderFor(
  project?: Partial<Pick<Project, "default_provider_id">> | null,
  task?: Partial<Pick<Task, "provider_id">> | null,
  environment: EnvironmentId = "claude",
): ModelProvider | null {
  const selected = resolveProvider({ project, task, environment });
  return selected?.type === "litellm" ? selected : firstProviderOfType("litellm");
}

export interface LitellmRuntime {
  provider: ModelProvider;
  baseUrl: string;
  key: string;
  adminKey: string;
  mcp: boolean;
  keyTimeoutMs?: number;
}

export interface GatewayResolutionInput {
  project?: Partial<Pick<Project, "default_provider_id">> | null;
  task?: Partial<Pick<Task, "provider_id">> | null;
  environment?: EnvironmentId;
}

/** The selected gateway row's URL, falling back to the oldest LiteLLM row. */
export function gatewayBaseUrl(input: GatewayResolutionInput = {}): string | null {
  return litellmRuntimeFor(input.project, input.task, input.environment)?.baseUrl ?? null;
}

/** The oldest configured local endpoint, for legacy health surfaces. */
export function localProviderBaseUrl(): string | null {
  const provider = listProviders().find((row) =>
    row.type === "ollama" || row.type === "lmstudio" || row.type === "custom",
  );
  return provider?.config.base_url ?? null;
}

/** Resolve a gateway row and its server-only runtime values. */
export function litellmRuntimeFor(
  project?: Partial<Pick<Project, "default_provider_id">> | null,
  task?: Partial<Pick<Task, "provider_id">> | null,
  environment: EnvironmentId = "claude",
): LitellmRuntime | null {
  const provider = litellmProviderFor(project, task, environment);
  if (!provider || provider.type !== "litellm" || !provider.config.base_url) return null;
  return {
    provider,
    baseUrl: provider.config.base_url,
    key: getProviderSecret(provider.id, "key"),
    adminKey: getProviderSecret(provider.id, "admin_key"),
    mcp: provider.config.mcp ?? true,
    keyTimeoutMs: provider.config.key_timeout_ms,
  };
}
