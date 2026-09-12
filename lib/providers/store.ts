/*
 * Typed CRUD over `model_providers`, on the shared connection. This is what
 * routes, the UI's data loaders and lib/agentEnv.ts use; lib/providers/rows.ts
 * is the same API over a connection passed in, for the boot-time seed.
 *
 * DB only, no SDK and no driving. A provider row never carries a secret: the
 * values live in lib/providerSecrets.ts and a row carries `has_key`-style
 * booleans instead.
 */

import { getDb } from "../db";
import type { CreateProviderInput, ModelProvider, ProviderUsage, UpdateProviderInput } from "./rows";
import {
  countProviderRowsOfType,
  deleteProviderRow,
  firstProviderRowOfType,
  getProviderRow,
  insertProviderRow,
  listProviderRows,
  providerUsageRow,
  updateProviderRow,
} from "./rows";
import type { EnvironmentId, ProviderType } from "./types";
import { PROVIDER_REGISTRY, bundledTypeFor } from "./types";

export type { CreateProviderInput, ModelProvider, ProviderTestResult, ProviderUsage, UpdateProviderInput } from "./rows";

/** Every provider: bundled rows first, then user-added rows oldest first. */
export function listProviders(): ModelProvider[] {
  return listProviderRows(getDb());
}

export function getProvider(id: string): ModelProvider | null {
  return getProviderRow(getDb(), id);
}

/** The oldest row of a type, which for a bundled type is the only one. */
export function firstProviderOfType(type: ProviderType): ModelProvider | null {
  return firstProviderRowOfType(getDb(), type);
}

export function countProvidersOfType(type: ProviderType): number {
  return countProviderRowsOfType(getDb(), type);
}

/** Create a row. Refuses a second bundled row for the same environment. */
export function createProvider(input: CreateProviderInput): ModelProvider {
  return insertProviderRow(getDb(), input);
}

/** Patch label, config, policy or the last probe result. Null id returns null. */
export function updateProvider(id: string, fields: UpdateProviderInput): ModelProvider | null {
  return updateProviderRow(getDb(), id, fields);
}

/**
 * Hard delete, returning what pointed at the row so the caller can say what it
 * detached. Null when there is no such row.
 */
export function deleteProvider(id: string): ProviderUsage | null {
  return deleteProviderRow(getDb(), id);
}

/** The projects, tasks, schedules and runbooks that reference a provider. */
export function providerUsage(id: string): ProviderUsage {
  return providerUsageRow(getDb(), id);
}

/** Whether anything at all points at a provider. */
export function providerUsageCount(id: string): number {
  const u = providerUsage(id);
  return u.projects.length + u.tasks.length + u.schedules.length + u.runbooks.length;
}

/**
 * Every model id whose continued visibility depends on this provider. A task,
 * schedule or runbook may name the provider directly, or inherit it from its
 * project. The provider's own default is the project-level default available
 * in the landed schema, which has no separate projects.model column.
 */
export function pinnedModelsForProvider(provider: ModelProvider): string[] {
  const db = getDb();
  const ids = new Set<string>();
  if (provider.config.default_model) ids.add(provider.config.default_model);

  const queries = [
    `SELECT t.model AS model
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.model IS NOT NULL AND (t.provider_id = ? OR (t.provider_id IS NULL AND p.default_provider_id = ?))`,
    `SELECT s.model AS model
       FROM schedules s JOIN projects p ON p.id = s.project_id
      WHERE s.model IS NOT NULL AND (s.provider_id = ? OR (s.provider_id IS NULL AND p.default_provider_id = ?))`,
    `SELECT r.model AS model
       FROM runbooks r JOIN projects p ON p.id = r.project_id
      WHERE r.model IS NOT NULL AND (r.provider_id = ? OR (r.provider_id IS NULL AND p.default_provider_id = ?))`,
  ];
  for (const sql of queries) {
    const rows = db.prepare(sql).all(provider.id, provider.id) as { model: string }[];
    for (const row of rows) if (row.model) ids.add(row.model);
  }
  if (provider.bundled) {
    const inheritedQueries = [
      `SELECT t.model AS model
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.model IS NOT NULL AND t.provider_id IS NULL
          AND p.default_provider_id IS NULL AND t.agent = ?`,
      `SELECT s.model AS model
         FROM schedules s JOIN projects p ON p.id = s.project_id
        WHERE s.model IS NOT NULL AND s.provider_id IS NULL
          AND p.default_provider_id IS NULL AND s.agent = ?`,
      `SELECT r.model AS model
         FROM runbooks r JOIN projects p ON p.id = r.project_id
        WHERE r.model IS NOT NULL AND r.provider_id IS NULL
          AND p.default_provider_id IS NULL AND r.agent = ?`,
    ];
    for (const sql of inheritedQueries) {
      const rows = db.prepare(sql).all(provider.bundled) as { model: string }[];
      for (const row of rows) if (row.model) ids.add(row.model);
    }
  }
  return [...ids];
}

/**
 * The row an environment's own login owns, created on demand. Signing in to a
 * CLI is what brings its models along, so lib/agents/connections.ts calls this
 * when a connection is recorded and removeBundledProvider() when one is
 * cleared. An environment with no bundled type (nothing declares one today)
 * gets null and no row.
 */
export function ensureBundledProvider(env: string): ModelProvider | null {
  const type = bundledTypeFor(env);
  if (!type) return null;
  const existing = firstProviderOfType(type);
  if (existing) return existing;
  return createProvider({ type, label: PROVIDER_REGISTRY[type].label });
}

/**
 * Remove the row an environment's login owns. The endpoint and the credential
 * belong to the CLI, so signing out there takes the provider with it, and
 * every task, project, schedule and runbook that named it falls back to its
 * next default through ON DELETE SET NULL.
 */
export function removeBundledProvider(env: string): ProviderUsage | null {
  const type = bundledTypeFor(env);
  if (!type) return null;
  const existing = firstProviderOfType(type);
  if (!existing) return null;
  return deleteProvider(existing.id);
}

/** The bundled row for an environment, without creating one. */
export function bundledProviderFor(env: string): ModelProvider | null {
  const type = bundledTypeFor(env);
  return type ? firstProviderOfType(type) : null;
}

/** Every provider that serves an environment, in list order. */
export function providersForEnvironment(env: EnvironmentId): ModelProvider[] {
  return listProviders().filter((p) => p.environments.includes(env));
}
