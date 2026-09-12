/**
 * The instance's LiteLLM virtual key, as the rest of the app still asks for
 * it. Thin wrappers over the `key` field of the `litellm` provider row
 * (lib/providerSecrets.ts, lib/providers/store.ts), mirrored into process.env
 * so the value has one home at run time.
 *
 * Not part of `agent_env`, which GET /api/projects serves to the browser;
 * `agentTurnEnv()` (lib/agentEnv.ts) resolves the credential from the
 * environment at turn time instead.
 *
 * `CALANDRIA_LITELLM_KEY` in the environment is the other way in, for an
 * instance that gets its secrets from compose or a systemd unit. It needs no
 * opt-in guard (lib/env-keys.mjs) because the key only reaches the gateway
 * this instance is configured to talk to. The env seed copies it onto the row
 * it creates (lib/providers/seed.ts), and it stays the fallback for an
 * instance with a key but no gateway row to hang it on.
 *
 * lib/db.ts imports loadPersistedGatewayKey from lib/providerSecrets.ts
 * rather than from here: this module reads a provider row, and lib/db.ts must
 * not reach a module that reads one from inside init().
 */

import { firstProviderOfType } from "./providers/store";
import {
  clearLegacyGatewayKey,
  clearProviderSecret,
  getProviderSecret,
  setProviderSecret,
  writeLegacyGatewayKey,
} from "./providerSecrets";

export { loadPersistedGatewayKey } from "./providerSecrets";

/** Whether this instance has a gateway key at all. */
export function hasGatewayKey(): boolean {
  return !!gatewayKey();
}

/** The key itself, or "" if unset: the gateway row's stored key, else the environment. */
export function gatewayKey(): string {
  const row = firstProviderOfType("litellm");
  if (row) {
    const stored = getProviderSecret(row.id, "key");
    if (stored) return stored;
  }
  return (process.env.CALANDRIA_LITELLM_KEY ?? "").trim();
}

/**
 * Persist a key typed into Settings. No format guard: LiteLLM virtual keys
 * are usually `sk-…`, but a master key or a custom-prefixed key can look like
 * anything, and refusing a valid key would be worse than accepting a bad one.
 * Control characters are refused by the secrets store, since the key is
 * interpolated into ANTHROPIC_CUSTOM_HEADERS.
 */
export function setGatewayKey(key: string): void {
  const k = key.trim();
  const row = firstProviderOfType("litellm");
  if (row) setProviderSecret(row.id, "key", k);
  else writeLegacyGatewayKey(k);
  process.env.CALANDRIA_LITELLM_KEY = k;
}

export function clearGatewayKey(): void {
  const row = firstProviderOfType("litellm");
  if (row) clearProviderSecret(row.id, "key");
  clearLegacyGatewayKey();
  delete process.env.CALANDRIA_LITELLM_KEY;
}
