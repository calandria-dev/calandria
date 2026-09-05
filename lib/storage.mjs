/* Where Calandria's on-disk state lives, and how a pre-rename install still
 * finds it.
 *
 * Database and worktrees default under `~/.calandria`. An older install may
 * still have `~/.zen-orchestrator/orchestrator.db` or
 * `~/.agent-orchestrator/worktrees`; existing data is never moved, since a
 * worktree is registered by absolute path inside its project repo's .git and
 * relocating one needs a `git worktree repair` run by hand.
 *
 * Resolution lives here for lib/config.ts, lib/db-lock.mjs and
 * docker/entrypoint.sh to share. Plain .mjs so the CommonJS entrypoints can
 * import it; must be COPY'd into the runtime image (see the Dockerfile).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnv } from "./env.mjs";

/** The database file this fork writes. */
export const DB_FILE = "calandria.db";
/** Legacy database file name. Read, never written to a fresh dir. */
export const LEGACY_DB_FILE = "orchestrator.db";

const defaultDbDir = () => path.join(os.homedir(), ".calandria");
const legacyDbDir = () => path.join(os.homedir(), ".zen-orchestrator");
const defaultWorktreesDir = () => path.join(os.homedir(), ".calandria", "worktrees");
const legacyWorktreesDir = () => path.join(os.homedir(), ".agent-orchestrator", "worktrees");

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Which database file `dir` already holds, preferring ours. Null if neither. */
function existingDbFile(dir) {
  if (exists(path.join(dir, DB_FILE))) return DB_FILE;
  if (exists(path.join(dir, LEGACY_DB_FILE))) return LEGACY_DB_FILE;
  return null;
}

/**
 * The boot mutex's two files, named after whichever database they guard, so
 * an older build still holding `orchestrator.lock.db` contends for the same
 * file instead of claiming a differently-named one beside it. Both are pure
 * locks; neither holds data.
 */
export function lockFilesFor(dbFile) {
  const stem = dbFile === LEGACY_DB_FILE ? "orchestrator" : "calandria";
  return { lock: `${stem}.lock.db`, sidecar: `${stem}.lock.json` };
}

/**
 * Where the database is: `{ dir, file, path, legacyDir, legacyFile }`. The
 * two `legacy*` flags say whether the old location or old file name is in
 * use, and so whether there's anything to tell the user.
 *
 * `explicitDir` (or CALANDRIA_DB_DIR) pins the directory; only the file name
 * falls back.
 */
export function resolveDbLocation(explicitDir) {
  const explicit = explicitDir || readEnv("CALANDRIA_DB_DIR");
  if (explicit) {
    const dir = path.resolve(explicit);
    const file = existingDbFile(dir) ?? DB_FILE;
    return { dir, file, path: path.join(dir, file), legacyDir: false, legacyFile: file === LEGACY_DB_FILE };
  }

  const dir = defaultDbDir();
  const file = existingDbFile(dir);
  if (file) {
    return { dir, file, path: path.join(dir, file), legacyDir: false, legacyFile: file === LEGACY_DB_FILE };
  }

  // Nothing at the new default: adopt the old location only if it holds a
  // database file. Checking the file, not the directory, lets the container
  // entrypoint pre-create an empty ~/.calandria without stranding existing data.
  const old = legacyDbDir();
  if (exists(path.join(old, LEGACY_DB_FILE))) {
    return {
      dir: old,
      file: LEGACY_DB_FILE,
      path: path.join(old, LEGACY_DB_FILE),
      legacyDir: true,
      legacyFile: true,
    };
  }

  return { dir, file: DB_FILE, path: path.join(dir, DB_FILE), legacyDir: false, legacyFile: false };
}

/** True if `dir` exists and holds at least one entry. */
function hasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Where per-task worktrees go: `{ dir, legacyDir }`.
 *
 * The old directory wins only when populated: an empty leftover is
 * abandoned, but a checkout there is registered by absolute path inside its
 * project repo and can't be moved from here.
 */
export function resolveWorktreesDir() {
  const explicit = readEnv("CALANDRIA_WORKTREES_DIR");
  if (explicit) return { dir: explicit, legacyDir: false };
  const old = legacyWorktreesDir();
  if (hasEntries(old)) return { dir: old, legacyDir: true };
  return { dir: defaultWorktreesDir(), legacyDir: false };
}

/**
 * One line naming any legacy location still in use, or null. Printed once at
 * boot by server.js, the only heads-up an operator gets that they're running
 * on pre-rename paths. Never turns into an automatic move.
 */
export function legacyStorageWarning() {
  const db = resolveDbLocation();
  const worktrees = resolveWorktreesDir();
  const parts = [];
  if (db.legacyDir || db.legacyFile) {
    // A pinned dir holding the old FILE name moves within that dir, since the
    // default dir would walk the operator out of the one they configured.
    const target = db.legacyDir ? path.join(defaultDbDir(), DB_FILE) : path.join(path.dirname(db.path), DB_FILE);
    parts.push(
      `using legacy ${db.path}; move it to ${target} when convenient ` +
        `(stop the app, mv the file, see docs/SELF_HOSTING.md)`,
    );
  }
  if (worktrees.legacyDir) {
    parts.push(
      `per-task worktrees are still under the legacy ${worktrees.dir}; ` +
        `git registers them by absolute path, so they are left alone`,
    );
  }
  return parts.length ? parts.join(" | ") : null;
}
