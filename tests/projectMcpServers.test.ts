import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/projects/[id]/mcp-servers/route";
import { createProject, listPermissionRules } from "@/lib/store";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// GET/POST /api/projects/[id]/mcp-servers is the project-scoped route behind
// the settings picker (docs/AGENTS.md, "Hosted MCP servers"). GET merges
// <gateway>/v1/mcp/server and <gateway>/mcp-rest/tools/list with which
// aliases this project already trusts; POST mints a "trust this server"
// permission_rules row.

let gw: FakeGateway | null = null;
let savedBase: string | undefined;
let savedKey: string | undefined;

afterEach(async () => {
  await gw?.close();
  gw = null;
  if (savedBase === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
  else process.env.CALANDRIA_LITELLM_BASE_URL = savedBase;
  if (savedKey === undefined) delete process.env.CALANDRIA_LITELLM_KEY;
  else process.env.CALANDRIA_LITELLM_KEY = savedKey;
});

function pointAtGateway(url: string, key = "") {
  savedBase = process.env.CALANDRIA_LITELLM_BASE_URL;
  savedKey = process.env.CALANDRIA_LITELLM_KEY;
  process.env.CALANDRIA_LITELLM_BASE_URL = url;
  if (key) process.env.CALANDRIA_LITELLM_KEY = key;
  else delete process.env.CALANDRIA_LITELLM_KEY;
}

const getReq = (id: string, qs = "") => GET(new Request(`http://test/api/projects/${id}/mcp-servers${qs}`), { params: Promise.resolve({ id }) });
const postReq = (id: string, body: unknown) =>
  POST(new Request(`http://test/api/projects/${id}/mcp-servers`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("GET — catalog", () => {
  it("answers 'not enabled' with no gateway configured, rather than 404 or an error", async () => {
    delete process.env.CALANDRIA_LITELLM_BASE_URL;
    const project = createProject({ name: "no-gateway" });
    const res = await getReq(project.id);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.servers).toEqual([]);
  });

  it("404s for a project that doesn't exist", async () => {
    const res = await getReq("nope");
    expect(res.status).toBe(404);
  });

  it("lists the gateway's servers with a tool preview and a trusted flag", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo", description: "demo tools", tools: ["demo-lookup"] }, { alias: "search" }] });
    pointAtGateway(gw.url);
    const project = createProject({ name: "with-gateway" });

    const res = await getReq(project.id);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.reachable).toBe(true);
    const demo = body.servers.find((s: { alias: string }) => s.alias === "demo");
    expect(demo.description).toBe("demo tools");
    expect(demo.tools).toEqual(["demo-lookup"]);
    expect(demo.trusted).toBe(false);
  });

  it("marks a server this project has already trusted", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    pointAtGateway(gw.url);
    const project = createProject({ name: "trusted" });
    await postReq(project.id, { alias: "demo" });

    const res = await getReq(project.id);
    const body = await res.json();
    expect(body.servers.find((s: { alias: string }) => s.alias === "demo").trusted).toBe(true);
  });

  it("?probe=<alias> runs a live mount check instead of the catalog", async () => {
    gw = await startFakeGateway({ requireKey: "sk-right", mcpServers: [{ alias: "demo" }] });
    pointAtGateway(gw.url, "sk-wrong");
    const project = createProject({ name: "probed" });

    const res = await getReq(project.id, "?probe=demo");
    const body = await res.json();
    expect(body.alias).toBe("demo");
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid proxy server token/i);
  });
});

describe("POST — trust this server", () => {
  it("mints a mcp_server permission_rules row for the alias", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    pointAtGateway(gw.url);
    const project = createProject({ name: "mint" });

    const res = await postReq(project.id, { alias: "demo" });
    expect(res.status).toBe(200);
    const rules = listPermissionRules(project.id);
    expect(rules).toEqual([
      expect.objectContaining({ tool: "mcp__demo__*", match_kind: "mcp_server", value: "demo" }),
    ]);
  });

  it("is idempotent — trusting the same alias twice stores one row", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    pointAtGateway(gw.url);
    const project = createProject({ name: "idempotent" });

    await postReq(project.id, { alias: "demo" });
    await postReq(project.id, { alias: "demo" });
    expect(listPermissionRules(project.id)).toHaveLength(1);
  });

  it("refuses an empty alias", async () => {
    const project = createProject({ name: "refuse" });
    const res = await postReq(project.id, { alias: "" });
    expect(res.status).toBe(400);
  });

  it("404s for a project that doesn't exist", async () => {
    const res = await postReq("nope", { alias: "demo" });
    expect(res.status).toBe(404);
  });

  it("refuses when CALANDRIA_LITELLM_MCP is off, even with a gateway configured", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    pointAtGateway(gw.url);
    const project = createProject({ name: "flag-off" });
    const savedFlag = process.env.CALANDRIA_LITELLM_MCP;
    process.env.CALANDRIA_LITELLM_MCP = "off";
    vi.resetModules();
    try {
      const mod = (await import("@/app/api/projects/[id]/mcp-servers/route")) as typeof import("@/app/api/projects/[id]/mcp-servers/route");
      const res = await mod.POST(
        new Request(`http://test/api/projects/${project.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ alias: "demo" }) }),
        { params: Promise.resolve({ id: project.id }) }
      );
      expect(res.status).toBe(400);
      expect(listPermissionRules(project.id)).toEqual([]);
    } finally {
      if (savedFlag === undefined) delete process.env.CALANDRIA_LITELLM_MCP;
      else process.env.CALANDRIA_LITELLM_MCP = savedFlag;
      vi.resetModules();
    }
  });
});
