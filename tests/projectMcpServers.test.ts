import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/projects/[id]/mcp-servers/route";
import { getDb } from "@/lib/db";
import { createProject, listPermissionRules, updateProject } from "@/lib/store";
import { createProvider } from "@/lib/providers/store";
import { setProviderSecret } from "@/lib/providerSecrets";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// GET/POST /api/projects/[id]/mcp-servers is the project-scoped route behind
// the settings picker (docs/AGENTS.md, "Hosted MCP servers"). GET merges
// <gateway>/v1/mcp/server and <gateway>/mcp-rest/tools/list with which
// aliases this project already trusts; POST mints a "trust this server"
// permission_rules row.

let gw: FakeGateway | null = null;

function resetGatewayState() {
  delete process.env.CALANDRIA_LITELLM_BASE_URL;
  getDb().prepare("DELETE FROM model_providers WHERE type = 'litellm'").run();
}

beforeEach(resetGatewayState);

afterEach(async () => {
  await gw?.close();
  gw = null;
  resetGatewayState();
});

async function pointAtGateway(url: string, key = "", mcp = true) {
  const provider = createProvider({ type: "litellm", config: { base_url: url, mcp } });
  if (key) setProviderSecret(provider.id, "key", key);
  return provider;
}

const getReq = (id: string, qs = "") => GET(new Request(`http://test/api/projects/${id}/mcp-servers${qs}`), { params: Promise.resolve({ id }) });
const postReq = (id: string, body: unknown) =>
  POST(new Request(`http://test/api/projects/${id}/mcp-servers`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("GET: catalog", () => {
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
    const provider = await pointAtGateway(gw.url);
    const project = updateProject(createProject({ name: "with-gateway" }).id, { default_provider_id: provider.id })!;

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
    const provider = await pointAtGateway(gw.url);
    const project = updateProject(createProject({ name: "trusted" }).id, { default_provider_id: provider.id })!;
    await postReq(project.id, { alias: "demo" });

    const res = await getReq(project.id);
    const body = await res.json();
    expect(body.servers.find((s: { alias: string }) => s.alias === "demo").trusted).toBe(true);
  });

  it("?probe=<alias> runs a live mount check instead of the catalog", async () => {
    gw = await startFakeGateway({ requireKey: "sk-right", mcpServers: [{ alias: "demo" }] });
    const provider = await pointAtGateway(gw.url, "sk-wrong");
    const project = updateProject(createProject({ name: "probed" }).id, { default_provider_id: provider.id })!;

    const res = await getReq(project.id, "?probe=demo");
    const body = await res.json();
    expect(body.alias).toBe("demo");
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid proxy server token/i);
  });
});

describe("POST: trust this server", () => {
  it("mints a mcp_server permission_rules row for the alias", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const provider = await pointAtGateway(gw.url);
    const project = updateProject(createProject({ name: "mint" }).id, { default_provider_id: provider.id })!;

    const res = await postReq(project.id, { alias: "demo" });
    expect(res.status).toBe(200);
    const rules = listPermissionRules(project.id);
    expect(rules).toEqual([
      expect.objectContaining({ tool: "mcp__demo__*", match_kind: "mcp_server", value: "demo" }),
    ]);
  });

  it("is idempotent, so trusting the same alias twice stores one row", async () => {
    gw = await startFakeGateway({ mcpServers: [{ alias: "demo" }] });
    const provider = await pointAtGateway(gw.url);
    const project = updateProject(createProject({ name: "idempotent" }).id, { default_provider_id: provider.id })!;

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
    const provider = await pointAtGateway(gw.url, "", false);
    const project = updateProject(createProject({ name: "flag-off" }).id, { default_provider_id: provider.id })!;
    const res = await POST(
      new Request(`http://test/api/projects/${project.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ alias: "demo" }) }),
      { params: Promise.resolve({ id: project.id }) }
    );
    expect(res.status).toBe(400);
    expect(listPermissionRules(project.id)).toEqual([]);
  });
});
