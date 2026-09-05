// Tests the groups → tags upgrade path (lib/db.ts migrate(); docs/FEATURES.md
// § Migration).
//
// This is the one part of the conversion a fresh install never exercises,
// since the tables it reads only exist on a database that ran the old schema.
// The test rebuilds that shape on top of the current one (the `task_groups`
// table, the `tasks.group_id` column, a recorded agent edit naming the
// `group` field) and runs migrate() over it, matching what an upgrading
// instance does at boot.
import { describe, expect, it, beforeEach } from "vitest";
import { getDb, migrate } from "@/lib/db";
import { createProject, createTask, getTaskTagIds, listTags, recordAgentEdit, listAgentEdits } from "@/lib/store";
import { nanoid } from "nanoid";

/** The pre-tags shape, recreated verbatim from the schema it shipped as. */
function restoreLegacySchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_groups (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      color          TEXT,
      origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      position       INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_task_groups_project ON task_groups(project_id);
  `);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("group_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id) ON DELETE SET NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)");
}

const taskColumns = () => (getDb().prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
const tableExists = (name: string) =>
  !!getDb().prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

describe("groups → tags migration", () => {
  let pid: string;
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM tags").run();
    pid = createProject({ name: `legacy-${nanoid(6)}` }).id;
    restoreLegacySchema();
  });

  it("copies every group across with its id, and every group_id becomes a membership", () => {
    const db = getDb();
    const planner = createTask({ project_id: pid, title: "Plan the auth migration" });
    const a = createTask({ project_id: pid, title: "Add session table" });
    const b = createTask({ project_id: pid, title: "Port login route" });
    const loose = createTask({ project_id: pid, title: "Unrelated" });
    const gid = nanoid();
    const now = Date.now();
    db.prepare(
      `INSERT INTO task_groups (id, project_id, name, description, color, origin_task_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(gid, pid, "Auth migration", "the brief", "#3E7CA8", planner.id, 3, now, now);
    db.prepare("UPDATE tasks SET group_id = ? WHERE id IN (?, ?)").run(gid, a.id, b.id);

    migrate(db);

    // The id survives: origin_task_id, a bookmarked URL and any recorded agent
    // edit all name it, and a re-keyed tag would break every one of them.
    const tags = listTags(pid);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      id: gid,
      name: "Auth migration",
      description: "the brief",
      color: "#3E7CA8",
      origin_task_id: planner.id,
      position: 3,
    });
    // …and its members are its members, with the counts derived from them.
    expect(getTaskTagIds(a.id)).toEqual([gid]);
    expect(getTaskTagIds(b.id)).toEqual([gid]);
    expect(getTaskTagIds(loose.id)).toEqual([]);
    expect(tags[0].counts.total).toBe(2);
  });

  it("drops the old column and table, so nothing can answer membership twice", () => {
    const db = getDb();
    expect(taskColumns()).toContain("group_id");
    migrate(db);
    expect(taskColumns()).not.toContain("group_id");
    expect(tableExists("task_groups")).toBe(false);
    expect(tableExists("task_tags")).toBe(true);
  });

  it("is a no-op the second time, and on a database that never had groups", () => {
    const db = getDb();
    const t = createTask({ project_id: pid, title: "Solo" });
    const gid = nanoid();
    const now = Date.now();
    db.prepare(
      `INSERT INTO task_groups (id, project_id, name, description, color, origin_task_id, position, created_at, updated_at)
       VALUES (?, ?, 'Once', '', NULL, NULL, 0, ?, ?)`
    ).run(gid, pid, now, now);
    db.prepare("UPDATE tasks SET group_id = ? WHERE id = ?").run(gid, t.id);

    migrate(db);
    migrate(db);

    expect(listTags(pid).map((x) => x.id)).toEqual([gid]);
    expect(getTaskTagIds(t.id)).toEqual([gid]);
  });

  it("rewrites recorded agent edits from `group` to a one-element `tags` list", () => {
    const db = getDb();
    const target = createTask({ project_id: pid, title: "Edited by an agent" });
    const gid = nanoid();
    const now = Date.now();
    db.prepare(
      `INSERT INTO task_groups (id, project_id, name, description, color, origin_task_id, position, created_at, updated_at)
       VALUES (?, ?, 'Auth migration', '', NULL, NULL, 0, ?, ?)`
    ).run(gid, pid, now, now);
    // Written through the store so the row is shaped exactly as the old
    // update_task wrote it: a scalar group id in before_value/after_value.
    recordAgentEdit({
      task_id: target.id,
      project_id: pid,
      actor_task_id: "planner",
      actor_title: "Plan it",
      actor_agent: "claude",
      changes: [
        { field: "title" as const, before: "Old", after: "New", before_value: "Old", after_value: "New" },
        // Cast: `group` is no longer in the union. This models a row written
        // under the field's earlier name.
        { field: "group", before: "(none)", after: "Auth migration", before_value: null, after_value: gid } as never,
      ],
    });

    migrate(db);

    const [edit] = listAgentEdits(target.id);
    const tags = edit.changes.find((c) => c.field === "tags");
    expect(tags).toBeDefined();
    // The readable halves are untouched, since they were already names, and
    // Revert gets the id LIST it writes back through setTaskTags.
    expect(tags!.before_value).toEqual([]);
    expect(tags!.after_value).toEqual([gid]);
    // Everything else in the same row is left exactly as it was.
    expect(edit.changes.find((c) => c.field === "title")).toMatchObject({ before_value: "Old", after_value: "New" });
  });
});
