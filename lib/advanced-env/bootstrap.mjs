/* Applies the saved app-scope environment overlay at process start.
 *
 * Plain Node so server.js and pty-server.js can both run it before anything
 * that reads configuration loads. The app scope has to reach `process.env`
 * before lib/config.ts, lib/log.mjs and the auth modules initialize, because
 * those capture their values at import time; both entrypoints await
 * applyAppEnvironment() and only then start their other dynamic imports.
 *
 * Precedence is defaults < saved app values < inherited launch environment.
 * A name the launch environment already carries (under its canonical spelling
 * or its pre-rename ORCH_ alias, blank counting as unset the way lib/env.mjs
 * reads it) keeps the launch value, and the saved row is reported as shadowed
 * by the host. The desktop environment file (desktop/env-file.js) is part of
 * that inherited layer, so a variable set there still wins.
 *
 * What the overlay changed is published on
 * `globalThis[Symbol.for("calandria.advancedEnvironment")]`. The plain Node
 * entrypoint and the Next bundle each load their own copy of the module
 * graph, so a module-local variable would be invisible to the other realm;
 * the well-known symbol is the one slot both see. It is process-local state,
 * never serialized and never returned by an API: it carries pre-overlay
 * values, which include secrets the launch environment held.
 *
 * Agent turns need the inherited environment back, without the app overlay on
 * top of it, so restoreAppOverlay() undoes the overlay against a copy. An
 * app-only secret must not reach a child session just because the server
 * process happens to carry it.
 */

import { resolveDbLocation } from "../storage.mjs";
import { readEnv } from "../env.mjs";
import { advancedEnvPath, readEnvironmentFile } from "./disk.mjs";
import { validateNameForScope } from "./catalog.mjs";

/** The slot lib/advanced-env/store.ts reads through its runtime-state adapter. */
export const APPLIED_ENV_SLOT = Symbol.for("calandria.advancedEnvironment");

const EMPTY = () => ({
  appliedRevision: 0,
  applied: Object.create(null),
  preOverlay: Object.create(null),
  loadError: null,
});

/**
 * What this process applied at boot, or null when no entrypoint has run the
 * bootstrap. Null and "applied nothing" are different: the store reports every
 * saved app row as needing a restart in the first case, which is accurate.
 *
 * @returns {import("./types").AppliedAppEnvironment | null}
 */
export function appliedAppEnvironment() {
  const slot = globalThis[APPLIED_ENV_SLOT];
  return slot === undefined ? null : slot;
}

/** Publish the applied state where every realm in this process can read it. */
function publish(state) {
  globalThis[APPLIED_ENV_SLOT] = state;
  return state;
}

/**
 * The settings file for this instance, resolved the same way the database is.
 * Takes an explicit environment so a sidecar can be handed the deployment
 * inputs it was launched with.
 *
 * @param {{ env?: Record<string, string | undefined>, dbDir?: string }} [opts]
 */
export function environmentFilePathFor({ env = process.env, dbDir } = {}) {
  return advancedEnvPath(dbDir || resolveDbLocation(readEnv("CALANDRIA_DB_DIR", env)).dir);
}

/**
 * Read the saved app rows and apply the ones the launch environment does not
 * already set. Safe to call twice in one process: the previous overlay is
 * removed first, so the second pass sees the same inherited baseline as the
 * first and pre-overlay values never accumulate.
 *
 * Never throws. A missing file means no saved settings. A malformed or
 * unreadable file leaves the environment untouched and records a redacted
 * `loadError`, so boot continues and Settings shows the diagnostic.
 *
 * @param {{ env?: Record<string, string | undefined>, dbDir?: string, filePath?: string }} [opts]
 * @returns {import("./types").AppliedAppEnvironment}
 */
export function applyAppEnvironment({ env = process.env, dbDir, filePath } = {}) {
  const previous = appliedAppEnvironment();
  if (previous) restoreInto(env, previous);

  let target;
  try {
    target = filePath || environmentFilePathFor({ env, dbDir });
  } catch (e) {
    return publish({ ...EMPTY(), loadError: `The Calandria data directory could not be resolved (${codeOf(e)}).` });
  }

  const { store, error } = readEnvironmentFile(target);
  if (!store) return publish({ ...EMPTY(), loadError: error });

  const applied = Object.create(null);
  const preOverlay = Object.create(null);
  let rejected = 0;

  for (const row of store.rows) {
    if (row.scope !== "app") continue;
    // A hand-edited file is the only way a reserved name reaches this point,
    // and the reserved set holds PORT, HOME, LD_PRELOAD and the rest of the
    // loader and identity inputs. Re-check the same rule the write path
    // enforces instead of trusting the file.
    if (!validateNameForScope(row.name, "app").ok) {
      rejected += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(applied, row.name)) continue;
    if (readEnv(row.name, env) !== undefined) continue;

    preOverlay[row.name] = env[row.name];
    env[row.name] = row.value;
    applied[row.name] = row.value;
  }

  return publish({
    appliedRevision: store.revision,
    applied,
    preOverlay,
    // Counts only. A rejected row's name is as sensitive as a secret row's.
    loadError: rejected
      ? `${rejected} saved app variable(s) are not applicable and were skipped. Remove or rename them in Settings.`
      : null,
  });
}

/**
 * The inherited environment as it stood before the app overlay, as a fresh
 * null-prototype copy. Agent turns compose on top of this so an app-only
 * value, secret or not, does not leak into a child session.
 *
 * @param {Record<string, string | undefined>} env
 * @param {import("./types").AppliedAppEnvironment | null} [state]
 * @returns {Record<string, string>}
 */
export function restoreAppOverlay(env = process.env, state = appliedAppEnvironment()) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  if (state) restoreInto(out, state);
  return out;
}

/** Put `state`'s pre-overlay values back, in place. */
function restoreInto(env, state) {
  for (const name of Object.keys(state.applied || {})) {
    const before = state.preOverlay ? state.preOverlay[name] : undefined;
    if (before === undefined) delete env[name];
    else env[name] = before;
  }
}

function codeOf(e) {
  return e && e.code ? e.code : "unknown";
}
