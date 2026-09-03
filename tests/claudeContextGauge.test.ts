// The context-window gauge used to read the latest usage row's input side —
// "7.6M tokens" against a 200k window on a tool-heavy turn. A turn is one SDK
// query spanning MANY API requests (every tool round-trip re-reads the whole
// context), and the result message's usage SUMS every one of them: spend, not
// occupancy. Occupancy is what each assistant message's own usage
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
import type { Project, Task, StreamEvent, TaskStreamEvent, TurnUsage } from "@/lib/types";

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
const assistant = (text: string, usage: Record<string, number>, parent: string | null = null, id?: string) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  // `id` is the API RESPONSE's id, which every message split out of that one
  // response shares. Spend is deduped on it (the gauge is deduped on the value
  // instead), so a fixture modelling a second content block must repeat it.
  message: { id: id ?? `msg-${text}`, content: [{ type: "text", text }], usage },
});
const result = (usage: Record<string, number>, modelUsage?: Record<string, Record<string, number>>) =>
  ({ type: "result", subtype: "success", result: "ok", total_cost_usd: 0.4, usage, ...(modelUsage ? { modelUsage } : {}) });

// A tool-heavy turn with a subagent: the main session grows 50k → 120k while
// the subagent runs its own 400k window.
const MAIN_1 = { input_tokens: 1_000, cache_read_input_tokens: 49_000, cache_creation_input_tokens: 0, output_tokens: 20 };
const MAIN_2 = { input_tokens: 2_000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 8_000, output_tokens: 30 };
const SUB = { input_tokens: 400_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 };

// The result message's `usage` is the MAIN SESSION's requests and nothing else
// — MAIN_1 + MAIN_2 exactly, with the sidechain absent. That is not an
// assumption: it was measured against the live CLI on two scripted fan-outs,
// where result.usage equalled the sum over the `parent_tool_use_id == null`
// assistant messages to the token (18/36,808/4,957 both times).
const RESULT_USAGE = { input_tokens: 3_000, cache_read_input_tokens: 159_000, cache_creation_input_tokens: 8_000, output_tokens: 50 };

// `modelUsage` IS the whole turn — the same measurement showed its per-model
// costs summing to `total_cost_usd` exactly, sidechains included. So the
// difference between it and the figure above is precisely subagent spend, and
// that subtraction is what the driver reports. The sidechain here is deliberately
// bigger than its one visible assistant message (625,010 against SUB's 400,010):
// only a subagent's last message per tool call reaches the stream, so summing
// what's visible undercounts — measured at roughly half — which is why the
// driver subtracts rollups instead of adding up messages.
const MAIN_MODEL = { inputTokens: 3_000, outputTokens: 50, cacheReadInputTokens: 159_000, cacheCreationInputTokens: 8_000 };
const SUB_MODEL = { inputTokens: 400_000, outputTokens: 10, cacheReadInputTokens: 220_000, cacheCreationInputTokens: 5_000 };
const MODEL_USAGE = { "claude-sonnet-4-5": MAIN_MODEL, "claude-haiku-4-5": SUB_MODEL };
const MAIN_TOKENS = 170_050;  // 3,000 + 50 + 159,000 + 8,000
const SUB_TOKENS = 625_010;   // 400,000 + 10 + 220,000 + 5,000

function scriptTurn() {
  mockCli(async function* (nextInput) {
    await nextInput();
    yield init;
    yield assistant("first", MAIN_1);
    yield assistant("first-again", MAIN_1, null, "msg-first"); // same response, second content block: same usage, no new event
    yield assistant("sub", SUB, "toolu_agent_1"); // subagent sidechain — its own window
    yield assistant("second", MAIN_2);
    yield assistant("errored", { input_tokens: 0, output_tokens: 0 }); // synthesized error message: no usage
    yield result(RESULT_USAGE, MODEL_USAGE);
    await nextInput();
  });
}

const fakeProject = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const fakeTask = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

/** The turn's own totals: the report the result message produced, never one of
 *  the per-request PARTIAL reports the driver emits as the turn goes (those are
 *  provisional, and this one supersedes them — see tests/usageFlush.test.ts). */
