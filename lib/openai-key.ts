import fs from "node:fs";
import path from "node:path";
import { DB_DIR } from "./config";
import { writeSecretFile } from "./secretFile";

/**
 * "I have an API key instead" path for the Codex agent, the OpenAI mirror of
 * lib/anthropic-key.ts. Most instances connect Codex through the user's
 * ChatGPT plan (lib/agents/codex/auth.ts, `codex login`); this is the
 * per-token API-key alternative. The key lives in an owner-only file on the
 * volume, not the settings table the client `/api/settings` endpoint reads
 * wholesale, and is mirrored into process.env so `codex` children and the SDK
 * inherit it. loadPersistedOpenAiKey() re-applies it on boot, since
 * production entrypoints strip OPENAI_API_KEY from the container env.
 */
const KEY_PATH = path.join(DB_DIR, "openai-api-key");

export function hasOpenAiKey(): boolean {
  // Checked first: after the boot strip (lib/env-keys.mjs), a key in
  // process.env came from this file or from CALANDRIA_ALLOW_API_KEY_ENV, and
  // is what the codex children actually bill. Status surfaces must count it
  // even when no key file exists.
  if (process.env.OPENAI_API_KEY) return true;
  try {
    return fs.statSync(KEY_PATH).size > 0;
  } catch {
    return false;
  }
}

/** Loose shape check; real validation is the verify turn actually working. */
export function looksLikeOpenAiKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

/**
 * Refuses to store the key if the file cannot be made owner-only; throws
 * instead. On win32 that protection is an ACL, since a POSIX mode is a no-op
 * there (lib/secretFile.ts).
 */
export function setOpenAiKey(key: string): void {
  const k = key.trim();
  writeSecretFile(KEY_PATH, k, { advice: "Pass the key in the environment with CALANDRIA_ALLOW_API_KEY_ENV=1 instead." });
  process.env.OPENAI_API_KEY = k;
}

export function clearOpenAiKey(): void {
  try {
    fs.rmSync(KEY_PATH, { force: true });
  } catch {}
  delete process.env.OPENAI_API_KEY;
}

/** Called once at DB init: re-apply a persisted key to this process's env. */
export function loadPersistedOpenAiKey(): void {
  try {
    const k = fs.readFileSync(KEY_PATH, "utf8").trim();
    if (k) process.env.OPENAI_API_KEY = k;
  } catch {
    /* no persisted key: ChatGPT-plan login, or nothing configured yet */
  }
}
