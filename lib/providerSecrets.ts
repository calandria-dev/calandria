/*
 * Every model provider's credentials, in one 0600 JSON file beside the
 * database, keyed by provider id and field name:
 *
 *   { "<provider id>": { "key": "sk-…", "admin_key": "sk-…" } }
 *
 * WHY a file and not a column: `GET /api/providers` and `GET /api/projects`
 * serve provider rows to the browser, so anything on a row is readable by
 * anyone with the app open. The store never returns a secret; it returns
 * `has_key`-style booleans (lib/providers/rows.ts) and the value stays here.
 *
 * This generalizes lib/litellm-key.ts, which held the one gateway key in a
 * bare file at the same location. That file is still read at boot so an
 * upgrade does not lose the key (loadPersistedGatewayKey below).
 *
 * fs plus lib/config.ts only. lib/db.ts imports the boot loader from here
 * rather than from lib/litellm-key.ts, because that module now reads the
 * litellm provider row and must not be on lib/db.ts's import path.
 */

import fs from "node:fs";
import path from "node:path";

import { DB_DIR } from "./config";
import { writeSecretFile } from "./secretFile";
import type { SecretField, SecretFlag } from "./providers/types";
import { SECRET_FLAG_OF } from "./providers/types";

const SECRETS_PATH = path.join(DB_DIR, "provider-secrets.json");

/** Where the single gateway key lived before providers had rows. */
const LEGACY_GATEWAY_KEY_PATH = path.join(DB_DIR, "litellm-key");

type SecretStore = Record<string, Partial<Record<SecretField, string>>>;

/** The advice appended to a failure to lock the file down. */
const ADVICE = "Pass the credential in the environment instead, or remove the provider.";

function read(): SecretStore {
  let raw = "";
  try {
    raw = fs.readFileSync(SECRETS_PATH, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SecretStore) : {};
  } catch {
    // A corrupt file reads as "no secrets stored". Throwing here would take
    // the whole app down over a credential the user can retype.
    console.warn(`[provider-secrets] ${SECRETS_PATH} is not readable JSON; treating it as empty`);
    return {};
  }
}

function write(store: SecretStore): void {
  for (const [id, fields] of Object.entries(store)) {
    if (!fields || !Object.keys(fields).length) delete store[id];
  }
  if (!Object.keys(store).length) {
    try {
      fs.rmSync(SECRETS_PATH, { force: true });
    } catch {
      /* nothing left to store; an undeletable empty file is harmless */
    }
    return;
  }
  writeSecretFile(SECRETS_PATH, `${JSON.stringify(store, null, 2)}\n`, { advice: ADVICE });
}

/**
 * Reject control characters. A key is interpolated into
 * ANTHROPIC_CUSTOM_HEADERS, whose headers are newline-separated, so one would
 * let a value inject an extra header into every turn.
 */
function assertStorable(value: string): void {
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error("a credential cannot contain control characters");
}

/** The stored value, or "" when this provider has no such field set. */
export function getProviderSecret(providerId: string, field: SecretField): string {
  return (read()[providerId]?.[field] ?? "").trim();
}

/** Whether the field is set, without reading it. */
export function hasProviderSecret(providerId: string, field: SecretField): boolean {
  return !!getProviderSecret(providerId, field);
}

/**
 * Store a credential. An empty value clears the field, which is how a form
 * says "this provider needs no key" as distinct from "leave what is stored".
 * No format guard: virtual keys, master keys and vendor keys all look
 * different, and refusing a valid key would be worse than accepting a bad one.
 */
export function setProviderSecret(providerId: string, field: SecretField, value: string): void {
  const v = value.trim();
  if (!v) {
    clearProviderSecret(providerId, field);
    return;
  }
  assertStorable(v);
  const store = read();
  store[providerId] = { ...store[providerId], [field]: v };
  write(store);
}

export function clearProviderSecret(providerId: string, field: SecretField): void {
  const store = read();
  const fields = store[providerId];
  if (!fields || fields[field] === undefined) return;
  delete fields[field];
  write(store);
}

/** Forget every credential for a provider. Called when its row is deleted. */
export function deleteProviderSecrets(providerId: string): void {
  const store = read();
  if (!(providerId in store)) return;
  delete store[providerId];
  write(store);
}

/**
 * What a provider row carries in place of its secrets: one `has_*` boolean per
 * field the type declares, so a form can render the field and say whether it
 * is already set without a second lookup. A type with no secret fields gets an
 * empty object.
 */
export function providerSecretFlags(
  providerId: string,
  fields: readonly SecretField[],
): Partial<Record<SecretFlag, boolean>> {
  const flags: Partial<Record<SecretFlag, boolean>> = {};
  for (const field of fields) flags[SECRET_FLAG_OF[field]] = hasProviderSecret(providerId, field);
  return flags;
}

/**
 * Re-apply the gateway key an older release persisted to its own bare file, so
 * a restart after the upgrade does not lose it. Mirrored into the environment,
 * where lib/litellm-key.ts's `gatewayKey()` finds it and the env seed
 * (lib/providers/seed.ts) copies it onto the litellm row it creates. An
 * operator-set `CALANDRIA_LITELLM_KEY` wins, since it is the more explicit of
 * the two.
 *
 * Called from lib/db.ts at boot, before the seed runs.
 */
export function loadPersistedGatewayKey(): void {
  if ((process.env.CALANDRIA_LITELLM_KEY ?? "").trim()) return;
  try {
    const k = fs.readFileSync(LEGACY_GATEWAY_KEY_PATH, "utf8").trim();
    if (k) process.env.CALANDRIA_LITELLM_KEY = k;
  } catch {
    /* no persisted key: the gateway may not need one, or isn't configured yet */
  }
}

/** Write the pre-rows gateway key file. Only lib/litellm-key.ts uses this, for
 *  an instance with a key but no litellm provider row to hang it on. */
export function writeLegacyGatewayKey(key: string): void {
  assertStorable(key);
  writeSecretFile(LEGACY_GATEWAY_KEY_PATH, key, {
    advice: "Pass the key in the environment with CALANDRIA_LITELLM_KEY instead.",
  });
}

export function clearLegacyGatewayKey(): void {
  try {
    fs.rmSync(LEGACY_GATEWAY_KEY_PATH, { force: true });
  } catch {
    /* the key is already gone from the environment, which is what turns it off */
  }
}

/** Exported for the suite, which asserts on the file's mode and contents. */
export const PROVIDER_SECRETS_PATH = SECRETS_PATH;
