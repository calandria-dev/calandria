import { describe, it, expect, vi } from "vitest";

// The linger kill-switch: ORCH_BACKGROUND_LINGER=off restores the pre-feature
// behavior — the turn closes at result time even with background work pending,
// and the capability flag flips so buildProjectContext re-warns the model that
// backgrounded commands die at turn end. Its own file because the env is read
// at module load (lib/config.ts), so the main linger suite can't flip it.
const { queryMock } = vi.hoisted(() => {
  process.env.ORCH_BACKGROUND_LINGER = "off";
  return { queryMock: vi.fn() };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => ({ type: "sdk", ...(cfg as object) }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { buildProjectContext } from "@/lib/agents/shared";
import type { Project, Task, StreamEvent } from "@/lib/types";

const project = { id: "p1", name: "P", repo_path: "/tmp/repo", context: "" } as Project;
const task = { id: "t1", agent: "claude", title: "T", description: "", session_id: null, worktree_path: "", generation: 1 } as unknown as Task;

describe("ORCH_BACKGROUND_LINGER=off", () => {
  it("closes at result time even with background work pending", async () => {
    queryMock.mockImplementation((args: { prompt: AsyncIterable<unknown>; options: { hooks?: { Stop?: { hooks: ((i: unknown) => Promise<unknown>)[] }[] } } }) => {
      const it2 = args.prompt[Symbol.asyncIterator]();
      return (async function* () {
        await it2.next();
        yield { type: "system", subtype: "init", session_id: "s" };
        for (const h of args.options.hooks?.Stop?.[0]?.hooks ?? []) {
          await h({ background_tasks: [{ id: "bg1", type: "shell", status: "running", description: "sleep 5" }] });
        }
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } };
        // With the switch off the driver must release the input here — this
        // read hangs the test (and fails it on timeout) if it lingers instead.
        const end = await it2.next();
        expect(end.done).toBe(true);
      })();
    });
    const events: StreamEvent[] = [];
    for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
    expect(events.some((e) => e.type === "background_pending")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("flips the capability and the system-prompt warning back to die-at-turn-end", () => {
    expect(claudeDriver.capabilities.backgroundTasksLinger).toBe(false);
    const ctx = buildProjectContext(project, task);
    expect(ctx).toContain("do NOT survive the end of your turn");
    expect(ctx).not.toContain("keep running after your turn ends");
  });
});
