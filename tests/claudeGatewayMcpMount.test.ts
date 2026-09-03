import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Hosted LiteLLM gateway MCP servers on Claude tasks (docs/design/litellm.md,
// "Hosted MCP servers"): mcpServers[alias] mounted next to the in-process
// `calandria` server in query() options. Same trick as
// tests/claudeTurnHooks.test.ts — the SDK is mocked at its module boundary so
// the REAL driver builds the REAL options object.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { createProject, createTask, updateProject, updateTask } from "@/lib/store";
import type { Project, Task } from "@/lib/types";

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(() => (async function* () {})());
});

let savedBase: string | undefined;
let savedKey: string | undefined;
beforeEach(() => {
  savedBase = process.env.CALANDRIA_LITELLM_BASE_URL;
  savedKey = process.env.CALANDRIA_LITELLM_KEY;
});
afterEach(() => {
  if (savedBase === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
  else process.env.CALANDRIA_LITELLM_BASE_URL = savedBase;
  if (savedKey === undefined) delete process.env.CALANDRIA_LITELLM_KEY;
  else process.env.CALANDRIA_LITELLM_KEY = savedKey;
});

/** Run one (empty) turn and hand back the mcpServers option the driver built. */
async function mcpServersFor(task: Task, project: Project): Promise<Record<string, unknown>> {
  for await (const _ev of claudeDriver.runTurn(task, project, "hello")) void _ev;
  const options = (queryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> })?.options ?? {};
  return (options.mcpServers as Record<string, unknown>) ?? {};
}

describe("hosted gateway MCP servers mount on a Claude turn", () => {
  it("mounts a project's selected aliases as http servers, independent of the task's own model-provider kind", async () => {
    process.env.CALANDRIA_LITELLM_BASE_URL = "http://gw.example";
    process.env.CALANDRIA_LITELLM_KEY = "sk-instance";
    // No agent_env override at all — an ordinary cloud-login task — proving the
    // mount doesn't gate on describeProvider(...).kind === "gateway".
    let project = createProject({ name: "McpMountCloud" });
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo", "search"]) })!;
    const task = createTask({ project_id: project.id, title: "t" });

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp).sort()).toEqual(["calandria", "demo", "search"]);
    expect(mcp.demo).toEqual({
      type: "http",
      url: "http://gw.example/demo/mcp",
      headers: { "x-litellm-api-key": "Bearer sk-instance" },
    });
  });

  it("mounts nothing with no gateway configured, even with a selection saved", async () => {
    delete process.env.CALANDRIA_LITELLM_BASE_URL;
    let project = createProject({ name: "McpMountNoGateway" });
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo"]) })!;
    const task = createTask({ project_id: project.id, title: "t" });

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp)).toEqual(["calandria"]);
  });

  it("a task's own override replaces the project's selection", async () => {
    process.env.CALANDRIA_LITELLM_BASE_URL = "http://gw.example";
    let project = createProject({ name: "McpMountOverride" });
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo"]) })!;
    let task = createTask({ project_id: project.id, title: "t" });
    task = updateTask(task.id, { gateway_mcp: JSON.stringify(["search"]) })!;

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp).sort()).toEqual(["calandria", "search"]);
  });

  it("never lets a selected alias literally named 'calandria' shadow the in-process server", async () => {
    process.env.CALANDRIA_LITELLM_BASE_URL = "http://gw.example";
    let project = createProject({ name: "McpMountReserved" });
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["calandria"]) })!;
    const task = createTask({ project_id: project.id, title: "t" });

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp)).toEqual(["calandria"]);
    // Still the real in-process server (has tools), not the http passthrough
    // an unguarded spread would have produced.
    expect((mcp.calandria as { type?: string }).type).toBe("sdk");
  });
});
