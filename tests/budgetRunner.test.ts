import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// Same seam as tests/authFailure.test.ts: the Claude driver module is mocked so
// the runner's real error/queue/flag handling runs without the SDK (or a real
// login) anywhere near it. The registry maps "claude" to this module, so
// getDriver(task.agent) resolves the mock.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, listMessages, listPendingMessages, addPendingMessage } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { BUDGET_EXCEEDED_NOTICE, BUDGET_EXCEEDED_BANNER_REASON, isBudgetExceeded } from "@/lib/budgetFailure";
import { getAgentAuthBroken, clearAgentAuthBroken, markAgentAuthBroken } from "@/lib/agents/connections";
import type { TaskStreamEvent } from "@/lib/types";

// The proxy-level JSON shape from lib/budgetFailure.ts's own doc comment — a
// key/user/team budget rejection surfaced through whichever CLI carries the
// upstream body through in its error text.
const BUDGET_DEAD =
  'Budget has been exceeded! Current cost: 12.5, Max budget: 10.0 {"error": {"message": "Budget has been exceeded", "type": "budget_exceeded", "param": null, "code": "400"}}';

// Resolve once the runner publishes an event of the given type for this task,
// collecting every event seen along the way (so a test can assert on both the
// terminal boundary and what preceded it).
function watch(taskId: string, until: TaskStreamEvent["type"]): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  const done = new Promise<void>((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      events.push(ev);
      if (ev.type === until) { unsub(); resolve(); }
    });
  });
  return { events, done };
}

beforeEach(() => {
  runTurnMock.mockReset();
  clearAgentAuthBroken("claude");
});

describe("gateway budget recovery", () => {
  it("matches the fixture body via isBudgetExceeded", () => {
    expect(isBudgetExceeded(BUDGET_DEAD)).toBe(true);
  });

  it("flags the agent instance-wide with a budget-specific reason, offers a retry, and parks the queue instead of burning it", async () => {
    const project = createProject({ name: "P", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    // Two follow-ups the user typed while the turn was live (what POST /messages
    // parks in pending_messages). They must survive the budget failure.
    addPendingMessage(task.id, task.generation, "and then deploy it");
    addPendingMessage(task.id, task.generation, "and write a test");

    // The session opens, then the gateway key turns out to be over budget — it
    // fails at the API, not at spawn.
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      throw new Error(BUDGET_DEAD);
    });

    const w = watch(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await w.done;

    // The transcript carries the provider's own words AND the durable recovery
    // notice the UI turns into a "Retry" button.
    const errMsg = listMessages(task.id).find((m) => m.role === "system" && m.content.includes(BUDGET_EXCEEDED_NOTICE));
    expect(errMsg).toBeTruthy();
    expect(errMsg!.content).toContain("Budget has been exceeded");
    // One ⚠ — the runner prefixes it, so the renderer must not add a second.
    expect(errMsg!.content.startsWith("⚠ ")).toBe(true);
    expect(errMsg!.content).not.toContain("⚠ ⚠");

    // The agent is flagged app-wide (one key, every task) with the budget's own
    // reason text, NOT the raw error — the UI must not say "reconnect" for a
    // budget problem.
    const broken = getAgentAuthBroken("claude");
    expect(broken?.reason).toBe(BUDGET_EXCEEDED_BANNER_REASON);
    const announced = w.events.filter((e) => e.type === "agent_auth");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ agent: "claude", broken: true });

    // The queue is untouched — no dequeue, no second (identically failing) turn.
    expect(listPendingMessages(task.id)).toHaveLength(2);
    expect(w.events.some((e) => e.type === "dequeued")).toBe(false);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // …and the transcript says so, so the parked bubbles aren't a mystery.
    expect(listMessages(task.id).some((m) => m.content.includes("kept in the queue"))).toBe(true);

    // The turn still settles: nothing is left spinning.
    expect(getTask(task.id)!.running).toBe(0);
  });

  it("clears the flag once a turn runs again, and tells every tab", async () => {
    const project = createProject({ name: "P2", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T2", description: "d" });
    // Broken by an earlier turn (or a previous app run — the flag is persisted).
    markAgentAuthBroken("claude", BUDGET_EXCEEDED_BANNER_REASON, 1);

    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-ok" };
      yield { type: "done", sessionId: "sess-ok" };
    });

    const w = watch(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await w.done;

    // A completed turn is stronger proof than reading the budget elsewhere — it
    // used the same path a real turn takes.
    expect(getAgentAuthBroken("claude")).toBeNull();
    expect(w.events.filter((e) => e.type === "agent_auth")).toEqual([
      { type: "agent_auth", agent: "claude", broken: false, reason: null },
    ]);
  });

  it("an ordinary turn failure is not mistaken for a budget failure", async () => {
    const project = createProject({ name: "P3", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T3", description: "d" });
    addPendingMessage(task.id, task.generation, "follow-up");

    // Turn 1 fails on the work; turn 2 (the dequeued follow-up) succeeds.
    runTurnMock
      .mockImplementationOnce(async function* () {
        yield { type: "session", sessionId: "sess-a" };
        throw new Error("ENOSPC: no space left on device");
      })
      .mockImplementation(async function* () {
        yield { type: "session", sessionId: "sess-a" };
        yield { type: "done", sessionId: "sess-a" };
      });

    const w = watch(task.id, "dequeued");
    startTurn(task, project, "hi", "");
    await w.done;

    expect(getAgentAuthBroken("claude")).toBeNull();
    const msgs = listMessages(task.id);
    expect(msgs.some((m) => m.content.includes(BUDGET_EXCEEDED_NOTICE))).toBe(false);
    expect(msgs.some((m) => m.content.includes("ENOSPC"))).toBe(true);
    // The follow-up was dequeued and run: an unrelated failure doesn't park it.
    expect(listPendingMessages(task.id)).toHaveLength(0);
  });
});
