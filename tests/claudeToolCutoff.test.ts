// A Calandria tool call the Claude CLI answers ITSELF ("The tool call was
// interrupted before a result was received"): the call never reached
// lib/agentToolGuard.mjs, so the driver's stream pump is the only place that
// can see it. Measured 2026-08-20..2026-09-03 (CLI 2.1.257): 1 of 363 such
// calls failed in a task's first session, 31 of 123 in resumed ones, and once
// one fails the rest of that session's Calandria calls fail while Bash, Read
// and Edit keep working. This pins what the driver does about it:
//
//   - the persisted result is rewritten to say whose sentence it is
//     (toolInterruptedMessage) and the event carries `cutOff: true`, which the
//     runner counts onto the `turn ok` line as `tool_cutoffs`;
//   - the user is told ONCE per turn, as a transcript notice, that /clear
//     starts the fresh session measured to work;
//   - only Calandria's own tools are claimed — a Bash result carrying the same
//     sentence is the CLI's business, not ours;
//   - the CLI's stderr is captured with the task on it, and with
//     CALANDRIA_CLAUDE_DEBUG_DIR set the CLI writes a per-turn debug log there,
//     the one record of what it did with a call Calandria never received.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { queryMock, DEBUG_DIR } = vi.hoisted(() => {
  // lib/config.ts reads this at import time; the suite's tmp DB dir is the
  // one place every platform agrees is writable and disposable.
  const dir = `${process.env.CALANDRIA_DB_DIR}/cli-debug-${process.pid}`;
  process.env.CALANDRIA_CLAUDE_DEBUG_DIR = dir;
  return { queryMock: vi.fn(), DEBUG_DIR: dir };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { CLI_INTERRUPTED_TOOL_RESULT, toolCutoffNotice, toolInterruptedMessage } from "@/lib/agentToolGuard.mjs";
import type { Project, Task, StreamEvent } from "@/lib/types";

type QueryArgs = { prompt: AsyncIterable<unknown>; options: Record<string, unknown> & { hooks?: { Stop?: { hooks: ((input: unknown) => Promise<unknown>)[] }[] } } };

function mockCli(run: (stop: () => Promise<void>) => AsyncGenerator<unknown>): void {
  queryMock.mockImplementation((args: QueryArgs) => {
    const hooks = args.options.hooks?.Stop?.[0]?.hooks ?? [];
    return run(async () => {
      for (const h of hooks) await h({ background_tasks: [], session_crons: [] });
    });
  });
}

const CLI_TEXT = `${CLI_INTERRUPTED_TOOL_RESULT}. It may or may not have completed on the server — verify before assuming it succeeded, and retry if needed.`;
const SUGGEST = "mcp__calandria__suggest_task";

const init = { type: "system", subtype: "init", session_id: "sess-1" };
const result = { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } };
const toolUses = (blocks: { id: string; name: string; input?: Record<string, unknown> }[]) => ({
  type: "assistant",
  message: { content: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} })) },
});
const toolResults = (blocks: { id: string; text: string; error?: boolean }[]) => ({
  type: "user",
  message: { content: blocks.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: b.text, is_error: !!b.error })) },
});

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

async function drain(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return events;
}
const results = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "tool_result" }> => e.type === "tool_result");
const notices = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "notice" }> => e.type === "notice");

beforeEach(() => {
  queryMock.mockReset();
});

describe("a Calandria tool call the CLI answered itself", () => {
  it("is rewritten, flagged cutOff, and reported to the user once per turn", async () => {
    mockCli(async function* (stop) {
      yield init;
      yield toolUses([
        { id: "c1", name: SUGGEST, input: { title: "A" } },
        { id: "c2", name: SUGGEST, input: { title: "B" } },
        { id: "b1", name: "Bash", input: { command: "true" } },
      ]);
      yield toolResults([
        { id: "c1", text: CLI_TEXT, error: true },
        { id: "c2", text: CLI_TEXT, error: true },
        // The CLI's sentence on a tool that is not ours: not our call to claim.
        { id: "b1", text: CLI_TEXT, error: true },
      ]);
      yield result;
      await stop();
    });
    const events = await drain();

    const rs = results(events);
    const c1 = rs.find((r) => r.id === "c1");
    const c2 = rs.find((r) => r.id === "c2");
    const b1 = rs.find((r) => r.id === "b1");
    expect(c1?.cutOff).toBe(true);
    expect(c1?.content).toBe(toolInterruptedMessage(SUGGEST));
    expect(c1?.isError).toBe(true);
    expect(c2?.cutOff).toBe(true);
    expect(c2?.content).toBe(toolInterruptedMessage(SUGGEST));
    expect(b1?.cutOff).toBeUndefined();
    expect(b1?.content).toBe(CLI_TEXT);

    // One notice for the turn, naming the first tool that was cut off, not one
    // per call: the second is news to nobody.
    const ns = notices(events).filter((n) => n.content.includes("cut off"));
    expect(ns).toHaveLength(1);
    expect(ns[0].content).toBe(toolCutoffNotice(SUGGEST));
    expect(ns[0].content).toContain("/clear");
  });

  it("leaves a healthy Calandria result alone and says nothing", async () => {
    mockCli(async function* (stop) {
      yield init;
      yield toolUses([{ id: "c1", name: "mcp__calandria__list_tasks" }]);
      yield toolResults([{ id: "c1", text: '{"project":"P","tasks":[]}' }]);
      yield result;
      await stop();
    });
    const events = await drain();
    const [r] = results(events);
    expect(r.cutOff).toBeUndefined();
    expect(r.content).toBe('{"project":"P","tasks":[]}');
    expect(r.isError).toBe(false);
    expect(notices(events).filter((n) => n.content.includes("cut off"))).toHaveLength(0);
  });
});

describe("what the driver asks the CLI to record", () => {
  it("captures the CLI's stderr and, with CALANDRIA_CLAUDE_DEBUG_DIR set, a per-turn debug file", async () => {
    mockCli(async function* (stop) {
      yield init;
      yield result;
      await stop();
    });
    await drain();
    const { options } = queryMock.mock.calls[0][0] as QueryArgs;
    expect(typeof options.stderr).toBe("function");
    const debugFile = options.debugFile as string;
    expect(path.dirname(debugFile)).toBe(path.normalize(DEBUG_DIR));
    expect(path.basename(debugFile)).toMatch(/^t1-g1-\d{4}-\d{2}-\d{2}T[\d-]+Z\.log$/);
    // The directory is made for the CLI, which only writes the file.
    expect(fs.existsSync(DEBUG_DIR)).toBe(true);
  });
});
