import { createServer, type Server } from "node:http";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { createProject, createTask } from "@/lib/store";
import { createSchedule } from "@/lib/schedule/store";
import { createRunbook } from "@/lib/runbooks/store";
import { ensureBundledProvider, getProvider, listProviders } from "@/lib/providers/store";
import { getProviderSecret, hasProviderSecret } from "@/lib/providerSecrets";
import { GET as listProvidersRoute, POST as createProviderRoute } from "@/app/api/providers/route";
import {
  GET as getProviderRoute,
  PATCH as patchProviderRoute,
  DELETE as deleteProviderRoute,
} from "@/app/api/providers/[id]/route";
import { GET as usageRoute } from "@/app/api/providers/[id]/usage/route";
import { POST as testUnsavedRoute } from "@/app/api/providers/test/route";
import { POST as testSavedRoute } from "@/app/api/providers/[id]/test/route";
import { GET as detectRoute } from "@/app/api/providers/detect/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method = "POST") =>
  new Request("http://test/api/providers", { method, body: JSON.stringify(body) });
const bodyOf = async (response: Response) => (await response.json()) as Record<string, any>;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
  getDb().prepare("DELETE FROM runbooks").run();
  getDb().prepare("DELETE FROM schedules").run();
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined as never;
});

describe("provider routes", () => {
  it("creates and redacts provider secrets on GET", async () => {
    const created = await createProviderRoute(json({
      type: "litellm",
      label: "Work gateway",
      config: { base_url: "http://gateway.example" },
      key: "sk-test-secret",
      admin_key: "admin-secret",
      model_policy: { mode: "allow", ids: ["gpt-5"], known: ["gpt-5"], unavailable: [] },
    }));
    expect(created.status).toBe(201);
    const provider = (await bodyOf(created)).provider;
    expect(provider).toMatchObject({ label: "Work gateway", type: "litellm", has_key: true, has_admin_key: true });
    expect(JSON.stringify(provider)).not.toContain("sk-test-secret");
    expect(getProviderSecret(provider.id, "key")).toBe("sk-test-secret");

    const listed = await bodyOf(await listProvidersRoute());
    expect(listed.providers).toHaveLength(1);
    expect(JSON.stringify(listed.providers)).not.toContain("admin-secret");
  });

  it("refuses bundled providers on POST and DELETE", async () => {
    const post = await createProviderRoute(json({ type: "anthropic", label: "Nope" }));
    expect(post.status).toBe(400);

    const bundled = ensureBundledProvider("claude")!;
    const deleted = await deleteProviderRoute(new Request("http://test", { method: "DELETE" }), params(bundled.id));
    expect(deleted.status).toBe(409);
    expect(getProvider(bundled.id)).not.toBeNull();
  });

  it("honors PATCH secret semantics: empty leaves and null clears", async () => {
    const created = await bodyOf(await createProviderRoute(json({
      type: "litellm", config: { base_url: "http://gateway.example" }, key: "old-key",
    })));
    const id = created.provider.id as string;

    const left = await patchProviderRoute(json({ key: "" }, "PATCH"), params(id));
    expect(left.status).toBe(200);
    expect(getProviderSecret(id, "key")).toBe("old-key");

    const cleared = await patchProviderRoute(json({ key: null }, "PATCH"), params(id));
    expect(cleared.status).toBe(200);
    expect(hasProviderSecret(id, "key")).toBe(false);
  });

  it("returns usage and detaches all references on DELETE", async () => {
    const provider = (await bodyOf(await createProviderRoute(json({
      type: "litellm", config: { base_url: "http://gateway.example" },
    })))).provider;
    const project = createProject({ name: `provider-route-${Math.random().toString(36).slice(2)}` });
    getDb().prepare("UPDATE projects SET default_provider_id = ? WHERE id = ?").run(provider.id, project.id);
    const task = createTask({ project_id: project.id, title: "provider task" });
    getDb().prepare("UPDATE tasks SET provider_id = ? WHERE id = ?").run(provider.id, task.id);
    const schedule = createSchedule({
      project_id: project.id, name: "provider schedule", prompt: "/test", days_mask: 62,
      time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET provider_id = ? WHERE id = ?").run(provider.id, schedule.id);
    const runbook = createRunbook({ project_id: project.id, name: "provider runbook", prompt: "/test" });
    getDb().prepare("UPDATE runbooks SET provider_id = ? WHERE id = ?").run(provider.id, runbook.id);

    const usage = await bodyOf(await usageRoute(new Request("http://test"), params(provider.id)));
    expect(usage.usage.projects.map((x: any) => x.id)).toContain(project.id);
    expect(usage.usage.tasks.map((x: any) => x.id)).toContain(task.id);
    expect(usage.usage.schedules.map((x: any) => x.id)).toContain(schedule.id);
    expect(usage.usage.runbooks.map((x: any) => x.id)).toContain(runbook.id);

    const deleted = await bodyOf(await deleteProviderRoute(new Request("http://test", { method: "DELETE" }), params(provider.id)));
    expect(deleted.usage).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ id: project.id })]),
      tasks: expect.arrayContaining([expect.objectContaining({ id: task.id })]),
      schedules: expect.arrayContaining([expect.objectContaining({ id: schedule.id })]),
      runbooks: expect.arrayContaining([expect.objectContaining({ id: runbook.id })]),
    });
    expect(getProvider(provider.id)).toBeNull();
    expect((getDb().prepare("SELECT default_provider_id FROM projects WHERE id = ?").get(project.id) as any).default_provider_id).toBeNull();
  });

  it("tests an unsaved local provider and returns its models", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "llama3" }, { name: "qwen" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await bodyOf(await testUnsavedRoute(json({
      type: "ollama", config: { base_url: "http://localhost:11434" },
    })));
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "llama3", family: null }),
      expect.objectContaining({ id: "qwen", family: null }),
    ]));
  });

  it("tests a saved provider, persists the result, and presents status and model count", async () => {
    const created = await bodyOf(await createProviderRoute(json({
      type: "ollama", config: { base_url: "http://127.0.0.1:38471" },
    })));
    const id = created.provider.id as string;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "llama3" }, { name: "qwen" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const testedAt = Date.now();
    const result = await bodyOf(await testSavedRoute(new Request("http://test", { method: "POST" }), params(id)));
    expect(result.reachable).toBe(true);
    expect(getProvider(id)!.last_test).toMatchObject({ reachable: true, models: [
      expect.objectContaining({ id: "llama3", family: null }),
      expect.objectContaining({ id: "qwen", family: null }),
    ] });
    expect(getProvider(id)!.last_test_at).toBeGreaterThanOrEqual(testedAt);

    const presented = await bodyOf(await getProviderRoute(new Request("http://test"), params(id)));
    expect(presented.provider).toMatchObject({ status: "reachable", model_count: 2 });
  });

  it("counts an explicitly empty successful catalog as zero models", async () => {
    const created = await bodyOf(await createProviderRoute(json({
      type: "litellm",
      config: { base_url: "http://gateway.example" },
      model_policy: { mode: "allow", ids: ["gpt-5"], known: ["gpt-5"], unavailable: [] },
    })));
    const id = created.provider.id as string;
    const now = Date.now();
    getDb().prepare("UPDATE model_providers SET last_test = ?, last_test_at = ? WHERE id = ?")
      .run(JSON.stringify({ reachable: true, models: [] }), now, id);

    const presented = await bodyOf(await getProviderRoute(new Request("http://test"), params(id)));
    expect(presented.provider).toMatchObject({ status: "reachable", model_count: 0 });
  });

  it("detects a local server through a free-port stub server", async () => {
    originalFetch = globalThis.fetch;
    const server: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "llama3" }, { name: "qwen" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub server did not get a port");
    const target = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const mapped = String(input).replace("http://localhost:11434", target).replace("http://localhost:1234", target);
      return originalFetch(mapped, init);
    }) as typeof fetch;
    try {
      const result = await bodyOf(await detectRoute());
      expect(result.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "ollama", base_url: "http://localhost:11434", model_count: 2 }),
        expect.objectContaining({ type: "lmstudio", base_url: "http://localhost:1234", model_count: 2 }),
      ]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not detect a reachable endpoint already used by any provider type", async () => {
    await createProviderRoute(json({
      type: "custom", config: { base_url: "http://localhost:11434", api: "openai" },
    }));
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "llama3" }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await bodyOf(await detectRoute());
    expect(result.servers.some((server: { type: string; base_url: string }) =>
      server.type === "ollama" && server.base_url === "http://localhost:11434",
    )).toBe(false);
  });
});
