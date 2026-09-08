import { describe, it, expect, beforeEach, vi } from "vitest";

// The spend ledger on a turn that never reached a result message. `usage` is
// otherwise only read from the SDK's result message, and a model can run
// through tool calls for a long time without producing one. The driver
// reports each request's own tokens as a PARTIAL usage event, which the
// runner holds instead of writing: a full report supersedes them, and the
// finally writes whatever is left when none arrived.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTaskUsage } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { abortTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import { getDb } from "@/lib/db";
import type { StreamEvent, TaskStreamEvent } from "@/lib/types";

beforeEach(() => {
  runTurnMock.mockReset();
});

function fixture() {
  const project = createProject({ name: "Spend", repo_path: "" });
  const task = createTask({ project_id: project.id, title: "T", description: "" });
  return { project, task };
}

function collect(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
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

type Row = {
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

function usageRows(taskId: string): Row[] {
  return getDb()
    .prepare(
      "SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM task_usage WHERE task_id = ? ORDER BY rowid"
    )
    .all(taskId) as Row[];
}

/** One API request's own usage, as the Claude driver reports it per assistant message. */
const request = (input: number, output: number, cacheRead = 0, cacheWrite = 0): StreamEvent => ({
  type: "usage",
  usage: {
    cost_usd: 0,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
  },
  partial: true,
});

/** Yield `before`, then park until the turn is Stopped. */
function scriptThenPark(before: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
    for (const ev of before) yield ev;
    await new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
  });
}

/** The turn has consumed everything up to the marker assistant line. */
async function awaitMarker(events: TaskStreamEvent[]) {
  await vi.waitFor(() => expect(events.some((e) => e.type === "assistant")).toBe(true));
}

describe("spend on a turn that never reported a result", () => {
  it("writes what the per-request reports measured, unpriced", async () => {
    const { project, task } = fixture();
    scriptThenPark([
      { type: "session", sessionId: "s1" },
      request(10, 5, 100, 20),
      request(4, 7, 200, 0),
      { type: "assistant", content: "working" },
    ]);

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await awaitMarker(events);

    // Nothing is written or published while the turn runs: a full report would
    // cover the same requests, and the client ADDS a usage event to the task's
    // running total, so publishing both would double it on screen.
    expect(usageRows(task.id)).toHaveLength(0);
    expect(events.some((e) => e.type === "usage")).toBe(false);

    abortTurn(task.id);
    await done;

    expect(usageRows(task.id)).toEqual([
      { cost_usd: null, input_tokens: 14, output_tokens: 12, cache_read_tokens: 300, cache_creation_tokens: 20 },
    ]);
    // Unpriced, not a confident $0: the per-request source carries tokens
    // alone, so the total is a floor and the UI must say so.
    const totals = getTaskUsage(task.id);
    expect(totals).toMatchObject({ cost_usd: 0, total_tokens: 346, turns: 1, unpriced_turns: 1 });
    // The live chip gets it too, marked unpriced, instead of waiting for a refetch.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    expect(events.find((e) => e.type === "usage")).toMatchObject({ unpriced: true });
  });

  it("keeps the per-request tokens when the only full report is an empty one", async () => {
    const { project, task } = fixture();
    scriptThenPark([
      { type: "session", sessionId: "s1" },
      request(10, 5),
      // Every resumed session's first result message reports all zeros. It
      // says nothing about the requests already made, so it must not
      // supersede them, or every resumed turn would lose those tokens.
      { type: "usage", usage: { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      { type: "assistant", content: "working" },
    ]);

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await awaitMarker(events);
    abortTurn(task.id);
    await done;

    expect(usageRows(task.id)).toEqual([
      { cost_usd: null, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    ]);
  });
});

describe("spend on a turn that did report a result", () => {
  it("takes the full report's totals and never adds the per-request ones to them", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield request(10, 5, 100, 20);
      yield request(4, 7, 200, 0);
      // The result message's usage is the segment's own totals: the sum over
      // exactly those requests (verified to the token; see claudeSubagentTokens).
      yield {
        type: "usage",
        usage: { cost_usd: 0.5, input_tokens: 14, output_tokens: 12, cache_read_tokens: 300, cache_creation_tokens: 20 },
      } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    expect(usageRows(task.id)).toEqual([
      { cost_usd: 0.5, input_tokens: 14, output_tokens: 12, cache_read_tokens: 300, cache_creation_tokens: 20 },
    ]);
    expect(getTaskUsage(task.id)).toMatchObject({ cost_usd: 0.5, total_tokens: 346, turns: 1, unpriced_turns: 0 });
  });

  it("counts the requests made AFTER a full report, which that report cannot cover", async () => {
    const { project, task } = fixture();
    scriptThenPark([
      { type: "session", sessionId: "s1" },
      request(10, 5),
      { type: "usage", usage: { cost_usd: 0.5, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 } },
      request(3, 2),
      { type: "assistant", content: "working" },
    ]);

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await awaitMarker(events);
    abortTurn(task.id);
    await done;

    expect(usageRows(task.id)).toEqual([
      { cost_usd: 0.5, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      { cost_usd: null, input_tokens: 3, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
    ]);
  });

  it("writes no row at all for a report with nothing in it", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield {
        type: "usage",
        usage: { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    // An all-zero row is noise in a per-turn ledger, and one arrived seconds
    // into every resumed turn.
    expect(usageRows(task.id)).toHaveLength(0);
    expect(getTaskUsage(task.id)).toMatchObject({ turns: 0, unpriced_turns: 0 });
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });
});
