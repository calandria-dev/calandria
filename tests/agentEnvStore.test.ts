import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, updateProject, createTask, updateTask, addUsage, getProject, getTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { LOCAL_MODEL_BASE_URL } from "@/lib/config";
import { taskProvider } from "@/lib/agentEnv";

// The persisted half of the provider override: the allowlist is enforced by
// the store (serializeAgentEnv) on every write path, `task_usage.provider`
// tags a turn with the endpoint it ran against, and `suggest_task`'s
// `provider` param — the delegation hook — writes the same preset the
// settings form does.

describe("agent_env in the store", () => {
  it("updateProject normalizes the override through the allowlist, from an object or JSON text", () => {
    const p = createProject({ name: "env-proj" });
    expect(p.agent_env).toBe("");
    const asObject = updateProject(p.id, { agent_env: { ANTHROPIC_BASE_URL: "http://localhost:11434", PATH: "/evil" } as unknown as string })!;
    expect(asObject.agent_env).toBe('{"ANTHROPIC_BASE_URL":"http://localhost:11434"}');
    const asText = updateProject(p.id, { agent_env: '{"OPENAI_BASE_URL":"http://localhost:1234/v1","NODE_OPTIONS":"--require x"}' })!;
    expect(asText.agent_env).toBe('{"OPENAI_BASE_URL":"http://localhost:1234/v1"}');
    // An unrelated patch leaves it alone; clearing takes any empty form.
    expect(updateProject(p.id, { name: "renamed" })!.agent_env).toBe(asText.agent_env);
    expect(updateProject(p.id, { agent_env: "" })!.agent_env).toBe("");
  });

  it("createTask and updateTask carry a task-level override, defaulting to inherit", () => {
    const p = createProject({ name: "env-task" });
    const t = createTask({ project_id: p.id, title: "t", agent_env: { CODEX_MODEL: "gpt-oss:20b", PATH: "/evil" } });
    expect(t.agent_env).toBe('{"CODEX_MODEL":"gpt-oss:20b"}');
    const plain = createTask({ project_id: p.id, title: "u" });
    expect(plain.agent_env).toBe("");
    expect(updateTask(plain.id, { agent_env: '{"ANTHROPIC_MODEL":"gemma3"}' })!.agent_env).toBe('{"ANTHROPIC_MODEL":"gemma3"}');
    expect(updateTask(plain.id, { title: "v" })!.agent_env).toBe('{"ANTHROPIC_MODEL":"gemma3"}');
  });

  it("addUsage stores the provider host, '' for the cloud", () => {
    const p = createProject({ name: "env-usage" });
    const t = createTask({ project_id: p.id, title: "t" });
    const usage = { cost_usd: 0, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };
    addUsage({ project_id: p.id, task_id: t.id, generation: 1, agent: "claude", usage });
    addUsage({ project_id: p.id, task_id: t.id, generation: 1, agent: "claude", provider: "localhost:11434", usage });
    const rows = getDb().prepare("SELECT provider FROM task_usage WHERE task_id = ? ORDER BY rowid").all(t.id) as { provider: string }[];
    expect(rows.map((r) => r.provider)).toEqual(["", "localhost:11434"]);
  });
});

describe("suggest_task provider param", () => {
  it("'local' pins the task to the instance's local endpoint with the named model", () => {
    const p = createProject({ name: "delegate" });
    const { task, text } = createSuggestedTask(p, { title: "rename the helpers", description: "…", provider: "local", model: "qwen3-coder" });
    expect(task).not.toBeNull();
    const provider = taskProvider(getProject(p.id)!, getTask(task!.id)!);
    expect(provider.kind).toBe("local");
    expect(provider.anthropic_base_url).toBe(LOCAL_MODEL_BASE_URL);
    expect(provider.model).toBe("qwen3-coder");
    expect(task!.model).toBe("qwen3-coder");
    expect(text).toContain("local model server");
  });

  it("'local' without a model refuses unless the project already names one, and reuses the project's endpoint", () => {
    const p = createProject({ name: "delegate-2" });
    const refused = createSuggestedTask(p, { title: "x", description: "…", provider: "local" });
    expect(refused.task).toBeNull();
    expect(refused.text).toMatch(/needs a model/);
    updateProject(p.id, { agent_env: '{"ANTHROPIC_BASE_URL":"http://192.168.1.50:11434","ANTHROPIC_MODEL":"gemma3"}' });
    const ok = createSuggestedTask(getProject(p.id)!, { title: "y", description: "…", provider: "local" });
    expect(ok.task).not.toBeNull();
    const provider = taskProvider(getProject(p.id)!, getTask(ok.task!.id)!);
    expect(provider.anthropic_base_url).toBe("http://192.168.1.50:11434");
    expect(provider.model).toBe("gemma3");
  });

  it("'cloud' sends a task back to the agent's login inside a local project", () => {
    const p = createProject({ name: "delegate-3" });
    updateProject(p.id, { agent_env: '{"ANTHROPIC_BASE_URL":"http://localhost:11434","ANTHROPIC_MODEL":"gemma3"}' });
    const { task } = createSuggestedTask(getProject(p.id)!, { title: "z", description: "…", provider: "cloud" });
    expect(taskProvider(getProject(p.id)!, getTask(task!.id)!).kind).toBe("cloud");
    // Omitted = inherit.
    const inherit = createSuggestedTask(getProject(p.id)!, { title: "w", description: "…" });
    expect(inherit.task!.agent_env).toBe("");
    expect(taskProvider(getProject(p.id)!, getTask(inherit.task!.id)!).kind).toBe("local");
  });
});
