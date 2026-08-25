// Where an unconfigured install puts its data — and what it does when it finds
// a pre-rename install already there.
//
// The defaults moved to ~/.calandria, but nothing is ever MOVED: an operator
// upgrading in place must keep every project and task, and the worktrees half
// can't be relocated from this side at all (git stores an absolute path in each
// repo's .git/worktrees/<id>/gitdir). So the rules below are the whole feature,
// and they're the kind of thing that reads as obviously-correct right up until
// someone reorders two `if`s and silently hands a returning user an empty app.
//
// The resolver reads os.homedir() and the env at CALL time, not import time,
// which is what makes a fake HOME testable here at all.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DB_FILE,
  LEGACY_DB_FILE,
  legacyStorageWarning,
  lockFilesFor,
  resolveDbLocation,
  resolveWorktreesDir,
} from "../lib/storage.mjs";

const NEW_DIR = ".calandria";
const OLD_DB_DIR = ".zen-orchestrator";
const OLD_WORKTREES_DIR = ".agent-orchestrator";

let home: string;
let saved: Record<string, string | undefined>;
let n = 0;

/** Point os.homedir() at an empty directory and clear the suite's own overrides. */
beforeEach(() => {
  saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CALANDRIA_DB_DIR: process.env.CALANDRIA_DB_DIR,
    CALANDRIA_WORKTREES_DIR: process.env.CALANDRIA_WORKTREES_DIR,
  };
  home = path.join(process.env.CALANDRIA_TEST_TMP!, `home-${++n}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // tests/setup.ts pins both at tmp dirs for the rest of the suite; the DEFAULTS
  // are exactly what this file is about, so they have to come off.
  delete process.env.CALANDRIA_DB_DIR;
  delete process.env.CALANDRIA_WORKTREES_DIR;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Write a plausible database file (contents are never read — only existence is). */
function seedDb(dir: string, file: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, "SQLite format 3\0");
  return p;
}

describe("database location", () => {
  it("puts a fresh install at ~/.calandria/calandria.db", () => {
    const at = resolveDbLocation();
    expect(at.path).toBe(path.join(home, NEW_DIR, DB_FILE));
    expect(at.legacyDir).toBe(false);
    expect(at.legacyFile).toBe(false);
    // Resolution must not CREATE anything — the caller mkdirs when it opens.
    expect(fs.existsSync(path.join(home, NEW_DIR))).toBe(false);
    expect(legacyStorageWarning()).toBeNull();
  });

  it("keeps using a pre-rename database when the new location has none", () => {
    const old = seedDb(path.join(home, OLD_DB_DIR), LEGACY_DB_FILE);

    const at = resolveDbLocation();
    expect(at.path).toBe(old);
    expect(at.file).toBe(LEGACY_DB_FILE);
    expect(at.legacyDir).toBe(true);

    // One hint line, naming both where it is and where it should go.
    const warning = legacyStorageWarning();
    expect(warning).toContain(old);
    expect(warning).toContain(path.join(home, NEW_DIR, DB_FILE));
  });

  it("is not fooled by an empty ~/.calandria (the container entrypoint mkdirs one)", () => {
    const old = seedDb(path.join(home, OLD_DB_DIR), LEGACY_DB_FILE);
    fs.mkdirSync(path.join(home, NEW_DIR), { recursive: true });

    expect(resolveDbLocation().path).toBe(old);
  });

  it("prefers the new database when both exist", () => {
    seedDb(path.join(home, OLD_DB_DIR), LEGACY_DB_FILE);
    const fresh = seedDb(path.join(home, NEW_DIR), DB_FILE);

    const at = resolveDbLocation();
    expect(at.path).toBe(fresh);
    expect(at.legacyDir).toBe(false);
    expect(at.legacyFile).toBe(false);
    expect(legacyStorageWarning()).toBeNull();
  });

  it("falls back by FILE NAME inside an explicit CALANDRIA_DB_DIR", () => {
    const dir = path.join(home, "elsewhere");
    const old = seedDb(dir, LEGACY_DB_FILE);
    process.env.CALANDRIA_DB_DIR = dir;

    const at = resolveDbLocation();
    expect(at.path).toBe(old);
    expect(at.file).toBe(LEGACY_DB_FILE);
    // The directory was chosen by the operator, so only the file name is legacy.
    expect(at.legacyDir).toBe(false);
    expect(at.legacyFile).toBe(true);
    expect(legacyStorageWarning()).toContain(old);
  });

  it("never leaves an explicit CALANDRIA_DB_DIR to find a database elsewhere", () => {
    seedDb(path.join(home, OLD_DB_DIR), LEGACY_DB_FILE);
    const dir = path.join(home, "empty-but-configured");
    process.env.CALANDRIA_DB_DIR = dir;

    // An operator who set the var said where the data lives. A silent hop to
    // ~/.zen-orchestrator would be the app choosing a different database than
    // the one it was pointed at.
    expect(resolveDbLocation().path).toBe(path.join(dir, DB_FILE));
  });
});

describe("boot-lock file names", () => {
  // The lock must be named after the database it guards, or an older build
  // holding orchestrator.lock.db and a new build that adopted its
  // orchestrator.db would contend for two different files and both run.
  it("pairs with the database file in use", () => {
    expect(lockFilesFor(DB_FILE)).toEqual({ lock: "calandria.lock.db", sidecar: "calandria.lock.json" });
    expect(lockFilesFor(LEGACY_DB_FILE)).toEqual({
      lock: "orchestrator.lock.db",
      sidecar: "orchestrator.lock.json",
    });
  });
});

describe("worktrees location", () => {
  it("cuts new worktrees under ~/.calandria/worktrees", () => {
    expect(resolveWorktreesDir()).toEqual({ dir: path.join(home, NEW_DIR, "worktrees"), legacyDir: false });
  });

  it("keeps a populated legacy directory rather than relocating registered worktrees", () => {
    const old = path.join(home, OLD_WORKTREES_DIR, "worktrees");
    fs.mkdirSync(path.join(old, "someTaskId"), { recursive: true });

    expect(resolveWorktreesDir()).toEqual({ dir: old, legacyDir: true });
    expect(legacyStorageWarning()).toContain(old);
  });

  it("abandons an EMPTY legacy directory", () => {
    fs.mkdirSync(path.join(home, OLD_WORKTREES_DIR, "worktrees"), { recursive: true });

    expect(resolveWorktreesDir().dir).toBe(path.join(home, NEW_DIR, "worktrees"));
    expect(legacyStorageWarning()).toBeNull();
  });

  it("obeys an explicit CALANDRIA_WORKTREES_DIR even with a populated legacy one", () => {
    fs.mkdirSync(path.join(home, OLD_WORKTREES_DIR, "worktrees", "someTaskId"), { recursive: true });
    process.env.CALANDRIA_WORKTREES_DIR = path.join(home, "chosen");

    expect(resolveWorktreesDir()).toEqual({ dir: path.join(home, "chosen"), legacyDir: false });
  });
});

/*
 * The end-to-end shape of the two cases that actually matter to a person: an
 * upgrade in place must still find every project and task, and a brand-new
 * install must land at the new default. Both boot the real store against a fake
 * HOME rather than asserting on the resolver alone — lib/config.ts reads its
 * paths at IMPORT time, so a wiring mistake between the resolver and DB_PATH
 * would pass every test above and still hand a returning user an empty app.
 */
async function bootStore() {
  // getDb() memoizes on globalThis, and lib/config.ts computes DB_PATH once per
  // module graph — so a "boot" is a module reset plus dropping that connection.
  closeDb();
  vi.resetModules();
  return await import("../lib/store");
}

function closeDb() {
  const open = (globalThis as { __orchDb?: { close(): void } }).__orchDb;
  if (open) {
    // close() checkpoints the WAL away, which is what makes the file below
    // movable — the same reason the migration recipe says to stop the app first.
    try { open.close(); } catch {}
    delete (globalThis as { __orchDb?: unknown }).__orchDb;
  }
}

describe("booting", () => {
  afterEach(closeDb);

  it("creates ~/.calandria/calandria.db on a fresh install", async () => {
    const store = await bootStore();
    store.listProjects();

    expect(fs.existsSync(path.join(home, NEW_DIR, DB_FILE))).toBe(true);
    expect(fs.existsSync(path.join(home, OLD_DB_DIR))).toBe(false);
  });

  it("still loads the projects and tasks of a pre-rename install", async () => {
    const seeded = await bootStore();
    const project = seeded.createProject({ name: "Legacy", repo_path: "/tmp/legacy" });
    const task = seeded.createTask({ project_id: project.id, title: "From before the rename" });
    // Everything the database held, not just our row: init() also seeds the
    // Welcome project, and losing that would be the same bug.
    const before = seeded.listProjectsPlain().map((p) => p.id);

    // Put the database exactly where an upgrade in place would find it.
    closeDb();
    fs.mkdirSync(path.join(home, OLD_DB_DIR), { recursive: true });
    fs.renameSync(path.join(home, NEW_DIR, DB_FILE), path.join(home, OLD_DB_DIR, LEGACY_DB_FILE));
    fs.rmSync(path.join(home, NEW_DIR), { recursive: true, force: true });

    const store = await bootStore();
    expect(store.listProjectsPlain().map((p) => p.id)).toEqual(before);
    expect(before).toContain(project.id);
    expect(store.listTasks(project.id).map((t) => t.title)).toEqual([task.title]);
    // And no second, empty database was created at the new default beside it.
    expect(fs.existsSync(path.join(home, NEW_DIR, DB_FILE))).toBe(false);
    expect(legacyStorageWarning()).toContain(path.join(home, OLD_DB_DIR, LEGACY_DB_FILE));
  });
});
