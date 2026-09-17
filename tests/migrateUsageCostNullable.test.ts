import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { init, migrate } from "../lib/db";

// task_usage.cost_usd was REAL NOT NULL DEFAULT 0, so there was no way to
// record "this endpoint's price is unknown": a turn against a custom
// provider override was billed a wrong $0 instead. SQLite cannot drop a NOT
// NULL constraint in place, so lib/db.ts rebuilds the table under a guard:
// rename, recreate with cost_usd nullable, copy every row by name in rowid
// order, drop the old table, reindex, all inside one transaction with
// foreign_keys off and restored on in a finally. These tests, following the
// same pattern as tests/migrateBuildingFold.ts, prove the rebuild does not
// lose, reorder or coerce a single row on the way through.

const COLUMNS = [
  "id",
  "project_id",
  "task_id",
  "generation",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "created_at",
  "agent",
  "subagent_tokens",
  "provider",
];

// init() already creates task_usage in the POST-migration (nullable cost_usd)
// shape and runs migrate() once as part of init, which also backfills the
// agent/subagent_tokens/provider columns added by earlier ALTERs. To exercise
// the guarded rebuild for real we have to roll the table back to the exact
// legacy shape the guard keys off (PRAGMA table_info(task_usage).cost_usd.
// notnull), but with those later columns already present. A real pre-upgrade
// database has both facts true at once, since those ALTERs shipped before this
// one.
function legacyDb() {
  const db = new Database(":memory:");
  init(db);
  db.exec("DROP TABLE task_usage");
  db.exec(`
    CREATE TABLE task_usage (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation            INTEGER NOT NULL,
      cost_usd              REAL NOT NULL DEFAULT 0,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      agent                 TEXT NOT NULL DEFAULT '',
      subagent_tokens       INTEGER,
      provider              TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec("CREATE INDEX idx_task_usage_task ON task_usage(task_id)");
  db.exec("CREATE INDEX idx_task_usage_project ON task_usage(project_id)");
  return db;
}

function insertProject(db: Database.Database, id: string, position: number, createdAt: number) {
  db.prepare(
    `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, port, position, created_at)
     VALUES (?, ?, '', '', '#C2603C', '', '', 'main', 0, ?, ?)`
  ).run(id, id.toUpperCase(), position, createdAt);
}

function insertTask(db: Database.Database, id: string, projectId: string, createdAt: number) {
  db.prepare(`INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    projectId,
    id.toUpperCase(),
    createdAt,
    createdAt
  );
}

type Row = [string, string, string, number, number, number, number, number, number, number, string, number | null, string];

// Four rows with distinct values in every column (two projects, two tasks,
// two agents), so a rebuild that mixed up a column or a foreign key would
// show up as a mismatch instead of being masked by repeated values. u1 and
// u4 carry a NULL subagent_tokens (the same "unknown, not zero" shape this
// migration extends to cost_usd), and u3/u4 carry a non-empty provider.
const ROWS: Row[] = [
  ["u1", "p1", "t1", 1, 0.5, 100, 50, 10, 5, 1000, "claude", null, ""],
  ["u2", "p1", "t1", 2, 0, 200, 75, 20, 8, 1001, "claude", 42, ""],
  ["u3", "p2", "t2", 1, 3.75, 300, 125, 30, 12, 1002, "codex", 0, "openrouter"],
  ["u4", "p2", "t2", 1, 1.25, 400, 175, 40, 16, 1003, "codex", null, "vertex"],
];

function seed(db: Database.Database) {
  insertProject(db, "p1", 0, 900);
  insertProject(db, "p2", 1, 901);
  insertTask(db, "t1", "p1", 900);
  insertTask(db, "t2", "p2", 901);
  const insert = db.prepare(`INSERT INTO task_usage (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`);
  for (const row of ROWS) insert.run(...row);
}

// Selected in rowid order (the same order the migration's INSERT...SELECT
// copies in) and as plain objects, so array equality checks both content AND
// order in one assertion.
const snapshot = (db: Database.Database) => db.prepare(`SELECT ${COLUMNS.join(", ")} FROM task_usage ORDER BY rowid`).all();

const costNotNull = (db: Database.Database) =>
  !!(db.prepare("PRAGMA table_info(task_usage)").all() as { name: string; notnull: number }[]).find((c) => c.name === "cost_usd")
    ?.notnull;

