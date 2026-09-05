/* Tests scripts/backup.mjs, the WAL-safe hot backup.
 *
 * The snapshot must contain writes that are still only in the write-ahead
 * log. A plain `cp calandria.db` backup opens and has a schema, but drops
 * the most recent writes; the first case below writes uncheckpointed rows
 * and asserts the snapshot has them while a raw copy of the same file does
 * not.
 *
 * Tests run the real script as a subprocess, since it resolves paths from
 * the environment (lib/storage.mjs) and shells out to tar.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outputLines } from "./platform";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "backup.mjs");

let root: string | null = null;
let openDb: Database.Database | null = null;

/* Teardown owns the fixture's connection, not the test body.
 *
 * Each case holds a mid-WAL database open, and a failing case never reaches
 * the close at its end. POSIX allows unlinking an open file, but Windows
 * refuses with EBUSY (issue #53), so this hook closes the handle before
 * removing the directory, keeping a failing assertion the only red result.
 *
 * Removal tolerates handles it doesn't hold, matching tests/setup.ts: a
 * scanner or indexer on a freshly written temp directory must not fail an
 * otherwise passing test. */
afterEach(() => {
  try {
    if (openDb?.open) openDb.close();
  } catch {
    /* already closed */
  }
  openDb = null;
  if (root) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
      console.warn(`[tests] could not remove ${root}:`, err);
    }
  }
  root = null;
});

type Fixture = {
  root: string;
  dbDir: string;
  dbPath: string;
  home: string;
  worktrees: string;
  /** Held open: closing the last connection checkpoints the WAL.
   *  Closed by the afterEach above, so a failing case still lets go of it. */
  db: Database.Database;
};

/**
 * A data directory shaped like a real one: a WAL database, the uploads tree and
 * VAPID key beside it, the boot lock's mutex pair, and, by default, the
 * worktrees dir nested inside it, matching where it lands with both variables
 * unset (`~/.calandria/worktrees` under `~/.calandria`).
 */
function fixture(dbFile = "calandria.db", rows = 40): Fixture {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "calandria-backup-"));
  root = base;
  const dbDir = path.join(base, "data");
  const home = path.join(base, "home");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(path.join(dbDir, "uploads", "task-1"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });

  const dbPath = path.join(dbDir, dbFile);
  const db = new Database(dbPath);
  openDb = db;
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
  for (let i = 0; i < rows; i++) insert.run(`note ${i}`);

  fs.writeFileSync(path.join(dbDir, "uploads", "task-1", "shot.png"), "not really a png");
  fs.writeFileSync(path.join(dbDir, "vapid.json"), '{"privateKey":"x"}');
  fs.writeFileSync(path.join(dbDir, "anthropic-api-key"), "sk-secret");
  // The lock pair the app holds while running. The backup must not carry it:
  // restoring one would restore a stale claim.
  fs.writeFileSync(path.join(dbDir, "calandria.lock.db"), "");
  fs.writeFileSync(path.join(dbDir, "calandria.lock.json"), '{"pid":1}');

  const worktrees = path.join(dbDir, "worktrees");
  fs.mkdirSync(path.join(worktrees, "task-1"), { recursive: true });
  fs.writeFileSync(path.join(worktrees, "task-1", "file.txt"), "a checkout");

  fs.writeFileSync(path.join(home, ".claude.json"), '{"oauthAccount":{}}');
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"token":"t"}');
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"c"}');

  return { root: base, dbDir, dbPath, home, worktrees, db };
}

function run(f: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  const outDir = path.join(f.root, "out");
  const res = spawnSync(process.execPath, [SCRIPT, "--out", outDir, "--quiet", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.home,
      USERPROFILE: f.home, // os.homedir() reads this one on Windows
      CALANDRIA_DB_DIR: f.dbDir,
      CALANDRIA_WORKTREES_DIR: f.worktrees,
      CALANDRIA_PROJECTS_DIR: path.join(f.root, "projects"),
      ...extraEnv,
    },
  });
  return { ...res, outDir, produced: res.stdout.trim() };
}

/** The archive's member paths, relative to the backup directory inside it.
 *
 *  Uses `outputLines`, not `split("\n")`: `tar.exe` on Windows ends every
 *  entry with CRLF, so a plain split leaves a trailing `\r` on each member
 *  (issue #53). The final `filter(Boolean)` drops the blank the trailing
 *  newline produces and the root directory entry, which maps to the empty
 *  string once its prefix is stripped. */
function listArchive(archive: string): string[] {
  const res = spawnSync("tar", ["-tzf", path.basename(archive)], {
    cwd: path.dirname(archive),
    encoding: "utf8",
  });
  expect(res.status, res.stderr).toBe(0);
  return outputLines(res.stdout)
    .map((line) => line.replace(/^calandria-backup-[^/]+\/?/, "").replace(/\/$/, ""))
    .filter(Boolean);
}

