/* The server-side writer for the advanced-settings file, and the presented
 * view the browser and the agent tools read.
 *
 * One file, `advanced-environment.json`, beside the resolved database, holds
 * both scopes. It is a file and not a table because the app scope is needed
 * before the database opens. The path is resolved through lib/storage.mjs on
 * every call, so a test that points CALANDRIA_DB_DIR somewhere else is
 * honored without a module reload.
 *
 * Writes are serialized by being synchronous: every mutation reads, checks the
 * expected revision, writes and renames inside one synchronous block, so no
 * other turn of the event loop can interleave a read-modify-write. The
 * database ownership lock (lib/db-lock.mjs) keeps this the only writing
 * process on the instance.
 *
 * A write goes to a restricted temporary sibling and is renamed over the
 * target, so a failed write leaves the previous complete file in place. No
 * value and no secret name is ever logged or attached to an error.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveDbLocation } from "../storage.mjs";
import { restrictSecretFile, writeSecretFile } from "../secretFile";
import {
  advancedEnvPath,
  emptyEnvironment,
  readEnvironmentFile,
} from "./disk.mjs";
import {
  findDuplicateRow,
  lookupDescriptor,
  redactStoredVariable,
  validateNameForScope,
  validateValue,
} from "./catalog.mjs";
import type {
  AppliedAppEnvironment,
  CreateEnvironmentInput,
  DeleteEnvironmentInput,
  EnvScope,
  PatchEnvironmentInput,
  PresentedVariable,
  StoredEnvironment,
  StoredVariable,
} from "./types";

const ADVICE = "Check the ownership and permissions of the Calandria data directory.";

/** The process-local slot lib/advanced-env/bootstrap.mjs publishes at boot. */
export const APPLIED_ENV_SLOT = Symbol.for("calandria.advancedEnvironment");

/**
 * How the store learns what boot actually applied and what the launch
 * environment held before the overlay. Task 3 installs the real adapter; until
 * then the default reports no applied overlay, which is the truth on an
 * instance whose entrypoints do not load the file yet.
 */
export type RuntimeStateAdapter = {
  appliedAppEnvironment(): AppliedAppEnvironment | null;
  hostEnv(): Record<string, string | undefined>;
};

const defaultAdapter: RuntimeStateAdapter = {
  appliedAppEnvironment() {
    const slot = (globalThis as Record<symbol, unknown>)[APPLIED_ENV_SLOT];
    return (slot as AppliedAppEnvironment | undefined) ?? null;
  },
  hostEnv() {
    return process.env;
  },
};

let adapter: RuntimeStateAdapter = defaultAdapter;

/** Install a runtime-state adapter. Passing null restores the default. */
export function setRuntimeStateAdapter(next: RuntimeStateAdapter | null): void {
  adapter = next ?? defaultAdapter;
}

/** The IO the writer performs, injectable so tests can fail a write or a
 * rename without depending on the process being unprivileged. */
export type StoreIo = {
  writeRestricted(filePath: string, contents: string): void;
  rename(from: string, to: string): void;
  restrict(filePath: string): void;
};

const defaultIo: StoreIo = {
  writeRestricted(filePath, contents) {
    writeSecretFile(filePath, contents, { advice: ADVICE });
  },
  rename(from, to) {
    fs.renameSync(from, to);
  },
  restrict(filePath) {
    restrictSecretFile(filePath, { advice: ADVICE });
  },
};

let io: StoreIo = defaultIo;

/** Install write IO. Passing null restores the real filesystem. */
export function setStoreIo(next: StoreIo | null): void {
  io = next ?? defaultIo;
}

/** The settings file for this instance. */
export function environmentFilePath(): string {
  return advancedEnvPath(resolveDbLocation().dir);
}

export type StoreFailure = {
  ok: false;
  status: 400 | 404 | 409 | 500;
  code:
    | "invalid_name"
    | "reserved_name"
    | "provider_owned"
    | "unsupported_name"
    | "wrong_scope"
    | "invalid_value"
    | "duplicate_name"
    | "not_found"
    | "revision_conflict"
    | "confirm_expose"
    | "storage";
  reason: string;
  currentRevision?: number;
};

export type MutationResult = { ok: true; row: PresentedVariable | null; revision: number } | StoreFailure;

function failure(status: StoreFailure["status"], code: StoreFailure["code"], reason: string, currentRevision?: number): StoreFailure {
  return currentRevision === undefined
    ? { ok: false, status, code, reason }
    : { ok: false, status, code, reason, currentRevision };
}

