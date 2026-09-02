import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "@/app/api/projects/[id]/models/route";
import { createProject, createTask, listTasks, getTaskContext, updateProject, updateTask } from "@/lib/store";
import { clearEndpointProbeCache } from "@/lib/modelEndpoint";
import { cloudOverrideEnv, providerPresetEnv, serializeAgentEnv } from "@/lib/agentEnv";

// GET /api/projects/[id]/models — the browser's only route to a local model
// server, since the endpoint is loopback on the SERVER and generally
// unreachable from the page. Plus the other half of pointing a project at one:
// a model the catalog can't size means the context gauge has no window, and
// says so rather than guessing.

const local = (baseUrl: string, model = "") => serializeAgentEnv(providerPresetEnv({ baseUrl, model, token: "ollama" }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(models: string[]) {
  const f = vi.fn((input: unknown) =>
    Promise.resolve(String(input).endsWith("/api/tags") ? json({ models: models.map((name) => ({ name })) }) : json({}, 404)),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

const call = (id: string, baseUrl?: string) =>
  GET(new Request(`http://test/api/projects/${id}/models${baseUrl ? `?base_url=${encodeURIComponent(baseUrl)}` : ""}`), {
    params: Promise.resolve({ id }),
  });

afterEach(() => {
  vi.unstubAllGlobals();
  clearEndpointProbeCache();
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
});
