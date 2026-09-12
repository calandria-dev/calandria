/*
 * The `model_providers` SQL layer, over a connection the caller hands in.
 *
 * WHY the connection is a parameter: lib/db.ts runs the env seed
 * (lib/providers/seed.ts) from inside init(), before `global.__calandriaDb`
 * is set, so anything reached from there must not call getDb(). Importing
 * lib/db.ts here would also close a cycle back through it. lib/providers/store.ts
 * is this same API bound to getDb(), and is what routes and the UI use.
 *
 * Secrets never appear on a row. The store returns `has_key`-style booleans
 * and the values live in lib/providerSecrets.ts.
 */

import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

import { deleteProviderSecrets, providerSecretFlags } from "../providerSecrets";
import type { EnvironmentId, ModelPolicy, ProviderConfig, ProviderType } from "./types";
import {
  PROVIDER_REGISTRY,
  defaultModelPolicy,
  environmentsFor,
  isProviderType,
  parseModelPolicy,
  parseProviderConfig,
} from "./types";

/** The last probe of a provider, as the test routes record it. Every field is
 *  optional: a probe reports what it could learn. */
export interface ProviderTestResult {
  reachable?: boolean;
  api?: string;
  version?: string;
  latency_ms?: number;
  error?: string;
  [key: string]: unknown;
}

/** One configured provider, as everything outside this module sees it. */
export interface ModelProvider {
  id: string;
  type: ProviderType;
  label: string;
  config: ProviderConfig;
  model_policy: ModelPolicy;
  created_at: number;
  updated_at: number;
  last_test_at: number | null;
  last_test: ProviderTestResult | null;
  /** The environment whose login owns this row, or null for a user-added one. */
  bundled: EnvironmentId | null;
  /** The environments this row serves, decided by its type (lib/providers/types.ts). */
  environments: EnvironmentId[];
  /** Present only for a type that declares the field. Never the value itself. */
  has_key?: boolean;
  has_admin_key?: boolean;
}

export interface CreateProviderInput {
  type: ProviderType;
  label?: string;
  config?: unknown;
  model_policy?: unknown;
}

export interface UpdateProviderInput {
  label?: string;
  config?: unknown;
  model_policy?: unknown;
  last_test?: ProviderTestResult | null;
  last_test_at?: number | null;
}

/** What pointed at a provider. Read before a delete, and served by the usage route. */
export interface ProviderUsage {
  projects: { id: string; name: string }[];
  tasks: { id: string; project_id: string; title: string }[];
  schedules: { id: string; project_id: string; name: string }[];
  runbooks: { id: string; project_id: string; name: string }[];
}

interface ProviderRow {
  id: string;
  type: string;
  label: string;
  config: string;
  model_policy: string;
  created_at: number;
  updated_at: number;
  last_test_at: number | null;
  last_test: string | null;
}

function readJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A stored config is read tolerantly: a row written by a newer build can
 * carry a field this one's schema refuses, and refusing the whole row would
 * hide a working provider rather than surface the extra field.
 */
function readConfig(type: ProviderType, raw: string): ProviderConfig {
  const parsed = readJson(raw);
  try {
    return parseProviderConfig(type, parsed ?? {});
  } catch {
    return (parsed && typeof parsed === "object" ? parsed : {}) as ProviderConfig;
  }
}

