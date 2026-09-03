import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "@/app/api/projects/[id]/models/route";
import { createProject, createTask, listTasks, getTaskContext, updateProject, updateTask } from "@/lib/store";
import { clearEndpointProbeCache } from "@/lib/modelEndpoint";
import { cloudOverrideEnv, gatewayPresetEnv, providerPresetEnv, serializeAgentEnv } from "@/lib/agentEnv";
import { clearGatewayModelCache, gatewayModelCatalog } from "@/lib/gatewayModels";
import { clearGatewayRates } from "@/lib/gatewayPricing";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// GET /api/projects/[id]/models — the browser's only route to a local model
// server, since the endpoint is loopback on the SERVER and generally
// unreachable from the page. Plus the other half of pointing a project at one:
// a model the catalog can't size means the context gauge has no window, and
// says so rather than guessing.

const local = (baseUrl: string, model = "") => serializeAgentEnv(providerPresetEnv({ baseUrl, model, token: "ollama" }));
const gateway = (baseUrl: string, model = "") => serializeAgentEnv(gatewayPresetEnv({ baseUrl, billing: "key", model }));

// taskProvider()'s gateway classification (lib/agentEnv.ts isGatewayEndpoint)
// compares a project's ANTHROPIC_BASE_URL against the INSTANCE's own
// CALANDRIA_LITELLM_BASE_URL, read fresh on every call — so a route-level test
// has to point the instance at the fake gateway for the call to see it as
// "gateway" rather than "custom". Restored after, since this env is otherwise
// unset in a hermetic run (tests/setup.ts).
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(models: string[]) {
  const f = vi.fn((input: unknown) =>
    Promise.resolve(String(input).endsWith("/api/tags") ? json({ models: models.map((name) => ({ name })) }) : json({}, 404)),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

const call = (id: string, baseUrl?: string, agent?: string) => {
  const params = new URLSearchParams();
  if (baseUrl) params.set("base_url", baseUrl);
  if (agent) params.set("agent", agent);
  const qs = params.toString();
  return GET(new Request(`http://test/api/projects/${id}/models${qs ? `?${qs}` : ""}`), { params: Promise.resolve({ id }) });
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearEndpointProbeCache();
  clearGatewayModelCache();
  clearGatewayRates();
});

describe("GET /api/projects/[id]/models", () => {
  it("lists what the project's saved endpoint reports", async () => {
    const p = createProject({ name: "models-saved" });
    updateProject(p.id, { agent_env: local("http://localhost:11434", "qwen3-coder") });
    const f = server(["qwen3-coder:latest", "llama3.2:3b"]);

    const body = await (await call(p.id)).json();
    expect(body).toMatchObject({ base_url: "http://localhost:11434", reachable: true, api: "ollama", error: null });
    expect(body.models).toEqual(["qwen3-coder:latest", "llama3.2:3b"]);
    expect(String(f.mock.calls[0][0])).toBe("http://localhost:11434/api/tags");
  });

  // The settings dialog has to show suggestions for the URL being TYPED — there
  // is no saved override to read until the user has already committed to one.
  it("probes ?base_url= instead, for a URL that hasn't been saved yet", async () => {
    const p = createProject({ name: "models-typed" });
    const f = server(["gpt-oss:20b"]);

    const body = await (await call(p.id, "http://localhost:1234/v1/")).json();
    expect(body.models).toEqual(["gpt-oss:20b"]);
    // …normalized on the way in, so a pasted /v1 doesn't become /v1/api/tags.
    expect(body.base_url).toBe("http://localhost:1234");
    expect(String(f.mock.calls[0][0])).toBe("http://localhost:1234/api/tags");
  });

  it("answers a cloud project with an empty list rather than an error", async () => {
    const p = createProject({ name: "models-cloud" });
    const f = server(["never-asked"]);
    const body = await (await call(p.id)).json();
    expect(body).toEqual({ base_url: "", reachable: false, api: null, models: [], error: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports an unreachable endpoint as an answer, not a 500", async () => {
    const p = createProject({ name: "models-down" });
    updateProject(p.id, { agent_env: local("http://localhost:11434") });
    vi.stubGlobal("fetch", vi.fn(() => {
      const e = new TypeError("fetch failed");
      (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return Promise.reject(e);
    }));
    const r = await call(p.id);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ reachable: false, models: [] });
    expect(body.error).toContain("connection refused");
  });

  it("404s an unknown project", async () => {
    const r = await call("nope");
    expect(r.status).toBe(404);
  });
});

describe("GET /api/projects/[id]/models — gateway", () => {
  let gw: FakeGateway;
  afterEach(async () => {
    await gw?.close();
  });

  it("lists the gateway's catalog as model_options, filtered for the given agent", async () => {
    gw = await startFakeGateway({
      models: [
        { name: "claude-sonnet-4-5", provider: "anthropic" },
        { name: "gpt-5-codex", provider: "openai" },
        { name: "gemini-3-flash", provider: "gemini" },
      ],
    });
    const p = createProject({ name: "models-gateway" });
    updateProject(p.id, { agent_env: gateway(gw.url) });

    await withGatewayEnv(gw.url, async () => {
      const claude = await (await call(p.id, undefined, "claude")).json();
      expect(claude.api).toBe("gateway");
      expect(claude.reachable).toBe(true);
      expect(claude.models.sort()).toEqual(["claude-sonnet-4-5", "gemini-3-flash", "gpt-5-codex"].sort());
      expect(claude.model_options.find((m: { value: string }) => m.value === "gpt-5-codex").sub).toContain("translated");

      const codex = await (await call(p.id, undefined, "codex")).json();
      expect(codex.models).toEqual(["gpt-5-codex"]);

      const gemini = await (await call(p.id, undefined, "gemini")).json();
      expect(gemini.models).toEqual(["gemini-3-flash"]);
    });
  });

  it("defaults to the project's own agent when ?agent= is absent", async () => {
    gw = await startFakeGateway({ models: [{ name: "gemini-3-flash", provider: "gemini" }] });
    const p = createProject({ name: "models-gateway-default" });
    updateProject(p.id, { default_agent: "gemini", agent_env: gateway(gw.url) });

    await withGatewayEnv(gw.url, async () => {
      const body = await (await call(p.id)).json();
      expect(body.models).toEqual(["gemini-3-flash"]);
    });
  });

  it("reports an unreachable gateway as an answer, with model_options empty", async () => {
    const p = createProject({ name: "models-gateway-down" });
    updateProject(p.id, { agent_env: gateway("http://127.0.0.1:1") });

    await withGatewayEnv("http://127.0.0.1:1", async () => {
      const body = await (await call(p.id)).json();
      expect(body.reachable).toBe(false);
      expect(body.model_options).toEqual([]);
      expect(body.error).toBeTruthy();
    });
  });
});

describe("context window under a provider override", () => {
  it("is the catalog's for a cloud task and unknown for a local one", () => {
    const cloud = createProject({ name: "ctx-cloud" });
    const t = createTask({ project_id: cloud.id, title: "t", agent: "claude", model: "claude-opus-4-5" });
    expect(getTaskContext(t.id).context_window).toBeGreaterThan(0);
    expect(listTasks(cloud.id).find((r) => r.id === t.id)!.context_window).toBeGreaterThan(0);

    // The override rewrites ANTHROPIC_MODEL and the opus/sonnet/haiku aliases,
    // so this task is NOT running the Opus its row still names — sizing it from
    // the catalog would draw a 4% gauge on a 32K window about to overflow.
    updateProject(cloud.id, { agent_env: local("http://localhost:11434", "qwen3-coder") });
    expect(getTaskContext(t.id).context_window).toBe(0);
    expect(getTaskContext(t.id).context_pct).toBe(0);
    expect(listTasks(cloud.id).find((r) => r.id === t.id)!.context_window).toBe(0);
  });

  it("follows a TASK-level override, in both directions", () => {
    const p = createProject({ name: "ctx-task" });
    const t = createTask({ project_id: p.id, title: "t", agent: "claude", model: "claude-opus-4-5" });

    updateTask(t.id, { agent_env: local("http://localhost:11434", "qwen3-coder") });
    expect(getTaskContext(t.id).context_window).toBe(0);

    // …and a task sent back to the cloud inside a local project is sizable again.
    updateProject(p.id, { agent_env: local("http://localhost:11434", "qwen3-coder") });
    const back = createTask({ project_id: p.id, title: "u", agent: "claude", model: "claude-opus-4-5" });
    expect(getTaskContext(back.id).context_window).toBe(0);
    updateTask(back.id, { agent_env: serializeAgentEnv(cloudOverrideEnv()) });
    expect(getTaskContext(back.id).context_window).toBeGreaterThan(0);
  });

  it("is the gateway catalog's window for a gateway task, unlike a local/custom override", async () => {
    const gw = await startFakeGateway({ models: [{ name: "claude-sonnet-4-5", max_input_tokens: 1_000_000 }] });
    try {
      await withGatewayEnv(gw.url, async () => {
        const p = createProject({ name: "ctx-gateway" });
        updateProject(p.id, { agent_env: gateway(gw.url, "claude-sonnet-4-5") });
        const t = createTask({ project_id: p.id, title: "t", agent: "claude", model: "claude-sonnet-4-5" });
        // Nothing probed yet: same "unknown" as any other override.
        expect(getTaskContext(t.id).context_window).toBe(0);

        await gatewayModelCatalog(gw.url, "");
        expect(getTaskContext(t.id).context_window).toBe(1_000_000);
        expect(listTasks(p.id).find((r) => r.id === t.id)!.context_window).toBe(1_000_000);

        // A model the catalog never reported still reports unknown, same as a
        // local override — the catalog is an ANSWER, not a blanket "gateway
        // means sizable".
        updateTask(t.id, { model: "some-unlisted-model" });
        expect(getTaskContext(t.id).context_window).toBe(0);
      });
    } finally {
      await gw.close();
    }
  });
});
