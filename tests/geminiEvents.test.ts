// Event-mapping tests for the Antigravity (Gemini) driver, run against NDJSON
// recorded from the real `agy` CLI (1.1.22, 2026-09-02) rather than hand-written
// literals — the same shape as tests/codexEvents.test.ts. The fixtures are what
// pins this driver to the CLI's actual wire format, which differs from the
// vendor's documentation on nearly every detail.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mapAgyEvent, newState, classify, mcpIdentity, ZERO_CUM, type GeminiCum } from "@/lib/agents/gemini/events";
import type { StreamEvent } from "@/lib/types";

function fixture(name: string): unknown[] {
  const file = path.join(__dirname, "fixtures", "gemini", name);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Replay a whole fixture, returning the events and the state left behind. */
function replay(name: string, opts: { cum?: GeminiCum; aborted?: boolean } = {}) {
  const state = newState("gemini-3.8-flash-high", opts.cum ?? ZERO_CUM);
  const events: StreamEvent[] = [];
  for (const line of fixture(name)) events.push(...mapAgyEvent(line, state, opts.aborted ?? false));
  return { events, state };
}

const only = <T extends StreamEvent["type"]>(events: StreamEvent[], type: T) =>
  events.filter((e) => e.type === type) as Extract<StreamEvent, { type: T }>[];

describe("classify", () => {
  it("reads the measured envelope, which carries both a tag and a payload key", () => {
    expect(classify({ event: "init", conversation_id: "c1", init: { cwd: "/x" } })).toMatchObject({
      kind: "init",
      conversationId: "c1",
    });
    expect(classify({ event: "step_update", step_update: { step_type: "tool" } }).kind).toBe("step_update");
    expect(classify({ event: "result", result: { status: "SUCCESS" } }).kind).toBe("result");
  });

  it("still classifies if the CLI ever drops the payload key and sends a flat object", () => {
    expect(classify({ event: "result", status: "SUCCESS" }).kind).toBe("result");
  });

  it("drops anything it doesn't recognize rather than throwing", () => {
    expect(classify({ event: "brand_new_thing" }).kind).toBe("unknown");
    expect(classify(null).kind).toBe("unknown");
    expect(classify("nope").kind).toBe("unknown");
  });
});

describe("mcpIdentity", () => {
  // The load-bearing one. Every MCP call goes through the CLI's own
  // `call_mcp_tool` dispatcher, so reading tool_info.name would name every
  // Calandria tool "call_mcp_tool" and lib/suggestionCard.ts would never match
  // a suggest_task row.
  it("recovers the real server and tool from call_mcp_tool's parameters", () => {
    expect(
      mcpIdentity({ name: "call_mcp_tool", parameters: { ServerName: "calandria", ToolName: "suggest_task" } })
    ).toEqual({ server: "calandria", tool: "suggest_task" });
  });

  it("returns null for an ordinary tool", () => {
    expect(mcpIdentity({ name: "run_command", parameters: { CommandLine: "ls" } })).toBeNull();
  });
});

describe("a turn that calls an MCP tool", () => {
  const { events } = replay("mcp-tool-call.jsonl");

  it("emits the conversation id from init, so a turn that dies is still resumable", () => {
    expect(events[0]).toEqual({ type: "session", sessionId: "a619d7dd-760a-49fa-a581-8ffef68d4cb9" });
  });

  it("names the MCP call after the tool the model actually asked for", () => {
    const tool = only(events, "tool").find((t) => t.name?.includes("get_task"));
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("calandria__get_task");
    expect(tool!.title).toBe("⚙ calandria: get_task");
  });

  it("settles the call's output onto the same row", () => {
    const tool = only(events, "tool").find((t) => t.name === "calandria__get_task")!;
    const result = only(events, "tool_result").find((r) => r.id === tool.id);
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    expect(result!.content).toContain("task-HOME-2");
  });

  it("renders an ordinary tool step with its own name and headline parameter", () => {
    const view = only(events, "tool").find((t) => t.name === "view_file");
    expect(view).toBeDefined();
    expect(view!.title).toContain("View file");
  });

  it("emits the assistant's reply exactly once", () => {
    const said = only(events, "assistant");
    expect(said).toHaveLength(1);
    expect(said[0].content).toBe("task-HOME-2");
  });

  it("emits one done carrying the conversation id", () => {
    const done = only(events, "done");
    expect(done).toHaveLength(1);
    expect(done[0].sessionId).toBe("a619d7dd-760a-49fa-a581-8ffef68d4cb9");
  });

  it("reports the turn's tokens, with reasoning folded into output", () => {
    const usage = only(events, "usage");
    expect(usage).toHaveLength(1);
    // Fresh conversation, so the cumulative report IS this turn's spend.
    expect(usage[0].usage.input_tokens).toBe(45546);
    expect(usage[0].usage.output_tokens).toBe(505 + 384);
    expect(usage[0].usage.cache_read_tokens).toBe(0);
    // Token-only reporting, so cost is an estimate rather than a billed figure.
    expect(usage[0].usage.cost_usd).toBeGreaterThan(0);
  });
});

describe("usage is cumulative over the conversation, not per turn", () => {
  // The correction that matters most for spend: `result.usage` on turn 2 reports
  // the WHOLE conversation. Billing the raw figure would charge turn 1 twice.
  const first = replay("mcp-tool-call.jsonl");

  it("subtracts the previous turn's baseline on a resume", () => {
    const { events } = replay("resume-cumulative-usage.jsonl", { cum: first.state.cum });
    const usage = only(events, "usage")[0].usage;
    // 61357 - 45546, which is exactly what the resumed turn's own step reported.
    expect(usage.input_tokens).toBe(15811);
    expect(usage.output_tokens).toBe(551 - 505 + (425 - 384));
  });

  it("bills the whole conversation if the baseline is missing", () => {
    const { events } = replay("resume-cumulative-usage.jsonl");
    expect(only(events, "usage")[0].usage.input_tokens).toBe(61357);
  });

  it("takes a report at face value when the counters went backwards", () => {
    // A baseline from a different run of the conversation. Clamping to zero
    // would silently stop billing; the Codex driver makes the same call.
    const high: GeminiCum = { input: 999_999, output: 0, thinking: 0, cacheRead: 0 };
    const { events } = replay("resume-cumulative-usage.jsonl", { cum: high });
    expect(only(events, "usage")[0].usage.input_tokens).toBe(61357);
  });

  it("leaves the new baseline on the state for the driver to persist", () => {
    const { state } = replay("resume-cumulative-usage.jsonl", { cum: first.state.cum });
    expect(state.cum.input).toBe(61357);
  });
});

describe("a tool the CLI auto-denied", () => {
  // Measured: headless mode has nobody to prompt, so it denies the call, ends
  // the run CANCELED and still exits 0. Treating CANCELED as "the user stopped
  // it" would report a turn that did nothing as a clean success.
  it("surfaces an error when we did not ask for the stop", () => {
    const { events } = replay("tool-auto-denied.jsonl");
    const errors = only(events, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toMatch(/stopped early/i);
  });

  it("stays silent when the stop was our own abort", () => {
    const { events } = replay("tool-auto-denied.jsonl", { aborted: true });
    expect(only(events, "error")).toHaveLength(0);
    // The turn still settles, so the runner can finish it.
    expect(only(events, "done")).toHaveLength(1);
  });

  it("still bills what the cancelled turn spent", () => {
    const { events } = replay("tool-auto-denied.jsonl", { aborted: true });
    expect(only(events, "usage")[0].usage.input_tokens).toBe(13920);
  });
});

describe("step handling", () => {
  it("suppresses the bridge's ask_user, which renders as its own card", () => {
    const state = newState();
    const events = mapAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 9,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "call_mcp_tool",
          tool_info: {
            name: "call_mcp_tool",
            parameters: { ServerName: "calandria", ToolName: "ask_user", Arguments: { question: "which?" } },
          },
        },
      },
      state
    );
    expect(events).toEqual([]);
  });

  it("drops the echo of our own prompt and the CLI's internal notes", () => {
    const state = newState();
    for (const type of ["user_input", "system_message"]) {
      expect(mapAgyEvent({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: type } }, state)).toEqual([]);
    }
  });

  it("accumulates streamed prose and emits it once the step is done", () => {
    const state = newState();
    const step = (extra: Record<string, unknown>) => ({
      event: "step_update",
      step_update: { step_index: 3, step_type: "agent_response", ...extra },
    });
    expect(mapAgyEvent(step({ state: "ACTIVE", text_delta: "Hello " }), state)).toEqual([]);
    expect(mapAgyEvent(step({ state: "ACTIVE", text_delta: "world" }), state)).toEqual([]);
    expect(mapAgyEvent(step({ state: "DONE" }), state)).toEqual([{ type: "assistant", content: "Hello world" }]);
  });

  it("emits nothing for a thinking-only agent_response step", () => {
    const state = newState();
    const events = mapAgyEvent(
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response" } },
      state
    );
    expect(events).toEqual([]);
  });

  it("emits one tool event per step however many updates arrive", () => {
    const state = newState();
    const step = (s: string) => ({
      event: "step_update",
      step_update: {
        step_index: 7,
        state: s,
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" }, ...(s === "DONE" ? { output: "a\nb" } : {}) },
      },
    });
    const first = mapAgyEvent(step("ACTIVE"), state);
    expect(first.filter((e) => e.type === "tool")).toHaveLength(1);
    const second = mapAgyEvent(step("DONE"), state);
    expect(second.filter((e) => e.type === "tool")).toHaveLength(0);
    expect(second.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });

  it("marks a refused tool call as an error result", () => {
    const state = newState();
    const events = mapAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 8,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "rm -rf /" }, error: "denied by policy" },
        },
      },
      state
    );
    const result = events.find((e) => e.type === "tool_result") as Extract<StreamEvent, { type: "tool_result" }>;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("denied by policy");
  });

  it("names the file a writing tool touched so the card can open it", () => {
    const state = newState();
    const events = mapAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: { name: "write_to_file", parameters: { AbsolutePath: "/repo/main.go" } },
        },
      },
      state
    );
    const tool = events.find((e) => e.type === "tool") as Extract<StreamEvent, { type: "tool" }>;
    expect(tool.file).toBe("/repo/main.go");
  });

  it("does not name a file for a read-only tool", () => {
    const state = newState();
    const events = mapAgyEvent(
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: "/repo/main.go" } },
        },
      },
      state
    );
    const tool = events.find((e) => e.type === "tool") as Extract<StreamEvent, { type: "tool" }>;
    expect(tool.file).toBeUndefined();
  });
});

describe("result handling", () => {
  it("emits the final response when no step streamed it", () => {
    const state = newState();
    const events = mapAgyEvent(
      { event: "result", result: { conversation_id: "c9", status: "SUCCESS", response: "all done" } },
      state
    );
    expect(events.filter((e) => e.type === "assistant")).toEqual([{ type: "assistant", content: "all done" }]);
  });

  it("does not repeat a reply a step already streamed", () => {
    const state = newState();
    mapAgyEvent(
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "hi" } },
      state
    );
    const events = mapAgyEvent({ event: "result", result: { status: "SUCCESS", response: "hi" } }, state);
    expect(events.filter((e) => e.type === "assistant")).toHaveLength(0);
  });

  it("passes an ERROR through verbatim so authFailure can classify it", () => {
    const state = newState();
    const events = mapAgyEvent(
      { event: "result", result: { status: "ERROR", error: "You are not logged into Antigravity." } },
      state
    );
    const err = events.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>;
    expect(err.content).toBe("You are not logged into Antigravity.");
  });
});
