/*
 * What a configured model provider is: an endpoint, a credential and a model
 * policy (docs/superpowers/specs/2026-09-06-model-providers-design.md).
 *
 * This file is the one table the rest of the product reads provider facts
 * from. Which environments a provider serves is decided HERE from its type,
 * never by the user and never by a route, so a `litellm` row offers the same
 * three CLIs on every instance. The environment registry
 * (lib/agents/capabilities.ts) derives its `providerTypes` from this table,
 * and a test fails on drift between the two.
 *
 * Pure data plus zod schemas: no DB, no fs, no SDK. lib/providers/rows.ts
 * and lib/providers/store.ts sit on it.
 */

import { z } from "zod";

/**
 * The coding CLI a turn runs in, by driver id (lib/agents/registry.ts). The
 * UI word is "environment"; the column and the driver seam keep the name
 * `agent`.
 */
export type EnvironmentId = "claude" | "codex" | "gemini";

/**
 * Every kind of provider, in two groups.
 *
 * Bundled: one row per environment, created when that CLI signs in and
 * removed when it signs out (lib/agents/connections.ts). Never added by hand,
 * and the credential is the CLI's own login.
 *
 * User-added: any number of rows each, created from Settings.
 */
export type ProviderType =
  | "anthropic"
  | "openai"
  | "google"
  | "openai_key"
  | "gemini_key"
  | "litellm"
  | "ollama"
  | "lmstudio"
  | "custom";

export const PROVIDER_TYPES: readonly ProviderType[] = [
  "anthropic",
  "openai",
  "google",
  "openai_key",
  "gemini_key",
  "litellm",
  "ollama",
  "lmstudio",
  "custom",
];

export function isProviderType(v: unknown): v is ProviderType {
  return typeof v === "string" && (PROVIDER_TYPES as readonly string[]).includes(v);
}

/**
 * How a type's model policy reads. `allow` lists the models turned on;
 * `deny` lists the models turned off. Taken from the type, never set by the
 * user: a gateway can advertise a hundred models and most of them have no
 * business in a picker, while a bundled login and a local server list what
 * they actually have.
 */
export type PolicyMode = "allow" | "deny";

/** The secret fields a provider can hold, stored by lib/providerSecrets.ts. */
export type SecretField = "key" | "admin_key";

/** What the store exposes in place of a secret. */
export type SecretFlag = "has_key" | "has_admin_key";

export const SECRET_FLAG_OF: Record<SecretField, SecretFlag> = {
  key: "has_key",
  admin_key: "has_admin_key",
};

/**
 * A provider's type-specific settings, stored as JSON in
 * `model_providers.config`. Never holds a secret: the row is served to the
 * browser, so anything in it is readable by anyone with the app open.
 *
 * One flat shape rather than a discriminated union, because a row read back
 * from SQLite is only as typed as its `type` column. `configSchemaFor()` is
 * what decides whether a given object is valid for a given type.
 */
export interface ProviderConfig {
  /** The endpoint, for the types that have one. */
  base_url?: string;
  /** litellm: whether turns bill against the instance key or a subscription pass-through. */
  billing?: "key" | "subscription";
  /** litellm: whether hosted MCP servers on this gateway may be mounted. */
  mcp?: boolean;
  /** litellm: bound on one call to the gateway's key-management surface. */
  key_timeout_ms?: number;
  /** custom: which API shape the endpoint speaks. */
  api?: "anthropic" | "openai";
  /** Any type: the model a task falls back to when nothing nearer names one. */
  default_model?: string;
}

const baseConfig = z.object({ default_model: z.string().optional() });

