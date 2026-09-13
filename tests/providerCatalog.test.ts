import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@/lib/providers/rows";
import { applyModelPolicy, clearVendorModelCache, placeCatalog, providerCatalog, type PlacedCatalogModel } from "@/lib/providers/catalog";
import { placeModel } from "@/lib/providers/families";
import { setProviderSecret, clearProviderSecret } from "@/lib/providerSecrets";
import { clearGatewayModelCache } from "@/lib/gatewayModels";
import { clearEndpointProbeCache } from "@/lib/modelEndpoint";
import { getDb } from "@/lib/db";
import { createProject, createTask } from "@/lib/store";
import { createProvider, pinnedModelsForProvider } from "@/lib/providers/store";

const provider = (type: ModelProvider["type"], config: ModelProvider["config"] = {}, id: string = type): ModelProvider => ({
  id,
  type,
  label: type,
  config,
  model_policy: { mode: type === "litellm" ? "allow" : "deny", ids: [], known: [], unavailable: [] },
  created_at: 0,
  updated_at: 0,
  last_test_at: null,
  last_test: null,
  bundled: type === "anthropic" ? "claude" : type === "openai" ? "codex" : type === "google" ? "gemini" : null,
  environments: type === "litellm" ? ["claude", "codex", "gemini"] : ["claude"],
});

const placed = (id: string, chat = true): PlacedCatalogModel => ({
  id,
  sub: "",
  ...placeModel(id, "custom"),
  chat,
});

afterEach(() => {
  vi.restoreAllMocks();
  clearGatewayModelCache();
  clearEndpointProbeCache();
  clearVendorModelCache();
});

