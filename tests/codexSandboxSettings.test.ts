import { describe, expect, it } from "vitest";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { PATCH as patchSettings } from "@/app/api/settings/route";
import { createProject, createTask, getSetting, getTask, listTasks } from "@/lib/store";
import Database from "better-sqlite3";
import { init, migrate } from "@/lib/db";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("Codex sandbox settings", () => {
  it("migrates existing task rows with a null sandbox override", () => {
    const db = new Database(":memory:");
    try {
      init(db);
      db.prepare("INSERT INTO projects (id, name, created_at) VALUES ('project', 'Project', ?)").run(Date.now());
      db.prepare("INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('task', 'project', 'Task', ?, ?)").run(Date.now(), Date.now());
      db.exec("ALTER TABLE tasks DROP COLUMN sandbox_mode");

      migrate(db);

      expect(db.prepare("SELECT sandbox_mode FROM tasks WHERE id = 'task'").get()).toEqual({ sandbox_mode: null });
    } finally {
      db.close();
    }
  });

  it("persists a task override and clears it when the agent changes", async () => {
    const project = createProject({ name: "Sandbox persistence" });
    const task = createTask({ project_id: project.id, title: "Task", agent: "codex" });

    const set = await patchTask(
      new Request("http://test", { method: "PATCH", body: JSON.stringify({ sandbox_mode: "workspace-write" }) }),
      params(task.id)
    );
    expect(set.status).toBe(200);
    expect(getTask(task.id)?.sandbox_mode).toBe("workspace-write");
    const response = await patchTask(
      new Request("http://test", { method: "PATCH", body: JSON.stringify({ agent: "claude" }) }),
      params(task.id)
    );

    expect(response.status).toBe(200);
    expect(getTask(task.id)?.sandbox_mode).toBeNull();
  });

  it("rejects an invalid task override before changing any task field", async () => {
    const project = createProject({ name: "Sandbox atomic patch" });
    const task = createTask({ project_id: project.id, title: "Original", sandbox_mode: "read-only" });

    const response = await patchTask(
      new Request("http://test", { method: "PATCH", body: JSON.stringify({ title: "Changed", sandbox_mode: "unsafe" }) }),
      params(task.id)
    );

    expect(response.status).toBe(400);
    expect(getTask(task.id)).toMatchObject({ title: "Original", sandbox_mode: "read-only" });
  });

  it("rejects an invalid create override without creating a task", async () => {
    const project = createProject({ name: "Sandbox atomic create" });
    const response = await createTaskRoute(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, title: "No row", sandbox_mode: "unsafe" }),
    }));

    expect(response.status).toBe(400);
    expect(listTasks(project.id)).toEqual([]);
  });

  it("only accepts the Codex default key and valid sandbox values", async () => {
    const invalid = await patchSettings(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ "default_sandbox_mode:codex": "unsafe", notifications: "off" }),
    }));
    expect(invalid.status).toBe(400);
    expect(getSetting("default_sandbox_mode:codex")).toBeNull();
    expect(getSetting("notifications")).toBeNull();

    const valid = await patchSettings(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ "default_sandbox_mode:codex": "danger-full-access" }),
    }));
    expect(valid.status).toBe(200);
    expect(getSetting("default_sandbox_mode:codex")).toBe("danger-full-access");

    await patchSettings(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ "default_sandbox_mode:claude": "read-only", "default_sandbox_mode:codex": null }),
    }));
    expect(getSetting("default_sandbox_mode:codex")).toBeNull();
    expect(getSetting("default_sandbox_mode:claude")).toBeNull();
  });
});
