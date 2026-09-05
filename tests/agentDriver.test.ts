import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Pins the driver contract: a scripted fake driver run through lib/runner.ts
// must produce the same persistence and publish behavior as any real driver.
// The fake replaces the Claude driver module, so the registry's
// getDriver("claude") resolution runs for real; only the SDK-driving module
// is swapped out.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown, hooks?: unknown) =>
      runTurnMock(task, project, userText, ac, hooks),
  },
}));

// The Codex CLI is mocked at the SDK boundary (@openai/codex-sdk). The real
// lib/agents/codex/driver.ts runs: startThread, prompt seeding, and
// lib/agents/codex/events.ts normalization. The spawned `codex` process is
// replaced by a fake thread that replays recorded JSONL ThreadEvents. This
// pins both drivers to the same StreamEvent-to-runner contract from opposite
// ends of the seam.
const { codexRun } = vi.hoisted(() => ({ codexRun: { events: [] as unknown[] } }));

vi.mock("@openai/codex-sdk", () => {
  class FakeThread {
    id: string | null;
    constructor(id?: string | null) {
      this.id = id ?? null;
    }
    async runStreamed() {
      const self = this;
      const events = codexRun.events;
      return {
        events: (async function* () {
          for (const ev of events) {
            const e = ev as { type?: string; thread_id?: string };
            // The real SDK populates thread.id from thread.started; mirror that
            // so the driver reads the right id back after the stream drains.
            if (e.type === "thread.started" && e.thread_id) self.id = e.thread_id;
            yield ev;
          }
        })(),
      };
    }
    async run() {
      return { finalResponse: "" };
    }
  }
  class Codex {
    startThread() {
      return new FakeThread();
    }
    resumeThread(id: string) {
      return new FakeThread(id);
    }
  }
  return { Codex };
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { createProject, createTask, getTask, getProject, updateTask, listMessages, getTaskUsage, getTaskContext, listProjectSessions, updateProject, addPendingMessage, deleteProject } from "@/lib/store";
import { getDriver, listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { DEFAULT_CODEX_MODEL } from "@/lib/agents/codex/pricing";
import { startResumeTurn } from "@/lib/runner";
import { subscribe, subscribeGlobal } from "@/lib/events";
import type { StreamEvent, TaskStreamEvent, ToolData } from "@/lib/types";
import { cloudOverrideEnv, gatewayPresetEnv, serializeAgentEnv } from "@/lib/agentEnv";
import { gatewayModelCatalog, clearGatewayModelCache } from "@/lib/gatewayModels";
import { clearGatewayRates } from "@/lib/gatewayPricing";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// Collect every event the runner publishes for a task until turn_end.
function collectEvents(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") {
      unsub();
      resolve();
    }
  });
  return { events, done };
}

function script(events: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

// Recorded codex JSONL (same fixtures the codex event-mapping unit test uses),
// replayed through the mocked SDK into the real codex driver.
function loadCodexFixture(name: string): unknown[] {
  const file = path.join(__dirname, "fixtures", "codex", name);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  runTurnMock.mockReset();
  codexRun.events = [];
});

describe("agent registry", () => {
  it("resolves by id, falls back to the default driver on unknown/empty ids", () => {
    expect(getDriver("claude").id).toBe("claude");
    expect(getDriver("no-such-agent").id).toBe(DEFAULT_AGENT);
    expect(getDriver(null).id).toBe(DEFAULT_AGENT);
    expect(getDriver(undefined).id).toBe(DEFAULT_AGENT);
    // Codex is a registered driver and resolves to itself, not the fallback.
    expect(getDriver("codex").id).toBe("codex");
    expect(listDrivers().map((d) => d.id)).toEqual(expect.arrayContaining(["claude", "codex"]));
  });

  it("stamps new tasks with the project's default agent", () => {
    const project = createProject({ name: "AgentCol" });
    expect(project.default_agent).toBe("claude");
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    expect(task.agent).toBe("claude");
    // A project-level default flows into tasks created after it changes.
    updateProject(project.id, { default_agent: "codex" });
    const t2 = createTask({ project_id: project.id, title: "T2", description: "" });
    expect(t2.agent).toBe("codex");
    expect(getDriver(t2.agent).id).toBe("codex");
    // …and an unknown persisted agent still resolves to a runnable driver.
    updateProject(project.id, { default_agent: "ghost-agent" });
    const t3 = createTask({ project_id: project.id, title: "T3", description: "" });
    expect(t3.agent).toBe("ghost-agent");
    expect(getDriver(t3.agent).id).toBe(DEFAULT_AGENT);
  });
});

