import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "@/app/api/providers/[id]/models/route";
import { POST } from "@/app/api/providers/[id]/models/refresh/route";
import { getDb } from "@/lib/db";
import { clearEndpointProbeCache } from "@/lib/modelEndpoint";
import { clearGatewayModelCache } from "@/lib/gatewayModels";
import { createProvider, getProvider } from "@/lib/providers/store";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
  clearEndpointProbeCache();
  clearGatewayModelCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearEndpointProbeCache();
  clearGatewayModelCache();
});

describe("provider model policy routes", () => {
  it("GET returns flat chat, non-chat, and duplicate rows with flags", async () => {
    let gateway: FakeGateway | undefined;
    try {
      gateway = await startFakeGateway({
        models: [
          { name: "claude-sonnet-4-6", provider: "anthropic" },
          { name: "anthropic/claude-sonnet-4-6-20260212", provider: "anthropic" },
          { name: "openai/text-embedding-3-large", provider: "openai", mode: "embedding" },
        ],
      });
      const row = createProvider({ type: "litellm", config: { base_url: gateway.url } });
      const response = await GET(new Request(`http://test/api/providers/${row.id}/models?agent=claude`), params(row.id));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.mode).toBe("allow");
      expect(body.models).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "claude-sonnet-4-6", chat: true, on: true, duplicate_of: null }),
        expect.objectContaining({ id: "anthropic/claude-sonnet-4-6-20260212", chat: true, duplicate_of: "anthropic/claude-sonnet-4-6" }),
        expect.objectContaining({ id: "openai/text-embedding-3-large", chat: false }),
      ]));
      expect(getProvider(row.id)?.model_policy.known).toEqual(expect.arrayContaining([
        "claude-sonnet-4-6",
        "anthropic/claude-sonnet-4-6-20260212",
        "openai/text-embedding-3-large",
      ]));
    } finally {
      await gateway?.close();
    }
  });

  it("PUT treats ids as enabled chat ids in allow mode", async () => {
    let gateway: FakeGateway | undefined;
    try {
      gateway = await startFakeGateway({ models: ["claude-sonnet-4-6", "claude-opus-4-8"] });
      const row = createProvider({ type: "litellm", config: { base_url: gateway.url } });
      const response = await PUT(
        new Request(`http://test/api/providers/${row.id}/models?agent=claude`, { method: "PUT", body: JSON.stringify({ ids: ["claude-opus-4-8"] }) }),
        params(row.id),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.models.find((m: { id: string }) => m.id === "claude-opus-4-8").on).toBe(true);
      expect(body.models.find((m: { id: string }) => m.id === "claude-sonnet-4-6").on).toBe(false);
      expect(getProvider(row.id)?.model_policy.ids).toEqual(["claude-opus-4-8"]);
    } finally {
      await gateway?.close();
    }
  });

  it("PUT treats ids as enabled chat ids in deny mode", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
    });
    const row = createProvider({ type: "custom", config: { base_url: "http://models.test", api: "openai" } });
    const response = await PUT(
      new Request(`http://test/api/providers/${row.id}/models?agent=claude`, { method: "PUT", body: JSON.stringify({ ids: ["gpt-5"] }) }),
      params(row.id),
    );
    expect(response.status).toBe(200);
    expect(getProvider(row.id)?.model_policy.ids).toEqual([]);
    expect((await response.json()).models[0].on).toBe(true);
  });

  it("refresh invalidates a cached endpoint source", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      const id = calls === 1 ? "qwen3-coder:30b" : "qwen3-coder:32b";
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
    });
    const row = createProvider({ type: "custom", config: { base_url: "http://models.test", api: "openai" } });
    await GET(new Request(`http://test/api/providers/${row.id}/models?agent=claude`), params(row.id));
    const response = await POST(new Request(`http://test/api/providers/${row.id}/models/refresh?agent=claude`, { method: "POST" }), params(row.id));
    expect(response.status).toBe(200);
    expect((await response.json()).models.map((m: { id: string }) => m.id)).toContain("qwen3-coder:32b");
    expect(calls).toBe(4);
  });

  it.each(["GET", "PUT", "POST"])("returns 404 for missing provider (%s)", async (method) => {
    const request = new Request("http://test/api/providers/missing/models", { method, body: method === "PUT" ? JSON.stringify({ ids: [] }) : undefined });
    const response = method === "GET" ? await GET(request, params("missing")) : method === "PUT" ? await PUT(request, params("missing")) : await POST(request, params("missing"));
    expect(response.status).toBe(404);
  });

  it("rejects malformed PUT bodies", async () => {
    const row = createProvider({ type: "custom", config: { base_url: "http://models.test", api: "openai" } });
    const response = await PUT(new Request(`http://test/api/providers/${row.id}/models`, { method: "PUT", body: JSON.stringify({ ids: "gpt-5" }) }), params(row.id));
    expect(response.status).toBe(400);
  });
});