/** A base URL with no trailing slash and no trailing `/v1`, the shape lib/agentEnv.ts stores. */
const baseUrl = z
  .string()
  .trim()
  .min(1, "an endpoint is required")
  .transform((s) => s.replace(/\/+$/, "").replace(/\/v1$/i, ""))
  .refine((s) => /^https?:\/\//i.test(s), "an endpoint must start with http:// or https://");

const CONFIG_SCHEMAS = {
  /** The credential is the CLI's own login, so there is nothing to configure. */
  bundled: baseConfig.strict(),
  litellm: baseConfig
    .extend({
      base_url: baseUrl,
      billing: z.enum(["key", "subscription"]).default("key"),
      mcp: z.boolean().default(true),
      key_timeout_ms: z.number().int().nonnegative().optional(),
    })
    .strict(),
  /** Ollama and LM Studio: an endpoint and nothing else, since neither takes a credential. */
  endpoint: baseConfig.extend({ base_url: baseUrl }).strict(),
  custom: baseConfig
    .extend({ base_url: baseUrl, api: z.enum(["anthropic", "openai"]) })
    .strict(),
  /** The vendor's own base URL is built in; only the key is configurable. */
  vendorKey: baseConfig.strict(),
} as const;

/** One entry per provider type: everything Calandria decides from the type alone. */
export interface ProviderTypeEntry {
  type: ProviderType;
  /** What a row of this type is called when the user has not named it. */
  label: string;
  /**
   * The environment this type is bundled with, or null for a user-added type.
   * A bundled type holds at most one row, and that row belongs to this CLI's
   * login.
   */
  bundled: EnvironmentId | null;
  /** The environments a row of this type can serve. Decided here, never by the user. */
  environments: readonly EnvironmentId[];
  /** How this type's model policy reads (see PolicyMode). */
  policyMode: PolicyMode;
  /** The secret fields a row of this type holds, in the order a form shows them. */
  secretFields: readonly SecretField[];
  /** Validates and normalizes `config` for this type. */
  configSchema: z.ZodType<ProviderConfig, unknown>;
}

/**
 * Antigravity appears only for `google`, `gemini_key` and `litellm`. The
 * driver passes GOOGLE_GEMINI_BASE_URL through to the CLI and nothing
 * verifies that a local server answers the Gemini API, so `ollama`,
 * `lmstudio` and `custom` serve Claude Code and Codex only. Adding `gemini`
 * to one of those lists is how that changes, once somebody has shown it
 * working.
 */
export const PROVIDER_REGISTRY: Record<ProviderType, ProviderTypeEntry> = {
  anthropic: {
    type: "anthropic",
    label: "Anthropic",
    bundled: "claude",
    environments: ["claude"],
    policyMode: "deny",
    secretFields: [],
    configSchema: CONFIG_SCHEMAS.bundled,
  },
  openai: {
    type: "openai",
    label: "OpenAI",
    bundled: "codex",
    environments: ["codex"],
    policyMode: "deny",
    secretFields: [],
    configSchema: CONFIG_SCHEMAS.bundled,
  },
  google: {
    type: "google",
    label: "Google",
    bundled: "gemini",
    environments: ["gemini"],
    policyMode: "deny",
    secretFields: [],
    configSchema: CONFIG_SCHEMAS.bundled,
  },
  openai_key: {
    type: "openai_key",
    label: "OpenAI API key",
    bundled: null,
    environments: ["codex"],
    policyMode: "deny",
    secretFields: ["key"],
    configSchema: CONFIG_SCHEMAS.vendorKey,
  },
  gemini_key: {
    type: "gemini_key",
    label: "Gemini API key",
    bundled: null,
    environments: ["gemini"],
    policyMode: "deny",
    secretFields: ["key"],
    configSchema: CONFIG_SCHEMAS.vendorKey,
  },
  litellm: {
    type: "litellm",
    label: "LiteLLM gateway",
    bundled: null,
    environments: ["claude", "codex", "gemini"],
    policyMode: "allow",
    secretFields: ["key", "admin_key"],
    configSchema: CONFIG_SCHEMAS.litellm,
  },
  ollama: {
    type: "ollama",
    label: "Ollama",
    bundled: null,
    environments: ["claude", "codex"],
    policyMode: "deny",
    secretFields: [],
    configSchema: CONFIG_SCHEMAS.endpoint,
  },
  lmstudio: {
    type: "lmstudio",
    label: "LM Studio",
    bundled: null,
    environments: ["claude", "codex"],
    policyMode: "deny",
    secretFields: [],
    configSchema: CONFIG_SCHEMAS.endpoint,
  },
  custom: {
    type: "custom",
    label: "Custom endpoint",
    bundled: null,
    environments: ["claude", "codex"],
    policyMode: "deny",
    secretFields: ["key"],
    configSchema: CONFIG_SCHEMAS.custom,
  },
};

export function providerTypeEntry(type: ProviderType): ProviderTypeEntry {
  return PROVIDER_REGISTRY[type];
}

/** The environments a row of this type serves. */
export function environmentsFor(type: ProviderType): EnvironmentId[] {
  return [...PROVIDER_REGISTRY[type].environments];
}

/** Whether this type's rows are created by signing in to a CLI. */
export function isBundledType(type: ProviderType): boolean {
  return PROVIDER_REGISTRY[type].bundled !== null;
}

/** The bundled type an environment's login creates, or null for an environment with none. */
export function bundledTypeFor(env: string): ProviderType | null {
  for (const entry of Object.values(PROVIDER_REGISTRY)) {
    if (entry.bundled === env) return entry.type;
  }
  return null;
}

/** Every type a user can add, in the order the add page's grid shows them. */
export const USER_ADDED_TYPES: readonly ProviderType[] = PROVIDER_TYPES.filter((t) => !isBundledType(t));

/**
 * Which models reach a picker. In `allow` mode `ids` are the models turned on;
 * in `deny` mode they are the models turned off. `known` is the catalog as of
 * the last read, for diffing. `unavailable` are pinned ids that have left the
 * catalog: served flagged, struck through in the picker, and never selectable.
 */
export interface ModelPolicy {
  mode: PolicyMode;
  ids: string[];
  known: string[];
  unavailable: string[];
}

export const modelPolicySchema = z.object({
  mode: z.enum(["allow", "deny"]),
  ids: z.array(z.string()).default([]),
  known: z.array(z.string()).default([]),
  unavailable: z.array(z.string()).default([]),
});

/** A fresh row's policy: the type's mode, with nothing pinned either way. */
export function defaultModelPolicy(type: ProviderType): ModelPolicy {
  return { mode: PROVIDER_REGISTRY[type].policyMode, ids: [], known: [], unavailable: [] };
}

/**
 * Validate `value` as a config for `type`, applying the type's defaults.
 * Throws a message naming the first bad field, which the routes surface as a
 * 400.
 */
export function parseProviderConfig(type: ProviderType, value: unknown): ProviderConfig {
  const parsed = PROVIDER_REGISTRY[type].configSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`${type} provider config is invalid (${where}${issue.message})`);
  }
  return parsed.data;
}

/**
 * Validate `value` as a policy for `type`. A policy whose mode disagrees with
 * the type is corrected rather than refused: the mode comes from the type, so
 * a caller sending the other one is describing a policy that cannot exist.
 */
export function parseModelPolicy(type: ProviderType, value: unknown): ModelPolicy {
  const parsed = modelPolicySchema.safeParse(value ?? {});
  if (!parsed.success) return defaultModelPolicy(type);
  return { ...parsed.data, mode: PROVIDER_REGISTRY[type].policyMode };
}

/**
 * Which local server answers on a port. 11434 is Ollama's default and 1234 is
 * LM Studio's; anything else is something Calandria cannot name, so it is a
 * `custom` row. Used by the env seed and by the agent_env migration, which
 * have to agree.
 */
export function localTypeForPort(baseUrl: string): ProviderType {
  let port = "";
  try {
    port = new URL(baseUrl).port;
  } catch {
    /* not a URL: nothing to read a port off, so it is a custom endpoint */
  }
  if (port === "11434") return "ollama";
  if (port === "1234") return "lmstudio";
  return "custom";
}
