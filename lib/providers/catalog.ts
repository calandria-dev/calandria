import type { AgentModelOption } from "../agents/types";
import { claudeCapabilities } from "../agents/claude/capabilities";
import { clearCodexCatalogCache, codexLocalCatalog } from "../agents/codex/catalog";
import { codexCapabilities } from "../agents/codex/capabilities";
import { GEMINI_CAPABILITIES } from "../agents/gemini/capabilities";
import { MODEL_PROBE_MS } from "../config";
import {
  clearGatewayModelCache,
  gatewayModelCatalog,
  gatewayModelOptions,
  type GatewayFitAgent,
} from "../gatewayModels";
import { clearEndpointProbeCache, endpointModels } from "../modelEndpoint";
import { getProviderSecret } from "../providerSecrets";
import type { ModelProvider } from "./rows";
import { modelFamilies, placeModel, type ModelPlacement } from "./families";
import { pinnedModelsForProvider, providersForEnvironment, updateProvider } from "./store";
import type { EnvironmentId, ModelPolicy, ProviderType } from "./types";

export interface ProviderCatalogModel {
  id: string;
  label: string;
  sub: string;
  ctx: number;
  /** A source may know the modality even when the id does not say it. */
  chat?: boolean;
}

export type PlacedCatalogModel = Omit<ProviderCatalogModel, "chat"> & ModelPlacement;

export interface AppliedModelPolicy {
  on: PlacedCatalogModel[];
  off: PlacedCatalogModel[];
  unavailable: PlacedCatalogModel[];
  duplicates: PlacedCatalogModel[];
  nextPolicy: ModelPolicy;
}

export interface ProviderModelsRead extends AppliedModelPolicy {
  refreshed_at: number;
}

export interface FlatProviderModel {
  id: string;
  ctx: number;
  family: string;
  version: string;
  on: boolean;
  duplicate_of: string | null;
  chat: boolean;
}

export interface ModelTreeSource {
  provider_id: string;
  model: string;
  price: "plan" | "metered" | "free" | "";
  unavailable: boolean;
}

export interface ModelTreeVersion {
  id: string;
  label: string;
  ctx: number;
  sub: string;
  sources: ModelTreeSource[];
}

export interface ModelTreeFamily {
  id: string;
  label: string;
  vendor: string;
  versions: ModelTreeVersion[];
}

export interface ModelsTree {
  families: ModelTreeFamily[];
}

const VENDOR_CACHE_MS = 10_000;
const catalogState = globalThis as {
  __calandriaVendorModels?: Map<string, { at: number; value: ProviderCatalogModel[] }>;
};
const vendorCache = (catalogState.__calandriaVendorModels ??= new Map());

export function clearVendorModelCache(providerId?: string): void {
  if (providerId) vendorCache.delete(providerId);
  else vendorCache.clear();
}

