#!/usr/bin/env node
/* Hot backup of a Calandria instance, safe to run against a live server.
 *
 * Snapshots the database with `VACUUM INTO` (a read-only transaction, no
 * application lock) instead of copying calandria.db directly: a WAL-mode
 * database copied by `cp` misses the write-ahead log and can be stale or
 * torn, while VACUUM INTO writes a self-contained, checkpointed copy.
 *
 * Archives db/ (the snapshot), db-dir/ (uploads, VAPID key, API keys) and
 * agent-login/ (~/.claude*, ~/.codex, ~/.gemini) by default. --worktrees and
 * --projects are opt-in: both are reconstructible from the project repo and
 * large enough to make a nightly backup a disk problem. Paths are resolved
 * through lib/storage.mjs so a pre-rename orchestrator.db install is still found.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readEnv } from "../lib/env.mjs";
import { resolveDbLocation, resolveWorktreesDir } from "../lib/storage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const USAGE = `Usage: node scripts/backup.mjs [options]

Writes a timestamped, self-consistent snapshot of this instance to
<out>/calandria-backup-<UTC stamp>.tar.gz. Safe to run while the app is up.

Options:
  --out DIR       Where to write the archive. Default: CALANDRIA_BACKUP_DIR,
                  else <CALANDRIA_DB_DIR>/backups.
  --worktrees     Also archive per-task git worktrees (large; reconstructible).
  --projects      Also archive cloned project repos (large; reconstructible).
  --no-logins     Skip the agent CLI login state (~/.claude*, ~/.codex, ~/.gemini).
  --no-archive    Leave the staging directory instead of tarring it up.
  --quiet         Only print the resulting path.
  -h, --help      This.

The archive contains credentials. It is written 0600 (POSIX); on Windows it
inherits the ACL of the directory it lands in — put it somewhere private.
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    out: "",
    worktrees: false,
    projects: false,
    logins: true,
    archive: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return null;
    else if (a === "--out") opts.out = argv[++i] ?? "";
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a === "--worktrees") opts.worktrees = true;
    else if (a === "--projects") opts.projects = true;
    else if (a === "--no-logins") opts.logins = false;
    else if (a === "--no-archive") opts.archive = false;
    else if (a === "--quiet") opts.quiet = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (opts.out === "") opts.out = readEnv("CALANDRIA_BACKUP_DIR") || "";
  return opts;
}

/** UTC stamp like `YYYYMMDDTHHMMSSZ`: sorts lexically, unambiguous about zone. */
function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // File vanished mid-scan; the total is best-effort.
      }
    }
  }
  return total;
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/**
 * Writes the consistent snapshot. `VACUUM INTO` reads the live database
 * inside one read transaction and writes a fresh, checkpointed file, so a
 * turn committing mid-backup lands wholly inside the snapshot or wholly
 * after it, and the result needs no `-wal`/`-shm` sidecars.
 */
function snapshotDb(srcPath, destPath) {
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    db.prepare("VACUUM INTO ?").run(destPath);
  } finally {
    db.close();
  }
  const snap = new Database(destPath, { readonly: true, fileMustExist: true });
  try {
    const check = snap.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new Error(`snapshot failed integrity_check: ${check}`);
    const count = (table) => {
      try {
        return snap.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
      } catch {
        return null; // a database old enough not to have the table yet
      }
    };
    return {
      userVersion: snap.pragma("user_version", { simple: true }),
      pageSize: snap.pragma("page_size", { simple: true }),
      counts: { projects: count("projects"), tasks: count("tasks"), messages: count("messages") },
    };
  } finally {
    snap.close();
  }
}

/**
 * Copies everything in the database's directory besides the database itself:
 * uploads, the VAPID key, a persisted API key. Excludes any SQLite file
 * (snapshotDb already made that copy), the boot lock file, the output
 * directory, and the worktrees dir when nested inside it (the default,
 * `~/.calandria/worktrees` under `~/.calandria`).
 */
function copyDbDirExtras(dbDir, destDir, excludeDirs) {
  const root = path.resolve(dbDir);
  const excluded = new Set(excludeDirs.map((d) => path.resolve(d)));
  const skipped = [];
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(root)) return { skipped };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const src = path.join(root, entry.name);
    if (excluded.has(path.resolve(src))) {
      skipped.push(entry.name);
      continue;
    }
    if (/\.db(-wal|-shm|-journal)?$/.test(entry.name) || /\.lock\.json$/.test(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    fs.cpSync(src, path.join(destDir, entry.name), { recursive: true, preserveTimestamps: true });
  }
  return { skipped };
}

/**
 * Copies the agent CLIs' login state, kept at its real path under a `home/`
 * prefix so restoring is `cp -a agent-login/home/. ~/`.
 *
 * Curated instead of a whole-directory copy: `~/.claude` also holds every
 * session transcript the CLI has written, which is large and not needed to
 * make a restored instance work. On macOS the Claude credential lives in the
 * login Keychain instead of `.credentials.json`, so its absence here is
 * recorded rather than treated as an error.
 */
