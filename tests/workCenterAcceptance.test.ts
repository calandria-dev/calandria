import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";

// Stage 1 acceptance (WC-11): behavior that spans the surfaces and the
// database lifecycle rather than one module. Per-module cases live in the
// other workCenter*.test.ts files.
import { init, migrate } from "../lib/db";
import { createProject, createTask, updateTask } from "@/lib/store";
import { assembleSnapshot } from "@/lib/workCenter/snapshot";
import { awaitingCountFor, needsYouRows } from "@/lib/workCenter/compat";
import { parkAsk } from "./helpers";

const WC_COLUMNS = [
  "active_turn_id", "latest_turn_id", "latest_turn_outcome", "latest_turn_failure_code",
  "completed_at", "failure_ack_turn_id", "base_rewrite_episode_id", "pr_ci_episode_id",
  "ci_recovery_episode_id",
];

const columnsOf = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);

describe("database lifecycle", () => {
  it("a fresh database has every Work Center column and no recorded turns", () => {
    const db = new Database(":memory:");
    init(db);
    const cols = columnsOf(db);
    for (const c of WC_COLUMNS) expect(cols, c).toContain(c);
    expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE latest_turn_id IS NOT NULL OR active_turn_id IS NOT NULL").get() as { n: number }).n).toBe(0);
  });

  it("an upgraded database keeps old rows, reads their results as unknown, and migrates twice without change", () => {
    const db = new Database(":memory:");
    init(db);
    db.prepare("INSERT INTO projects (id, name, repo_path, created_at) VALUES ('p','P','/tmp/x',1)").run();
    db.prepare(
      "INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at) VALUES ('t','p','old','', 'done', 1, 1)",
    ).run();
    const before = db.prepare("SELECT * FROM tasks").all();
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
    const row = db.prepare("SELECT latest_turn_id, latest_turn_outcome, completed_at, active_turn_id FROM tasks WHERE id='t'").get();
    expect(row).toEqual({ latest_turn_id: null, latest_turn_outcome: null, completed_at: null, active_turn_id: null });
    expect(columnsOf(db).filter((c, i, a) => a.indexOf(c) !== i)).toEqual([]);
  });
});

describe("one visible count across every surface", () => {
  it("the pill headline, project badges and compatibility rows agree across two projects with a snoozed task", async () => {
    const a = createProject({ name: "AccA" });
    const b = createProject({ name: "AccB" });
    const mk = async (projectId: string, title: string) => {
      const t = createTask({ project_id: projectId, title });
      updateTask(t.id, { status: "in_progress", started: 1 });
      await parkAsk(t.id);
      return t;
    };
    const a1 = await mk(a.id, "a1");
    await mk(a.id, "a2");
    await mk(b.id, "b1");
    updateTask(a1.id, { snoozed_until: Date.now() + 3_600_000 });

    const snap = assembleSnapshot({});
    const mine = new Set([a.id, b.id]);
    const global = snap.summary.visibleNeedsYouTaskCount.value as number;
    const perProject = snap.projects.filter((p) => mine.has(p.projectId));
    const badgeSum = perProject.reduce((n, p) => n + (p.summary.visibleNeedsYouTaskCount.value as number), 0);
    const rows = needsYouRows().filter((r) => mine.has(r.project_id));

    // The snoozed task is hidden everywhere: 2 visible of 3 unresolved.
    expect(badgeSum).toBe(2);
    expect(rows.map((r) => r.title).sort()).toEqual(["a2", "b1"]);
    expect(awaitingCountFor(a.id) + awaitingCountFor(b.id)).toBe(badgeSum);
    expect(global).toBeGreaterThanOrEqual(badgeSum);
    expect(snap.summary.needsYouTaskCount.value).toBe(global + (snap.summary.snoozedNeedsYouTaskCount.value as number));
  });
});

describe("project count freshness", () => {
  it("a source that changes after the count was read shows on the next turn of the event loop", async () => {
    const p = createProject({ name: "AccFresh" });
    const t = createTask({ project_id: p.id, title: "f" });
    updateTask(t.id, { status: "in_progress", started: 1 });
    expect(awaitingCountFor(p.id)).toBe(0);
    await parkAsk(t.id);
    await new Promise((r) => setTimeout(r, 0));
    // The desktop badge reads this through /api/projects after each event. A
    // count reused for a second stayed at 0 until an unrelated event arrived.
    expect(awaitingCountFor(p.id)).toBe(1);
  });
});
