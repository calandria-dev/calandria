// Turn-lifecycle logging (issue #16 item 1).
//
// Every turn logs a start and an outcome line, giving the operator a view of
// rate, duration, and spend without opening the database. These lines are
// pinned like any other contract: the fields a dashboard would key on, and
// the rule that the outcome word matches what the schedule ledger recorded
// for the same turn.
//
// Driven through the REAL runner with a scripted driver, the same seam
// tests/agentDriver.test.ts uses: a line asserted against a hand-called logger
// would prove nothing about whether the runner reaches it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown, hooks?: unknown) =>
      runTurnMock(task, project, userText, ac, hooks),
  },
}));

import { createProject, createTask, getTask } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { SCHEDULED_RUN_CONTEXT } from "@/lib/runContext";
import type { StreamEvent } from "@/lib/types";

function script(events: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

/** Resolves when the runner publishes turn_end, by which point both
 *  lifecycle lines have been emitted. */
function turnEnded(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });
}

/** Every runner line this turn printed, parsed. JSON mode because that is the
 *  shape a collector consumes; the text rendering is pinned in log.test.ts. */
type Line = Record<string, unknown>;
function runnerLines(spies: ReturnType<typeof vi.spyOn>[]): Line[] {
  return spies
    .flatMap((s) => s.mock.calls.map((c) => c[0] as string))
    .filter((l) => typeof l === "string" && l.startsWith("{"))
    .map((l) => JSON.parse(l) as Line)
    .filter((l) => l.component === "runner");
}

let spies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  runTurnMock.mockReset();
  process.env.CALANDRIA_LOG_FORMAT = "json";
  spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  delete process.env.CALANDRIA_LOG_FORMAT;
  vi.restoreAllMocks();
});

describe("turn lifecycle logging", () => {
  it("counts the Calandria tool calls the agent CLI answered itself onto the ok line", async () => {
    const project = createProject({ name: "Cutoffs" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([
      { type: "session", sessionId: "s-1" },
      { type: "tool", id: "c1", name: "mcp__calandria__suggest_task", title: "✦ Suggest a task", detail: "" },
      { type: "tool_result", id: "c1", content: "cut off", isError: true, cutOff: true },
      { type: "tool", id: "b1", name: "Bash", title: "❯ true", detail: "true" },
      { type: "tool_result", id: "b1", content: "", isError: false },
      { type: "tool", id: "c2", name: "mcp__calandria__create_pr", title: "✦ Open a PR", detail: "" },
      { type: "tool_result", id: "c2", content: "cut off", isError: true, cutOff: true },
      { type: "done", sessionId: "s-1" },
    ]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;
    const end = runnerLines(spies).find((l) => l.msg === "turn ok")!;
    // Two of three calls were the CLI's own answers; the Bash one was not.
    expect(end.tool_cutoffs).toBe(2);
  });

  it("logs a start line and an ok line carrying duration and this turn's token usage", async () => {
    const project = createProject({ name: "Logging" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([
      { type: "session", sessionId: "s-1" },
      { type: "assistant", content: "done" },
      // Two reports in one turn: an SDK can emit usage more than once, and the
      // line must show the turn's TOTAL, not the last one it happened to see.
      { type: "usage", usage: { cost_usd: 0.01, input_tokens: 100, output_tokens: 20, cache_read_tokens: 1000, cache_creation_tokens: 5 } },
      { type: "usage", usage: { cost_usd: 0.02, input_tokens: 50, output_tokens: 10, cache_read_tokens: 500, cache_creation_tokens: 0 } },
      { type: "done", sessionId: "s-1" },
    ]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    const lines = runnerLines(spies);
    const start = lines.find((l) => l.msg === "turn start")!;
    const end = lines.find((l) => l.msg === "turn ok")!;
    expect(start).toMatchObject({
      level: "info",
      task: task.id,
      project: project.id,
      agent: "claude",
      generation: 1,
      origin: "user",
      resume: false,
    });
    expect(end).toMatchObject({
      level: "info",
      task: task.id,
      project: project.id,
      tokens_in: 150,
      tokens_out: 30,
      cache_read: 1500,
      cache_write: 5,
      tokens_total: 1685,
      cost_usd: 0.03,
    });
    expect(typeof end.ms).toBe("number");
    expect(end.ms as number).toBeGreaterThanOrEqual(0);
    // A clean turn says nothing about an error; the field is dropped, not null.
    expect("error" in end).toBe(false);
    // Likewise a turn whose Calandria tool calls all reached Calandria.
    expect("tool_cutoffs" in end).toBe(false);
    // Exactly two lines per turn, keeping the log readable and not a trace.
    expect(lines.map((l) => l.msg)).toEqual(["turn start", "turn ok"]);
  });

  it("reports a failed turn at error level with the reason", async () => {
    const project = createProject({ name: "Failing" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s-2" } as StreamEvent;
      throw new Error("the driver fell over");
    });
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    const end = runnerLines(spies).find((l) => String(l.msg).startsWith("turn ") && l.msg !== "turn start")!;
    expect(end.msg).toBe("turn failed");
    expect(end.level).toBe("error");
    expect(end.error).toContain("the driver fell over");
  });

  it("calls a turn whose session never opened `interrupted`, not `ok`", async () => {
    // The same word the schedule ledger settles this case with: nothing ran, so
    // reporting it green is exactly the silent skip the logging exists to catch.
    const project = createProject({ name: "NoSession" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([{ type: "done", sessionId: null }]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    const end = runnerLines(spies).find((l) => l.msg !== "turn start" && String(l.msg).startsWith("turn "))!;
    expect(end.msg).toBe("turn interrupted");
    expect(end.level).toBe("warn");
  });

  it("names why the turn is running, and whether it resumed a session", async () => {
    const project = createProject({ name: "Origin" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    // First turn opens the session…
    script([{ type: "session", sessionId: "s-3" }, { type: "done", sessionId: "s-3" }]);
    let ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "one");
    await ended;
    spies.forEach((s) => s.mockClear());

    // …so the second one resumes it, and this one is a schedule firing.
    script([{ type: "session", sessionId: "s-3" }, { type: "done", sessionId: "s-3" }]);
    ended = turnEnded(task.id);
    const { startTurn } = await import("@/lib/runner");
    startTurn(getTask(task.id)!, project, "two", "", undefined, SCHEDULED_RUN_CONTEXT);
    await ended;

    const start = runnerLines(spies).find((l) => l.msg === "turn start")!;
    expect(start).toMatchObject({ origin: "schedule", resume: true });
  });

  it("keeps the human bracket format when CALANDRIA_LOG_FORMAT is unset", async () => {
    delete process.env.CALANDRIA_LOG_FORMAT;
    const project = createProject({ name: "TextMode" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([{ type: "session", sessionId: "s-4" }, { type: "done", sessionId: "s-4" }]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    const printed = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).filter((l) => l.startsWith("[runner]"));
    expect(printed.some((l) => l === `[runner] turn start task=${task.id} project=${project.id} agent=claude generation=1 origin=user resume=false`)).toBe(true);
    expect(printed.some((l) => l.startsWith(`[runner] turn ok task=${task.id}`) && l.includes("tokens_total=0"))).toBe(true);
  });
});
