/*
 * Resolves the `provider` and `model` parameters shared by suggest_task,
 * create_runbook and update_runbook (lib/agentTools.ts, lib/runbookTools.ts):
 * an id, an exact label, or the "local"/"cloud" alias, plus a model id
 * checked against that provider's own policy snapshot. DB only, no catalog
 * probe and no SDK, so the agent-tool modules that import it stay pinned
 * SDK-free and a tool call never blocks on a live network probe.
 */

import type { ModelProvider } from "./rows";
import { bundledProviderFor, firstProviderOfType, getProvider, listProviders } from "./store";
import type { ProviderType } from "./types";

const LOCAL_TYPES: readonly ProviderType[] = ["ollama", "lmstudio", "custom"];

export type ProviderRefResult = { provider: ModelProvider } | { error: string };

/**
 * "local" is the first Ollama, LM Studio or custom row, in that order,
 * regardless of which environments it serves: the alias means "run this
 * somewhere free", not "run this in whichever CLI is asking". "cloud" is the
 * calling environment's own bundled login. Anything else is matched against
 * every provider's id, then its label case-insensitively.
 */
export function resolveProviderRef(ref: string, environment: string): ProviderRefResult {
  const wanted = ref.trim();
  if (wanted === "local") {
    for (const type of LOCAL_TYPES) {
      const row = firstProviderOfType(type);
      if (row) return { provider: row };
    }
    return {
      error:
        `"local" needs a local provider (Ollama, LM Studio, or a custom endpoint) configured first. ` +
        `Add one in Settings → Models, or pass a provider id or label from list_providers.`,
    };
  }
  if (wanted === "cloud") {
    const row = bundledProviderFor(environment);
    if (!row) {
      return {
        error:
          `"cloud" needs ${environment} signed in first. Sign in from Settings → Models, or pass a ` +
          `provider id or label from list_providers.`,
      };
    }
    return { provider: row };
  }
  const byId = getProvider(wanted);
  if (byId) return { provider: byId };

  const lower = wanted.toLowerCase();
  const byLabel = listProviders().filter((p) => p.label.trim().toLowerCase() === lower);
  if (byLabel.length === 1) return { provider: byLabel[0] };
  if (byLabel.length > 1) {
    return {
      error:
        `"${wanted}" is ambiguous: ${byLabel.length} providers share that label. Pass one of these ids ` +
        `instead: ${byLabel.map((p) => p.id).join(", ")}.`,
    };
  }
  const known = listProviders().slice(0, 5).map((p) => `${p.id} (${p.label})`);
  return {
    error:
      `No provider matches "${wanted}". Call list_providers for the ids and labels, or pass "local" or ` +
      `"cloud"${known.length ? `. First known: ${known.join(", ")}` : ""}.`,
  };
}

export type ModelRefResult = { ok: true } | { error: string };

/**
 * Checked against the provider's own policy snapshot (`model_policy.known`,
 * the catalog as of its last read/test), never a live probe: a tool call
 * must not block on network, and Settings → Models is what keeps the
 * snapshot current. A provider never tested yet (`known` empty) has nothing
 * to check against, so anything passes; the turn itself is what tells the
 * agent if the id was wrong. A bundled provider (the CLI's own login) has no
 * policy to check at all.
 */
export function checkProviderModel(provider: ModelProvider, model: string): ModelRefResult {
  if (provider.bundled) return { ok: true };
  const policy = provider.model_policy;
  if (!policy.known.length) return { ok: true };
  const known = new Set(policy.known);
  if (!known.has(model)) {
    const validIds = policy.mode === "allow" ? policy.ids : policy.known.filter((id) => !policy.ids.includes(id));
    return {
      error:
        `"${model}" isn't a model ${provider.label} lists` +
        (validIds.length ? `. First known ids: ${validIds.slice(0, 5).join(", ")}` : "") +
        `. Check Settings → Models, or call list_providers.`,
    };
  }
  const off = policy.mode === "allow" ? !policy.ids.includes(model) : policy.ids.includes(model);
  if (off) {
    return {
      error: `"${model}" is off under ${provider.label}'s policy. Turn it on in Settings → Models, or pick one that's on.`,
    };
  }
  return { ok: true };
}
