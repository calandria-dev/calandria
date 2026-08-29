import { describe, it, expect, beforeEach, vi } from "vitest";

// The driver half of the auto-start seam (issue #40).
//
// update_task and withdraw_suggestion can move a task to a terminal status,
// which unblocks whatever was waiting on it — and the launch that follows lives
// in lib/autoStart.ts, a module this driver MUST NOT import: it reaches
// lib/runner.ts, which resolves this driver through lib/agents/registry.ts, and
// that cycle is what made Turbopack emit lib/autoStart.ts as a sync module in
// production, so `startTurn` was read off a pending Promise and every single
// auto-start died. tests/importGraph.test.ts pins that the edge is gone; this
// file pins that the BEHAVIOR it used to carry still happens, through the
// TurnHooks callback the launcher injects (lib/agents/types.ts).
//
// Same trick as tests/claudeSettingSources.test.ts: the SDK is mocked at its
// module boundary, so the REAL driver builds the REAL Calandria MCP server and
// we can call the tools it mounted exactly as the CLI would.
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { createSuggestedTask } from "@/lib/agentTools";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { UPDATE_TASK, WITHDRAW_SUGGESTION } from "@/lib/agentToolDefs.mjs";
import type { Project, Task } from "@/lib/types";
import type { TurnHooks } from "@/lib/agents/types";

type ToolStub = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(() => (async function* () {})());
});

/**
 * Run one (empty) turn for `task` with `hooks` injected, and hand back the
 * Calandria tools the driver mounted for it. The tools close over the task and
 * project the turn was started with, exactly as they do in production.
 */
async function toolsFor(task: Task, project: Project, hooks?: Partial<TurnHooks>): Promise<Map<string, ToolStub>> {
  // Partial + no-op defaults so each case names only the hook it is about.
  const full: TurnHooks | undefined = hooks && { onTaskCleared: () => {}, onPrOpened: () => {}, ...hooks };
  for await (const _ev of claudeDriver.runTurn(task, project, "hello", undefined, full)) void _ev;
  const options = (queryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> })?.options ?? {};
  const server = (options.mcpServers as { calandria?: { tools?: ToolStub[] } })?.calandria;
  return new Map((server?.tools ?? []).map((t) => [t.name, t]));
}

describe("the Claude driver reports a cleared blocker instead of sweeping it", () => {
  it("update_task fires onTaskCleared with the task it marked done", async () => {
    const project = createProject({ name: "HooksUpdate" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const onTaskCleared = vi.fn();

    const tools = await toolsFor(caller, project, { onTaskCleared });
    await tools.get(UPDATE_TASK.name)!.handler({ status: "done" });

    expect(getTask(caller.id)!.status).toBe("done");
    // The id of the row that WENT TERMINAL — which is what the sweep selects
    // dependents by, and need not be the caller (update_task can write any task).
    expect(onTaskCleared).toHaveBeenCalledWith(caller.id);
  });

  it("does not fire it for an edit that clears nothing", async () => {
    const project = createProject({ name: "HooksNoop" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const onTaskCleared = vi.fn();

    const tools = await toolsFor(caller, project, { onTaskCleared });
    await tools.get(UPDATE_TASK.name)!.handler({ title: "Renamed" });

    expect(getTask(caller.id)!.title).toBe("Renamed");
    expect(onTaskCleared).not.toHaveBeenCalled();
  });

  it("withdraw_suggestion fires it against the withdrawn task", async () => {
    const project = createProject({ name: "HooksWithdraw" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    updateTask(caller.id, { started: 1, running: 1 });
    const inert = createSuggestedTask(project, { title: "Proposed", description: "" }).task!;
    const onTaskCleared = vi.fn();

    const tools = await toolsFor(getTask(caller.id)!, project, { onTaskCleared });
    await tools.get(WITHDRAW_SUGGESTION.name)!.handler({ task: inert.id, reason: "redundant" });

    // Cancelled counts as cleared — a withdrawn blocker will never finish, so
    // anything waiting on it must stop waiting (lib/autoStart.ts's blocks()).
    expect(getTask(inert.id)!.status).toBe("cancelled");
    expect(onTaskCleared).toHaveBeenCalledWith(inert.id);
  });

  it("survives a turn launched with no hooks at all", async () => {
    // A driver run outside the runner has nobody to notify. The tool must still
    // do its work rather than throwing at the model.
    const project = createProject({ name: "HooksAbsent" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });

    const tools = await toolsFor(caller, project);
    const res = (await tools.get(UPDATE_TASK.name)!.handler({ status: "done" })) as { isError?: boolean };

    expect(res.isError).toBeUndefined();
    expect(getTask(caller.id)!.status).toBe("done");
  });
});
