// The review schema is additive and idempotent (WC-12): a database stamped at
// the previous version keeps every old row through two migrations, gains the
// review tables and indexes once, and starts with no review requirement.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { init } from "@/lib/db";
import { SCHEMA_VERSION } from "@/lib/schema-version.mjs";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
});

const REVIEW_TABLES = ["review_repositories", "review_artifacts", "review_requests", "review_submissions", "review_actions", "review_applicability_receipts", "review_cleanup_jobs"];

function previousVersionDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calandria-review-mig-"));
  scratch.push(dir);
  const db = new Database(path.join(dir, "calandria.db"));
  init(db);
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Old project', 1)").run();
  db.prepare("INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'Old task', 1, 1)").run();
  for (const t of [...REVIEW_TABLES].reverse()) db.exec(`DROP TABLE ${t}`);
  db.exec("ALTER TABLE tasks DROP COLUMN review_content_epoch");
  db.pragma("user_version = 9");
  return db;
}

const tables = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const indexes = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_review_%'").all() as { name: string }[]).map((r) => r.name).sort();

describe("review schema migration", () => {
  it("upgrades a version-9 database twice without duplicating or losing rows", () => {
    const db = previousVersionDb();
    const before = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as Record<string, unknown>;
    init(db);
    const afterOnce = { tables: tables(db).sort(), indexes: indexes(db), tasks: db.prepare("SELECT COUNT(*) AS n FROM tasks").get(), projects: db.prepare("SELECT COUNT(*) AS n FROM projects").get() };
    init(db);
    const afterTwice = { tables: tables(db).sort(), indexes: indexes(db), tasks: db.prepare("SELECT COUNT(*) AS n FROM tasks").get(), projects: db.prepare("SELECT COUNT(*) AS n FROM projects").get() };
    expect(afterTwice).toEqual(afterOnce);
    for (const t of REVIEW_TABLES) expect(afterTwice.tables).toContain(t);
    expect(afterTwice.indexes).toHaveLength(5);
    const row = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as Record<string, unknown>;
    expect(row).toEqual({ ...before, review_content_epoch: 0 });
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(10);
    for (const t of REVIEW_TABLES) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    db.close();
  });

  it("enforces the contract constraints", () => {
    const db = previousVersionDb();
    init(db);
    const req = (id: string, key: string, over = "") =>
      db.prepare(`INSERT INTO review_requests (id, task_id, owner_task_id, owner_session_id, generation, submitter_agent, kind, output_key, required, state, version, created_at, updated_at)
        VALUES (?, 't1', 't1', 's', 0, 'claude', 'code', ?, 1, 'pending', ${over || 1}, 1, 1)`).run(id, key);
    req("r1", "k");
    expect(() => req("r2", "k")).toThrow(/UNIQUE/);
    expect(() => req("r3", "")).toThrow(/CHECK/);
    expect(() => req("r4", "v", "0")).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO review_artifacts (id, kind, manifest_json, manifest_sha256, document_bytes, created_at) VALUES ('a', 'document', '{}', 'x', NULL, 1)").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO review_artifacts (id, kind, manifest_json, manifest_sha256, document_bytes, created_at) VALUES ('b', 'code', '{}', 'x', x'00', 1)").run()).toThrow(/CHECK/);
    // Deleting the task keeps the request, with the live link cleared and the owner identity intact.
    db.prepare("DELETE FROM tasks WHERE id = 't1'").run();
    expect(db.prepare("SELECT task_id, owner_task_id FROM review_requests WHERE id = 'r1'").get()).toEqual({ task_id: null, owner_task_id: "t1" });
    db.close();
  });
});
