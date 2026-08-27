// The schema version stamp and the boot gate on top of it (issue #13 items 3-4).
//
// What's worth pinning here is a failure nobody can see by running the app: an
// operator rolls an image tag BACK after an upgrade, and the older build opens
// a database a newer one already migrated. There is no error to notice — the
// instance just runs against a schema it doesn't understand. So the cases below
// assert the refusal happens, that it happens BEFORE anything is written, and
// that the ordinary directions (fresh install, older database, same version)
// are untouched.
import { describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSchemaVersionSupported, init, migrate } from "@/lib/db";
import {
  SCHEMA_VERSION,
  assertSchemaVersionAtBoot,
  readSchemaVersion,
  schemaTooNew,
} from "@/lib/schema-version.mjs";

const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** A throwaway directory holding a `calandria.db`, resolvable by the boot gate. */
function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-schema-"));
  scratch.push(dir);
  return dir;
}

function openScratchDb(dir: string): Database.Database {
  return new Database(path.join(dir, "calandria.db"));
}

const userVersion = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;

describe("schema version stamp", () => {
  it("stamps the current version at the end of migrate()", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    // The bare shape migrate() needs to run over — everything it touches is
    // guarded by table_info/IF NOT EXISTS, so an empty file is a legal input.
    init(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("moves an unstamped (pre-gate) database forward rather than refusing it", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    init(db);
    // Every database written before this feature existed reads back as 0.
    db.pragma("user_version = 0");
    expect(userVersion(db)).toBe(0);

    migrate(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("survives the backup snapshot, which is what a rollback restores", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    init(db);
    const snap = path.join(dir, "snapshot.db");
    // VACUUM INTO is exactly what scripts/backup.mjs does; user_version lives in
    // the file header, and a stamp that didn't travel with the snapshot would
    // make the restore half of the rollback runbook a coin flip.
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    db.close();

    expect(readSchemaVersion(snap)).toBe(SCHEMA_VERSION);
  });
});

describe("boot gate", () => {
  it("refuses a database stamped newer than this build understands", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    init(db);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => assertSchemaVersionAtBoot(dir)).toThrow(/newer version of Calandria/i);
  });

  it("says what to do about it: the newer tag, or the pre-upgrade backup", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    init(db);
    db.pragma(`user_version = ${SCHEMA_VERSION + 4}`);
    db.close();

    let message = "";
    try {
      assertSchemaVersionAtBoot(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    // Both numbers, so "newer" is checkable rather than asserted...
    expect(message).toContain(`${SCHEMA_VERSION + 4}`);
    expect(message).toContain(`${SCHEMA_VERSION}`);
    // ...and both exits, since the refusal is all the operator gets: the app
    // never boots far enough to serve a page explaining itself.
    expect(message).toContain("CALANDRIA_IMAGE");
    expect(message).toContain("docs/SELF_HOSTING.md");
  });

  it("refuses BEFORE writing anything, so the older build leaves no trace", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    // A database from the future that this build has never seen the schema of.
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);

    expect(() => init(db)).toThrow(/newer version of Calandria/i);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables).toEqual([]);
    // Not even the journal mode: the gate runs ahead of every pragma init sets.
    expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
    db.close();
  });

  it("lets an older-or-equal stamp through, in both directions", () => {
    const dir = scratchDir();
    const db = openScratchDb(dir);
    init(db);

    // Equal: the ordinary restart.
    expect(() => assertSchemaVersionSupported(db)).not.toThrow();
    expect(() => assertSchemaVersionAtBoot(dir)).not.toThrow();

    // Older: the ordinary upgrade — additive migrations bring it forward.
    db.pragma("user_version = 0");
    expect(() => assertSchemaVersionSupported(db)).not.toThrow();
    expect(assertSchemaVersionAtBoot(dir)).toBe(0);
    db.close();
  });

  it("is a no-op on a fresh install, where there is no database yet", () => {
    const dir = scratchDir();
    expect(readSchemaVersion(path.join(dir, "calandria.db"))).toBeNull();
    expect(assertSchemaVersionAtBoot(dir)).toBeNull();
  });

  it("treats an unreadable stamp as nothing to say, not as a refusal", () => {
    // A backup can never stop the app from booting, and neither can a file this
    // gate can't parse — the real open in lib/db.ts reports that properly.
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "calandria.db"), "not a database at all");
    expect(schemaTooNew(readSchemaVersion(path.join(dir, "calandria.db")))).toBe(false);
    expect(() => assertSchemaVersionAtBoot(dir)).not.toThrow();
  });
});
