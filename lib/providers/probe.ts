import { isAgentConnected } from "../agents/connections";
import { MODEL_PROBE_MS } from "../config";
import { probeGateway } from "../gatewayHealth";
import { gatewayModelCatalog } from "../gatewayModels";
import { endpointModels } from "../modelEndpoint";
import { getProviderSecret } from "../providerSecrets";
import type { ModelProvider, ProviderTestResult } from "./rows";
import type { ProviderConfig, ProviderType, SecretField } from "./types";
import { providerTypeEntry } from "./types";

export interface ProviderProbeModel {
  id: string;
  context_window: number | null;
  family: string | null;
  version: string | null;
  duplicate_of: string | null;
  chat: boolean;
}

export interface ProviderProbeResult extends ProviderTestResult {
  reachable: boolean;
  api: string | null;
  version: string | null;
  latency_ms: number;
  error: string | null;
  key: { spend: number | null; max_budget: number | null };
  models: ProviderProbeModel[];
}

interface ProbeInput {
  type: ProviderType;
  config: ProviderConfig;
  secrets?: Partial<Record<SecretField, string>>;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /timed? ?out|abort/i.test(message) ? "timed out" : message.replace(/^TypeError: /, "");
}

function model(
  id: string,
  contextWindow: number | null = null,
  chat = true,
): ProviderProbeModel {
  return {
    id,
    context_window: contextWindow,
    // lib/providers/families.ts lands in the catalog step. Keep the response
    // shape stable until placeModel() is available there.
    family: null,
    version: null,
    duplicate_of: null,
    chat,
  };
}

function blank(startedAt: number, fields: Partial<ProviderProbeResult>): ProviderProbeResult {
  return {
    reachable: false,
    api: null,
    version: null,
    latency_ms: Date.now() - startedAt,
    error: null,
    key: { spend: null, max_budget: null },
    models: [],
    ...fields,
  };
}

async function vendorModels(
  type: "openai_key" | "gemini_key",
  key: string,
  startedAt: number,
): Promise<ProviderProbeResult> {
  const openai = type === "openai_key";
  const url = openai
    ? "https://api.openai.com/v1/models"
    : "https://generativelanguage.googleapis.com/v1beta/models";
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(MODEL_PROBE_MS),
      headers: {
        accept: "application/json",
        ...(openai ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key }),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return blank(startedAt, {
        api: openai ? "openai" : "gemini",
        error: `${response.status} ${response.statusText || "error"}`,
      });
    }
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; context_window?: unknown }>;
      models?: Array<{
        name?: unknown;
        inputTokenLimit?: unknown;
        supportedGenerationMethods?: unknown;
      }>;
    };
    const models = openai
      ? (Array.isArray(body.data) ? body.data : []).flatMap((entry) => {
          const id = typeof entry.id === "string" ? entry.id.trim() : "";
          return id
            ? [model(id, typeof entry.context_window === "number" ? entry.context_window : null)]
            : [];
        })
      : (Array.isArray(body.models) ? body.models : []).flatMap((entry) => {
          const raw = typeof entry.name === "string" ? entry.name.trim() : "";
          const id = raw.replace(/^models\//, "");
          if (!id) return [];
          const methods = Array.isArray(entry.supportedGenerationMethods)
            ? entry.supportedGenerationMethods.filter((v): v is string => typeof v === "string")
            : [];
          return [
            model(
              id,
              typeof entry.inputTokenLimit === "number" ? entry.inputTokenLimit : null,
              methods.length === 0 || methods.includes("generateContent"),
            ),
          ];
        });
    return blank(startedAt, {
      reachable: true,
      api: openai ? "openai" : "gemini",
      models,
    });
  } catch (error) {
    return blank(startedAt, {
      api: openai ? "openai" : "gemini",
      error: messageOf(error),
    });
  }
}

/** Probe a provider without persisting anything. Every network call is bounded
 * by CALANDRIA_MODEL_PROBE_MS through the existing probe helpers or directly. */
export async function probeProvider(input: ProbeInput): Promise<ProviderProbeResult> {
  const startedAt = Date.now();
  const entry = providerTypeEntry(input.type);

  if (entry.bundled) {
    const reachable = isAgentConnected(entry.bundled);
    return blank(startedAt, {
      reachable,
      api: input.type,
      error: reachable ? null : `${entry.bundled} is not connected`,
    });
  }

  const key = input.secrets?.key ?? "";
  if (input.type === "litellm") {
    const [health, catalog] = await Promise.all([
      probeGateway(input.config.base_url, key, MODEL_PROBE_MS),
      gatewayModelCatalog(input.config.base_url, key, MODEL_PROBE_MS),
    ]);
    return blank(startedAt, {
      reachable: health.reachable,
      api: "litellm",
      version: health.version,
      error: health.error ?? catalog.error,
      key: { spend: health.spend, max_budget: health.max_budget },
      models: catalog.models.map((entry) =>
        model(entry.model_name, entry.max_input_tokens || null, entry.mode == null || entry.mode === "chat"),
      ),
    });
  }

  if (input.type === "ollama" || input.type === "lmstudio" || input.type === "custom") {
    const result = await endpointModels(input.config.base_url);
    return blank(startedAt, {
      reachable: result.reachable,
      api: result.api ?? input.config.api ?? null,
      error: result.error,
      models: result.models.map((id) => model(id)),
    });
  }

  if (input.type === "openai_key" || input.type === "gemini_key") {
    return vendorModels(input.type, key, startedAt);
  }
  return blank(startedAt, { error: `unsupported provider type ${input.type}` });
}

/** Probe a stored row with its credentials kept server-side. */
export async function probeSavedProvider(provider: ModelProvider): Promise<ProviderProbeResult> {
  const secretFields = providerTypeEntry(provider.type).secretFields;
  const secrets: Partial<Record<SecretField, string>> = {};
  for (const field of secretFields) secrets[field] = getProviderSecret(provider.id, field);
  return probeProvider({ type: provider.type, config: provider.config, secrets });
}
