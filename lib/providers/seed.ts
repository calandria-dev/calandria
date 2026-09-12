/*
 * First-boot seeding of provider rows from environment variables.
 *
 * Provider configuration is per instance and user-editable, so the source of
 * truth is the database and the env vars are a seed. That is a deliberate
 * exception to the "every knob is env-driven" rule in CLAUDE.md, and it keeps
 * a compose file or a systemd unit working unchanged: set
 * CALANDRIA_LITELLM_BASE_URL or CALANDRIA_LOCAL_MODEL_BASE_URL and the row
 * appears on the next boot.
 *
 * Once a row of the type exists the database wins and the env is ignored, with
 * one log line saying so. Otherwise an operator who edited a provider in
 * Settings would find it overwritten on every restart.
 *
 * Called from lib/db.ts's init(), where recoverFromCrash() runs, so it takes
 * the connection rather than calling getDb() (see lib/providers/rows.ts).
 */

import type Database from "better-sqlite3";

import { providerSeedEnv } from "../config";
import type { ProviderSeedEnv } from "../config";
import { createLogger } from "../log.mjs";
import { setProviderSecret } from "../providerSecrets";
import { countProviderRowsOfType, insertProviderRow } from "./rows";
import type { ProviderType } from "./types";
import { PROVIDER_REGISTRY, localTypeForPort } from "./types";

const log = createLogger("providers");

/** The three types a local server can be. An instance gets one seeded row
 *  across all three: the var names one endpoint, not one per kind. */
const LOCAL_TYPES: readonly ProviderType[] = ["ollama", "lmstudio", "custom"];

/** "Ollama (mac-mini.local)": the type's own name plus the host it answers on,
 *  so two local servers are told apart in a list without reading the endpoint. */
function hostLabel(type: ProviderType, baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    /* not a URL: the bare label is still better than an empty one */
  }
  const label = PROVIDER_REGISTRY[type].label;
  return host ? `${label} (${host})` : label;
}

function seedGateway(db: Database.Database, env: ProviderSeedEnv): void {
  if (!env.litellmBaseUrl) return;
  if (countProviderRowsOfType(db, "litellm") > 0) {
    log.info("CALANDRIA_LITELLM_BASE_URL is set and a LiteLLM provider already exists; the stored provider wins", {
      base_url: env.litellmBaseUrl,
    });
    return;
  }
  const row = insertProviderRow(db, {
    type: "litellm",
    label: PROVIDER_REGISTRY.litellm.label,
    config: {
      base_url: env.litellmBaseUrl,
      // No env var chooses this. A gateway reached with a key is the shape
      // these vars describe; the provider's detail modal is where an
      // instance says otherwise.
      billing: "key",
      mcp: env.litellmMcp,
      key_timeout_ms: env.litellmKeyTimeoutMs,
    },
  });
  if (env.litellmKey) setProviderSecret(row.id, "key", env.litellmKey);
  if (env.litellmAdminKey) setProviderSecret(row.id, "admin_key", env.litellmAdminKey);
  log.info("seeded a LiteLLM provider from the environment", {
    provider: row.id,
    base_url: env.litellmBaseUrl,
    has_key: !!env.litellmKey,
    has_admin_key: !!env.litellmAdminKey,
  });
}

function seedLocal(db: Database.Database, env: ProviderSeedEnv): void {
  if (!env.localBaseUrlSet) return;
  const existing = LOCAL_TYPES.find((t) => countProviderRowsOfType(db, t) > 0);
  if (existing) {
    log.info("CALANDRIA_LOCAL_MODEL_BASE_URL is set and a local provider already exists; the stored provider wins", {
      base_url: env.localBaseUrl,
      type: existing,
    });
    return;
  }
  const type = localTypeForPort(env.localBaseUrl);
  const row = insertProviderRow(db, {
    type,
    label: hostLabel(type, env.localBaseUrl),
    config: {
      base_url: env.localBaseUrl,
      // A `custom` row has to declare an API shape, and a local server on a
      // port Calandria cannot name is most likely the OpenAI surface Ollama
      // and LM Studio both expose. The detail modal is where it changes.
      ...(type === "custom" ? { api: "openai" as const } : {}),
    },
  });
  log.info("seeded a local model provider from the environment", {
    provider: row.id,
    type,
    base_url: env.localBaseUrl,
  });
}

/**
 * Seed whatever the environment describes and the database does not already
 * have. Idempotent: a second call on the same database seeds nothing.
 */
export function seedProvidersFromEnv(db: Database.Database, env: ProviderSeedEnv = providerSeedEnv()): void {
  seedGateway(db, env);
  seedLocal(db, env);
}
