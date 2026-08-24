// The context-window gauge used to read the latest usage row's input side —
// "7.6M tokens" against a 200k window on a tool-heavy turn. A turn is one SDK
// query spanning MANY API requests (every tool round-trip re-reads the whole
// context) plus any subagents, and the result message's usage SUMS them all:
// spend, not occupancy. Occupancy is what each assistant message's own usage
// says the window held when its request was sent, and the last main-session
// one is the current figure. Pinned end to end here — mocked SDK → real Claude
// driver → real runner → tasks.context_measured → getTaskContext/listTasks —
// plus the usage-derived fallback that rows without a measurement still get,
// labelled as the estimate it is.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { addUsage, createProject, createTask, getTask, getTaskContext, getTaskUsage, listTasks, updateTask } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import type { Project, Task, StreamEvent, TaskStreamEvent } from "@/lib/types";

type QueryArgs = { prompt: AsyncIterable<unknown> };
function mockCli(run: (nextInput: () => Promise<IteratorResult<unknown>>) => AsyncGenerator<unknown>): void {
  queryMock.mockImplementation((args: QueryArgs) => {
    const it = args.prompt[Symbol.asyncIterator]();
    return run(() => it.next());
  });
}

const init = { type: "system", subtype: "init", session_id: "sess-ctx" };
// One API response as the SDK forwards it. `usage` is THIS request's — its
// input side is how full the window was when it went out.
const assistant = (text: string, usage: Record<string, number>, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id: `msg-${text}`, content: [{ type: "text", text }], usage },
});
const result = (usage: Record<string, number>) => ({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0.4, usage });

// A tool-heavy turn with a subagent: the main session grows 50k → 120k, the
// subagent runs its own 400k window, and the result sums everything (570k).
const MAIN_1 = { input_tokens: 1_000, cache_read_input_tokens: 49_000, cache_creation_input_tokens: 0, output_tokens: 20 };
const MAIN_2 = { input_tokens: 2_000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 8_000, output_tokens: 30 };
const SUB = { input_tokens: 400_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 };
const SUM = { input_tokens: 403_000, cache_read_input_tokens: 159_000, cache_creation_input_tokens: 8_000, output_tokens: 60 };

function scriptTurn() {
  mockCli(async function* (nextInput) {
    await nextInput();
    yield init;
    yield assistant("first", MAIN_1);
    yield assistant("first-again", MAIN_1); // same response, second content block: same usage, no new event
    yield assistant("sub", SUB, "toolu_agent_1"); // subagent sidechain — its own window
    yield assistant("second", MAIN_2);
    yield assistant("errored", { input_tokens: 0, output_tokens: 0 }); // synthesized error message: no usage
    yield result(SUM);
    await nextInput();
  });
}

const fakeProject = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const fakeTask = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

beforeEach(() => { queryMock.mockReset(); });

describe("claude driver: context events", () => {
  it("reports the last main-session request's input side, never the turn's sum", async () => {
    scriptTurn();
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(fakeTask, fakeProject, "go")) events.push(ev);

    const ctx = events.filter((e) => e.type === "context").map((e) => (e as { tokens: number }).tokens);
    // 50k, then 120k. NOT 50k twice (same response), NOT 400k (subagent), NOT
    // 0 (the synthesized error), and NOT 570k (the result's sum).
    expect(ctx).toEqual([50_000, 120_000]);

    // Spend accounting is untouched: the usage event is still the result's
    // total — that IS what the turn cost.
    const usage = events.find((e) => e.type === "usage") as { usage: { input_tokens: number; cache_read_tokens: number; cache_creation_tokens: number } };
    expect(usage.usage).toMatchObject({ input_tokens: 403_000, cache_read_tokens: 159_000, cache_creation_tokens: 8_000 });
  });
});

describe("runner + store: measured occupancy", () => {
  it("persists context as it arrives and the gauge reads it over the usage heuristic", async () => {
    const project = createProject({ name: "Ctx" });
    const row = createTask({ project_id: project.id, title: "T", description: "" });
    scriptTurn();

    // The runner persists BEFORE publishing: read the row inside the callback
    // to pin that the gauge moves mid-turn, not at turn end.
    const midTurn: number[] = [];
    const done = new Promise<void>((resolve) => {
      subscribe(row.id, (ev: TaskStreamEvent) => {
        if (ev.type === "context") midTurn.push(getTask(row.id)!.context_measured ?? -1);
        if (ev.type === "turn_end") resolve();
      });
    });
    await startResumeTurn(getTask(row.id)!, project, "go");
    await done;

    expect(midTurn).toEqual([50_000, 120_000]);
    expect(getTask(row.id)!.context_measured).toBe(120_000);

    // The gauge: measured, and the sum is nowhere near it.
    const ctx = getTaskContext(row.id);
    expect(ctx).toMatchObject({ context_tokens: 120_000, context_estimated: false });
    expect(getTaskUsage(row.id).total_tokens).toBe(570_060);
    const listed = listTasks(project.id).find((t) => t.id === row.id)!;
    expect(listed).toMatchObject({ context_tokens: 120_000, context_estimated: false });
    expect(listed.context_pct).toBeGreaterThan(0);
  });
});

describe("store: the usage-derived fallback", () => {
  const turn = (input: number, read: number) => ({ cost_usd: 0, input_tokens: input, output_tokens: 10, cache_read_tokens: read, cache_creation_tokens: 0 });

  it("estimates from the current generation's latest usage row when nothing was measured", () => {
    const project = createProject({ name: "Fallback" });
    const row = createTask({ project_id: project.id, title: "T", description: "" });
    // Never run: exact zero, nothing to hedge.
    expect(getTaskContext(row.id)).toMatchObject({ context_tokens: 0, context_estimated: false });

    addUsage({ project_id: project.id, task_id: row.id, generation: 1, usage: turn(1_000, 30_000) });
    addUsage({ project_id: project.id, task_id: row.id, generation: 1, usage: turn(2_000, 70_000) });
    expect(getTaskContext(row.id)).toMatchObject({ context_tokens: 72_000, context_estimated: true });
    expect(listTasks(project.id).find((t) => t.id === row.id)).toMatchObject({ context_tokens: 72_000, context_estimated: true });

    // A measurement wins outright.
    updateTask(row.id, { context_measured: 40_000 });
    expect(getTaskContext(row.id)).toMatchObject({ context_tokens: 40_000, context_estimated: false });
    expect(listTasks(project.id).find((t) => t.id === row.id)).toMatchObject({ context_tokens: 40_000, context_estimated: false });
  });

  it("drops to zero after /clear: the measurement is reset and old generations don't count", () => {
    const project = createProject({ name: "Cleared" });
    const row = createTask({ project_id: project.id, title: "T", description: "" });
    addUsage({ project_id: project.id, task_id: row.id, generation: 1, usage: turn(1_000, 90_000) });
    updateTask(row.id, { context_measured: 80_000 });
    expect(getTaskContext(row.id).context_tokens).toBe(80_000);

    // What the /clear route writes.
    updateTask(row.id, { generation: 2, session_id: null, context_measured: null });
    expect(getTaskContext(row.id)).toMatchObject({ context_tokens: 0, context_estimated: false });

    // The fresh generation's first turn on a driver with no measurement
    // (Codex) is estimated from its own row, not the old window's.
    addUsage({ project_id: project.id, task_id: row.id, generation: 2, usage: turn(500, 4_000) });
    expect(getTaskContext(row.id)).toMatchObject({ context_tokens: 4_500, context_estimated: true });
  });
});
