/* One app process per orchestrator.db, enforced at boot.
 *
 * WHY: the app is single-process by design — turns run detached and owned by
 * the server (lib/runner.ts), the event bus and the abort/ask registries are
 * in-memory on globalThis, and init() opens every boot by clearing the wreckage
 * a crash leaves behind (running flags, the pending-message queue, unanswered
 * permission cards). Point a SECOND process at the same database and that
 * recovery pass runs against a LIVE instance: it wipes the first process's
 * running flags, drops its queued follow-ups, and settles permission cards a
 * human is still looking at — while the first process keeps writing to rows the
 * second believes are idle. No error, no warning, just two servers disagreeing
 * about reality. So: refuse to boot, and put the recovery pass behind the lock.
 *
 * HOW: the mutex is a kernel file lock, not a heartbeat lease — a dedicated
 * SQLite database (orchestrator.lock.db, separate from the real one so a
 * concurrent `sqlite3 orchestrator.db` inspection still works and WAL is
 * untouched) with a `BEGIN IMMEDIATE` transaction that is opened and never
 * committed. That holds SQLite's RESERVED lock for the life of the connection,
 * so a second process's BEGIN IMMEDIATE fails SQLITE_BUSY immediately.
 *
 * Choosing a kernel lock over a pid+timestamp lease file deletes the entire
 * class of problems a lease has: there is no heartbeat to miss, no staleness
 * window to tune, and no pid-liveness heuristic to get wrong (pids are small
 * and reused inside a container, and a `docker restart` keeps the hostname, so
 * "pid 7 on host abc is alive" proves nothing). The OS drops the lock when the
 * process dies, so recovery after a SIGKILL/OOM is IMMEDIATE rather than
 * "eventually, once the lease expires".
 *
 * `locking_mode = EXCLUSIVE` is deliberately NOT used on top of this. In that
 * mode a connection also retains its SHARED lock forever, including after a
 * FAILED write — so two processes racing could both park on SHARED and
 * permanently deadlock each other out of the EXCLUSIVE upgrade. Held-RESERVED
 * already excludes every other writer, which is all a mutex needs.
 *
 * Identity (who holds it) is a best-effort JSON sidecar, read only to write a
 * useful error message. It never participates in deciding ownership, so a
 * sidecar left behind by a hard kill can't wedge anything.
 *
 * Plain .mjs because server.js is CommonJS and can't import TS — and because
 * it must be COPY'd into the runtime image explicitly (see the Dockerfile).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The mutex. A pure lock file — it holds no data we ever read. */
const LOCK_DB = "orchestrator.lock.db";
/** Diagnostics only: who to go looking for. Never load-bearing. */
const SIDECAR = "orchestrator.lock.json";

const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 200;

/**
 * How long acquisition retries before giving up. The wait exists for ONE case:
 * a predecessor that is still shutting down (a restart overlaps by ~a second).
 * A crashed predecessor releases instantly, so the wait is usually zero, and a
 * genuinely live holder is never going to let go — hence a bound, not a block.
 */
function defaultWaitMs() {
  const n = Number(process.env.ORCH_DB_LOCK_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

/**
 * Same resolution as DB_DIR in lib/config.ts. Duplicated rather than imported
 * because the plain-Node entrypoints can't read TS — the established convention
 * for this repo (see server.js); keep the env name and default in step.
 */
export function resolveDbLockDir(dir) {
  return path.resolve(dir || process.env.ORCH_DB_DIR || path.join(os.homedir(), ".zen-orchestrator"));
}

export class DbLockHeldError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = "DbLockHeldError";
    /** Best-effort {pid, host, startedAt} of the process that beat us, or null. */
    this.holder = holder;
  }
}

/*
 * State lives on globalThis, not in module scope, because this file is loaded
 * TWICE in one realm: server.js dynamic-imports it through Node's ESM loader,
 * while lib/db.ts imports it through Turbopack's bundle. Two module instances,
 * one process — so the ownership server.js established has to be visible to the
 * copy lib/db.ts holds, or the recovery pass would never be authorized. (Same
 * reason lib/events.ts, lib/abort.ts and lib/services.ts keep their state here.)
 */
const state = () => globalThis.__orchDbLock ?? null;

function isBusy(err) {
  return typeof err?.code === "string" && err.code.startsWith("SQLITE_BUSY");
}

/**
 * One attempt at the mutex. Returns the holding connection, or null if someone
 * else has it. The connection is CLOSED on failure — leaving it open would keep
 * a SHARED lock that stops the real holder from ever upgrading.
 */
