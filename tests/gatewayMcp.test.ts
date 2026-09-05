import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseGatewayMcp,
  serializeGatewayMcp,
  resolveGatewayMcp,
  gatewayMcpCatalog,
  probeGatewayMcpMount,
  gatewayMcpServersFor,
  gatewayMcpServersForCodex,
  gatewayMcpServersForGemini,
  slugifyGatewayAliasForGemini,
} from "../lib/gatewayMcp";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// Hosted MCP servers from the LiteLLM gateway (docs/AGENTS.md,
// "Hosted MCP servers"): the selection JSON round-trip, the catalog and
// tool-preview probe, the mount health probe (400 on a wrong key, read from
// the body, not the status), and the mcpServers a turn mounts.

describe("parseGatewayMcp / serializeGatewayMcp", () => {
  it("parses a JSON array string, trimming and deduplicating aliases", () => {
    expect(parseGatewayMcp('["demo", " search ", "demo", ""]')).toEqual(["demo", "search"]);
  });

  it("accepts an array directly, the shape a settings form submits", () => {
    expect(parseGatewayMcp(["demo", 42, null, "search"])).toEqual(["demo", "search"]);
  });

  it("reads garbage as an empty selection rather than throwing", () => {
    expect(parseGatewayMcp("not json")).toEqual([]);
    expect(parseGatewayMcp(null)).toEqual([]);
    expect(parseGatewayMcp(undefined)).toEqual([]);
    expect(parseGatewayMcp({ not: "an array" })).toEqual([]);
  });

  it("serializes to a normalized JSON array, never the raw input", () => {
    expect(serializeGatewayMcp(["b", "a", "b"])).toBe(JSON.stringify(["b", "a"]));
    expect(serializeGatewayMcp("garbage")).toBe("[]");
  });
});

describe("resolveGatewayMcp", () => {
  const project = { gateway_mcp: JSON.stringify(["demo"]) };

  it("uses the project's selection when the task has no override", () => {
    expect(resolveGatewayMcp(project, null)).toEqual(["demo"]);
    expect(resolveGatewayMcp(project, { gateway_mcp: null })).toEqual(["demo"]);
    expect(resolveGatewayMcp(project, undefined)).toEqual(["demo"]);
  });

  it("replaces the project's selection outright when the task sets one, including an explicit empty override", () => {
    expect(resolveGatewayMcp(project, { gateway_mcp: JSON.stringify(["search"]) })).toEqual(["search"]);
    expect(resolveGatewayMcp(project, { gateway_mcp: "[]" })).toEqual([]);
  });
});

describe("gatewayMcpCatalog", () => {
  let gw: FakeGateway | null = null;
  afterEach(async () => {
    await gw?.close();
    gw = null;
  });

  it("merges the server list with a tool-name preview from /mcp-rest/tools/list", async () => {
    gw = await startFakeGateway({
      mcpServers: [
        { alias: "demo", description: "a demo server", tools: ["demo-lookup_ticket", "demo-close_ticket"] },
        { alias: "search", auth_type: "api_key" },
      ],
    });
    const catalog = await gatewayMcpCatalog(gw.url, "");
    expect(catalog.reachable).toBe(true);
    expect(catalog.servers.map((s) => s.alias).sort()).toEqual(["demo", "search"]);
    const demo = catalog.servers.find((s) => s.alias === "demo")!;
    expect(demo.description).toBe("a demo server");
    expect(demo.tools).toEqual(["demo-lookup_ticket", "demo-close_ticket"]);
    expect(demo.needs_browser_signin).toBe(false);
  });

  it("marks oauth2 authorization_code servers as needing a browser sign-in, and mounts them anyway (no filtering here)", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "drive", auth_type: "oauth2_authorization_code" }] });
    const catalog = await gatewayMcpCatalog(gw.url, "");
    expect(catalog.servers[0].needs_browser_signin).toBe(true);
  });

  it("does not flag oauth2 client_credentials — headless per docs/design/litellm.md", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "svc", auth_type: "oauth2_client_credentials" }] });
    const catalog = await gatewayMcpCatalog(gw.url, "");
    expect(catalog.servers[0].needs_browser_signin).toBe(false);
  });

  it("reports unreachable rather than throwing when nothing is listening", async () => {
    const catalog = await gatewayMcpCatalog("http://127.0.0.1:1", "");
    expect(catalog.reachable).toBe(false);
    expect(catalog.servers).toEqual([]);
  });

  it("reports unreachable with no base URL", async () => {
    expect((await gatewayMcpCatalog("", "")).reachable).toBe(false);
  });
});

describe("probeGatewayMcpMount", () => {
  let gw: FakeGateway | null = null;
  afterEach(async () => {
    await gw?.close();
    gw = null;
  });

  it("succeeds against a real JSON-RPC tools/list on /<alias>/mcp", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const result = await probeGatewayMcpMount(gw.url, "demo", "");
    expect(result).toEqual({ ok: true, error: null });
  });

  it("reads the body, not the status, when a wrong key answers 400 (measured shape)", async () => {
    gw = await startFakeGateway({ requireKey: "sk-right", mcpServers: [{ alias: "demo" }] });
    const wrong = await probeGatewayMcpMount(gw.url, "demo", "sk-wrong");
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/invalid proxy server token/i);
    const right = await probeGatewayMcpMount(gw.url, "demo", "sk-right");
    expect(right).toEqual({ ok: true, error: null });
  });

  it("fails for an alias the gateway doesn't host", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const result = await probeGatewayMcpMount(gw.url, "nope", "");
    expect(result.ok).toBe(false);
  });
});

