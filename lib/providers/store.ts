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
