/* Where Calandria's on-disk state lives — and how an install that predates the
 * rename keeps finding it.
 *
 * The unconfigured defaults used to be two different legacy names, neither of
 * them the product's: `~/.zen-orchestrator/orchestrator.db` for the database
 * and `~/.agent-orchestrator/worktrees` for the per-task checkouts. Both now
 * default under `~/.calandria`.
 *
 * NOTHING IS EVER MOVED. A rename that relocates a running instance's database
 * behind its back is indistinguishable, from the user's side, from an instance
 * that lost every project and task — so the rule here is "keep using what's
 * already there, and say so once at boot". The worktrees half is not merely a
 * preference: git records a worktree by ABSOLUTE path in the parent repo's
 * .git/worktrees/<id>/gitdir, so relocating the directory would need a
 * `git worktree repair` run inside every project repo. That's a decision for
 * the operator, not a side effect of upgrading.
 *
 * Resolution, in one place because three consumers have to agree about it:
 * lib/config.ts (the app), lib/db-lock.mjs (the boot mutex, loaded by server.js
 * through Node's ESM loader before Next exists) and docker/entrypoint.sh (which
 * mirrors the mkdir). Plain .mjs for the same reason lib/env.mjs is: the
 * CommonJS entrypoints can't read TS. It must be COPY'd into the runtime image
 * (see the Dockerfile) or the container fails to boot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnv } from "./env.mjs";

/** The database file this fork writes. */
export const DB_FILE = "calandria.db";
/** What it was called before the rename. Read, never written to a fresh dir. */
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
 * The boot mutex's two files, named after whichever database they guard.
 *
 * Pairing them is what keeps mutual exclusion intact ACROSS the upgrade: an
 * older build still running holds `orchestrator.lock.db`, so a new build that
 * resolved to `orchestrator.db` has to contend for that same file rather than
 * quietly claiming a differently-named one beside it and running as a second
 * writer. (Both are pure locks — they hold no data we ever read.)
 */
export function lockFilesFor(dbFile) {
  const stem = dbFile === LEGACY_DB_FILE ? "orchestrator" : "calandria";
  return { lock: `${stem}.lock.db`, sidecar: `${stem}.lock.json` };
}

/**
 * Where the database is. Returns `{ dir, file, path, legacyDir, legacyFile }`,
 * where the two `legacy*` flags say whether the old *location* / old *file
 * name* is the one in use (i.e. whether there's anything to tell the user).
 *
 * `explicitDir` (or CALANDRIA_DB_DIR) pins the directory and only the file name
 * falls back — an operator who set the var already said where the data lives,
 * so the search never leaves it.
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

  // Nothing at the new default: adopt the old one if it actually has a database.
  // Checking for the FILE, not the directory, is what lets the container's
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
 * Where per-task worktrees go. Returns `{ dir, legacyDir }`.
 *
 * The old directory wins only when it's actually populated: an empty leftover
 * is worth abandoning, but a checkout in there is registered by absolute path
 * inside its project repo and cannot be moved from this side.
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
 * boot by server.js — beside the ORCH_* deprecation notice, and for the same
 * reason: it is the only heads-up an operator gets that they are running on
 * pre-rename paths, and it must never turn into an automatic move.
 */
export function legacyStorageWarning() {
  const db = resolveDbLocation();
  const worktrees = resolveWorktreesDir();
  const parts = [];
  if (db.legacyDir || db.legacyFile) {
    parts.push(
      `using legacy ${db.path}; move it to ${path.join(defaultDbDir(), DB_FILE)} when convenient ` +
        `(stop the app, mv the file — see docs/SELF_HOSTING.md)`,
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
