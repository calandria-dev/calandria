import { describe, it, expect } from "vitest";
import { createProject, createTask, listTasks, getTaskContext, updateProject, updateTask } from "@/lib/store";
import { createProvider } from "@/lib/providers/store";
import { clearGatewayModelCache, gatewayModelCatalog } from "@/lib/gatewayModels";
import { clearGatewayRates } from "@/lib/gatewayPricing";
import { startFakeGateway } from "./fakeGateway";

// A provider override on a project or task can put a task on an endpoint the
// vendor catalog knows nothing about, so the context gauge must ask the
// provider's own catalog instead of guessing from the model id (formerly
// covered alongside GET /api/projects/[id]/models, retired with that route).

const local = (baseUrl: string, model = "") =>
  createProvider({ type: "ollama", config: { base_url: baseUrl, ...(model ? { default_model: model } : {}) } });
const gateway = (baseUrl: string, model = "") =>
  createProvider({ type: "litellm", config: { base_url: baseUrl, billing: "key", ...(model ? { default_model: model } : {}) } });

async function withGatewayEnv<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CALANDRIA_LITELLM_BASE_URL;
  process.env.CALANDRIA_LITELLM_BASE_URL = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
    else process.env.CALANDRIA_LITELLM_BASE_URL = prev;
  }
}

describe("context window under a provider override", () => {
  it("is the catalog's for a cloud task and unknown for a local one", () => {
    const cloud = createProject({ name: "ctx-cloud" });
    const t = createTask({ project_id: cloud.id, title: "t", agent: "claude", model: "claude-opus-4-5" });
    expect(getTaskContext(t.id).context_window).toBeGreaterThan(0);
    expect(listTasks(cloud.id).find((r) => r.id === t.id)!.context_window).toBeGreaterThan(0);

    // The override rewrites ANTHROPIC_MODEL and the opus/sonnet/haiku aliases,
    // so this task is not running the Opus its row still names. Sizing it
    // from the catalog would draw a 4% gauge on a 32K window about to
    // overflow.
    updateProject(cloud.id, { default_provider_id: local("http://localhost:11434", "qwen3-coder").id });
    expect(getTaskContext(t.id).context_window).toBe(0);
    expect(getTaskContext(t.id).context_pct).toBe(0);
    expect(listTasks(cloud.id).find((r) => r.id === t.id)!.context_window).toBe(0);
  });

  it("follows a TASK-level override, in both directions", () => {
    const p = createProject({ name: "ctx-task" });
    const t = createTask({ project_id: p.id, title: "t", agent: "claude", model: "claude-opus-4-5" });

    updateTask(t.id, { provider_id: local("http://localhost:11434", "qwen3-coder").id });
    expect(getTaskContext(t.id).context_window).toBe(0);

    // A task sent back to the cloud inside a local project is sizable again.
    updateProject(p.id, { default_provider_id: local("http://localhost:11434", "qwen3-coder").id });
    const back = createTask({ project_id: p.id, title: "u", agent: "claude", model: "claude-opus-4-5" });
    expect(getTaskContext(back.id).context_window).toBe(0);
    updateTask(back.id, { provider_id: null });
    updateProject(p.id, { default_provider_id: null });
    expect(getTaskContext(back.id).context_window).toBeGreaterThan(0);
  });

  it("is the gateway catalog's window for a gateway task, unlike a local/custom override", async () => {
    const gw = await startFakeGateway({ models: [{ name: "claude-sonnet-4-5", max_input_tokens: 1_000_000 }] });
    try {
      await withGatewayEnv(gw.url, async () => {
        const p = createProject({ name: "ctx-gateway" });
        updateProject(p.id, { default_provider_id: gateway(gw.url, "claude-sonnet-4-5").id });
        const t = createTask({ project_id: p.id, title: "t", agent: "claude", model: "claude-sonnet-4-5" });
        // Nothing probed yet: same "unknown" as any other override.
        expect(getTaskContext(t.id).context_window).toBe(0);

        await gatewayModelCatalog(gw.url, "");
        expect(getTaskContext(t.id).context_window).toBe(1_000_000);
        expect(listTasks(p.id).find((r) => r.id === t.id)!.context_window).toBe(1_000_000);

        // A model the catalog never reported still reports unknown, same as a
        // local override. The catalog answers per model; it does not mean
        // every gateway model on the same connection is sizable.
        updateTask(t.id, { model: "some-unlisted-model" });
        expect(getTaskContext(t.id).context_window).toBe(0);
      });
    } finally {
      await gw.close();
      clearGatewayModelCache();
      clearGatewayRates();
    }
  });
});
