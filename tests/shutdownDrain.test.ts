import { describe, it, expect, beforeEach, vi } from "vitest";

// Graceful-shutdown drain (issue #14 item 1): drainActiveTurns() is what
// server.js's SIGTERM/SIGINT handler pings via POST /api/instance/drain before
// exiting, instead of the old bare process.exit(0). It must reuse the exact
// Stop-button mechanics (abortTurn + the finally's DENIED_INTERRUPTED
// settlement) rather than inventing a second shutdown path, wait for the real
// completion signal (turn_end) instead of trusting hasTurn()'s immediate
// false, and never hang the shutdown past its own bound.
//
// Same seam trick as tests/permissionGate.test.ts / tests/turnRace.test.ts:
// only the SDK-driving module is swapped, so the registry, runner, store and
// event bus all run for real.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, listMessages } from "@/lib/store";
import { startTurn, drainActiveTurns } from "@/lib/runner";
import { hasTurn } from "@/lib/abort";
import type { StreamEvent, ToolData } from "@/lib/types";

const REQUEST = {
  id: "perm:tu_1",
  tool: "Bash",
  title: "❯ npm test",
  detail: "npm test",
  expiresAt: 0,
};

function fixture(name: string) {
  const project = createProject({ name, repo_path: "" });
  const task = createTask({ project_id: project.id, title: "Gated task", description: "" });
  return { project, task: getTask(task.id)! };
}

const toolRows = (taskId: string): ToolData[] =>
  listMessages(taskId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as ToolData);

beforeEach(() => runTurnMock.mockReset());

describe("drainActiveTurns (graceful shutdown)", () => {
  it("no-ops immediately when nothing is running", async () => {
    await expect(drainActiveTurns(1000)).resolves.toEqual({ total: 0, settled: 0 });
  });

  it("aborts a live turn, waits for its finally, and settles an open permission card exactly like a Stop", async () => {
    const { project, task } = fixture("Drain");
    // Parks on a permission prompt and never decides — the real driver's event
    // queue would close with the SDK stream the same way once aborted; nothing
    // but the runner's finally settles the card.
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "permission", request: REQUEST } as StreamEvent;
      await new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
    });

    startTurn(task, project, "go", "");
    await vi.waitFor(() => expect(toolRows(task.id).some((d) => d.permission)).toBe(true));
    expect(hasTurn(task.id)).toBe(true);

    const result = await drainActiveTurns(2000);
    expect(result).toEqual({ total: 1, settled: 1 });

    // Same DENIED_INTERRUPTED settlement a Stop-button press produces.
    const row = toolRows(task.id).find((d) => d.permission)!;
    expect(row.permission?.outcome).toMatchObject({ decision: "deny", auto: true, reason: "interrupted" });
    expect(hasTurn(task.id)).toBe(false);
    expect(getTask(task.id)!.running).toBe(0);
  });

  it("drains every live turn across tasks in one pass", async () => {
    const gates = [
      new Promise<void>(() => {}), // never resolves on its own — must be aborted
      new Promise<void>(() => {}),
    ];
    let call = 0;
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
      const i = call++;
      // Registered BEFORE the first yield, like a real driver wires up its
      // abort handling at the top of runTurn — not lazily after some later
      // await, which would race a synchronous abortTurn() called while this
      // generator is still suspended on its first yield.
      const stopped = new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
      yield { type: "session", sessionId: `s${i}` } as StreamEvent;
      await Promise.race([gates[i], stopped]);
    });

    const { project: p1, task: t1 } = fixture("DrainA");
    const { project: p2, task: t2 } = fixture("DrainB");
    startTurn(t1, p1, "go", "");
    startTurn(t2, p2, "go", "");
    await vi.waitFor(() => {
      expect(hasTurn(t1.id)).toBe(true);
      expect(hasTurn(t2.id)).toBe(true);
    });

    const result = await drainActiveTurns(2000);
    expect(result).toEqual({ total: 2, settled: 2 });
    expect(hasTurn(t1.id)).toBe(false);
    expect(hasTurn(t2.id)).toBe(false);
    expect(getTask(t1.id)!.running).toBe(0);
    expect(getTask(t2.id)!.running).toBe(0);
  });

  it("gives up at the bound instead of hanging when a turn won't unwind", async () => {
    const { project, task } = fixture("DrainStuck");
    // Ignores the abort signal entirely — models a driver stuck on an
    // uninterruptible call. The turn's finally never runs within the window.
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      await new Promise<void>(() => {});
    });

    startTurn(task, project, "go", "");
    await vi.waitFor(() => expect(hasTurn(task.id)).toBe(true));

    const start = Date.now();
    const result = await drainActiveTurns(150);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toEqual({ total: 1, settled: 0 });
    // abortTurn() still ran (the signal was tripped, and the registry entry
    // it deletes synchronously is gone) even though the driver never noticed.
    expect(hasTurn(task.id)).toBe(false);
  });
});
