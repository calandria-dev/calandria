import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Pins hosted LiteLLM gateway MCP servers on Claude tasks (docs/AGENTS.md):
// mcpServers[alias] mounted next to the in-process `calandria` server in
// query() options. Same approach as tests/claudeTurnHooks.test.ts: the SDK is
// mocked at its module boundary so the real driver builds the real options
// object.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { createProject, createTask, updateProject, updateTask } from "@/lib/store";
import { createProvider, deleteProvider } from "@/lib/providers/store";
import { setProviderSecret } from "@/lib/providerSecrets";
import type { Project, Task } from "@/lib/types";

const createdProviders: string[] = [];

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(() => (async function* () {})());
});
afterEach(() => {
  for (const id of createdProviders.splice(0)) deleteProvider(id);
});

beforeEach(() => {
  // Provider rows are created per test below. The process environment remains
  // empty so these cases exercise row resolution instead of seed settings.
  delete process.env.CALANDRIA_LITELLM_BASE_URL;
  delete process.env.CALANDRIA_LITELLM_KEY;
});

function gatewayProvider(url: string, key?: string, mcp = true) {
  const provider = createProvider({ type: "litellm", config: { base_url: url, mcp } });
  createdProviders.push(provider.id);
  if (key) setProviderSecret(provider.id, "key", key);
  return provider;
}

/** Run one (empty) turn and hand back the mcpServers option the driver built. */
async function mcpServersFor(task: Task, project: Project): Promise<Record<string, unknown>> {
  for await (const _ev of claudeDriver.runTurn(task, project, "hello")) void _ev;
  const options = (queryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> })?.options ?? {};
  return (options.mcpServers as Record<string, unknown>) ?? {};
}

describe("hosted gateway MCP servers mount on a Claude turn", () => {
  it("mounts a project's selected aliases as http servers, independent of the task's own model-provider kind", async () => {
    // No agent_env override at all, an ordinary cloud-login task, proving the
    // mount doesn't gate on describeProvider(...).kind === "gateway".
    let project = createProject({ name: "McpMountCloud" });
    const provider = gatewayProvider("http://gw.example", "sk-instance");
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo", "search"]), default_provider_id: provider.id })!;
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
    let project = createProject({ name: "McpMountNoGateway" });
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo"]) })!;
    const task = createTask({ project_id: project.id, title: "t" });

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp)).toEqual(["calandria"]);
  });

  it("a task's own override replaces the project's selection", async () => {
    let project = createProject({ name: "McpMountOverride" });
    const provider = gatewayProvider("http://gw.example");
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["demo"]), default_provider_id: provider.id })!;
    let task = createTask({ project_id: project.id, title: "t" });
    task = updateTask(task.id, { gateway_mcp: JSON.stringify(["search"]) })!;

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp).sort()).toEqual(["calandria", "search"]);
  });

  it("never lets a selected alias literally named 'calandria' shadow the in-process server", async () => {
    let project = createProject({ name: "McpMountReserved" });
    const provider = gatewayProvider("http://gw.example");
    project = updateProject(project.id, { gateway_mcp: JSON.stringify(["calandria"]), default_provider_id: provider.id })!;
    const task = createTask({ project_id: project.id, title: "t" });

    const mcp = await mcpServersFor(task, project);
    expect(Object.keys(mcp)).toEqual(["calandria"]);
    // Must stay the real in-process server, since an unguarded spread would
    // overwrite it with a plain http passthrough entry.
    expect((mcp.calandria as { type?: string }).type).toBe("sdk");
  });
});
