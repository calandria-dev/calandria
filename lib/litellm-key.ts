import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";
import { writeSecretFile } from "./secretFile";

/**
 * The instance's LiteLLM virtual key, persisted the way lib/anthropic-key.ts
 * persists an Anthropic key: a 0600 file beside the database, mirrored into
 * this process's environment so the value has one home at run time.
 *
 * It is deliberately NOT part of `agent_env`. That column is written from a
 * settings form and served to the browser by GET /api/projects, so a key kept
 * there would be a key anyone with the app open could read, and a project row
 * would become a way to exfiltrate it. The gateway preset stores only base URLs
 * and a billing marker; `agentTurnEnv()` (lib/agentEnv.ts) resolves the
 * credential from the environment at turn time and composes the one header
 * that carries it.
 *
 * `CALANDRIA_LITELLM_KEY` in the environment is the other way in, for an
 * instance that gets its secrets from compose or a systemd unit. Unlike an
 * inherited ANTHROPIC_API_KEY it needs no opt-in guard (lib/env-keys.mjs): the
 * key only reaches the gateway the same instance is configured to talk to, so
 * there is no vendor account it could silently start billing.
 */

const KEY_PATH = path.join(DB_DIR, "litellm-key");

/** Whether this instance has a gateway key at all. */
export function hasGatewayKey(): boolean {
  return !!gatewayKey();
}

/** The key itself, or "" — read from the env, which the file is mirrored into. */
export function gatewayKey(): string {
  return (process.env.CALANDRIA_LITELLM_KEY ?? "").trim();
}

/**
 * Persist a key typed into Settings. No format guard, unlike an Anthropic key:
 * LiteLLM virtual keys are `sk-…` by default but a master key or a key minted
 * with a custom prefix is whatever the operator chose, and refusing a valid key
 * because it doesn't look familiar is the worse failure.
 */
export function setGatewayKey(key: string): void {
  const k = key.trim();
  // The one shape that IS refused. The key is interpolated into
  // ANTHROPIC_CUSTOM_HEADERS, whose headers are newline-separated, so a control
  // character here would be a way to append a header of its own to every turn.
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

/** Re-apply the persisted key at boot, so a restart doesn't lose it. An env
 *  value set by the operator wins: it is the more explicit statement of the two. */
export function loadPersistedGatewayKey(): void {
  if (gatewayKey()) return;
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.CALANDRIA_LITELLM_KEY = k;
  } catch {
    /* no persisted key — the gateway may not need one, or may not be configured */
  }
}
