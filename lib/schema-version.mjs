/* The schema version stamp, and the boot gate that reads it.
 *
 * WHY: migrations here are additive and idempotent, so rolling an image tag
 * forward is safe: an older database picks up the new columns on the next
 * boot. Rolling backward is not, since an older build has no way to know
 * what a newer one added, dropped, or backfilled, and will open the database
 * and keep writing to it anyway. Nothing errors; the instance runs against a
 * schema it does not understand, and whatever the newer build wrote is at
 * the mercy of the older one. `docker compose pull` of a previous tag must
 * fail cleanly instead, which is what this file is for.
 *
 * HOW: `PRAGMA user_version` is a 32-bit integer in the SQLite file header
 * that SQLite itself never touches, so it costs nothing and travels with the
 * file through VACUUM INTO (i.e. through `npm run backup`'s snapshot).
 * migrate() stamps SCHEMA_VERSION at its end; boot refuses when the stamp it
 * reads is greater than the constant this build was compiled with.
 * Older-or-equal proceeds as the ordinary upgrade path, which the migrations
 * make safe.
 *
 * The gate is one-directional. A version floor ("this build is too new for
 * that database") would be wrong: additive migrations make any older
 * database upgradable, and there is no oldest supported stamp.
 *
 * Plain .mjs because server.js is CommonJS and can't import TS. It runs the
 * gate right after claiming the boot lock, so the refusal is a boot failure
 * with a message instead of a 500 on the first request that reaches getDb().
 * lib/db.ts imports the same constant and the same message, so an in-process
 * open (next build, the test suite, a stray script) is gated identically.
 * Being loaded by server.js un-bundled means it must be COPY'd into the
 * runtime image; see the Dockerfile.
 */

import Database from "better-sqlite3";

import { resolveDbLocation } from "./storage.mjs";

/**
 * Bump this in the same commit as any change to the schema in lib/db.ts: a
 * new table, a new column, a new index, a backfill. The number is not a
 * feature version and has nothing to do with the app's semver; it only
 * answers "would an older build recognize this database?", and the answer
 * is no the moment the schema moves. Under-bumping risks a data-losing
 * rollback that produces no warning; over-bumping produces a refusal an
 * operator can undo by re-pinning the tag they were already on.
 *
 * 1 - first stamped version (Calandria 0.3.x). Everything written before
 *     this existed reads back as 0, which is "older", which upgrades
 *     normally.
 * 2 - projects.landing_mode ('merge' | 'pr'): whether a project's work lands
 *     by local merge or by pull request.
 * 3 - projects.auto_reclaim: reclaim a task's worktree and local branch
 *     automatically once its work lands (lib/reclaim.ts).
 * 4 - task_usage.cost_usd widened to NULLable, NULL meaning "this endpoint's
 *     price is unknown" (a custom base URL) as distinct from a measured
 *     zero. The only stamp so far that is not purely additive: the column
 *     is rebuilt, and an older build would both re-impose NOT NULL on the
 *     next boot it migrates and read a NULL back as a number it isn't.
 */
export const SCHEMA_VERSION = 4;

/** True when a database stamped `found` is newer than this build understands. */
export function schemaTooNew(found) {
  return Number.isInteger(found) && found > SCHEMA_VERSION;
}

/**
 * The refusal an operator sees. It has to answer "what do I do now?" without
 * a browser, since the app never got far enough to serve one, so it names
 * both ways out: forward to the tag they came from, or back via the
 * pre-upgrade backup.
 */
export function schemaTooNewMessage(found, dbPath) {
  return [
    `Refusing to start: ${dbPath} was written by a NEWER version of Calandria.`,
    ``,
    `  database schema version: ${found}`,
    `  this build understands:  ${SCHEMA_VERSION}`,
    ``,
    `A newer build has already migrated this database. This build does not know what`,
    `it changed, and would keep writing to it anyway. That could lose or corrupt whatever`,
    `the newer version stored. Hence a refusal rather than a warning.`,
    ``,
    `Two ways out:`,
    `  1. Go back to the newer image tag you were running, e.g.`,
    `     CALANDRIA_IMAGE=ghcr.io/calandria-dev/calandria:0.3.0`,
    `     docker compose pull && docker compose up -d --no-build`,
    `  2. Or stay on this build and restore the backup you took before the upgrade:`,
    `     see "Rolling back an upgrade" in docs/SELF_HOSTING.md.`,
  ].join("\n");
}

/**
 * Read the stamp from a database file without taking any application lock or
 * touching WAL. Returns 0 for a database that has never been stamped, and
 * `null` when the file isn't there or can't be read: a fresh install has no
 * file yet, and an unreadable one is a problem for the open in lib/db.ts to
 * report properly instead of for this gate to guess at.
 */
export function readSchemaVersion(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db.pragma("user_version", { simple: true });
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/**
 * The boot gate. Throws with `schemaTooNewMessage()` when the database on
 * disk is stamped newer than this build; returns the stamp otherwise (null
 * when there's nothing to read yet). `explicitDir` is the already-resolved
 * directory server.js got from the lock, so the gate and the lock can't
 * disagree about which database is in play.
 */
export function assertSchemaVersionAtBoot(explicitDir) {
  const { path: dbPath } = resolveDbLocation(explicitDir);
  const found = readSchemaVersion(dbPath);
  if (schemaTooNew(found)) throw new Error(schemaTooNewMessage(found, dbPath));
  return found;
}