describe("driver contract through the runner", () => {
  it("any launched turn consumes a queued start (tasks.start_at) and announces the edit", async () => {
    // tasks.start_at (lib/deferredStart.ts) is the usage-window-reset deadline
    // a turn is waiting for. A turn the user sends before the reset must
    // clear the deadline, or the sweep resumes the session again once the
    // reset passes with a continue it does not need.
    const project = createProject({ name: "Queued" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    updateTask(task.id, { start_at: Date.now() + 3_600_000 });
    script([{ type: "session", sessionId: "thread-q" }, { type: "done", sessionId: "thread-q" }]);
    const edits: string[] = [];
    const unsub = subscribeGlobal((tid, ev) => { if (tid === task.id && ev.type === "task_edited") edits.push(ev.type); });
    const { done } = collectEvents(task.id);
    try {
      await startResumeTurn(getTask(task.id)!, project, "go early");
      await done;
    } finally {
      unsub();
    }
    expect(getTask(task.id)!.start_at).toBe(0);
    expect(edits).toEqual(["task_edited"]);
  });

  it("persists and publishes a full scripted turn exactly like the Claude driver", async () => {
    const project = createProject({ name: "Contract" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([
      { type: "session", sessionId: "thread-abc" },
      { type: "model", model: "fake-model-1" },
      { type: "assistant", content: "Working on it." },
      { type: "tool", id: "t1", title: "❯ ls", detail: "ls" },
      { type: "tool_result", id: "t1", content: "file.txt", isError: false },
      { type: "ask", id: "a1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
      { type: "ask_answered", id: "a1", answers: [["A"]] },
      { type: "notice", content: "Service live" },
      { type: "context", tokens: 95 },
      { type: "usage", usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40 } },
      { type: "suggested", title: "Follow-up idea", projectId: project.id },
      { type: "done", sessionId: "thread-abc" },
    ]);

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The driver received the task/project/prompt unmodified.
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock.mock.calls[0][0].id).toBe(task.id);
    expect(runTurnMock.mock.calls[0][2]).toBe("go");

    // Task row settled: session opened → started/in_progress, the opaque
    // session id persisted verbatim, model badge recorded, turn over →
    // running off + awaiting the user.
    const after = getTask(task.id)!;
    expect(after).toMatchObject({
      started: 1,
      status: "in_progress",
      running: 0,
      awaiting_input: 1,
      session_id: "thread-abc",
      resolved_model: "fake-model-1",
    });

    // Session row recorded (and closed) with the driver's opaque id.
    const sessions = listProjectSessions(project.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].claude_session_id).toBe("thread-abc");
    expect(sessions[0].ended_at).not.toBeNull();

    // Usage persisted from the usage event.
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0.5, total_tokens: 100, turns: 1 });
    // Occupancy persisted from the context event: measured, so it beats the
    // usage-derived estimate (which would have read 80 here).
    expect(after.context_measured).toBe(95);
    expect(getTaskContext(task.id)).toMatchObject({ context_tokens: 95, context_estimated: false });

    // Transcript: user echo, assistant text, the tool call merged with its
    // result, the answered ask, and the notice, all persisted rows.
    const msgs = listMessages(task.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "system"]);
    expect(msgs[0].content).toBe("go");
    expect(msgs[1].content).toBe("Working on it.");
    const tool = JSON.parse(msgs[2].content) as ToolData;
    expect(tool).toMatchObject({ title: "❯ ls", detail: "ls", result: "file.txt", isError: false });
    const ask = JSON.parse(msgs[3].content) as ToolData;
    expect(ask.ask).toMatchObject({ id: "a1", answers: [["A"]] });
    expect(msgs[4].content).toBe("Service live");

    // Publish contract: every persisted event carries its DB message id so
    // reconnecting clients upsert instead of duplicating, and the stream ends
    // with done + turn_end.
    const byType = (t: string) => events.filter((e) => e.type === t);
    for (const t of ["user", "assistant", "tool", "tool_result", "ask", "ask_answered", "notice"]) {
      expect(byType(t)).toHaveLength(1);
      expect((byType(t)[0] as { msgId?: string }).msgId).toBeTruthy();
    }
    // tool_result / ask_answered update the row their tool / ask created.
    expect((byType("tool_result")[0] as { msgId?: string }).msgId).toBe((byType("tool")[0] as { msgId?: string }).msgId);
    expect((byType("ask_answered")[0] as { msgId?: string }).msgId).toBe((byType("ask")[0] as { msgId?: string }).msgId);
    expect(byType("session")).toHaveLength(1);
    expect(byType("suggested")).toHaveLength(1);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
  });

  it("persists a driver error event as a durable system line and still settles the task", async () => {
    const project = createProject({ name: "ContractErr" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([
      { type: "session", sessionId: "s-err" },
      { type: "error", content: "driver exploded" },
      { type: "done", sessionId: "s-err" },
    ]);

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The error is in the transcript (not just streamed) with the ⚠ prefix.
    const errMsg = listMessages(task.id).find((m) => m.role === "system");
    expect(errMsg?.content).toBe("⚠ driver exploded");
    expect(events.some((e) => e.type === "error")).toBe(true);
    // The task is settled and resumable, not stuck running.
    expect(getTask(task.id)).toMatchObject({ running: 0, awaiting_input: 1, session_id: "s-err" });
  });

  it("keeps a task retryable when the driver never opens a session", async () => {
    const project = createProject({ name: "ContractNoOpen" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([{ type: "error", content: "could not start" }, { type: "done", sessionId: null }]);

    const { done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // No session event → started stays 0 (retryable) and nothing is awaiting input.
    expect(getTask(task.id)).toMatchObject({ started: 0, running: 0, awaiting_input: 0, session_id: null });
    expect(listProjectSessions(project.id)).toHaveLength(0);
  });

  it("feeds the wildcard channel with the task row already persisted (the /api/events invariant)", async () => {
    const project = createProject({ name: "ContractGlobal" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    script([
      { type: "session", sessionId: "s-global" },
      { type: "ask", id: "a1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
      { type: "ask_answered", id: "a1", answers: [["A"]] },
      { type: "done", sessionId: "s-global" },
    ]);

    // The global /api/events route builds each payload by re-reading the task
    // row when an event lands on the wildcard channel, so the runner must
    // persist before it publishes. Snapshot the row inside the listener, at
    // the moment the route would read it.
    const seen: { taskId: string; type: string; running: number; awaiting: number }[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const unsub = subscribeGlobal((taskId, ev) => {
      const t = getTask(taskId)!;
      seen.push({ taskId, type: ev.type, running: t.running, awaiting: t.awaiting_input });
      if (ev.type === "turn_end") { unsub(); resolve(); }
    });
    await startResumeTurn(task, project, "go");
    await done;

    expect(seen.every((s) => s.taskId === task.id)).toBe(true);
    const at = (type: string) => seen.find((s) => s.type === type)!;
    // Turn launch: running is already flagged when the user echo publishes.
    expect(at("user")).toMatchObject({ running: 1 });
    // Parked on a question: awaiting_input is up while still running…
    expect(at("ask")).toMatchObject({ running: 1, awaiting: 1 });
    // …and cleared the moment the last ask is answered.
    expect(at("ask_answered")).toMatchObject({ running: 1, awaiting: 0 });
    // Turn over: the row settled (running off, awaiting the user) before turn_end.
    expect(at("turn_end")).toMatchObject({ running: 0, awaiting: 1 });
  });
});

describe("the launcher's TurnHooks reach the driver", () => {
  // The driver's tool callbacks can fire the auto-start sweep only because the
  // launcher hands it down (lib/agents/types.ts's TurnHooks); the driver must
  // not import lib/autoStart.ts directly. A dropped `hooks` argument runs the
  // turn normally and never starts anything waiting on what the agent marked
  // done.
  it("passes them to the first turn AND to a drained follow-up", async () => {
    const project = createProject({ name: "Hooks" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    // Parked before the turn starts, so run()'s finally drains it as turn two,
    // the re-entry that has no caller left to re-supply the hooks.
    addPendingMessage(task.id, task.generation, "follow-up");

    const seen: unknown[] = [];
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, _ac: unknown, hooks: unknown) {
      seen.push(hooks);
      yield { type: "session", sessionId: `s-${seen.length}` } as StreamEvent;
      yield { type: "done", sessionId: `s-${seen.length}` } as StreamEvent;
    });

    const hooks = { onTaskCleared: vi.fn(), onPrOpened: vi.fn() };
    // Resolves on the second turn's turn_end (the first hands off to the drain).
    const { done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go", undefined, hooks);
    await done;

    expect(seen).toEqual([hooks, hooks]);
  });
});

describe("queue drain re-reads the project (no stale snapshot)", () => {
  it("runs a dequeued follow-up against the project as it stands at drain time, not turn start", async () => {
    const project = createProject({ name: "DrainFresh", context: "old context", branch: "main" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    // Park a follow-up so the runner drains it as the very next turn.
    addPendingMessage(task.id, task.generation, "follow-up");

    const projectsSeen: { context: string; branch: string }[] = [];
    runTurnMock.mockImplementation(async function* (_task: unknown, proj: { context: string; branch: string }) {
      projectsSeen.push({ context: proj.context, branch: proj.branch });
      // The project's base branch and context change mid-turn, before the
      // first turn finishes.
      if (projectsSeen.length === 1) {
        updateProject(project.id, { branch: "release", context: "new context" });
      }
      yield { type: "session", sessionId: `s-${projectsSeen.length}` } as StreamEvent;
      yield { type: "done", sessionId: `s-${projectsSeen.length}` } as StreamEvent;
    });

    // collectEvents resolves on the first turn_end it sees. The first turn hands
    // off to the drained follow-up (running stays on, no turn_end), so this
    // resolves only once the second turn ends.
    const { done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    expect(projectsSeen).toHaveLength(2);
    // The original turn ran against the snapshot passed in; the dequeued
    // follow-up ran against a fresh read reflecting the mid-turn mutation.
    expect(projectsSeen[0]).toEqual({ context: "old context", branch: "main" });
    expect(projectsSeen[1]).toEqual({ context: "new context", branch: "release" });
  });

  it("settles the task without crashing when the project is deleted mid-turn", async () => {
    const project = createProject({ name: "DrainDeleted" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    addPendingMessage(task.id, task.generation, "follow-up");

    let calls = 0;
    runTurnMock.mockImplementation(async function* () {
      calls++;
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      // The project (and, by FK cascade, this task + its queue) is deleted while
      // the turn is live. The drain must not crash trying to resume.
      deleteProject(project.id);
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The runner still closed the turn out (turn_end fired) and did not launch a
    // second turn against a vanished project.
    expect(calls).toBe(1);
    expect(events.map((e) => e.type).slice(-1)).toEqual(["turn_end"]);
    expect(getTask(task.id)).toBeUndefined();
  });
});

describe("codex driver contract through the runner", () => {
  it("normalizes a real codex turn (mocked CLI) into the same runner behavior as any driver", async () => {
    const project = createProject({ name: "CodexContract" });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    // The task runs the real codex driver, not the fallback.
    expect(task.agent).toBe("codex");
    expect(getDriver(task.agent).id).toBe("codex");

    codexRun.events = loadCodexFixture("command-file-message.jsonl");

    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await done;

    // The opaque codex thread id is persisted verbatim into session_id (the same
    // column a Claude session id lands in) and the task settles like any turn.
    const after = getTask(task.id)!;
    expect(after).toMatchObject({
      started: 1,
      status: "in_progress",
      running: 0,
      awaiting_input: 1,
      session_id: "019f3ecf-fed2-7ba3-b46e-dc6097412033",
    });

    // Session row recorded + closed with the driver's opaque id.
    const sessions = listProjectSessions(project.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].claude_session_id).toBe("019f3ecf-fed2-7ba3-b46e-dc6097412033");
    expect(sessions[0].ended_at).not.toBeNull();

    // Token usage persisted from turn.completed, with cost_usd estimated from
    // the fixture's token counts at the default model's published API prices
    // (8764 fresh×$5.00 + 30848 cached×$0.50 + 119×$30, per 1M). This
    // populates the task cost chip and Insights for Codex tasks.
    const taskUsage = getTaskUsage(task.id)!;
    expect(taskUsage).toMatchObject({ turns: 1 });
    // The fixture's 39612 input_tokens include its 30848 cached reads; the
    // buckets are disjoint here, so the prompt is counted once (8764 + 30848).
    expect(taskUsage.total_tokens).toBe(8764 + 30848 + 119);
    expect(taskUsage.cost_usd).toBeCloseTo(0.062814, 6);

    // The driver reports the model it resolved (task.model null → the CLI
    // default), persisted for the badge and the Insights provider panel.
    expect(after.resolved_model).toBe(DEFAULT_CODEX_MODEL);

    // Transcript: user echo, the two agent messages, and the command tool call
    // merged with its result, all persisted rows, agent-agnostic.
    const msgs = listMessages(task.id);
    expect(msgs[0].content).toBe("go");
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("echo hi"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "DONE")).toBe(true);
    const toolRow = msgs.find((m) => m.role === "tool");
    expect(toolRow).toBeTruthy();
    expect((JSON.parse(toolRow!.content) as ToolData).result).toContain("hi");

    // Publish contract closes with done + turn_end, same as the Claude path.
    expect(events.map((e) => e.type).slice(-2)).toEqual(["done", "turn_end"]);
    expect(events.some((e) => e.type === "session")).toBe(true);
    // The usage event is published live, so the cost chip updates the moment
    // the turn ends instead of on the next page load.
    const live = events.find((e) => e.type === "usage") as { usage?: { cost_usd: number } } | undefined;
    expect(live?.usage?.cost_usd).toBeCloseTo(0.062814, 6);
  });

  it("bills a resumed codex turn for its own tokens, not the whole thread's running total", async () => {
    const project = createProject({ name: "CodexCumulative" });
    updateProject(project.id, { default_agent: "codex" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });

    // Turn 1: the recorded fixture (39612 input / 30848 cached / 119 output).
    codexRun.events = loadCodexFixture("command-file-message.jsonl");
    const first = collectEvents(task.id);
    await startResumeTurn(task, project, "go");
    await first.done;
    const afterFirst = getTaskUsage(task.id)!;

    // Turn 2 resumes the same thread, so codex re-reports the thread's totals
    // (turn 1's numbers plus this turn's 1000 fresh / 200 cached / 50 output).
    // Only that growth may be added to the task's spend.
    codexRun.events = [
      { type: "thread.started", thread_id: "019f3ecf-fed2-7ba3-b46e-dc6097412033" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_9", type: "agent_message", text: "Done." } },
      {
        type: "turn.completed",
        usage: { input_tokens: 40_812, cached_input_tokens: 31_048, output_tokens: 169, reasoning_output_tokens: 0 },
      },
    ];
    const second = collectEvents(getTask(task.id)!.id);
    await startResumeTurn(getTask(task.id)!, project, "again");
    await second.done;

    const afterSecond = getTaskUsage(task.id)!;
    expect(afterSecond.turns).toBe(2);
    // 1000 fresh + 200 cached + 50 output, not another 39612/30848/119.
    expect(afterSecond.total_tokens - afterFirst.total_tokens).toBe(1_250);
    const secondUsage = second.events.find((e) => e.type === "usage") as { usage?: { input_tokens: number; cache_read_tokens: number; output_tokens: number } } | undefined;
    expect(secondUsage?.usage).toMatchObject({ input_tokens: 1_000, cache_read_tokens: 200, output_tokens: 50 });
  });
});

// A turn against a provider override (lib/agentEnv.ts) is not the vendor's
// spend, whatever the driver reports as cost. That covers two different
// facts the ledger keeps apart. A local model server bills nothing, so 0 is
// a measurement. A custom base URL may be OpenRouter or a Bedrock proxy, so
// its price is unknown and the row is NULL instead of a fake zero. Both are
// tagged with the endpoint's host, both keep their tokens (an unpriced turn
// still filled a context window), and the published usage event agrees with
// the row so the live chip and Insights stay consistent.
describe("provider override usage accounting", () => {
  it("records a measured zero and tags the row with the endpoint for a local-model project", async () => {
    const project = createProject({ name: "Local" });
    updateProject(project.id, { agent_env: JSON.stringify({ ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_MODEL: "qwen3-coder" }) });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([
      { type: "session", sessionId: "local-1" },
      { type: "usage", usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40 } },
      { type: "done", sessionId: "local-1" },
    ]);
    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, getProject(project.id)!, "go");
    await done;
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0, total_tokens: 100, turns: 1 });
    const usageEv = events.find((e) => e.type === "usage") as Extract<TaskStreamEvent, { type: "usage" }>;
    expect(usageEv.usage.cost_usd).toBe(0);
    expect(usageEv.usage.input_tokens).toBe(10);
    const { getDb } = await import("@/lib/db");
    const row = getDb().prepare("SELECT provider, cost_usd FROM task_usage WHERE task_id = ?").get(task.id) as { provider: string; cost_usd: number | null };
    // 0, not NULL: a model served on this machine is actually free.
    expect(row).toEqual({ provider: "localhost:11434", cost_usd: 0 });
    expect(getTaskUsage(task.id).unpriced_turns).toBe(0);
  });

  // A "Custom base URL" preset pointing at a paid third party must not be
  // billed at $0 like a local model: that would under-report real money in
  // Insights, the running total and the live chip with no on-screen signal
  // that the number is a placeholder.
  it("records a custom endpoint's cost as unknown rather than zero", async () => {
    const project = createProject({ name: "Custom" });
    updateProject(project.id, { agent_env: JSON.stringify({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_MODEL: "some/model" }) });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([
      { type: "session", sessionId: "custom-1" },
      { type: "usage", usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 40 } },
      { type: "done", sessionId: "custom-1" },
    ]);
    const { events, done } = collectEvents(task.id);
    await startResumeTurn(task, getProject(project.id)!, "go");
    await done;
    const { getDb } = await import("@/lib/db");
    const row = getDb().prepare("SELECT provider, cost_usd FROM task_usage WHERE task_id = ?").get(task.id) as { provider: string; cost_usd: number | null };
    // NULL, not 0 and not the driver's 0.5: the driver priced a model id it was
    // merely told, against a catalog this endpoint doesn't bill from.
    expect(row).toEqual({ provider: "openrouter.ai", cost_usd: null });
    // The total leaves it out and reports how many turns it left out, so the
    // dollar figure the UI renders is a marked floor instead of a lie.
    const totals = getTaskUsage(task.id);
    expect(totals).toMatchObject({ cost_usd: 0, total_tokens: 100, turns: 1, unpriced_turns: 1 });
    // Tokens survive intact; the wire carries 0 (the client adds it to the
    // running total) plus the flag that stops that 0 reading as "free".
    const usageEv = events.find((e) => e.type === "usage") as Extract<TaskStreamEvent, { type: "usage" }>;
    expect(usageEv.usage.cost_usd).toBe(0);
    expect(usageEv.usage.input_tokens).toBe(10);
    expect(usageEv.unpriced).toBe(true);
  });

  it("bills a task-level cloud override at the driver's figure inside a local project", async () => {
    const project = createProject({ name: "Local-2" });
    updateProject(project.id, { agent_env: JSON.stringify({ ANTHROPIC_BASE_URL: "http://localhost:11434" }) });
    const task = createTask({ project_id: project.id, title: "T", description: "", agent_env: cloudOverrideEnv() as Record<string, string> });
    script([
      { type: "session", sessionId: "cloud-1" },
      { type: "usage", usage: { cost_usd: 0.25, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      { type: "done", sessionId: "cloud-1" },
    ]);
    const { done } = collectEvents(task.id);
    await startResumeTurn(getTask(task.id)!, getProject(project.id)!, "go");
    await done;
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0.25, turns: 1, unpriced_turns: 0 });
    const { getDb } = await import("@/lib/db");
    expect((getDb().prepare("SELECT provider FROM task_usage WHERE task_id = ?").get(task.id) as { provider: string }).provider).toBe("");
  });
});

// The gateway is the one override kind that gets a real computed figure
// instead of a measured zero or an unpriced NULL (docs/AGENTS.md, "Model
// catalog, context windows and prices"): lib/gatewayPricing.ts prices the
// turn's own token counts against the resolved model's rate from the last
// catalog probe.
describe("gateway provider usage accounting", () => {
  let gw: FakeGateway;

  async function withGatewayEnv<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.CALANDRIA_LITELLM_BASE_URL;
    process.env.CALANDRIA_LITELLM_BASE_URL = url;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
      else process.env.CALANDRIA_LITELLM_BASE_URL = prev;
    }
  }

  afterEach(async () => {
    await gw?.close();
    clearGatewayModelCache();
    clearGatewayRates();
  });

  it("bills a gateway turn at the catalog's own rate, not the driver's figure", async () => {
    gw = await startFakeGateway({ models: [{ name: "claude-sonnet-4-5", provider: "anthropic" }] });
    await withGatewayEnv(gw.url, async () => {
      await gatewayModelCatalog(gw.url, "");
      const project = createProject({ name: "Gateway" });
      updateProject(project.id, { agent_env: serializeAgentEnv(gatewayPresetEnv({ baseUrl: gw.url, billing: "key", model: "claude-sonnet-4-5" })) });
      const task = createTask({ project_id: project.id, title: "T", description: "" });
      script([
        { type: "session", sessionId: "gw-1" },
        { type: "model", model: "claude-sonnet-4-5" },
        // The driver's own cost_usd (Claude Code prices per api.anthropic.com's
        // list price, invisible to a gateway redirect) must not be what lands.
        // The gateway's own rate does instead.
        { type: "usage", usage: { cost_usd: 999, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 } },
        { type: "done", sessionId: "gw-1" },
      ]);
      const { events, done } = collectEvents(task.id);
      await startResumeTurn(task, getProject(project.id)!, "go");
      await done;
      // 1000 * 0.000003 + 500 * 0.000015 (tests/fakeGateway.ts's fixed rates)
      const expected = 1000 * 0.000003 + 500 * 0.000015;
      expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: expected, turns: 1, unpriced_turns: 0 });
      const usageEv = events.find((e) => e.type === "usage") as Extract<TaskStreamEvent, { type: "usage" }>;
      expect(usageEv.usage.cost_usd).toBeCloseTo(expected, 10);
      expect(usageEv.unpriced).toBe(false);
    });
  });

  it("records NULL (unpriced) for a gateway model the last probe never reported", async () => {
    gw = await startFakeGateway({ models: [{ name: "claude-sonnet-4-5", provider: "anthropic" }] });
    await withGatewayEnv(gw.url, async () => {
      await gatewayModelCatalog(gw.url, "");
      const project = createProject({ name: "Gateway-unpriced" });
      updateProject(project.id, { agent_env: serializeAgentEnv(gatewayPresetEnv({ baseUrl: gw.url, billing: "key", model: "some-unlisted-model" })) });
      const task = createTask({ project_id: project.id, title: "T", description: "" });
      script([
        { type: "session", sessionId: "gw-2" },
        { type: "model", model: "some-unlisted-model" },
        { type: "usage", usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 } },
        { type: "done", sessionId: "gw-2" },
      ]);
      const { done } = collectEvents(task.id);
      await startResumeTurn(task, getProject(project.id)!, "go");
      await done;
      expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0, turns: 1, unpriced_turns: 1 });
    });
  });
});