/** Read the saved store. A corrupt file yields a redacted error and blocks
 * every write until it is repaired. */
function load(): { store: StoredEnvironment | null; error: string | null } {
  const { store, error } = readEnvironmentFile(environmentFilePath());
  return { store, error };
}

function persist(store: StoredEnvironment): StoreFailure | null {
  const target = environmentFilePath();
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const contents = JSON.stringify(store, null, 2) + "\n";
  try {
    io.writeRestricted(tmp, contents);
    io.rename(tmp, target);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* The temporary file is already gone, or the directory is unwritable. */
    }
    return failure(500, "storage", "The settings file could not be written. The previous settings are unchanged.");
  }
  try {
    // A rename carries the POSIX mode across, and re-running the restriction
    // covers the Windows ACL, which is attached to the path.
    io.restrict(target);
  } catch {
    /* The file is written with an owner-only mode already; a failed
     * re-restriction is not worth discarding a successful save. */
  }
  return null;
}

/* Host precedence: a canonical name or its ORCH_ alias that the launch
 * environment sets to a non-blank value shadows the saved row, following the
 * blank-counts-as-unset rule in lib/env.mjs. */
function aliasesOf(name: string): string[] {
  const upper = name.toUpperCase();
  if (upper.startsWith("CALANDRIA_")) return [name, "ORCH_" + name.slice("CALANDRIA_".length)];
  if (upper.startsWith("ORCH_")) return [name, "CALANDRIA_" + name.slice("ORCH_".length)];
  return [name];
}

function hostShadows(name: string, applied: AppliedAppEnvironment, hostEnv: Record<string, string | undefined>): boolean {
  for (const alias of aliasesOf(name)) {
    if (Object.prototype.hasOwnProperty.call(applied.applied, alias)) return false;
    const fromPre = Object.prototype.hasOwnProperty.call(applied.preOverlay, alias)
      ? applied.preOverlay[alias]
      : hostEnv[alias];
    if (fromPre) return true;
  }
  return false;
}

function appliedState(): AppliedAppEnvironment {
  return (
    adapter.appliedAppEnvironment() ?? { appliedRevision: 0, applied: {}, preOverlay: {}, loadError: null }
  );
}

export type EnvironmentView = {
  rows: PresentedVariable[];
  revision: number;
  restartRequired: boolean;
  loadError: string | null;
};

/**
 * The redacted list, with the effective app state computed against whatever
 * boot applied. With no boot overlay applied, every saved app row that the
 * host does not shadow still needs a restart, which is accurate.
 */
export function listEnvironment(scope?: EnvScope): EnvironmentView {
  const { store, error } = load();
  if (!store) return { rows: [], revision: 0, restartRequired: false, loadError: error };

  const applied = appliedState();
  const hostEnv = adapter.hostEnv();
  const shadowed = new Map<string, boolean>();
  for (const row of store.rows) {
    if (row.scope === "app") shadowed.set(row.id, hostShadows(row.name, applied, hostEnv));
  }

  const desired = new Map<string, string>();
  for (const row of store.rows) {
    if (row.scope === "app" && !shadowed.get(row.id)) desired.set(row.name, row.value);
  }
  let restartRequired = desired.size !== Object.keys(applied.applied).length;
  if (!restartRequired) {
    for (const [name, value] of desired) {
      if (applied.applied[name] !== value) {
        restartRequired = true;
        break;
      }
    }
  }

  const rows = store.rows
    .filter((row) => !scope || row.scope === scope)
    .map((row) => redactStoredVariable(row, { overriddenByHost: !!shadowed.get(row.id) }));

  return { rows, revision: store.revision, restartRequired, loadError: applied.loadError ?? error };
}

/** One redacted row by id, or null. */
export function getEnvironmentRow(id: string): PresentedVariable | null {
  const view = listEnvironment();
  return view.rows.find((row) => row.id === id) ?? null;
}

function checkName(name: string, scope: EnvScope, rows: readonly StoredVariable[], excludeId?: string): StoreFailure | null {
  const named = validateNameForScope(name, scope);
  if (!named.ok) return failure(400, named.code as StoreFailure["code"], named.reason);
  if (findDuplicateRow(rows, scope, name, excludeId)) {
    return failure(409, "duplicate_name", `A ${scope} variable with that name already exists.`);
  }
  return null;
}

function checkValue(name: string, value: string): StoreFailure | null {
  const checked = validateValue(lookupDescriptor(name), value);
  if (!checked.ok) return failure(400, "invalid_value", checked.reason);
  return null;
}

