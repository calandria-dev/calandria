import { describe, it, expect, beforeEach, vi } from "vitest";

// Mid-turn task notifications. The CLI registers EVERY Bash/Agent call as a
// task and announces it (measured on 2.1.240): a foreground call gets
// task_started + task_notification — summary = the call's own description,
// no output_file — an instant BEFORE its tool_result; a backgrounded call
// returns a "running in the background" tool_result first and is notified
// when it settles. The driver used to forward every summary as a notice, so
// each long foreground command left a floating line reading like an error
// ("⚠ Install devDeps in the worktree and typecheck"). Only the background
// settle is news: the foreground card is about to carry its own result.
//
// Same SDK-boundary mock as tests/claudeBackgroundLinger.test.ts, without
// the linger: the Stop hook reports nothing pending, so the turn closes at
// result time and only the mid-turn branch is exercised.

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import type { Project, Task, StreamEvent } from "@/lib/types";

type StopHook = (input: unknown) => Promise<unknown>;
type QueryArgs = { prompt: AsyncIterable<unknown>; options: { hooks?: { Stop?: { hooks: StopHook[] }[] } } };

function mockCli(run: (io: { stop: () => Promise<void>; nextInput: () => Promise<IteratorResult<unknown>> }) => AsyncGenerator<unknown>): void {
  queryMock.mockImplementation((args: QueryArgs) => {
    const it = args.prompt[Symbol.asyncIterator]();
    const hooks = args.options.hooks?.Stop?.[0]?.hooks ?? [];
    return run({
      stop: async () => { for (const h of hooks) await h({ background_tasks: [], session_crons: [] }); },
      nextInput: () => it.next(),
    });
  });
}

const init = { type: "system", subtype: "init", session_id: "sess-1" };
const result = { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } };
const toolUse = (id: string, command: string, description: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, description } }], usage: { input_tokens: 10 } },
});
const toolResult = (id: string, text: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const notification = (fields: Record<string, unknown>) => ({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "", summary: "", ...fields });

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

async function drain(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return events;
}
const notices = (events: StreamEvent[]) => events.filter((e) => e.type === "notice").map((e) => ("content" in e ? e.content : ""));

beforeEach(() => {
  queryMock.mockReset();
});

describe("claude driver mid-turn task notifications", () => {
  it("drops the announcement of a FOREGROUND call — the card is about to carry the result", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield toolUse("tu-fg", "npm run typecheck", "Install devDeps in the worktree and typecheck");
      // Measured order: the notification lands BEFORE the tool_result.
      yield notification({ tool_use_id: "tu-fg", summary: "Install devDeps in the worktree and typecheck" });
      yield toolResult("tu-fg", "ok");
      await stop();
      yield result;
      await nextInput();
    });
    const events = await drain();
    expect(notices(events)).toEqual([]);
    // The card itself is intact: tool + its result.
    expect(events.find((e) => e.type === "tool_result" && e.id === "tu-fg")).toMatchObject({ content: "ok", isError: false });
  });

  it("keeps the settle of a BACKGROUNDED call as a quiet note, and warns when it failed", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield toolUse("tu-bg", "npm test", "Run the suite");
      // A backgrounded call returns its placeholder FIRST, then settles later.
      yield toolResult("tu-bg", "Command running in background with ID: b1. You will be notified when it completes.");
      yield notification({ tool_use_id: "tu-bg", output_file: "/tmp/b1.output", summary: 'Background command "Run the suite" completed (exit code 0)' });
      yield toolUse("tu-bg2", "npm run build", "Build");
      yield toolResult("tu-bg2", "Command running in background with ID: b2.");
      yield notification({ tool_use_id: "tu-bg2", status: "failed", output_file: "/tmp/b2.output", summary: 'Background command "Build" failed (exit code 2)' });
      await stop();
      yield result;
      await nextInput();
    });
    expect(notices(await drain())).toEqual([
      'Background command "Run the suite" completed (exit code 0)',
      '⚠ Background command "Build" failed (exit code 2)',
    ]);
  });

  it("honors the CLI's skip_transcript flag, and still surfaces a notification with no tool_use id", async () => {
    mockCli(async function* ({ stop, nextInput }) {
      await nextInput();
      yield init;
      yield toolUse("tu-a", "sleep 1", "Housekeeping");
      yield toolResult("tu-a", "done");
      yield notification({ tool_use_id: "tu-a", skip_transcript: true, summary: "ambient housekeeping" });
      yield notification({ summary: "Something the session did on its own" });
      await stop();
      yield result;
      await nextInput();
    });
    expect(notices(await drain())).toEqual(["Something the session did on its own"]);
  });
});
