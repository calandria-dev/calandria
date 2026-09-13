import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/models/route";
import { getDb } from "@/lib/db";
import { clearGatewayModelCache } from "@/lib/gatewayModels";
import { createProvider, getProvider, updateProvider } from "@/lib/providers/store";
import { createProject, createTask } from "@/lib/store";

import { startFakeGateway, type FakeGateway } from "./fakeGateway";

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
});

afterEach(() => {
  clearGatewayModelCache();
});

describe("GET /api/models", () => {
  it("merges bundled and gateway sources into one version", async () => {
    let gateway: FakeGateway | undefined;
    try {
      gateway = await startFakeGateway({
        models: [{ name: "anthropic/claude-sonnet-4-6", provider: "anthropic" }],
      });
      const bundled = createProvider({ type: "anthropic", label: "Claude Code" });
      const gatewayProvider = createProvider({
        type: "litellm",
        label: "Work gateway",
        config: { base_url: gateway.url },
      });

      const response = await GET(new Request("http://test/api/models?agent=claude"));
      expect(response.status).toBe(200);
      const body = await response.json();

      const sonnet = body.families.find((family: { id: string }) => family.id === "sonnet");
      expect(sonnet).toBeDefined();
      const version = sonnet.versions.find((entry: { id: string }) => entry.id === "sonnet-4.6");
      expect(version).toBeDefined();
      expect(version.sources).toEqual([
        {
          provider_id: bundled.id,
          model: "claude-sonnet-4-6",
          price: "plan",
          unavailable: false,
        },
        {
          provider_id: gatewayProvider.id,
          model: "anthropic/claude-sonnet-4-6",
          price: "metered",
          unavailable: false,
        },
      ]);

      const sourceKeys = version.sources.map(
        (source: { provider_id: string; model: string }) => `${source.provider_id}:${source.model}`,
      );
      expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
      expect(getProvider(gatewayProvider.id)?.model_policy.known).toContain("anthropic/claude-sonnet-4-6");
    } finally {
      await gateway?.close();
    }
  });

  it("serves a pinned model that left the catalog as unavailable", async () => {
    let gateway: FakeGateway | undefined;
    let projectId: string | undefined;
    let taskId: string | undefined;
    let providerId: string | undefined;
    try {
      gateway = await startFakeGateway({ models: [] });
      const provider = createProvider({
        type: "litellm",
        label: "Work gateway",
        config: { base_url: gateway.url },
      });
      providerId = provider.id;
      updateProvider(provider.id, {
        model_policy: {
          mode: "allow",
          ids: ["anthropic/claude-sonnet-4-6"],
          known: ["anthropic/claude-sonnet-4-6"],
          unavailable: [],
        },
      });
      const project = createProject({ name: `unavailable-model-${Date.now()}` });
      projectId = project.id;
      const task = createTask({ project_id: project.id, title: "pinned", model: "anthropic/claude-sonnet-4-6" });
      taskId = task.id;
      getDb().prepare("UPDATE tasks SET provider_id = ? WHERE id = ?").run(provider.id, task.id);

      const response = await GET(new Request("http://test/api/models?agent=claude"));
      expect(response.status).toBe(200);
      const body = await response.json();
      const sonnet = body.families.find((family: { id: string }) => family.id === "sonnet");
      const version = sonnet.versions.find((entry: { id: string }) => entry.id === "sonnet-4.6");
      expect(version.sources).toEqual([
        {
          provider_id: provider.id,
          model: "anthropic/claude-sonnet-4-6",
          price: "metered",
          unavailable: true,
        },
      ]);
      expect(getProvider(provider.id)?.model_policy.unavailable).toEqual(["anthropic/claude-sonnet-4-6"]);
    } finally {
      if (taskId) getDb().prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      if (projectId) getDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      if (providerId) getDb().prepare("DELETE FROM model_providers WHERE id = ?").run(providerId);
      await gateway?.close();
    }
  });
});
