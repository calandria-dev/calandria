// Pins the external MCP endpoint (app/api/mcp, lib/externalMcp.ts): off without
// CALANDRIA_MCP_TOKEN, bearer-gated in both auth modes ahead of the browser-origin
// rules, and serving the task tools with no calling task behind them. Tool calls
// run over the real SDK client against the real route handler and assert on the DB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { middleware } from "@/middleware";
import { POST, GET, DELETE } from "@/app/api/mcp/route";
import { createProject, getTask, listAgentEdits, listTasks, updateTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { EXTERNAL_ACTOR, EXTERNAL_MCP_TOOLS } from "@/lib/externalMcp";
import { uid } from "./helpers";

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const TOKEN = "external-mcp-secret";
const URL_ = "http://127.0.0.1:3000/api/mcp";
const ENV_KEYS = ["CALANDRIA_MCP_TOKEN", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "SERVICE_TOKEN"] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CALANDRIA_MCP_TOKEN = TOKEN;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Routes the client's requests straight into the route handlers, by method. */
const routeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init);
  const handler = req.method === "GET" ? GET : req.method === "DELETE" ? DELETE : POST;
  return handler(req);
};

async function connect(token = TOKEN) {
  const client = new Client({ name: "external-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: routeFetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function rawPost(headers: Record<string, string>) {
  return POST(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
  );
}

describe("external MCP: auth", () => {
  it("is off (404) without CALANDRIA_MCP_TOKEN, in the route and in middleware", async () => {
    delete process.env.CALANDRIA_MCP_TOKEN;
    expect((await rawPost({ authorization: "Bearer anything" })).status).toBe(404);
    expect((await middleware(new NextRequest(URL_, { method: "POST" }))).status).toBe(404);
  });

  it("refuses a missing or wrong bearer token with 401", async () => {
    expect((await rawPost({})).status).toBe(401);
    expect((await rawPost({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await rawPost({ authorization: TOKEN })).status).toBe(401);
    expect((await rawPost({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("middleware admits the bearer token from a foreign Host in local mode, which the origin rules would refuse", async () => {
    const foreign = (auth?: string) =>
      new NextRequest("http://agents.example.net/api/mcp", { method: "POST", headers: auth ? { authorization: auth } : {} });
    expect((await middleware(foreign(`Bearer ${TOKEN}`))).status).toBe(200);
    expect((await middleware(foreign())).status).toBe(401);
    // The same foreign Host on any other route is still the local-origin 403.
    expect((await middleware(new NextRequest("http://agents.example.net/api/projects"))).status).toBe(403);
  });

  it("middleware gates it on the bearer token in Access mode, never on SERVICE_TOKEN or a JWT", async () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "test-aud";
    process.env.SERVICE_TOKEN = "instance-secret";
    const req = (headers: Record<string, string>) => new NextRequest(URL_, { method: "POST", headers });
    expect((await middleware(req({ authorization: `Bearer ${TOKEN}` }))).status).toBe(200);
    expect((await middleware(req({ authorization: "Bearer instance-secret" }))).status).toBe(401);
    expect((await middleware(req({ "x-service-token": "instance-secret" }))).status).toBe(401);
  });
});

describe("external MCP: tools", () => {
  it("lists exactly the external tool set, and no session-bound tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXTERNAL_MCP_TOOLS].sort());
    for (const bound of ["ask_user", "expose_service", "create_pr", "set_base_branch", "report_issue"]) {
      expect(tools.some((t) => t.name === bound)).toBe(false);
    }
    await client.close();
  });

  it("files a suggestion into a named project and refuses an unknown one", async () => {
    const project = createProject({ name: `Ext-Suggest-${uid()}` });
    const client = await connect();

    const ok = await call(client, "suggest_task", { project: project.name, title: "From outside", description: "Brief." });
    expect(ok.isError).toBeFalsy();
    const filed = listTasks(project.id).find((t) => t.title === "From outside");
    expect(filed?.suggested).toBe(1);

    const listed = await call(client, "list_tasks", { project: project.id });
    expect(JSON.parse(listed.content[0].text).tasks.map((t: { title: string }) => t.title)).toContain("From outside");

    const bad = await call(client, "suggest_task", { project: "no-such-project", title: "Lost", description: "" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/No project matches "no-such-project"/);
    await client.close();
  });

  it("records an edit to an accepted task as the external actor, with blocked_by ordering", async () => {
    const project = createProject({ name: `Ext-Update-${uid()}` });
    const first = createSuggestedTask(project, { title: "First", description: "" }).task!;
    const second = createSuggestedTask(project, { title: "Second", description: "" }).task!;
    updateTask(second.id, { suggested: 0 });
    const client = await connect();

    const res = await call(client, "update_task", { task: second.id, title: "Second, renamed", blocked_by: [first.id] });
    expect(res.isError).toBeFalsy();
    expect(getTask(second.id)?.title).toBe("Second, renamed");
    const edits = listAgentEdits(second.id);
    expect(edits).toHaveLength(1);
    expect(edits[0].actor_title).toBe(EXTERNAL_ACTOR.title);
    expect(edits[0].actor_task_id).toBe(EXTERNAL_ACTOR.id);

    const detail = await call(client, "get_task", { task: second.id });
    expect(JSON.parse(detail.content[0].text).blocked_by.map((b: { id: string }) => b.id)).toEqual([first.id]);
    await client.close();
  });

  it("refuses update_task with a blank task ref instead of targeting a caller row", async () => {
    const client = await connect();
    const res = await call(client, "update_task", { task: " ", title: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/`task` is required/);
    await client.close();
  });

  it("moves and withdraws with no calling task", async () => {
    const here = createProject({ name: `Ext-Here-${uid()}` });
    const there = createProject({ name: `Ext-There-${uid()}` });
    const moving = createSuggestedTask(here, { title: "Moving", description: "" }).task!;
    const dropped = createSuggestedTask(here, { title: "Dropped", description: "" }).task!;
    const client = await connect();

    const moved = await call(client, "move_task", { tasks: [moving.id], project: there.name });
    expect(moved.isError).toBeFalsy();
    expect(getTask(moving.id)?.project_id).toBe(there.id);

    const withdrawn = await call(client, "withdraw_suggestion", { task: dropped.id, reason: "Superseded." });
    expect(withdrawn.isError).toBeFalsy();
    expect(getTask(dropped.id)?.status).toBe("cancelled");
    await client.close();
  });

  it("creates, lists and updates a runbook in a named project", async () => {
    const project = createProject({ name: `Ext-Runbook-${uid()}` });
    const client = await connect();

    const created = await call(client, "create_runbook", {
      project: project.id,
      name: "Nightly triage",
      description: "Sort the inbox.",
      prompt: "Triage open issues.",
    });
    expect(created.isError).toBeFalsy();
    const listed = JSON.parse((await call(client, "list_runbooks", { project: project.id })).content[0].text);
    const rb = listed.runbooks.find((r: { name: string }) => r.name === "Nightly triage");
    expect(rb).toBeTruthy();

    const updated = await call(client, "update_runbook", { runbook: rb.id, name: "Nightly triage v2" });
    expect(updated.isError).toBeFalsy();
    await client.close();
  });
});
