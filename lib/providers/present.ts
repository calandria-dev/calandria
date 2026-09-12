import { isAgentConnected } from "../agents/connections";
import type { ModelProvider } from "./rows";

export type ProviderStatus = "connected" | "reachable" | "unreachable" | "untested";

export interface PresentedProvider extends ModelProvider {
  status: ProviderStatus;
  model_count: number;
}

function testedModels(provider: ModelProvider): string[] | null {
  const models = provider.last_test?.models;
  if (!Array.isArray(models)) return provider.model_policy.known.length ? provider.model_policy.known : null;
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id ? [id] : [];
  });
}

function enabledModelCount(provider: ModelProvider): number {
  const policy = provider.model_policy;
  const unavailable = new Set(policy.unavailable);
  if (policy.mode === "allow") {
    const tested = testedModels(provider);
    const known = tested === null ? null : new Set(tested);
    return new Set(policy.ids.filter((id) => !unavailable.has(id) && (known === null || known.has(id)))).size;
  }
  const off = new Set(policy.ids);
  return new Set((testedModels(provider) ?? []).filter((id) => !off.has(id) && !unavailable.has(id))).size;
}

export function presentProvider(provider: ModelProvider): PresentedProvider {
  let status: ProviderStatus = "untested";
  if (provider.bundled && isAgentConnected(provider.bundled)) status = "connected";
  else if (provider.last_test?.reachable === true) status = "reachable";
  else if (provider.last_test?.reachable === false) status = "unreachable";
  return { ...provider, status, model_count: enabledModelCount(provider) };
}