function toProvider(row: ProviderRow): ModelProvider {
  const type = isProviderType(row.type) ? row.type : "custom";
  const entry = PROVIDER_REGISTRY[type];
  return {
    id: row.id,
    type,
    label: row.label,
    config: readConfig(type, row.config),
    model_policy: parseModelPolicy(type, readJson(row.model_policy)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_test_at: row.last_test_at,
    last_test: (readJson(row.last_test) as ProviderTestResult | null) ?? null,
    bundled: entry.bundled,
    environments: environmentsFor(type),
    ...providerSecretFlags(row.id, entry.secretFields),
  };
}

/** Bundled rows first, then user-added rows oldest first, so the order a
 *  settings list renders in is the same on every load. */
function byBundledThenAge(a: ModelProvider, b: ModelProvider): number {
  const rank = (p: ModelProvider) => (p.bundled ? 0 : 1);
  return rank(a) - rank(b) || a.created_at - b.created_at;
}

export function listProviderRows(db: Database.Database): ModelProvider[] {
  const rows = db.prepare("SELECT * FROM model_providers ORDER BY created_at ASC, rowid ASC").all() as ProviderRow[];
  return rows.map(toProvider).sort(byBundledThenAge);
}

export function getProviderRow(db: Database.Database, id: string): ModelProvider | null {
  const row = db.prepare("SELECT * FROM model_providers WHERE id = ?").get(id) as ProviderRow | undefined;
  return row ? toProvider(row) : null;
}

/** The oldest row of a type. Every bundled type holds at most one, and the env
 *  seed uses this to decide whether a var still has anything to seed. */
export function firstProviderRowOfType(db: Database.Database, type: ProviderType): ModelProvider | null {
  const row = db
    .prepare("SELECT * FROM model_providers WHERE type = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(type) as ProviderRow | undefined;
  return row ? toProvider(row) : null;
}

export function countProviderRowsOfType(db: Database.Database, type: ProviderType): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM model_providers WHERE type = ?").get(type) as { n: number }).n;
}

/**
 * Create a row. A bundled type is limited to one row for its environment:
 * that row IS the CLI's login, and a second one would describe a second login
 * that does not exist. lib/agents/connections.ts is the only caller that
 * passes a bundled type; the POST route refuses them outright.
 */
export function insertProviderRow(db: Database.Database, input: CreateProviderInput): ModelProvider {
  const entry = PROVIDER_REGISTRY[input.type];
  if (!entry) throw new Error(`unknown provider type ${JSON.stringify(input.type)}`);
  if (entry.bundled && countProviderRowsOfType(db, input.type) > 0) {
    throw new Error(`the ${entry.label} provider already exists; ${entry.bundled} holds one bundled row`);
  }
  const config = parseProviderConfig(input.type, input.config ?? {});
  const policy =
    input.model_policy === undefined
      ? defaultModelPolicy(input.type)
      : parseModelPolicy(input.type, input.model_policy);
  const now = Date.now();
  const id = nanoid();
  db.prepare(
    `INSERT INTO model_providers (id, type, label, config, model_policy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.type, (input.label || entry.label).trim(), JSON.stringify(config), JSON.stringify(policy), now, now);
  return getProviderRow(db, id)!;
}

export function updateProviderRow(
  db: Database.Database,
  id: string,
  fields: UpdateProviderInput,
): ModelProvider | null {
  const existing = getProviderRow(db, id);
  if (!existing) return null;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (fields.label !== undefined) {
    sets.push("label = ?");
    values.push(fields.label.trim() || PROVIDER_REGISTRY[existing.type].label);
  }
  if (fields.config !== undefined) {
    sets.push("config = ?");
    values.push(JSON.stringify(parseProviderConfig(existing.type, fields.config)));
  }
  if (fields.model_policy !== undefined) {
    sets.push("model_policy = ?");
    values.push(JSON.stringify(parseModelPolicy(existing.type, fields.model_policy)));
  }
  if (fields.last_test !== undefined) {
    sets.push("last_test = ?");
    values.push(fields.last_test === null ? null : JSON.stringify(fields.last_test));
    // A probe result and its timestamp are one fact, so recording the result
    // stamps the clock unless the caller named its own.
    if (fields.last_test_at === undefined) {
      sets.push("last_test_at = ?");
      values.push(fields.last_test === null ? null : Date.now());
    }
  }
  if (fields.last_test_at !== undefined) {
    sets.push("last_test_at = ?");
    values.push(fields.last_test_at);
  }
  if (!sets.length) return existing;
  db.prepare(`UPDATE model_providers SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
  return getProviderRow(db, id)!;
}

export function providerUsageRow(db: Database.Database, id: string): ProviderUsage {
  return {
    projects: db
      .prepare("SELECT id, name FROM projects WHERE default_provider_id = ? ORDER BY name ASC")
      .all(id) as ProviderUsage["projects"],
    tasks: db
      .prepare("SELECT id, project_id, title FROM tasks WHERE provider_id = ? ORDER BY created_at ASC")
      .all(id) as ProviderUsage["tasks"],
    schedules: db
      .prepare("SELECT id, project_id, name FROM schedules WHERE provider_id = ? ORDER BY name ASC")
      .all(id) as ProviderUsage["schedules"],
    runbooks: db
      .prepare("SELECT id, project_id, name FROM runbooks WHERE provider_id = ? ORDER BY name ASC")
      .all(id) as ProviderUsage["runbooks"],
  };
}

/**
 * Hard delete, with the usage it detached. Every referencing column is
 * `ON DELETE SET NULL`, so the rows that pointed here fall back to the next
 * default rather than disappearing with the provider. The credentials go with
 * the row: leaving them would keep a key on disk with nothing able to name it.
 */
export function deleteProviderRow(db: Database.Database, id: string): ProviderUsage | null {
  const existing = getProviderRow(db, id);
  if (!existing) return null;
  const usage = providerUsageRow(db, id);
  db.prepare("DELETE FROM model_providers WHERE id = ?").run(id);
  deleteProviderSecrets(id);
  return usage;
}
