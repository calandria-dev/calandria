import { beforeEach, describe, expect, it } from "vitest";
import { GET as getProjectRoute, PATCH as patchProjectRoute } from "@/app/api/projects/[id]/route";
import { GET as listProjectsRoute } from "@/app/api/projects/route";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { GET as getTaskRoute, PATCH as patchTaskRoute } from "@/app/api/tasks/[id]/route";
import { getDb } from "@/lib/db";
import { deleteProviderSecrets, setProviderSecret } from "@/lib/providerSecrets";
import { createProvider, getProvider } from "@/lib/providers/store";
import { createProject, createTask, getProject, getTask } from "@/lib/store";
import type { Project, Task } from "@/lib/types";

const request = (method: string, body: unknown) =>
  new Request("http://test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const projectParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
});

describe("provider ids on project and task routes", () => {
  it("PATCH /api/projects/[id] stores default_provider_id", async () => {
    const project = createProject({ name: "Project provider" });
    const provider = createProvider({
      type: "custom",
      label: "Private endpoint",
      config: { base_url: "https://models.example.test/v1", api: "openai" },
    });
    const response = await patchProjectRoute(
      request("PATCH", { default_provider_id: provider.id }),
      projectParams(project.id),
    );

    expect(response.status).toBe(200);
    expect(getProject(project.id)!.default_provider_id).toBe(provider.id);
    const body = await response.json();
    expect(body.default_provider_id).toBe(provider.id);
    expect(body.provider).toMatchObject({ kind: "custom", openai_base_url: "https://models.example.test/v1", auth_token: null });
  });

  it("PATCH /api/tasks/[id] stores provider_id", async () => {
    const project = createProject({ name: "Task provider" });
    const provider = createProvider({ type: "ollama", config: { base_url: "http://ollama.test:11434" } });
    const task = createTask({ project_id: project.id, title: "Task" });
    const response = await patchTaskRoute(
      request("PATCH", { provider_id: provider.id }),
      projectParams(task.id),
    );

    expect(response.status).toBe(200);
    expect(getTask(task.id)!.provider_id).toBe(provider.id);
  });

  it("POST /api/tasks accepts provider_id", async () => {
    const project = createProject({ name: "Create provider" });
    const provider = createProvider({ type: "lmstudio", config: { base_url: "http://lmstudio.test:1234" } });
    const response = await createTaskRoute(
      request("POST", {
        project_id: project.id,
        title: "Created task",
        provider_id: provider.id,
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Task;
    expect(body.provider_id).toBe(provider.id);
    expect(getTask(body.id)!.provider_id).toBe(provider.id);
  });
});

describe("provider-safe project and task reads", () => {
  it("GET /api/projects/[id] includes the derived provider and strips secrets", async () => {
    const project = createProject({ name: "Read project" });
    const provider = createProvider({
      type: "custom",
      config: { base_url: "https://private.example.test/v1", api: "openai" },
    });
    setProviderSecret(provider.id, "key", "super-secret");
    try {
      const updated = getDb().prepare("UPDATE projects SET default_provider_id = ? WHERE id = ?").run(provider.id, project.id);
      expect(updated.changes).toBe(1);
      const response = await getProjectRoute(request("GET", undefined), projectParams(project.id));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Project & { provider: Record<string, unknown> };
      expect(body.provider).toMatchObject({ kind: "custom", openai_base_url: "https://private.example.test/v1", auth_token: null });
      expect(body.provider).not.toHaveProperty("super-secret");
      expect(JSON.stringify(body)).not.toContain("super-secret");

      const listResponse = await listProjectsRoute();
      const listed = (await listResponse.json()).find((row: { id: string }) => row.id === project.id);
      expect(listed.provider).toMatchObject({ kind: "custom", auth_token: null });
      expect(JSON.stringify(listed)).not.toContain("super-secret");
    } finally {
      deleteProviderSecrets(provider.id);
    }
  });

  it("GET /api/tasks/[id] includes the derived provider and strips secrets", async () => {
    const project = createProject({ name: "Read task" });
    const provider = createProvider({ type: "openai_key", config: { default_model: "gpt-test" } });
    setProviderSecret(provider.id, "key", "vendor-secret");
    try {
      const task = createTask({ project_id: project.id, title: "Read task", provider_id: provider.id });
      const response = await getTaskRoute(request("GET", undefined), projectParams(task.id));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Task & { provider: Record<string, unknown> };
      expect(body.provider).toMatchObject({ kind: "cloud", pricing: "vendor", model: "gpt-test", auth_token: null });
      expect(JSON.stringify(body)).not.toContain("vendor-secret");
      expect(getProvider(provider.id)).not.toHaveProperty("key");
    } finally {
      deleteProviderSecrets(provider.id);
    }
  });
});
