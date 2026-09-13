import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { deleteProviderSecrets, setProviderSecret } from "@/lib/providerSecrets";
import { createProvider, getProvider } from "@/lib/providers/store";
import { litellmProviderFor, litellmRuntimeFor, resolveProvider, resolveProviderEnv } from "@/lib/providers/resolve";

const project = (default_provider_id: string | null = null) => ({ default_provider_id });
const task = (provider_id: string | null = null) => ({ provider_id });

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
});

describe("provider runtime resolution", () => {
  it("resolves task, project, then bundled provider in order", () => {
    const bundled = createProvider({ type: "openai" });
    const projectProvider = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const taskProvider = createProvider({ type: "custom", config: { base_url: "http://model.example", api: "openai" } });

    expect(resolveProvider({ project: project(projectProvider.id), task: task(taskProvider.id), environment: "codex" })?.id).toBe(taskProvider.id);
    expect(resolveProvider({ project: project(projectProvider.id), task: task(null), environment: "codex" })?.id).toBe(projectProvider.id);
    expect(resolveProvider({ project: project(null), task: task(null), environment: "codex" })?.id).toBe(bundled.id);
  });

  it("builds local and gateway presets from row config", () => {
    const local = createProvider({
      type: "ollama",
      config: { base_url: "http://localhost:11434", default_model: "qwen3-coder:30b" },
    });
    const localEnv = resolveProviderEnv({ project: project(local.id), environment: "claude" });
    expect(localEnv.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_MODEL: "qwen3-coder:30b",
      OPENAI_BASE_URL: "http://localhost:11434/v1",
    });

    const gateway = createProvider({
      type: "litellm",
      config: { base_url: "http://gateway.example", billing: "subscription", default_model: "gpt-5" },
    });
    const gatewayEnv = resolveProviderEnv({ project: project(gateway.id), environment: "codex" });
    expect(gatewayEnv.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://gateway.example",
      CALANDRIA_GATEWAY_BILLING: "subscription",
      CODEX_MODEL: "gpt-5",
    });
  });

  it("keeps secrets out of rows and returns them only as turn extras", () => {
    const openai = createProvider({ type: "openai_key", config: { default_model: "gpt-5" } });
    setProviderSecret(openai.id, "key", "sk-openai");
    const result = resolveProviderEnv({ project: project(openai.id), environment: "codex" });
    expect(result.extras).toEqual({ OPENAI_API_KEY: "sk-openai" });
    expect(getProvider(openai.id)).not.toHaveProperty("key");
    expect(getProvider(openai.id)).not.toHaveProperty("api_key");
    deleteProviderSecrets(openai.id);

    const gemini = createProvider({ type: "gemini_key" });
    setProviderSecret(gemini.id, "key", "AIza-test");
    expect(resolveProviderEnv({ project: project(gemini.id), environment: "gemini" }).extras).toEqual({ GEMINI_API_KEY: "AIza-test" });
    deleteProviderSecrets(gemini.id);
  });

  it("selects the pointed gateway, otherwise the oldest gateway", () => {
    const oldest = createProvider({ type: "litellm", config: { base_url: "http://old-gateway" } });
    const newer = createProvider({ type: "litellm", config: { base_url: "http://new-gateway" } });
    expect(litellmProviderFor(project(null), task(null), "claude")?.id).toBe(oldest.id);
    expect(litellmProviderFor(project(newer.id), task(null), "claude")?.id).toBe(newer.id);
    expect(litellmRuntimeFor(project(newer.id), task(null), "claude")?.baseUrl).toBe("http://new-gateway");
  });
});