function openForWrite(expectedRevision: number): { store: StoredEnvironment } | StoreFailure {
  const { store, error } = load();
  if (!store) return failure(500, "storage", error || "The settings file could not be read.");
  if (!Number.isInteger(expectedRevision)) return failure(400, "revision_conflict", "expectedRevision must be an integer.");
  if (expectedRevision !== store.revision) {
    return failure(409, "revision_conflict", "The settings changed since this form was loaded.", store.revision);
  }
  return { store };
}

/** Add a variable. */
export function createVariable(input: CreateEnvironmentInput): MutationResult {
  if (input.scope !== "app" && input.scope !== "agent") return failure(400, "wrong_scope", "scope must be app or agent.");
  const opened = openForWrite(input.expectedRevision);
  if ("ok" in opened) return opened;
  const { store } = opened;

  const nameFailure = checkName(input.name, input.scope, store.rows);
  if (nameFailure) return nameFailure;
  const valueFailure = checkValue(input.name, input.value);
  if (valueFailure) return valueFailure;

  const revision = store.revision + 1;
  const row: StoredVariable = {
    id: randomUUID(),
    scope: input.scope,
    name: input.name,
    value: input.value,
    secret: !!input.secret,
    revision,
  };
  const next: StoredEnvironment = { version: 1, revision, rows: [...store.rows, row] };
  const wrote = persist(next);
  if (wrote) return wrote;
  return { ok: true, row: presentAfterWrite(row), revision };
}

/**
 * Edit a variable. An omitted name or value keeps the stored one, which is how
 * a secret is renamed or has its flag changed without retyping it. An empty
 * string is a replacement value and is distinct from omitting the field.
 * Turning secret off requires `confirmExpose`, since the name and the value
 * become visible in the list.
 */
export function patchVariable(id: string, input: PatchEnvironmentInput): MutationResult {
  if (input.name === null || input.value === null || input.secret === null) {
    return failure(400, "invalid_value", "name, value and secret cannot be null.");
  }
  const opened = openForWrite(input.expectedRevision);
  if ("ok" in opened) return opened;
  const { store } = opened;

  const existing = store.rows.find((row) => row.id === id);
  if (!existing) return failure(404, "not_found", "That variable no longer exists.");

  const name = input.name === undefined ? existing.name : input.name;
  const value = input.value === undefined ? existing.value : input.value;
  const secret = input.secret === undefined ? existing.secret : !!input.secret;

  if (existing.secret && !secret && !input.confirmExpose) {
    return failure(400, "confirm_expose", "Turning secret off reveals the name and value, so it needs confirmation.");
  }

  const nameFailure = checkName(name, existing.scope, store.rows, id);
  if (nameFailure) return nameFailure;
  const valueFailure = checkValue(name, value);
  if (valueFailure) return valueFailure;

  const revision = store.revision + 1;
  const updated: StoredVariable = { ...existing, name, value, secret, revision };
  const next: StoredEnvironment = {
    version: 1,
    revision,
    rows: store.rows.map((row) => (row.id === id ? updated : row)),
  };
  const wrote = persist(next);
  if (wrote) return wrote;
  return { ok: true, row: presentAfterWrite(updated), revision };
}

/** Remove a saved row. The inherited or default behavior applies again. */
export function deleteVariable(id: string, input: DeleteEnvironmentInput): MutationResult {
  const opened = openForWrite(input.expectedRevision);
  if ("ok" in opened) return opened;
  const { store } = opened;

  if (!store.rows.some((row) => row.id === id)) return failure(404, "not_found", "That variable no longer exists.");

  const revision = store.revision + 1;
  const next: StoredEnvironment = { version: 1, revision, rows: store.rows.filter((row) => row.id !== id) };
  const wrote = persist(next);
  if (wrote) return wrote;
  return { ok: true, row: null, revision };
}

function presentAfterWrite(row: StoredVariable): PresentedVariable {
  if (row.scope !== "app") return redactStoredVariable(row);
  return redactStoredVariable(row, { overriddenByHost: hostShadows(row.name, appliedState(), adapter.hostEnv()) });
}

/** The saved rows for one scope, unredacted. Server-side consumers only:
 * boot, the agent snapshot, and nothing that answers a request. */
export function savedRows(scope: EnvScope): StoredVariable[] {
  const { store } = load();
  return (store ?? emptyEnvironment()).rows.filter((row) => row.scope === scope);
}
