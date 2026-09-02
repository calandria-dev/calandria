import { describe, it, expect, vi, afterEach } from "vitest";
import { clearEndpointProbeCache, endpointModels, listEndpointModels, summarizeEndpoint } from "@/lib/modelEndpoint";
import { endpointSummary } from "@/app/shell/modelEndpoint";

// Asking a local model server what it can run (lib/modelEndpoint.ts). The
// server is mocked at `fetch`, since the point of every case here is a shape or
// a failure rather than a real Ollama.
//
// Two shapes, tried in order: Ollama's /api/tags first (its names are the ids
// its Anthropic endpoint wants, tag included), then /v1/models for LM Studio
// and everything else OpenAI-compatible.

type Handler = (url: string) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function server(handler: Handler) {
  const fetchMock = vi.fn((input: unknown) => Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearEndpointProbeCache();
});

describe("listEndpointModels", () => {
  it("reads Ollama's /api/tags and never asks /v1/models", async () => {
    const f = server((url) => {
      expect(url).toBe("http://localhost:11434/api/tags");
      return json({ models: [{ name: "qwen3-coder:latest", model: "qwen3-coder:latest" }, { name: "llama3.2:3b" }] });
    });
    const r = await listEndpointModels("http://localhost:11434");
    expect(r).toEqual({
      base_url: "http://localhost:11434",
      reachable: true,
      api: "ollama",
      models: ["qwen3-coder:latest", "llama3.2:3b"],
      error: null,
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("falls through to /v1/models when the Ollama route isn't there (LM Studio)", async () => {
    server((url) =>
      url.endsWith("/api/tags")
        ? json({ error: "not found" }, 404)
        : json({ data: [{ id: "qwen/qwen3-coder-30b" }, { id: "text-embedding-nomic" }] }),
    );
    const r = await listEndpointModels("http://localhost:1234");
    expect(r.api).toBe("openai");
    expect(r.reachable).toBe(true);
    expect(r.models).toEqual(["qwen/qwen3-coder-30b", "text-embedding-nomic"]);
  });

  it("treats a 200 in neither shape as a miss and keeps looking", async () => {
    server((url) => (url.endsWith("/api/tags") ? json({ hello: "world" }) : json({ data: [{ id: "gpt-oss" }] })));
    const r = await listEndpointModels("http://localhost:11434");
    expect(r.api).toBe("openai");
    expect(r.models).toEqual(["gpt-oss"]);
  });

  it("keeps a RUNNING server with nothing pulled reachable, not unreachable", async () => {
    server(() => json({ models: [] }));
    const r = await listEndpointModels("http://localhost:11434");
    expect(r.reachable).toBe(true);
    expect(r.models).toEqual([]);
    expect(r.error).toBeNull();
  });

  it("dedupes and drops blanks, keeping the server's own order", async () => {
    server(() => json({ models: [{ name: "a" }, { name: "a" }, { name: "  " }, { name: "b" }, { model: "c" }] }));
    expect((await listEndpointModels("http://localhost:11434")).models).toEqual(["a", "b", "c"]);
  });

  it("reports a refused connection in words, not as a thrown error", async () => {
    server(() => {
      const e = new TypeError("fetch failed");
      (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      throw e;
    });
    const r = await listEndpointModels("http://localhost:11434");
    expect(r.reachable).toBe(false);
    expect(r.models).toEqual([]);
    expect(r.error).toContain("connection refused");
  });

  // An LM Studio-shaped 404 on /api/tags is the LEAST informative of the two
  // failures. If /v1/models also failed, that failure is what says what's wrong.
  it("prefers the transport failure over a bare HTTP status when both legs fail", async () => {
    server((url) => {
      if (url.endsWith("/api/tags")) return json({}, 404);
      const e = new TypeError("fetch failed");
      (e as { cause?: unknown }).cause = { code: "ENOTFOUND" };
      throw e;
    });
    expect((await listEndpointModels("http://nope.invalid")).error).toBe("host not found");
  });

  it("calls a timeout a timeout", async () => {
    server(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect((await listEndpointModels("http://localhost:11434")).error).toBe("timed out");
  });

  it("normalizes a trailing slash and a trailing /v1 before probing", async () => {
    const f = server(() => json({ models: [{ name: "a" }] }));
    const r = await listEndpointModels("http://localhost:11434/v1/");
    expect(r.base_url).toBe("http://localhost:11434");
    expect(f.mock.calls[0][0]).toBe("http://localhost:11434/api/tags");
  });

  it("refuses a blank or non-http base URL without touching the network", async () => {
    const f = server(() => json({}));
    expect(await listEndpointModels("")).toMatchObject({ reachable: false, error: "no base URL" });
    expect(await listEndpointModels("file:///etc/passwd")).toMatchObject({ reachable: false, error: "not an http(s) URL" });
    expect(await listEndpointModels("localhost:11434")).toMatchObject({ reachable: false });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("endpointModels caching", () => {
  // GET /api/agents probes on every page load, and four tabs must not open four
  // sockets.
  it("probes once per URL inside the cache window", async () => {
    const f = server(() => json({ models: [{ name: "a" }] }));
    await endpointModels("http://localhost:11434");
    await endpointModels("http://localhost:11434/v1"); // same endpoint, normalized to the same key
    expect(f).toHaveBeenCalledTimes(1);
    await endpointModels("http://localhost:1234");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("caches an unreachable endpoint too — a down server is the expensive one to keep asking", async () => {
    const f = server(() => {
      throw new TypeError("fetch failed");
    });
    await endpointModels("http://localhost:11434");
    await endpointModels("http://localhost:11434");
    expect(f).toHaveBeenCalledTimes(2); // one call per shape, on the first probe only
  });
});

describe("summarizeEndpoint", () => {
  it("drops the ids and keeps the count", () => {
    expect(summarizeEndpoint({ base_url: "http://x:1", reachable: true, api: "ollama", models: ["a", "b"], error: null }))
      .toEqual({ base_url: "http://x:1", reachable: true, api: "ollama", model_count: 2, error: null });
  });
});

// The one sentence Settings, the project dialog and the New-task dialog all
// show, so they can't describe the same endpoint differently.
describe("endpointSummary", () => {
  it("names the server, the address and the count", () => {
    expect(endpointSummary({ base_url: "http://localhost:11434", reachable: true, api: "ollama", model_count: 4, error: null }))
      .toBe("Ollama at localhost:11434: reachable, 4 models");
  });

  it("says model, singular, when there is one", () => {
    expect(endpointSummary({ base_url: "http://localhost:1234", reachable: true, api: "openai", models: ["a"], error: null }))
      .toBe("An OpenAI-compatible server at localhost:1234: reachable, 1 model");
  });

  it("gives the reason when it isn't reachable", () => {
    expect(endpointSummary({ base_url: "http://localhost:11434", reachable: false, api: null, models: [], error: "connection refused — is the server running?" }))
      .toBe("No server at localhost:11434: connection refused — is the server running?");
  });

  it("says nothing at all for a cloud project, and says it's checking while it waits", () => {
    expect(endpointSummary(null)).toBe("");
    expect(endpointSummary({ base_url: "", reachable: false, api: null, models: [], error: null })).toBe("");
    expect(endpointSummary(null, true)).toBe("Checking the endpoint…");
  });
});