// PRAGMA index_list also reports the implicit sqlite_autoindex_* backing the
// TEXT PRIMARY KEY, which the rebuild neither drops nor needs to recreate.
// Filtering it out means this only asserts on the two explicit indexes the
// migration is responsible for.
const indexNames = (db: Database.Database) =>
  (db.prepare("PRAGMA index_list(task_usage)").all() as { name: string }[])
    .map((i) => i.name)
    .filter((n) => !n.startsWith("sqlite_"))
    .sort();

let open: Database.Database | undefined;
afterEach(() => open?.close());

describe("task_usage.cost_usd NOT NULL → nullable rebuild", () => {
  it("rebuilds a legacy NOT NULL table into a nullable one with every row intact, in order", () => {
    const db = (open = legacyDb());
    seed(db);
    expect(costNotNull(db)).toBe(true); // sanity: this really is the pre-migration shape

    const before = snapshot(db);
    migrate(db);

    expect(costNotNull(db)).toBe(false);

    // Row-for-row against the pre-migration snapshot, not a COUNT(*): a rebuild
    // that dropped a row, swapped two columns, or coerced a NULL to 0 would
    // still pass a count check. Comparing the full projected row set in rowid
    // order proves the copy-by-name step moved every value untouched,
    // including the legacy NULL subagent_tokens, which a careless numeric
    // copy could turn into 0, and the row order, since the rebuild assigns
    // the new table fresh rowids as it copies.
    const after = snapshot(db);
    expect(after).toEqual(before);
    expect((after as { id: string }[]).map((r) => r.id)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("recreates both indexes", () => {
    const db = (open = legacyDb());
    seed(db);
    migrate(db);
    expect(indexNames(db)).toEqual(["idx_task_usage_project", "idx_task_usage_task"]);
  });

  it("restores foreign_keys and leaves the database internally consistent", () => {
    const db = (open = legacyDb());
    seed(db);
    migrate(db);

    // foreign_keys is toggled OFF for the rebuild (a rename is otherwise seen
    // mid-flight by FK enforcement) and must come back ON in the finally, or
    // every write after boot would run unchecked.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // The rebuilt rows must still satisfy the constraints the old table
    // enforced; an empty result means no dangling task_id/project_id.
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("lets a NULL cost be inserted post-migration, and SUM skips it", () => {
    const db = (open = legacyDb());
    seed(db);
    migrate(db);

    // Before the migration this INSERT would have thrown NOT NULL constraint
    // failed: task_usage.cost_usd. Widening the column lets it succeed and
    // lets SUM treat the NULL row as absent instead of as $0.
    db.prepare(
      `INSERT INTO task_usage (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`
    ).run("u5", "p1", "t1", 3, 2, 50, 25, 5, 2, 2000, "claude", null, "");
    db.prepare(
      `INSERT INTO task_usage (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`
    ).run("u6", "p1", "t1", 3, null, 50, 25, 5, 2, 2001, "claude", null, "localhost:11434");

    const totals = db
      .prepare(
        `SELECT SUM(cost_usd) AS priced, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknownCount
           FROM task_usage WHERE id IN ('u5', 'u6')`
      )
      .get() as { priced: number; unknownCount: number };
    expect(totals.priced).toBe(2);
    expect(totals.unknownCount).toBe(1);
  });

  it("is idempotent: a second init/migrate does not rebuild or disturb the table again", () => {
    const db = (open = legacyDb());
    seed(db);
    migrate(db);
    const after1 = snapshot(db);

    // Second pass sees cost_usd already nullable, so the guard's `costCol.
    // notnull` check is false and the whole rebuild block is skipped. That is
    // what keeps calling migrate() on every boot safe as well as fast.
    migrate(db);

    expect(costNotNull(db)).toBe(false);
    expect(snapshot(db)).toEqual(after1);
    expect(indexNames(db)).toEqual(["idx_task_usage_project", "idx_task_usage_task"]);
  });

  it("leaves an already-nullable (post-migration) database untouched", () => {
    // A database created fresh by init() never has the legacy NOT NULL shape:
    // the CREATE TABLE itself already declares cost_usd nullable. migrate()
    // must be a no-op for it too, not just for one it just fixed.
    const db = (open = new Database(":memory:"));
    init(db);
    expect(costNotNull(db)).toBe(false);
    const before = snapshot(db);
    migrate(db);
    expect(snapshot(db)).toEqual(before);
  });
});
