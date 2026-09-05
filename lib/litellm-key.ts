import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";
import { writeSecretFile } from "./secretFile";

/**
 * The instance's LiteLLM virtual key: a 0600 file beside the database,
 * mirrored into process.env so the value has one home at run time.
 *
 * Not part of `agent_env`, which GET /api/projects serves to the browser;
 * `agentTurnEnv()` (lib/agentEnv.ts) resolves the credential from the
 * environment at turn time instead.
 *
 * `CALANDRIA_LITELLM_KEY` in the environment is the other way in, for an
 * instance that gets its secrets from compose or a systemd unit. It needs no
 * opt-in guard (lib/env-keys.mjs) because the key only reaches the gateway
 * this instance is configured to talk to.
 */

const KEY_PATH = path.join(DB_DIR, "litellm-key");

/** Whether this instance has a gateway key at all. */
export function hasGatewayKey(): boolean {
  return !!gatewayKey();
}

/** The key itself, or "" if unset. Read from the environment, which the file is mirrored into. */
export function gatewayKey(): string {
  return (process.env.CALANDRIA_LITELLM_KEY ?? "").trim();
}

/**
 * Persist a key typed into Settings. No format guard: LiteLLM virtual keys
 * are usually `sk-…`, but a master key or a custom-prefixed key can look like
 * anything, and refusing a valid key would be worse than accepting a bad one.
 */
export function setGatewayKey(key: string): void {
  const k = key.trim();
  // Reject control characters: the key is interpolated into
  // ANTHROPIC_CUSTOM_HEADERS, whose headers are newline-separated, so one
  // would let a value inject an extra header into every turn.
  if (/[\0-\x1f\x7f]/.test(k)) throw new Error("a key cannot contain control characters");
  writeSecretFile(KEY_PATH, k, { advice: "Pass the key in the environment with CALANDRIA_LITELLM_KEY instead." });
  process.env.CALANDRIA_LITELLM_KEY = k;
}

export function clearGatewayKey(): void {
  try {
    fs.rmSync(KEY_PATH, { force: true });
  } catch {}
  delete process.env.CALANDRIA_LITELLM_KEY;
}

/** Re-apply the persisted key at boot so a restart doesn't lose it. An
 *  operator-set env value wins, since it's the more explicit of the two. */
export function loadPersistedGatewayKey(): void {
  if (gatewayKey()) return;
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.CALANDRIA_LITELLM_KEY = k;
  } catch {
    /* no persisted key: the gateway may not need one, or isn't configured yet */
  }
}
