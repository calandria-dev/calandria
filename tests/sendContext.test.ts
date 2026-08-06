import { describe, expect, it } from "vitest";
import { createProject, createTask, getTask, updateProject, updateTask } from "@/lib/store";
import { buildProjectContext } from "@/lib/agents/shared";

describe("send_context (saved project context in sessions)", () => {
  it("defaults on for projects and tasks — the historic always-included behavior", () => {
    const project = createProject({ name: "Ctx defaults", context: "We build widgets." });
    expect(project.send_context).toBe(1);
    const task = createTask({ project_id: project.id, title: "Do a thing" });
    expect(task.send_context).toBe(1);
    expect(buildProjectContext(project, task)).toContain("We build widgets.");
  });

  it("new tasks seed their flag from the project setting", () => {
    const project = createProject({ name: "Ctx off by default", context: "Secret sauce." });
    updateProject(project.id, { send_context: 0 });
    const task = createTask({ project_id: project.id, title: "Quiet task" });
    expect(task.send_context).toBe(0);
    // An explicit choice at creation wins over the project default.
    const loud = createTask({ project_id: project.id, title: "Loud task", send_context: true });
    expect(loud.send_context).toBe(1);
  });

  it("omits only the saved context block — task details and tool instructions stay", () => {
    const project = createProject({ name: "Ctx trimmed", context: "Stack: Next.js, SQLite." });
    const task = createTask({ project_id: project.id, title: "Add a button", description: "A red one." });
    updateTask(task.id, { send_context: 0 });
    const ctx = buildProjectContext(project, getTask(task.id)!);
    expect(ctx).not.toContain("Stack: Next.js, SQLite.");
    expect(ctx).not.toContain("What we're building");
    expect(ctx).toContain('The current task is: "Add a button"');
    expect(ctx).toContain("Task details: A red one.");
    expect(ctx).toContain("suggest_task");
    expect(ctx).toContain("expose_service");
  });
});