function copyAgentLogin(home, destDir) {
  const wanted = [
    ".claude.json",
    path.join(".claude", ".credentials.json"),
    path.join(".claude", "settings.json"),
    path.join(".codex", "auth.json"),
    path.join(".codex", "config.toml"),
    // Antigravity's CLI settings (which model provider it uses). The OAuth
    // token is absent: `agy` keeps that in the OS keyring rather than a file,
    // so a restored instance signs in again, or runs on the API key, which
    // Calandria stores in its own database and the db backup already carries.
    path.join(".gemini", "antigravity-cli", "settings.json"),
  ];
  const included = [];
  const missing = [];
  for (const rel of wanted) {
    const src = path.join(home, rel);
    if (!fs.existsSync(src)) {
      missing.push(rel);
      continue;
    }
    const dest = path.join(destDir, "home", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { preserveTimestamps: true });
    included.push(rel);
  }
  return { included, missing };
}

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (!opts) {
    process.stdout.write(USAGE);
    return;
  }

  const started = Date.now();
  const log = (line) => {
    if (!opts.quiet) process.stderr.write(`${line}\n`);
  };

  const db = resolveDbLocation();
  if (!fs.existsSync(db.path)) {
    process.stderr.write(`no database at ${db.path} — nothing to back up\n`);
    process.exit(1);
  }
  const worktrees = resolveWorktreesDir();
  const projectsDir = readEnv("CALANDRIA_PROJECTS_DIR") || path.join(os.homedir(), "projects");

  const outDir = path.resolve(opts.out || path.join(db.dir, "backups"));
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const name = `calandria-backup-${stamp()}`;
  const staging = path.join(outDir, name);
  if (fs.existsSync(staging)) {
    process.stderr.write(`${staging} already exists — refusing to overwrite\n`);
    process.exit(1);
  }
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  let ok = false;
  try {
    log(`database  ${db.path}`);
    fs.mkdirSync(path.join(staging, "db"));
    const snapPath = path.join(staging, "db", db.file);
    const info = snapshotDb(db.path, snapPath);
    log(`snapshot  ${humanBytes(fs.statSync(snapPath).size)} (integrity_check ok)`);

    const extras = copyDbDirExtras(db.dir, path.join(staging, "db-dir"), [outDir, staging, worktrees.dir]);
    log(`db-dir    ${humanBytes(dirSize(path.join(staging, "db-dir")))}`);

    let login = null;
    if (opts.logins) {
      login = copyAgentLogin(os.homedir(), path.join(staging, "agent-login"));
      log(`logins    ${login.included.length ? login.included.join(", ") : "none found"}`);
    }

    const optional = {};
    for (const [flag, key, src] of [
      [opts.worktrees, "worktrees", worktrees.dir],
      [opts.projects, "projects", projectsDir],
    ]) {
      if (!flag) continue;
      if (!fs.existsSync(src)) {
        log(`${key.padEnd(9)} ${src} does not exist — skipped`);
        continue;
      }
      log(`${key.padEnd(9)} copying ${src} (this is the slow part)`);
      fs.cpSync(src, path.join(staging, key), { recursive: true, preserveTimestamps: true });
      optional[key] = src;
    }

    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      calandriaVersion: appVersion(),
      hostname: os.hostname(),
      platform: process.platform,
      // The absolute source paths: the database stores absolute paths too
      // (projects.repo_path, tasks.worktree_path), and a restore onto a
      // different layout has to reconcile them.
      source: {
        dbPath: db.path,
        dbDir: db.dir,
        dbFile: db.file,
        legacyDbFile: db.legacyFile,
        legacyDbDir: db.legacyDir,
        worktreesDir: worktrees.dir,
        projectsDir,
        home: os.homedir(),
      },
      db: { ...info, sha256: sha256(snapPath) },
      contents: {
        db: `db/${db.file}`,
        dbDirSkipped: extras.skipped.sort(),
        agentLogin: login ? login.included : null,
        agentLoginMissing: login ? login.missing : null,
        worktrees: optional.worktrees ?? null,
        projects: optional.projects ?? null,
      },
    };
    fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    if (!opts.archive) {
      log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      process.stdout.write(`${staging}\n`);
      ok = true;
      return;
    }

    const archive = path.join(outDir, `${name}.tar.gz`);
    // Run in the output dir and name everything relatively: a Windows absolute
    // path is `C:\...`, and a colon before the first slash is how tar spells a
    // remote host.
    const tar = spawnSync("tar", ["-czf", `${name}.tar.gz`, name], {
      cwd: outDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (tar.error || tar.status !== 0) {
      const why = tar.error ? tar.error.message : (tar.stderr?.toString().trim() || `tar exited ${tar.status}`);
      // Keep the staging dir: the expensive work is done and it is the backup,
      // just uncompressed (the same shape --no-archive produces).
      process.stderr.write(`tar failed (${why})\nthe uncompressed backup is at ${staging}\n`);
      process.exit(1);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.chmodSync(archive, 0o600);
    } catch {
      // Windows: chmod only toggles the read-only attribute. Documented.
    }
    log(`archive   ${humanBytes(fs.statSync(archive).size)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.stdout.write(`${archive}\n`);
    ok = true;
  } finally {
    // A half-written staging dir is worse than none: it looks like a backup.
    // The tar-failure path keeps it instead, exiting through process.exit(),
    // which never reaches this finally block.
    if (!ok) fs.rmSync(staging, { recursive: true, force: true });
  }
}

main();