function extract(archive: string): string {
  const into = path.join(path.dirname(archive), "extracted");
  fs.mkdirSync(into, { recursive: true });
  const res = spawnSync("tar", ["-xzf", archive, "-C", into], { encoding: "utf8" });
  expect(res.status, res.stderr).toBe(0);
  return path.join(into, fs.readdirSync(into)[0]);
}

const notes = (file: string) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT count(*) AS c FROM notes").get() as { c: number }).c;
  } finally {
    db.close();
  }
};

/** Row count, or null when the table isn't there at all. */
const notesOrNull = (file: string) => {
  try {
    return notes(file);
  } catch {
    return null;
  }
};

describe("scripts/backup.mjs", () => {
  it("captures writes that are still only in the WAL, which a file copy loses", () => {
    const f = fixture();
    // Confirms the fixture is mid-WAL before asserting on it.
    expect(fs.existsSync(`${f.dbPath}-wal`)).toBe(true);

    const res = run(f, []);
    expect(res.status, res.stderr).toBe(0);

    const dir = extract(res.produced);
    expect(notes(path.join(dir, "db", "calandria.db"))).toBe(40);

    // A naive copy of the same moment: the CREATE TABLE is itself still in
    // the log, so the copy has no table at all. Either way it isn't a backup.
    const naive = path.join(f.root, "naive.db");
    fs.copyFileSync(f.dbPath, naive);
    expect(notesOrNull(naive)).not.toBe(40);

    // The snapshot needs no sidecars: VACUUM INTO writes a checkpointed file.
    expect(fs.existsSync(path.join(dir, "db", "calandria.db-wal"))).toBe(false);
  });

  it("archives the state beside the database and skips what must not be restored", () => {
    const f = fixture();
    const res = run(f, []);
    expect(res.status, res.stderr).toBe(0);
    const members = listArchive(res.produced);

    expect(members).toContain("db/calandria.db");
    expect(members).toContain("db-dir/uploads/task-1/shot.png");
    expect(members).toContain("db-dir/vapid.json");
    expect(members).toContain("db-dir/anthropic-api-key");
    expect(members).toContain("agent-login/home/.claude.json");
    expect(members).toContain("agent-login/home/.claude/.credentials.json");
    expect(members).toContain("agent-login/home/.codex/auth.json");

    // No raw SQLite file, no lock, and no worktrees; the last one is nested
    // inside the database directory in the default layout.
    expect(members.some((m) => m.startsWith("db-dir/") && /\.db(-wal|-shm)?$/.test(m))).toBe(false);
    expect(members.some((m) => m.includes("lock"))).toBe(false);
    expect(members.some((m) => m.startsWith("worktrees"))).toBe(false);
  });

  it("records where the data came from, so a restore can reconcile absolute paths", () => {
    const f = fixture();
    const res = run(f, []);
    const dir = extract(res.produced);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

    expect(manifest.source.dbPath).toBe(f.dbPath);
    expect(manifest.source.worktreesDir).toBe(f.worktrees);
    expect(manifest.contents.db).toBe("db/calandria.db");
    expect(manifest.contents.agentLogin).toContain(".claude.json");
    expect(manifest.contents.worktrees).toBeNull();
    expect(manifest.db.counts).toBeTruthy();
  });

  it("follows lib/storage.mjs to a pre-rename orchestrator.db instead of assuming a name", () => {
    const f = fixture("orchestrator.db");
    const res = run(f, []);
    expect(res.status, res.stderr).toBe(0);
    const members = listArchive(res.produced);
    expect(members).toContain("db/orchestrator.db");
    expect(members).not.toContain("db/calandria.db");

    const dir = extract(res.produced);
    expect(notes(path.join(dir, "db", "orchestrator.db"))).toBe(40);
  });

  it("takes worktrees and project clones only when asked", () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.root, "projects", "repo"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "projects", "repo", "README.md"), "clone");

    const res = run(f, ["--worktrees", "--projects"]);
    expect(res.status, res.stderr).toBe(0);
    const members = listArchive(res.produced);
    expect(members).toContain("worktrees/task-1/file.txt");
    expect(members).toContain("projects/repo/README.md");
  });

  it("--no-archive leaves the backup as a directory", () => {
    const f = fixture();
    const res = run(f, ["--no-archive"]);
    expect(res.status, res.stderr).toBe(0);
    expect(fs.statSync(res.produced).isDirectory()).toBe(true);
    expect(notes(path.join(res.produced, "db", "calandria.db"))).toBe(40);
  });

  it("--no-logins omits the credentials", () => {
    const f = fixture();
    const res = run(f, ["--no-logins"]);
    const members = listArchive(res.produced);
    expect(members.some((m) => m.startsWith("agent-login"))).toBe(false);
  });

  it("fails loudly rather than writing an empty backup when there is no database", () => {
    const f = fixture();
    f.db.close();
    for (const name of fs.readdirSync(f.dbDir)) {
      if (name.startsWith("calandria.db")) fs.rmSync(path.join(f.dbDir, name));
    }
    const res = run(f, []);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no database at/);
    expect(fs.existsSync(res.outDir) ? fs.readdirSync(res.outDir) : []).toEqual([]);
  });
});