function tryLock(file) {
  let db;
  try {
    db = new Database(file, { timeout: 0 });
    // Never WAL: a WAL database coordinates through a -shm mapping, which is a
    // different (and weaker) thing than the file lock we are here for.
    db.pragma("journal_mode = DELETE");
    // Not committed, ever. This is the lock.
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (err) {
    try { db?.close(); } catch {}
    if (isBusy(err)) return null;
    throw err;
  }
}

function writeSidecar(dir) {
  const holder = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
  try {
    // tmp + rename so a reader never sees a half-written file.
    const tmp = path.join(dir, `${SIDECAR}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(holder));
    fs.renameSync(tmp, path.join(dir, SIDECAR));
  } catch {
    // Diagnostics are optional; losing them costs a nicer error message, nothing more.
  }
  return holder;
}

/** Best-effort identity of whoever holds the lock on `dir`. Null if unknown. */
export function readDbLockHolder(dir) {
  try {
    const raw = fs.readFileSync(path.join(resolveDbLockDir(dir), SIDECAR), "utf8");
    const holder = JSON.parse(raw);
    return typeof holder?.pid === "number" ? holder : null;
  } catch {
    return null;
  }
}

function heldMessage(dir, holder) {
  const who = holder
    ? `pid ${holder.pid} on host ${holder.host}, started ${new Date(holder.startedAt).toISOString()}`
    : "unknown (no lock details on disk — the holder may be mid-startup)";
  return (
    `Another Operator process is already running against this database.\n` +
    `  database: ${dir}\n` +
    `  holder:   ${who}\n\n` +
    `Two processes sharing one orchestrator.db corrupt each other's task state, ` +
    `so this one is refusing to start. Stop the other process, or point this one ` +
    `at a different ORCH_DB_DIR. If you are certain the holder is gone, ` +
    `ORCH_DB_LOCK=off skips this check — unsupported, and exactly what the check exists to prevent.`
  );
}

function lockDisabled(setting) {
  const raw = String(setting ?? process.env.ORCH_DB_LOCK ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim this database for this process, or refuse to run.
 *
 * Called from server.js BEFORE app.prepare() — deliberately not from getDb(),
 * so `next build`, the test suite, and one-off scripts never contend for a lock
 * they have no business holding.
 *
 * Resolves to {mode, dir, holder}: "owner" when we hold the mutex, "bypass"
 * under the ORCH_DB_LOCK=off escape hatch. Rejects with DbLockHeldError when
 * someone else has it.
 */
export async function acquireDbLock({ dir, waitMs, lock } = {}) {
  const resolved = resolveDbLockDir(dir);
  const existing = state();
  if (existing) {
    // Idempotent for the same database; a second, different one is a bug —
    // ownership is per-database and this process can only recover the one.
    if (existing.dir === resolved) return existing;
    throw new Error(`This process already holds the database lock for ${existing.dir}; refusing to also claim ${resolved}.`);
  }

  fs.mkdirSync(resolved, { recursive: true });

  if (lockDisabled(lock)) {
    // The escape hatch still records a capability, so the recovery pass runs
    // for a solo user who turned the lock off — the point of `off` is "don't
    // stop me", not "run a crippled instance".
    globalThis.__orchDbLock = { mode: "bypass", dir: resolved, db: null, holder: null, recoveryPending: true };
    return state();
  }

  const deadline = Date.now() + (waitMs ?? defaultWaitMs());
  const file = path.join(resolved, LOCK_DB);
  for (;;) {
    const db = tryLock(file);
    if (db) {
      globalThis.__orchDbLock = {
        mode: "owner",
        dir: resolved,
        db,
        holder: writeSidecar(resolved),
        recoveryPending: true,
      };
      registerReleaseHook();
      return state();
    }
    if (Date.now() >= deadline) {
      const holder = readDbLockHolder(resolved);
      throw new DbLockHeldError(heldMessage(resolved, holder), holder);
    }
    // Jitter: two processes racing would otherwise retry in lockstep.
    await sleep(POLL_MS + Math.floor(Math.random() * POLL_MS));
  }
}

let hooked = false;
function registerReleaseHook() {
  if (hooked) return;
  hooked = true;
  // server.js turns SIGTERM/SIGINT into process.exit(0), which DOES run 'exit'
  // handlers — the same contract lib/services.ts relies on to reap its children.
  process.on("exit", releaseDbLock);
}

/** Drop the lock and the sidecar. Safe to call when we hold nothing. */
export function releaseDbLock() {
  const held = state();
  if (!held) return;
  globalThis.__orchDbLock = undefined;
  try { held.db?.close(); } catch {}
  // Only ever remove OUR sidecar: if a successor already claimed the mutex it
  // has overwritten this file, and deleting it would erase a live holder's name.
  if (held.mode === "owner" && readDbLockHolder(held.dir)?.pid === process.pid) {
    try { fs.rmSync(path.join(held.dir, SIDECAR), { force: true }); } catch {}
  }
}

/** "owner" | "bypass" | "unowned" for `dir`, from this process's point of view. */
export function dbLockMode(dir) {
  const held = state();
  return held && held.dir === resolveDbLockDir(dir) ? held.mode : "unowned";
}

/**
 * May this process run init()'s crash-recovery pass against `dir`?
 *
 * True at most ONCE, and only for a database this process actually claimed.
 * One-shot because recovery describes a specific moment — the state a dead
 * predecessor left at boot — and re-running it later (a second init(), an HMR
 * reload) would clear the live turns THIS process has since started.
 */
export function consumeDbRecoveryAuthorization(dir) {
  const held = state();
  if (!held || held.dir !== resolveDbLockDir(dir) || !held.recoveryPending) return false;
  held.recoveryPending = false;
  return true;
}