describe("applyModelPolicy", () => {
  it("starts an allow policy with known, non-duplicate chat models", () => {
    const models = [placed("claude-sonnet-5"), placed("unknown"), placed("claude-sonnet-5-20260212"), placed("text-embedding-3", false)];
    const result = applyModelPolicy({ mode: "allow", ids: [], known: [], unavailable: [] }, models);
    expect(result.on.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    expect(result.off.map((m) => m.id)).toEqual(["unknown", "text-embedding-3"]);
    expect(result.duplicates.map((m) => m.id)).toEqual(["claude-sonnet-5-20260212"]);
    expect(result.nextPolicy.ids).toEqual(["claude-sonnet-5"]);
    expect(result.nextPolicy.known).toEqual(models.map((m) => m.id));
  });

  it("keeps newly discovered allow-list models off after the first read", () => {
    const result = applyModelPolicy(
      { mode: "allow", ids: ["claude-sonnet-5"], known: ["claude-sonnet-5"], unavailable: [] },
      [placed("claude-sonnet-5"), placed("claude-opus-5")],
    );
    expect(result.on.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    expect(result.off.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("uses deny ids as exclusions and enables every other listed model", () => {
    const result = applyModelPolicy(
      { mode: "deny", ids: ["claude-opus-5"], known: ["claude-opus-5", "claude-sonnet-5"], unavailable: [] },
      [placed("claude-opus-5"), placed("claude-sonnet-5")],
    );
    expect(result.on.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    expect(result.off.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("applies deny mode on its first read with empty known", () => {
    const result = applyModelPolicy({ mode: "deny", ids: [], known: [], unavailable: [] }, [placed("claude-opus-5")]);
    expect(result.on.map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(result.nextPolicy.known).toEqual(["claude-opus-5"]);
  });

  it("retains only pinned ids that left the catalog as unavailable", () => {
    const policy = { mode: "deny" as const, ids: ["gone-pinned", "gone-free"], known: ["gone-pinned", "gone-free"], unavailable: [] };
    const result = applyModelPolicy(policy, [placed("live")], ["gone-pinned"]);
    expect(result.unavailable.map((m) => m.id)).toEqual(["gone-pinned"]);
    expect(result.nextPolicy.unavailable).toEqual(["gone-pinned"]);
    expect(result.nextPolicy.ids).toEqual(["gone-pinned"]);
  });
});

describe("providerCatalog dispatch", () => {
  it("reads all bundled, endpoint, gateway and vendor-key sources", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("model/info")) {
        return new Response(JSON.stringify({ data: [{ model_name: "openai/gpt-5", model_info: { litellm_provider: "openai", mode: "chat", max_input_tokens: 272000 } }] }), { status: 200 });
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-3", displayName: "Gemini 3", inputTokenLimit: 1000, supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      setProviderSecret("openai_key", "key", "test-openai-key");
      setProviderSecret("gemini_key", "key", "test-gemini-key");
      expect((await providerCatalog(provider("anthropic"), "claude")).some((m) => m.id === "sonnet")).toBe(true);
      expect((await providerCatalog(provider("openai"), "codex")).some((m) => m.id === "gpt-5.6-sol")).toBe(true);
      expect((await providerCatalog(provider("google"), "gemini")).some((m) => m.id === "gemini-3.8-flash-high")).toBe(true);
      for (const type of ["ollama", "lmstudio", "custom"] as const) {
        const config = type === "custom"
          ? { base_url: "http://endpoint.test", api: "openai" as const }
          : { base_url: "http://endpoint.test" };
        expect((await providerCatalog(provider(type, config), "claude")).map((m) => m.id)).toEqual(["gpt-5"]);
      }
      expect((await providerCatalog(provider("litellm", { base_url: "http://gateway.test" }), "codex")).map((m) => m.id)).toEqual(["openai/gpt-5"]);
      expect((await providerCatalog(provider("openai_key"), "codex")).map((m) => m.id)).toEqual(["gpt-5"]);
      expect((await providerCatalog(provider("gemini_key"), "gemini")).map((m) => m.id)).toEqual(["gemini-3"]);
    } finally {
      clearProviderSecret("openai_key", "key");
      clearProviderSecret("gemini_key", "key");
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps gateway [1m] synthesis and non-chat modality metadata", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { model_name: "anthropic/claude-sonnet-5", model_info: { litellm_provider: "anthropic", mode: "chat", max_input_tokens: 1_000_000 } },
        { model_name: "openai/text-embedding-3", model_info: { litellm_provider: "openai", mode: "embedding", max_input_tokens: 8_192 } },
      ],
    }), { status: 200 })) as typeof fetch;
    try {
      const models = await providerCatalog(provider("litellm", { base_url: "http://wide-gateway.test" }, "wide-gateway"), "claude");
      expect(models.map((model) => model.id)).toEqual([
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-5[1m]",
        "openai/text-embedding-3",
      ]);
      expect(models.at(-1)?.chat).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("places catalog rows while preserving source labels and contexts", () => {
    const result = placeCatalog("ollama", [{ id: "qwen3-coder:30b", label: "Qwen", sub: "19 GB", ctx: 0 }]);
    expect(result[0]).toMatchObject({ family: "qwen", version: "qwen3-coder-30b", label: "Qwen3 Coder 30B", sub: "19 GB", ctx: 256_000 });
  });
});

describe("pinnedModelsForProvider", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM model_providers").run();
  });

  it("includes a model pinned directly on a task", () => {
    const provider = createProvider({ type: "litellm", config: { base_url: "http://gateway.test" } });
    const project = createProject({ name: `pinned-direct-${Date.now()}` });
    const task = createTask({ project_id: project.id, title: "direct", model: "claude-sonnet-4-6" });
    getDb().prepare("UPDATE tasks SET provider_id = ? WHERE id = ?").run(provider.id, task.id);

    expect(pinnedModelsForProvider(provider)).toContain("claude-sonnet-4-6");
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    getDb().prepare("DELETE FROM model_providers WHERE id = ?").run(provider.id);
  });

  it("includes a model inherited through the project's provider", () => {
    const provider = createProvider({ type: "litellm", config: { base_url: "http://gateway.test" } });
    const project = createProject({ name: `pinned-inherited-${Date.now()}` });
    getDb().prepare("UPDATE projects SET default_provider_id = ? WHERE id = ?").run(provider.id, project.id);
    const task = createTask({ project_id: project.id, title: "inherited", model: "claude-opus-4-6" });

    expect(pinnedModelsForProvider(provider)).toContain("claude-opus-4-6");
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    getDb().prepare("DELETE FROM model_providers WHERE id = ?").run(provider.id);
  });

  it("includes a provider config default_model", () => {
    const provider = createProvider({
      type: "litellm",
      config: { base_url: "http://gateway.test", default_model: "claude-sonnet-4-6" },
    });

    expect(pinnedModelsForProvider(provider)).toEqual(["claude-sonnet-4-6"]);
    getDb().prepare("DELETE FROM model_providers WHERE id = ?").run(provider.id);
  });

  it("pins a task model to the bundled fallback when both provider IDs are null", () => {
    const provider = createProvider({ type: "anthropic" });
    const project = createProject({ name: `pinned-bundled-fallback-${Date.now()}` });
    const task = createTask({ project_id: project.id, title: "bundled fallback", model: "claude-opus-4-6" });

    expect((getDb().prepare("SELECT default_provider_id FROM projects WHERE id = ?").get(project.id) as { default_provider_id: string | null }).default_provider_id).toBeNull();
    expect((getDb().prepare("SELECT provider_id FROM tasks WHERE id = ?").get(task.id) as { provider_id: string | null }).provider_id).toBeNull();
    expect(pinnedModelsForProvider(provider)).toContain("claude-opus-4-6");
    getDb().prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    getDb().prepare("DELETE FROM model_providers WHERE id = ?").run(provider.id);
  });
});