describe("gatewayMcpServersFor", () => {
  it("mounts one http entry per resolved alias, keyed by alias, with the litellm header and never Authorization", () => {
    const out = gatewayMcpServersFor({ gateway_mcp: JSON.stringify(["demo", "search"]) }, { gateway_mcp: null, gateway_key: "" }, "http://gw.example");
    expect(Object.keys(out).sort()).toEqual(["demo", "search"]);
    // No key configured anywhere, so no headers at all, not an empty Bearer.
    expect(out.demo).toEqual({ type: "http", url: "http://gw.example/demo/mcp" });
  });

  it("prefers the task's own minted key over the instance key", () => {
    vi.stubEnv("CALANDRIA_LITELLM_KEY", "sk-instance");
    try {
      const out = gatewayMcpServersFor({ gateway_mcp: JSON.stringify(["demo"]) }, { gateway_mcp: null, gateway_key: "sk-task" }, "http://gw.example");
      expect(out.demo.headers).toEqual({ "x-litellm-api-key": "Bearer sk-task" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the instance key when the task has none", () => {
    vi.stubEnv("CALANDRIA_LITELLM_KEY", "sk-instance");
    try {
      const out = gatewayMcpServersFor({ gateway_mcp: JSON.stringify(["demo"]) }, { gateway_mcp: null, gateway_key: "" }, "http://gw.example");
      expect(out.demo.headers).toEqual({ "x-litellm-api-key": "Bearer sk-instance" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mounts nothing without a configured gateway, even with a selection", () => {
    expect(gatewayMcpServersFor({ gateway_mcp: JSON.stringify(["demo"]) }, null, null)).toEqual({});
  });

  it("mounts nothing with an empty selection", () => {
    expect(gatewayMcpServersFor({ gateway_mcp: "[]" }, null, "http://gw.example")).toEqual({});
  });

  it("never mounts an alias literally named 'calandria', reserved for the in-process server", () => {
    const out = gatewayMcpServersFor({ gateway_mcp: JSON.stringify(["calandria", "demo"]) }, null, "http://gw.example");
    expect(Object.keys(out)).toEqual(["demo"]);
  });

  it("respects a task override that replaces the project's selection, including mounting nothing", () => {
    const project = { gateway_mcp: JSON.stringify(["demo"]) };
    expect(Object.keys(gatewayMcpServersFor(project, { gateway_mcp: JSON.stringify(["search"]) }, "http://gw.example"))).toEqual(["search"]);
    expect(gatewayMcpServersFor(project, { gateway_mcp: "[]" }, "http://gw.example")).toEqual({});
  });
});

// The fake gateway's own JSON-RPC surface on /<alias>/mcp: initialize,
// notifications/initialized, tools/list, tools/call, the shapes named in
// docs/AGENTS.md's appendix. Exercised directly, not only through
// probeGatewayMcpMount, so a bug in the double itself is not hidden behind
// every other test that only calls tools/list.
describe("fake gateway JSON-RPC mount", () => {
  let gw: FakeGateway | null = null;
  afterEach(async () => {
    await gw?.close();
    gw = null;
  });

  const rpc = async (url: string, alias: string, body: unknown) => {
    const res = await fetch(`${url}/${alias}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  it("initialize answers protocolVersion/capabilities/serverInfo", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const { status, body } = await rpc(gw.url, "demo", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.serverInfo.name).toBe("demo");
  });

  it("notifications/initialized answers 202 with no result to wait on", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const res = await fetch(`${gw.url}/demo/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  it("tools/list names the <alias>-<tool> prefix LiteLLM returns", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo", tools: ["demo-lookup_ticket"] }] });
    const { body } = await rpc(gw.url, "demo", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["demo-lookup_ticket"]);
  });

  it("tools/call runs a listed tool and reports a per-server outcome", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo", tools: ["demo-lookup_ticket"] }] });
    const { body } = await rpc(gw.url, "demo", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo-lookup_ticket", arguments: {} } });
    expect(body.result.content[0].text).toContain("demo-lookup_ticket");
    expect(body._meta["litellm.ai/server_outcomes"]).toEqual({ demo: "ok" });
  });

  it("tools/call on an unknown tool answers a JSON-RPC error, not a 500", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo", tools: ["demo-lookup_ticket"] }] });
    const { status, body } = await rpc(gw.url, "demo", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
    expect(status).toBe(200);
    expect(body.error).toBeTruthy();
  });

  it("tools/list works with no mcp-session-id header at all (measured)", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const res = await fetch(`${gw.url}/demo/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" }, // no mcp-session-id
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  });
});

describe("gatewayMcpServersFor — CALANDRIA_LITELLM_MCP gate", () => {
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.CALANDRIA_LITELLM_MCP;
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CALANDRIA_LITELLM_MCP;
    else process.env.CALANDRIA_LITELLM_MCP = savedFlag;
  });

  it("mounts nothing when the instance switch is off, even with a selection and a gateway", async () => {
    process.env.CALANDRIA_LITELLM_MCP = "off";
    vi.resetModules();
    const mod = (await import("../lib/gatewayMcp")) as typeof import("../lib/gatewayMcp");
    const out = mod.gatewayMcpServersFor({ gateway_mcp: JSON.stringify(["demo"]) }, null, "http://gw.example");
    expect(out).toEqual({});
  });
});

// Codex mounting (docs/AGENTS.md, "Mounting, per driver"): the same URL/key
// resolution as Claude's gatewayMcpServersFor, but codex's own shape (`url` +
// `http_headers`, never `Authorization`) and every entry carrying
// default_tools_approval_mode: "approve". codex exec has no approver, so a
// mounted server's tools must be pre-approved or every call comes back
// cancelled. The permission-mode gate on whether this function is even
// called lives in lib/agents/codex/driver.ts (gatewayMcpForPermission),
// pinned in tests/codexMcpBridge.test.ts.
describe("gatewayMcpServersForCodex", () => {
  it("mounts one entry per resolved alias, with url + http_headers and always default_tools_approval_mode approve", () => {
    const out = gatewayMcpServersForCodex({ gateway_mcp: JSON.stringify(["demo", "search"]) }, { gateway_mcp: null, gateway_key: "" }, "http://gw.example");
    expect(Object.keys(out).sort()).toEqual(["demo", "search"]);
    expect(out.demo).toEqual({ url: "http://gw.example/demo/mcp", default_tools_approval_mode: "approve" });
  });

  it("carries the litellm api key header, never Authorization", () => {
    const out = gatewayMcpServersForCodex({ gateway_mcp: JSON.stringify(["demo"]) }, { gateway_mcp: null, gateway_key: "sk-task" }, "http://gw.example");
    expect(out.demo.http_headers).toEqual({ "x-litellm-api-key": "Bearer sk-task" });
    expect(out.demo).not.toHaveProperty("Authorization");
  });

  it("mounts nothing without a configured gateway or with an empty selection", () => {
    expect(gatewayMcpServersForCodex({ gateway_mcp: JSON.stringify(["demo"]) }, null, null)).toEqual({});
    expect(gatewayMcpServersForCodex({ gateway_mcp: "[]" }, null, "http://gw.example")).toEqual({});
  });

  it("never mounts an alias literally named 'calandria'", () => {
    const out = gatewayMcpServersForCodex({ gateway_mcp: JSON.stringify(["calandria", "demo"]) }, null, "http://gw.example");
    expect(Object.keys(out)).toEqual(["demo"]);
  });
});

// Antigravity mounting: httpUrl + headers (the shape lib/agents/gemini/mcp.ts's
// GeminiMcpConfig union accepts), keyed by the alias slugified to hyphens.
// Gemini CLI's policy engine splits a tool name on the first underscore after
// `mcp_`, so an alias with one breaks a wildcard rule for it.
describe("gatewayMcpServersForGemini", () => {
  it("mounts httpUrl + headers, keyed by the slugified alias", () => {
    const out = gatewayMcpServersForGemini({ gateway_mcp: JSON.stringify(["demo"]) }, { gateway_mcp: null, gateway_key: "sk-task" }, "http://gw.example");
    expect(out).toEqual({ demo: { httpUrl: "http://gw.example/demo/mcp", headers: { "x-litellm-api-key": "Bearer sk-task" } } });
  });

  it("slugifies an alias with underscores to hyphens, without touching the URL's real alias", () => {
    const out = gatewayMcpServersForGemini({ gateway_mcp: JSON.stringify(["ticket_system"]) }, null, "http://gw.example");
    expect(Object.keys(out)).toEqual(["ticket-system"]);
    expect(out["ticket-system"].httpUrl).toBe("http://gw.example/ticket_system/mcp");
  });

  it("mounts nothing without a configured gateway or with an empty selection", () => {
    expect(gatewayMcpServersForGemini({ gateway_mcp: JSON.stringify(["demo"]) }, null, null)).toEqual({});
    expect(gatewayMcpServersForGemini({ gateway_mcp: "[]" }, null, "http://gw.example")).toEqual({});
  });

  it("never mounts an alias literally named 'calandria'", () => {
    const out = gatewayMcpServersForGemini({ gateway_mcp: JSON.stringify(["calandria", "demo"]) }, null, "http://gw.example");
    expect(Object.keys(out)).toEqual(["demo"]);
  });
});

describe("slugifyGatewayAliasForGemini", () => {
  it("replaces every underscore with a hyphen", () => {
    expect(slugifyGatewayAliasForGemini("ticket_system_v2")).toBe("ticket-system-v2");
  });

  it("leaves an alias with no underscores untouched", () => {
    expect(slugifyGatewayAliasForGemini("demo-server")).toBe("demo-server");
  });
});