const fullUsage = (events: StreamEvent[]): TurnUsage =>
  (events.find((e) => e.type === "usage" && !e.partial) as { usage: TurnUsage }).usage;

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

    // Spend accounting is untouched: the usage event still carries the result's
    // own token counts verbatim — that IS what the main session cost.
    expect(fullUsage(events)).toMatchObject({ input_tokens: 3_000, cache_read_tokens: 159_000, cache_creation_tokens: 8_000 });
  });

  it("also reports each main-session request's tokens as they happen, so a Stopped turn has a record", async () => {
    scriptTurn();
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(fakeTask, fakeProject, "go")) events.push(ev);

    const partials = events.filter((e) => e.type === "usage" && e.partial) as { usage: TurnUsage }[];
    // ONE per main-session API response, not one per message: the CLI splits a
    // response into a message per content block, all carrying that response's
    // usage, so the "first-again" copy must contribute nothing. Summing
    // per message would bill a two-block answer twice.
    expect(partials.map((p) => p.usage)).toEqual([
      { cost_usd: 0, input_tokens: 1_000, output_tokens: 20, cache_read_tokens: 49_000, cache_creation_tokens: 0 },
      { cost_usd: 0, input_tokens: 2_000, output_tokens: 30, cache_read_tokens: 110_000, cache_creation_tokens: 8_000 },
    ]);

    // The 400k sidechain is NOT among them: the result's usage covers the main
    // session alone, so a partial from a subagent would have nothing to be
    // superseded by and would double-count against modelUsage. The synthesized
    // error message, carrying no usage at all, is skipped as well.
    const summed = partials.reduce((n, p) => n + p.usage.input_tokens + p.usage.cache_read_tokens + p.usage.cache_creation_tokens, 0);
    expect(summed).toBeLessThan(SUB.input_tokens);

    // And no partial ever carries a price: the assistant message has none, and
    // the runner writes the flushed row unpriced rather than as a free turn.
    expect(partials.every((p) => p.usage.cost_usd === 0)).toBe(true);
  });

  it("reports sidechain spend separately, as the gap between modelUsage and the result's own usage", async () => {
    scriptTurn();
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(fakeTask, fakeProject, "go")) events.push(ev);
    const usage = fullUsage(events);

    // The pin the whole feature rests on: the two halves add up to the rollup.
    // Main is what the result reported, subagent is what it left out, and
    // together they are every token modelUsage accounted for.
    const main = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
    expect(main).toBe(MAIN_TOKENS);
    expect(usage.subagent_tokens).toBe(SUB_TOKENS);
    expect(main + usage.subagent_tokens!).toBe(MAIN_TOKENS + SUB_TOKENS);
  });

  it("omits the field entirely on a turn that never fanned out", async () => {
    mockCli(async function* (nextInput) {
      await nextInput();
      yield init;
      yield assistant("only", MAIN_1);
      // No sidechain, so modelUsage holds the main session alone and nets to 0.
      yield result(RESULT_USAGE, { "claude-sonnet-4-5": MAIN_MODEL });
      await nextInput();
    });
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(fakeTask, fakeProject, "go")) events.push(ev);
    const usage = fullUsage(events);
    // Undefined, not 0: the column stores NULL so a turn with no fan-out is
    // never confused with a driver that doesn't report the split at all.
    expect(usage.subagent_tokens).toBeUndefined();
  });

  it("reports nothing when the CLI sends no modelUsage rollup at all", async () => {
    mockCli(async function* (nextInput) {
      await nextInput();
      yield init;
      yield assistant("only", MAIN_1);
      yield result(RESULT_USAGE);
      await nextInput();
    });
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(fakeTask, fakeProject, "go")) events.push(ev);
    const usage = fullUsage(events);
    expect(usage.subagent_tokens).toBeUndefined();
    // The main-session figures are unaffected by the rollup being absent.
    expect(usage).toMatchObject({ input_tokens: 3_000, cache_read_tokens: 159_000 });
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
    expect(getTaskUsage(row.id).total_tokens).toBe(MAIN_TOKENS);
    expect(getTaskUsage(row.id).subagent_tokens).toBe(SUB_TOKENS);
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
