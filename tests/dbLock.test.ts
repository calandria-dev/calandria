// Pins the boot lock: one app process per database, enforced by a kernel file
// lock (SQLite's locking_mode = EXCLUSIVE on a dedicated lock database) instead
// of a heartbeat or pid heuristic. Two processes against one database corrupt
// each other's state, since init()'s crash-recovery resets (running flags, the
// pending-message queue, open permission cards) belong to whichever process
// owns the database, and running them from a second boot wipes the first
// process's live state. A holder killed with SIGKILL releases the lock
// immediately, since the OS closes its descriptors.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireDbLock,
  consumeDbRecoveryAuthorization,
  dbLockMode,
  readDbLockHolder,
  releaseDbLock,
} from "../lib/db-lock.mjs";
import { init } from "../lib/db";

const HOLDER = path.join(__dirname, "fixtures", "dbLockHolder.mjs");

let n = 0;
/** A fresh, empty CALANDRIA_DB_DIR-shaped directory per case. */
function freshDir(): string {
  const dir = path.join(process.env.CALANDRIA_TEST_TMP!, `lockdir-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type ChildResult = { ok: boolean; mode?: string; pid?: number; message?: string; holder?: { pid: number } | null };

/** Spawn the holder fixture; resolves with its one JSON line (and the handle). */
function spawnHolder(dir: string, waitMs: number, mode: "hold" | "exit", env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [HOLDER, dir, String(waitMs), mode], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const first = new Promise<ChildResult>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(out.slice(0, nl)));
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => reject(new Error(`holder exited ${code} with no result. stderr:\n${err}`)));
  });
  return { child, first };
}

const spawned: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill("SIGKILL");
  releaseDbLock();
});

describe("db boot lock", () => {
  it("grants ownership to the first process and records who holds it", async () => {
    const dir = freshDir();

    const state = await acquireDbLock({ dir, waitMs: 0 });

    expect(state.mode).toBe("owner");
    expect(dbLockMode(dir)).toBe("owner");
    expect(readDbLockHolder(dir)).toMatchObject({ pid: process.pid });
  });

  it("refuses a second process and names the holder", async () => {
    const dir = freshDir();
    await acquireDbLock({ dir, waitMs: 0 });

    const { child, first } = spawnHolder(dir, 0, "exit");
    spawned.push(child);
    const result = await first;

    expect(result.ok).toBe(false);
    expect(result.holder).toMatchObject({ pid: process.pid });
    // The message must let a human find the other process and the database
    // they are fighting over.
    expect(result.message).toContain(String(process.pid));
    expect(result.message).toContain(dir);
  });

  it("lets the next process in the moment a holder is SIGKILLed", async () => {
    const dir = freshDir();
    const { child, first } = spawnHolder(dir, 0, "hold");
    spawned.push(child);
    expect((await first).ok).toBe(true);

    // While it lives, this process is locked out.
    await expect(acquireDbLock({ dir, waitMs: 0 })).rejects.toThrow(/already running/i);

    // A hard kill leaves no chance to clean up; the kernel drops the lock.
    const died = new Promise((r) => child.on("exit", r));
    child.kill("SIGKILL");
    await died;

    const state = await acquireDbLock({ dir, waitMs: 2000 });
    expect(state.mode).toBe("owner");
  });

  it("takes over after a holder exits cleanly, leaving no sidecar behind", async () => {
    const dir = freshDir();
    const { child, first } = spawnHolder(dir, 0, "exit");
    spawned.push(child);
    expect((await first).ok).toBe(true);
    await new Promise((r) => child.on("exit", r));

    expect(readDbLockHolder(dir)).toBeNull();
    expect((await acquireDbLock({ dir, waitMs: 2000 })).mode).toBe("owner");
  });

  it("waits the configured window before giving up on a live holder", async () => {
    const dir = freshDir();
    await acquireDbLock({ dir, waitMs: 0 });

    const started = Date.now();
    const { child, first } = spawnHolder(dir, 600, "exit");
    spawned.push(child);
    const result = await first;

    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });

  it("lets both processes in when CALANDRIA_DB_LOCK=off, without claiming ownership", async () => {
    const dir = freshDir();
    const state = await acquireDbLock({ dir, waitMs: 0, lock: "off" });
    expect(state.mode).toBe("bypass");

    const { child, first } = spawnHolder(dir, 0, "exit", { CALANDRIA_DB_LOCK: "off" });
    spawned.push(child);
    expect(await first).toMatchObject({ ok: true, mode: "bypass" });
  });
});

describe("crash-recovery authorization", () => {
  it("is granted once to the owner and never again", async () => {
    const dir = freshDir();
    await acquireDbLock({ dir, waitMs: 0 });

    expect(consumeDbRecoveryAuthorization(dir)).toBe(true);
    expect(consumeDbRecoveryAuthorization(dir)).toBe(false);
  });

  it("is granted under the CALANDRIA_DB_LOCK=off escape hatch", async () => {
    const dir = freshDir();
    await acquireDbLock({ dir, waitMs: 0, lock: "off" });

    expect(consumeDbRecoveryAuthorization(dir)).toBe(true);
  });

  it("is refused to a process that never acquired the lock", () => {
    expect(consumeDbRecoveryAuthorization(freshDir())).toBe(false);
  });

  it("is refused for a database other than the one we own", async () => {
    const owned = freshDir();
    await acquireDbLock({ dir: owned, waitMs: 0 });

    expect(consumeDbRecoveryAuthorization(freshDir())).toBe(false);
  });

  it("crosses module instances, because in production it has to", async () => {
    // server.js dynamic-imports this module through Node's ESM loader; lib/db.ts
    // imports it through Turbopack's bundle. Two instances, one process, so the
    // ownership server.js established has to be visible to the copy lib/db.ts
    // holds, or crash recovery would never run in production and nothing here
    // would notice. The query string gives a second instance.
    // @ts-expect-error the cache-busting query is an ESM/Vite idiom, not a path TS can resolve
    const other: typeof import("../lib/db-lock.mjs") = await import("../lib/db-lock.mjs?instance=2");
    const dir = freshDir();

    await acquireDbLock({ dir, waitMs: 0 });

    expect(other.dbLockMode(dir)).toBe("owner");
    expect(other.consumeDbRecoveryAuthorization(dir)).toBe(true);
    // It is one-shot across instances, not once per copy of the module.
    expect(consumeDbRecoveryAuthorization(dir)).toBe(false);
  });
});

describe("init() crash recovery", () => {
  // A database that looks like a process died mid-turn: one task flagged
  // running, one follow-up parked behind it, one permission card unanswered.
  function midTurnDb(): Database.Database {
    const db = new Database(":memory:");
    init(db);
    const now = Date.now();
    db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('p', 'P', ?)").run(now);
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, running, created_at, updated_at) VALUES ('t', 'p', 'T', 1, ?, ?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO pending_messages (id, task_id, generation, content, created_at) VALUES ('m', 't', 1, 'hi', ?)"
    ).run(now);
    db.prepare(
      `INSERT INTO messages (id, task_id, generation, role, content, created_at)
       VALUES ('c', 't', 1, 'tool', '{"permission":{"request":{"id":"r1"}}}', ?)`
    ).run(now);
    return db;
  }

  const state = (db: Database.Database) => ({
    running: (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE running = 1").get() as { n: number }).n,
    pending: (db.prepare("SELECT COUNT(*) AS n FROM pending_messages").get() as { n: number }).n,
    openCards: (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE role = 'tool' AND json_extract(content, '$.permission.outcome') IS NULL"
        )
        .get() as { n: number }
    ).n,
  });

  it("leaves a mid-turn database untouched when this process doesn't own it", () => {
    const db = midTurnDb();

    init(db);

    // Every one of these belongs to the process that is running the turn.
    expect(state(db)).toEqual({ running: 1, pending: 1, openCards: 1 });
  });

  it("clears the wreckage of a dead process when this one owns the database", async () => {
    const db = midTurnDb();
    await acquireDbLock({ dir: process.env.CALANDRIA_DB_DIR!, waitMs: 0 });

    init(db);

    expect(state(db)).toEqual({ running: 0, pending: 0, openCards: 0 });
  });

  it("does not re-run recovery on a later init() in the same process", async () => {
    const db = midTurnDb();
    await acquireDbLock({ dir: process.env.CALANDRIA_DB_DIR!, waitMs: 0 });
    init(db);

    // A turn starts, and a follow-up is queued behind it.
    db.prepare("UPDATE tasks SET running = 1 WHERE id = 't'").run();
    db.prepare(
      "INSERT INTO pending_messages (id, task_id, generation, content, created_at) VALUES ('m2', 't', 1, 'hi', 0)"
    ).run();
    init(db);

    expect(state(db)).toMatchObject({ running: 1, pending: 1 });
  });
});
