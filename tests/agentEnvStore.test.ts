import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, updateProject, createTask, updateTask, addUsage, getProject, getTask } from "@/lib/store";
import { createProvider, getProvider } from "@/lib/providers/store";
import { resolvedTaskProvider } from "@/lib/providers/resolve";

describe("provider rows used by projects and tasks", () => {
  it("resolves task, then project, with the provider row kept secret-free", () => {
    const project = createProject({ name: "provider-precedence" });
    const projectProvider = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434", default_model: "qwen3" } });
    const taskProvider = createProvider({ type: "custom", config: { base_url: "https://models.example.test", api: "anthropic", default_model: "claude-local" } });
    updateProject(project.id, { default_provider_id: projectProvider.id });
    expect(getProvider(projectProvider.id)).not.toHaveProperty("key");
    expect(resolvedTaskProvider(getProject(project.id)!, null, "claude")).toMatchObject({ kind: "local", model: "qwen3" });

    const task = createTask({ project_id: project.id, title: "task", provider_id: taskProvider.id });
    expect(resolvedTaskProvider(getProject(project.id)!, getTask(task.id)!, "claude")).toMatchObject({ kind: "custom", host: "models.example.test", model: "claude-local" });
    updateTask(task.id, { provider_id: null });
    expect(resolvedTaskProvider(getProject(project.id)!, getTask(task.id)!, "claude").kind).toBe("local");
  });

  it("stores provider ids on project and task rows", () => {
    const project = createProject({ name: "provider-ids" });
    const provider = createProvider({ type: "lmstudio", config: { base_url: "http://localhost:1234" } });
    expect(updateProject(project.id, { default_provider_id: provider.id })!.default_provider_id).toBe(provider.id);
    const task = createTask({ project_id: project.id, title: "task", provider_id: provider.id });
    expect(task.provider_id).toBe(provider.id);
    expect(updateTask(task.id, { provider_id: null })!.provider_id).toBeNull();
  });

  it("addUsage stores the resolved provider host, including cloud as empty", () => {
    const project = createProject({ name: "provider-usage" });
    const task = createTask({ project_id: project.id, title: "task" });
    const usage = { cost_usd: 0, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", usage });
    addUsage({ project_id: project.id, task_id: task.id, generation: 1, agent: "claude", provider: "localhost:11434", usage });
    const rows = getDb().prepare("SELECT provider FROM task_usage WHERE task_id = ? ORDER BY rowid").all(task.id) as { provider: string }[];
    expect(rows.map((row) => row.provider)).toEqual(["", "localhost:11434"]);
  });
});
