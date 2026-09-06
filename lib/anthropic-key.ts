import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";
import { writeSecretFile } from "./secretFile";

/**
 * "I have an API key instead" path of the onboarding wizard. Most instances
 * authenticate as the user's own Claude Max/Pro subscription (lib/claude-auth.ts,
 * `claude auth login`), but a user can choose to bill per-token with an
 * Anthropic API key instead. The key is stored in an owner-only file on the
 * volume, not the settings table, which the client `/api/settings` endpoint
 * reads wholesale, and mirrored into process.env so the SDK's `claude`
 * children and every pty shell spawned afterward inherit it.
 * loadPersistedApiKey() re-applies it on boot: production entrypoints strip
 * ANTHROPIC_API_KEY from the container env, so the running process is the
 * only place it lives.
 */
const KEY_PATH = path.join(DB_DIR, "anthropic-api-key");

export function hasApiKey(): boolean {
  // After the boot strip (lib/env-keys.mjs), a key in process.env is either
  // persisted here or kept via CALANDRIA_ALLOW_API_KEY_ENV, and it is what the
  // SDK's claude children actually bill, so status surfaces must count it even
  // when no key file exists.
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    return fs.statSync(KEY_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Loose shape check; real validation happens when the verify turn runs. */
export function looksLikeApiKey(key: string): boolean {
  return /^sk-ant-[\w-]{20,}$/.test(key.trim());
}

/**
 * Throws instead of storing the key if the file could not be made owner-only.
 * On win32 that means an ACL, since a POSIX mode is a no-op there (lib/secretFile.ts).
 */
export function setApiKey(key: string): void {
  const k = key.trim();
  writeSecretFile(KEY_PATH, k, { advice: "Pass the key in the environment with CALANDRIA_ALLOW_API_KEY_ENV=1 instead." });
  process.env.ANTHROPIC_API_KEY = k;
}

export function clearApiKey(): void {
  try {
    fs.rmSync(KEY_PATH, { force: true });
  } catch {}
  delete process.env.ANTHROPIC_API_KEY;
}

/** Called once at DB init: re-apply a persisted key to this process's env. */
export function loadPersistedApiKey(): void {
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.ANTHROPIC_API_KEY = k;
  } catch {
    /* no persisted key: subscription login, or nothing yet */
  }
}
