/* The plain-Node reader for the advanced-settings file.
 *
 * This is the half of the store that boot needs: server.js and pty-server.js
 * read the saved app overlay before Next exists, so the reader carries no
 * imports from lib/ beyond node builtins and takes an explicit file path. The
 * writer lives in ./store.ts, which the server process owns alone.
 *
 * Nothing here logs file contents. A malformed file is reported by position
 * (`rows[2].value`) with no name and no value in the message, because a row
 * can hold a secret whose name is also hidden.
 *
 * Plain .mjs on purpose: it must stay importable by both CommonJS entrypoints
 * and be COPY'd into the runtime image (Dockerfile).
 */

import fs from "node:fs";
import path from "node:path";

export const ADVANCED_ENV_FILE = "advanced-environment.json";

/** The settings file beside a resolved database directory. @param {string} dir */
export function advancedEnvPath(dir) {
  return path.join(dir, ADVANCED_ENV_FILE);
}

/** A fresh empty store. Callers get their own copy, never a shared literal. */
export function emptyEnvironment() {
  return { version: 1, revision: 0, rows: [] };
}

const SCOPES = new Set(["app", "agent"]);

/** @param {unknown} value */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse the file's text into a store. Structure only: names and values are
 * checked for type here and for policy in ./catalog.mjs, so a file written by
 * an older build with a name this build now reserves still loads.
 *
 * @param {string} text
 * @returns {{ ok: true, store: { version: 1, revision: number, rows: any[] } }
 *          | { ok: false, error: string }}
 */
export function parseEnvironment(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "advanced-environment.json is not valid JSON." };
  }
  if (!isPlainObject(data)) return { ok: false, error: "advanced-environment.json is not an object." };
  if (data.version !== 1) {
    return { ok: false, error: `advanced-environment.json has unsupported version ${JSON.stringify(data.version)}.` };
  }
  if (!Number.isInteger(data.revision) || data.revision < 0) {
    return { ok: false, error: "advanced-environment.json has an invalid revision." };
  }
  if (!Array.isArray(data.rows)) return { ok: false, error: "advanced-environment.json has no rows array." };

  const rows = [];
  const seenIds = new Set();
  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    const bad = (field) => ({ ok: false, error: `advanced-environment.json has an invalid rows[${i}].${field}.` });
    if (!isPlainObject(row)) return bad("entry");
    if (typeof row.id !== "string" || !row.id) return bad("id");
    if (seenIds.has(row.id)) return bad("id");
    if (!SCOPES.has(row.scope)) return bad("scope");
    if (typeof row.name !== "string" || !row.name) return bad("name");
    if (typeof row.value !== "string") return bad("value");
    if (typeof row.secret !== "boolean") return bad("secret");
    if (!Number.isInteger(row.revision) || row.revision < 0) return bad("revision");
    seenIds.add(row.id);
    rows.push({
      id: row.id,
      scope: row.scope,
      name: row.name,
      value: row.value,
      secret: row.secret,
      revision: row.revision,
    });
  }
  return { ok: true, store: { version: 1, revision: data.revision, rows } };
}

/**
 * Read the file at `filePath`.
 *
 * A missing file means empty settings, which is the first-boot state and not
 * an error. Malformed or unsupported data returns the store as null with a
 * redacted error; the caller keeps the file and blocks writes until it is
 * repaired. A read that fails for any other reason (permissions, IO) is
 * reported the same way, so boot can continue with no overlay and a visible
 * diagnostic.
 *
 * @param {string} filePath
 * @returns {{ store: { version: 1, revision: number, rows: any[] } | null,
 *             error: string | null, missing: boolean }}
 */
export function readEnvironmentFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { store: emptyEnvironment(), error: null, missing: true };
    return { store: null, error: `advanced-environment.json could not be read (${e && e.code ? e.code : "unknown"}).`, missing: false };
  }
  const parsed = parseEnvironment(text);
  if (!parsed.ok) return { store: null, error: parsed.error, missing: false };
  return { store: parsed.store, error: null, missing: false };
}

/**
 * The app-scope overlay a boot loader applies: canonical name to literal
 * value, in file order. Null-prototype so a stored `__proto__` row can never
 * reach Object.prototype through this map.
 *
 * @param {{ rows: any[] } | null} store
 * @param {"app" | "agent"} scope
 */
export function overlayFor(store, scope) {
  const out = Object.create(null);
  for (const row of (store && store.rows) || []) {
    if (row.scope === scope) out[row.name] = row.value;
  }
  return out;
}
