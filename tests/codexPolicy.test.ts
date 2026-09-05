import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { init, migrate } from "../lib/db";
import {
  codexRunPolicy,
  resolveCodexMode,
  gitWritableRoots,
  configuredWritableRoots,
  sandboxPolicyObject,
  CODEX_MODES,
  DEFAULT_CODEX_MODE,
} from "@/lib/agents/codex/policy";
import { codexCapabilities } from "@/lib/agents/codex/capabilities";

// What each permission mode means to Codex (lib/agents/codex/policy.ts):
// the sandbox, the approval policy, who answers, and — the part the user hit
// first — the writable roots that let a commit work from a linked worktree
// under workspace-write, since the CLI marks a worktree's real gitdir
// read-only and the common dir sits outside every root.

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function worktreeFixture(): { repo: string; wt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-"));
  tmp.push(root);
  const repo = path.join(root, "repo");
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
  fs.mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  const wt = path.join(root, "wt");
  git(["worktree", "add", "-q", wt, "-b", "task"]);
  return { repo, wt };
}

describe("codex permission modes", () => {
  it("resolves the five keys and defaults everything else", () => {
    for (const m of CODEX_MODES) expect(resolveCodexMode(m)).toBe(m);
    expect(resolveCodexMode(null)).toBe(DEFAULT_CODEX_MODE);
    expect(resolveCodexMode("dontAsk")).toBe(DEFAULT_CODEX_MODE);
    expect(DEFAULT_CODEX_MODE).toBe("auto");
  });

  it("maps each mode to its sandbox, approval policy and reviewer", () => {
    const cwd = os.tmpdir();
    const auto = codexRunPolicy("auto", cwd);
    expect(auto).toMatchObject({ sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review", network: true, asks: false });

    const dflt = codexRunPolicy("default", cwd);
    expect(dflt).toMatchObject({ sandbox: "workspace-write", approval: "on-request", reviewer: "user", asks: true });

    const edits = codexRunPolicy("acceptEdits", cwd);
    expect(edits).toMatchObject({ sandbox: "workspace-write", approval: "never", reviewer: "user", asks: false });

    const bypass = codexRunPolicy("bypassPermissions", cwd);
    expect(bypass).toMatchObject({ sandbox: "danger-full-access", approval: "never", writableRoots: [], asks: false });
    expect(sandboxPolicyObject(bypass)).toEqual({ type: "dangerFullAccess" });

    const plan = codexRunPolicy("plan", cwd);
    expect(plan).toMatchObject({ sandbox: "read-only", approval: "never", network: false, writableRoots: [] });
    expect(sandboxPolicyObject(plan)).toEqual({ type: "readOnly", networkAccess: false });
  });

  it("sends on-request for the never-asking modes once the CLI has downgraded 'never'", () => {
    expect(codexRunPolicy("acceptEdits", os.tmpdir(), { downgraded: true })).toMatchObject({ approval: "on-request", asks: true });
    expect(codexRunPolicy("bypassPermissions", os.tmpdir(), { downgraded: true }).approval).toBe("on-request");
    // The asking modes already ask; the flag changes nothing for them.
    expect(codexRunPolicy("auto", os.tmpdir(), { downgraded: true }).reviewer).toBe("auto_review");
  });

  it("offers exactly those keys in the picker, auto marked as the default", () => {
    const modes = codexCapabilities().permissionModes.map((m) => m.value);
    expect(modes).toEqual([...CODEX_MODES]);
    expect(codexCapabilities().permissionModes.find((m) => m.value === "auto")?.sub).toContain("(default)");
  });
});

describe("writable roots for a linked worktree", () => {
  it("grants the private gitdir and the common dir's objects, refs and logs — never the common dir itself", () => {
    const { repo, wt } = worktreeFixture();
    const roots = gitWritableRoots(wt);
    const common = path.join(repo, ".git");
    expect(roots).toContain(path.join(common, "worktrees", "wt"));
    expect(roots).toContain(path.join(common, "objects"));
    expect(roots).toContain(path.join(common, "refs"));
    expect(roots).toContain(path.join(common, "logs"));
    expect(roots).not.toContain(common);
    expect(roots.some((r) => r.endsWith("hooks"))).toBe(false);
  });

  it("returns nothing for a primary checkout or a non-git directory", () => {
    const { repo } = worktreeFixture();
    expect(gitWritableRoots(repo)).toEqual([]);
    expect(gitWritableRoots(os.tmpdir())).toEqual([]);
  });

  it("lands on the workspace-write policy object and on no other", () => {
    const { wt } = worktreeFixture();
    const ww = sandboxPolicyObject(codexRunPolicy("default", wt, { extraRoots: ["/extra"] }));
    expect(ww.type).toBe("workspaceWrite");
    if (ww.type === "workspaceWrite") {
      expect(ww.writableRoots.some((r) => r.endsWith(path.join("worktrees", "wt")))).toBe(true);
      expect(ww.writableRoots).toContain("/extra");
      expect(ww.networkAccess).toBe(true);
    }
    expect(codexRunPolicy("bypassPermissions", wt).writableRoots).toEqual([]);
    expect(codexRunPolicy("plan", wt).writableRoots).toEqual([]);
  });

  it("reads CODEX_WRITABLE_ROOTS as absolute paths on the platform delimiter", () => {
    const abs = path.resolve(os.tmpdir(), "x");
    expect(configuredWritableRoots(["", "relative/dir", abs, " "].join(path.delimiter))).toEqual([abs]);
    expect(configuredWritableRoots("")).toEqual([]);
  });
});

describe("the bypassPermissions → acceptEdits migration for Codex rows", () => {
  let open: Database.Database | undefined;
  afterEach(() => open?.close());

  function seeded() {
    const db = (open = new Database(":memory:"));
    init(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, port, position, created_at)
       VALUES ('p1', 'P', 'P', '', '#C2603C', '', '', 'main', 0, 0, ?)`,
    ).run(now);
    const task = db.prepare(
      `INSERT INTO tasks (id, project_id, title, description, priority, status, generation, created_at, updated_at, agent, permission_mode)
       VALUES (?, 'p1', 'T', '', 'med', 'in_progress', 1, ?, ?, ?, ?)`,
    );
    task.run("codex-bypass", now, now, "codex", "bypassPermissions");
    task.run("codex-plan", now, now, "codex", "plan");
    task.run("claude-bypass", now, now, "claude", "bypassPermissions");
    db.prepare(`INSERT INTO runbooks (id, project_id, name, prompt, agent, permission_mode, created_at, updated_at) VALUES ('r1', 'p1', 'R', 'go', 'codex', 'bypassPermissions', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_permission_mode:codex', 'bypassPermissions')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_permission_mode:claude', 'bypassPermissions')`).run();
    // Pretend this database predates the migration.
    db.prepare("DELETE FROM settings WHERE key = 'codex_modes_migrated'").run();
    return db;
  }

  const mode = (db: Database.Database, id: string) =>
    (db.prepare("SELECT permission_mode FROM tasks WHERE id = ?").get(id) as { permission_mode: string | null }).permission_mode;
  const setting = (db: Database.Database, key: string) =>
    (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;

  it("moves every Codex row that chose the old sandboxed 'bypass' onto acceptEdits and leaves the rest alone", () => {
    const db = seeded();
    migrate(db);
    expect(mode(db, "codex-bypass")).toBe("acceptEdits");
    expect(mode(db, "codex-plan")).toBe("plan");
    expect(mode(db, "claude-bypass")).toBe("bypassPermissions");
    expect((db.prepare("SELECT permission_mode FROM runbooks WHERE id = 'r1'").get() as { permission_mode: string }).permission_mode).toBe("acceptEdits");
    expect(setting(db, "default_permission_mode:codex")).toBe("acceptEdits");
    expect(setting(db, "default_permission_mode:claude")).toBe("bypassPermissions");
    expect(setting(db, "codex_modes_migrated")).toBe("1");
  });

  it("runs once: a row that chooses full access after the migration keeps it", () => {
    const db = seeded();
    migrate(db);
    db.prepare("UPDATE tasks SET permission_mode = 'bypassPermissions' WHERE id = 'codex-plan'").run();
    migrate(db);
    expect(mode(db, "codex-plan")).toBe("bypassPermissions");
  });
});
