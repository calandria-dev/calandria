/**
 * The instance's LiteLLM virtual key, as the rest of the app still asks for
 * it. Thin wrappers over the `key` field of the `litellm` provider row
 * (lib/providerSecrets.ts, lib/providers/store.ts).
 *
 * Never serialized into a provider row or an API response. `agentTurnEnv()`
 * resolves the provider row and reads its credential at turn time.
 *
 * `CALANDRIA_LITELLM_KEY` in the environment is the other way in, for an
 * instance that gets its secrets from compose or a systemd unit. It needs no
 * opt-in guard (lib/env-keys.mjs) because the key only reaches the gateway
 * this instance is configured to talk to. The env seed copies it onto the row
 * it creates (lib/providers/seed.ts). Once a row exists the database and its
 * provider secret are authoritative.
 *
 * lib/db.ts imports loadPersistedGatewayKey from lib/providerSecrets.ts
 * rather than from here: this module reads a provider row, and lib/db.ts must
 * not reach a module that reads one from inside init().
 */

import { firstProviderOfType } from "./providers/store";
import {
  clearProviderSecret,
  getProviderSecret,
  setProviderSecret,
} from "./providerSecrets";

export { loadPersistedGatewayKey } from "./providerSecrets";

/** Whether this instance has a gateway key at all. */
export function hasGatewayKey(): boolean {
  return !!gatewayKey();
}

/** The oldest gateway row's key, or "" if unset. */
export function gatewayKey(): string {
  const row = firstProviderOfType("litellm");
  return row ? getProviderSecret(row.id, "key") : "";
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
  if (!row) throw new Error("no LiteLLM provider is configured");
  setProviderSecret(row.id, "key", k);
}

export function clearGatewayKey(): void {
  const row = firstProviderOfType("litellm");
  if (row) clearProviderSecret(row.id, "key");
}