function unique<T extends { id: string }>(models: readonly T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function fromCapabilities(models: AgentModelOption[]): ProviderCatalogModel[] {
  return models.map((model) => ({
    id: model.value,
    label: model.label,
    sub: model.sub,
    ctx: model.contextWindow,
  }));
}

function fitAgent(agent: EnvironmentId): GatewayFitAgent {
  return agent;
}

async function gatewayCatalog(provider: ModelProvider, agent: EnvironmentId): Promise<ProviderCatalogModel[]> {
  const catalog = await gatewayModelCatalog(provider.config.base_url, getProviderSecret(provider.id, "key"));
  const raw = new Map(catalog.models.map((model) => [model.model_name, model]));
  const out: ProviderCatalogModel[] = gatewayModelOptions(catalog.models, fitAgent(agent)).map((model) => ({
    id: model.value,
    label: model.label,
    sub: model.sub,
    ctx: model.contextWindow,
    chat: true,
  }));

  // The environment filter intentionally drops non-chat entries. The provider
  // modal still needs those rows so it can count and hide them explicitly.
  for (const model of catalog.models) {
    if (model.mode === "chat" || out.some((entry) => entry.id === model.model_name)) continue;
    out.push({
      id: model.model_name,
      label: model.model_name,
      sub: model.litellm_provider,
      ctx: model.max_input_tokens,
      chat: false,
    });
  }

  // Preserve source order when options synthesized a [1m] row next to its
  // catalog entry. The map read also proves a returned base id came from this
  // response and guards a future option transform from inventing a bare row.
  return unique(out.filter((model) => raw.has(model.id) || /\[1m\]$/i.test(model.id)));
}

async function readJson(url: string, headers: HeadersInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(MODEL_PROBE_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function openAiKeyCatalog(providerId: string, key: string): Promise<ProviderCatalogModel[]> {
  if (!key) return [];
  const hit = vendorCache.get(providerId);
  if (hit && Date.now() - hit.at < VENDOR_CACHE_MS) return hit.value;
  const body = (await readJson("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` })) as
    | { data?: unknown[] }
    | null;
  const ids = Array.isArray(body?.data)
    ? body.data.flatMap((entry) => {
        const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : null;
        return typeof id === "string" && id.trim() ? [id.trim()] : [];
      })
    : [];
  const value = unique(ids.map((id) => ({ id, label: id, sub: "", ctx: 0 })));
  vendorCache.set(providerId, { at: Date.now(), value });
  return value;
}

async function geminiKeyCatalog(providerId: string, key: string): Promise<ProviderCatalogModel[]> {
  if (!key) return [];
  const hit = vendorCache.get(providerId);
  if (hit && Date.now() - hit.at < VENDOR_CACHE_MS) return hit.value;
  const out: ProviderCatalogModel[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = (await readJson(url.toString(), { "x-goog-api-key": key })) as
      | { models?: unknown[]; nextPageToken?: unknown }
      | null;
    if (!body) break;
    for (const entry of Array.isArray(body.models) ? body.models : []) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const raw = typeof row.name === "string" ? row.name.replace(/^models\//, "").trim() : "";
      if (!raw) continue;
      const methods = Array.isArray(row.supportedGenerationMethods) ? row.supportedGenerationMethods : [];
      out.push({
        id: raw,
        label: typeof row.displayName === "string" && row.displayName ? row.displayName : raw,
        sub: "",
        ctx: typeof row.inputTokenLimit === "number" ? row.inputTokenLimit : 0,
        chat: methods.length === 0 || methods.includes("generateContent"),
      });
    }
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
  } while (pageToken);
  const value = unique(out);
  vendorCache.set(providerId, { at: Date.now(), value });
  return value;
}

/** Read one provider's source using the cache owned by that source. */
export async function providerCatalog(
  provider: ModelProvider,
  agent: EnvironmentId,
): Promise<ProviderCatalogModel[]> {
  switch (provider.type) {
    case "anthropic":
      return fromCapabilities(claudeCapabilities().models);
    case "openai": {
      const local = codexLocalCatalog().entries;
      return local.length
        ? unique(
          local
          .filter((entry) => entry.visibility !== "hide")
          .map((entry) => ({
            id: entry.slug,
            label: entry.slug,
            sub: "",
            ctx: entry.contextWindow ?? 0,
          })),
        )
        : fromCapabilities(codexCapabilities().models);
    }
    case "google":
      return fromCapabilities(GEMINI_CAPABILITIES.models);
    case "litellm":
      return gatewayCatalog(provider, agent);
    case "ollama":
    case "lmstudio":
    case "custom": {
      const catalog = await endpointModels(provider.config.base_url);
      return catalog.models.map((id) => ({ id, label: id, sub: "", ctx: 0 }));
    }
    case "openai_key":
      return openAiKeyCatalog(provider.id, getProviderSecret(provider.id, "key"));
    case "gemini_key":
      return geminiKeyCatalog(provider.id, getProviderSecret(provider.id, "key"));
  }
}

export function placeCatalog(providerType: ProviderType, catalog: readonly ProviderCatalogModel[]): PlacedCatalogModel[] {
  return unique(catalog).map((model) => {
    const placement = placeModel(model.id, providerType);
    return {
      ...model,
      ...placement,
      label: placement.label || model.label,
      sub: model.sub,
      ctx: model.ctx > 0 ? model.ctx : placement.ctx,
      chat: model.chat ?? placement.chat,
    };
  });
}

/**
 * Apply the stored allow/deny policy to a freshly placed catalog. The optional
 * pinned ids are the only absent rows retained. Existing unavailable ids are
 * also retained until a caller proves they are no longer pinned.
 */
export function applyModelPolicy(
  policy: ModelPolicy,
  placed: readonly PlacedCatalogModel[],
  pinnedIds: readonly string[] = [],
  providerType: ProviderType = "custom",
): AppliedModelPolicy {
  const fresh = unique(placed);
  const freshIds = new Set(fresh.map((model) => model.id));
  const pinned = new Set(pinnedIds);
  const initialAllow =
    policy.mode === "allow" && policy.known.length === 0
      ? fresh.filter((model) => model.chat && model.family !== "other" && !model.duplicate_of).map((model) => model.id)
      : policy.ids;
  const missing = [...new Set([...policy.known, ...policy.unavailable])].filter(
    (id) => !freshIds.has(id) && pinned.has(id),
  );
  const retainedIds = initialAllow.filter((id) => freshIds.has(id) || missing.includes(id));
  const enabled = new Set(retainedIds);
  const duplicates = fresh.filter((model) => !!model.duplicate_of);
  const selectable = fresh.filter((model) => !model.duplicate_of);
  const on = selectable.filter((model) =>
    policy.mode === "allow" ? enabled.has(model.id) : !enabled.has(model.id),
  );
  const off = selectable.filter((model) =>
    policy.mode === "allow" ? !enabled.has(model.id) : enabled.has(model.id),
  );
  const unavailable = missing.map((id) => ({ id, sub: "", ...placeModel(id, providerType) }));
  return {
    on,
    off,
    unavailable,
    duplicates,
    nextPolicy: {
      mode: policy.mode,
      ids: retainedIds,
      known: fresh.map((model) => model.id),
      unavailable: missing,
    },
  };
}

function samePolicy(a: ModelPolicy, b: ModelPolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function invalidateProviderCatalog(provider: ModelProvider): void {
  if (provider.type === "litellm") clearGatewayModelCache();
  if (provider.type === "ollama" || provider.type === "lmstudio" || provider.type === "custom") {
    clearEndpointProbeCache();
  }
  if (provider.type === "openai") clearCodexCatalogCache();
  if (provider.type === "openai_key" || provider.type === "gemini_key") clearVendorModelCache(provider.id);
}

/** Read, place and apply one provider, persisting catalog drift. */
export async function readProviderModels(
  provider: ModelProvider,
  agent: EnvironmentId,
  refresh = false,
): Promise<ProviderModelsRead> {
  if (refresh) invalidateProviderCatalog(provider);
  const placed = placeCatalog(provider.type, await providerCatalog(provider, agent));
  const applied = applyModelPolicy(
    provider.model_policy,
    placed,
    pinnedModelsForProvider(provider),
    provider.type,
  );
  if (!samePolicy(provider.model_policy, applied.nextPolicy)) {
    updateProvider(provider.id, { model_policy: applied.nextPolicy });
  }
  return { ...applied, refreshed_at: Date.now() };
}

export function policyForEnabledIds(
  policy: ModelPolicy,
  models: readonly PlacedCatalogModel[],
  ids: readonly string[],
): ModelPolicy {
  const enabled = new Set(ids);
  const chatIds = models.filter((model) => model.chat).map((model) => model.id);
  const unavailableState = policy.ids.filter((id) => policy.unavailable.includes(id));
  const currentState =
    policy.mode === "allow" ? chatIds.filter((id) => enabled.has(id)) : chatIds.filter((id) => !enabled.has(id));
  return {
    ...policy,
    ids: [...new Set([...currentState, ...unavailableState])],
  };
}

export function flatProviderModels(read: ProviderModelsRead): {
  mode: ModelPolicy["mode"];
  refreshed_at: number;
  models: FlatProviderModel[];
} {
  const enabled = new Set(read.on.map((model) => model.id));
  return {
    mode: read.nextPolicy.mode,
    refreshed_at: read.refreshed_at,
    models: [...read.on, ...read.off, ...read.duplicates]
      .map((model) => ({
        id: model.id,
        ctx: model.ctx,
        family: model.family,
        version: model.version,
        on: model.duplicate_of
          ? read.nextPolicy.mode === "allow"
            ? read.nextPolicy.ids.includes(model.id)
            : !read.nextPolicy.ids.includes(model.id)
          : enabled.has(model.id),
        duplicate_of: model.duplicate_of,
        chat: model.chat,
      }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
  };
}

function priceFor(provider: ModelProvider): ModelTreeSource["price"] {
  if (provider.bundled) return "plan";
  if (provider.type === "litellm") return "metered";
  if (provider.type === "ollama" || provider.type === "lmstudio") return "free";
  return "";
}

function versionOrder(a: ModelTreeVersion, b: ModelTreeVersion): number {
  const latest = (id: string) => (id === "latest" ? 2 : id.startsWith("latest-") ? 1 : 0);
  const latestOrder = latest(b.id) - latest(a.id);
  if (latestOrder) return latestOrder;
  const numbers = (id: string) =>
    [...id.replace(/-1m$/i, "").matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const av = numbers(a.id);
  const bv = numbers(b.id);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const difference = (bv[i] ?? -1) - (av[i] ?? -1);
    if (difference) return difference;
  }
  // Stable sort preserves the catalog's priority among variants of one
  // release, such as GPT 5.6 Sol/Terra/Luna and Gemini High/Medium/Low.
  return 0;
}

/** Build the picker tree from every provider that serves one environment. */
export async function modelsTreeForEnvironment(agent: EnvironmentId): Promise<ModelsTree> {
  const providers = providersForEnvironment(agent);
  const reads = await Promise.all(providers.map((provider) => readProviderModels(provider, agent)));
  const familyMap = new Map<string, ModelTreeFamily>();
  const familyMeta = new Map(modelFamilies.map((family) => [family.id, family]));
  familyMeta.set("other", { id: "other", label: "Other", vendor: "open" });

  for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
    const provider = providers[providerIndex];
    const read = reads[providerIndex];
    for (const [model, unavailable] of [
      ...read.on.filter((row) => row.chat).map((row) => [row, false] as const),
      ...read.unavailable.filter((row) => row.chat && !row.duplicate_of).map((row) => [row, true] as const),
    ]) {
      const meta = familyMeta.get(model.family) ?? familyMeta.get("other")!;
      let family = familyMap.get(meta.id);
      if (!family) {
        family = { id: meta.id, label: meta.label, vendor: meta.vendor, versions: [] };
        familyMap.set(meta.id, family);
      }
      let version = family.versions.find((row) => row.id === model.version);
      if (!version) {
        version = { id: model.version, label: model.label, ctx: model.ctx, sub: model.sub, sources: [] };
        family.versions.push(version);
      } else {
        version.ctx = Math.max(version.ctx, model.ctx);
        if (!version.sub && model.sub) version.sub = model.sub;
      }
      const key = `${provider.id}\0${model.id}`;
      if (!version.sources.some((source) => `${source.provider_id}\0${source.model}` === key)) {
        version.sources.push({
          provider_id: provider.id,
          model: model.id,
          price: priceFor(provider),
          unavailable,
        });
      }
    }
  }

  const familyOrder = new Map(modelFamilies.map((family, index) => [family.id, index]));
  const families = [...familyMap.values()];
  for (const family of families) {
    family.versions.sort(versionOrder);
    family.versions.forEach((version) =>
      version.sources.sort((a, b) => {
        const pa = providers.find((provider) => provider.id === a.provider_id);
        const pb = providers.find((provider) => provider.id === b.provider_id);
        return Number(!pa?.bundled) - Number(!pb?.bundled);
      }),
    );
  }
  families.sort((a, b) => {
    if (a.id === "other") return 1;
    if (b.id === "other") return -1;
    return (familyOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (familyOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
  return { families };
}
