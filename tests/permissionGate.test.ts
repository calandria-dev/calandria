import { describe, it, expect, beforeEach, vi } from "vitest";

// The permission prompt end-to-end through the runner: a scripted driver emits
// the `permission` / `permission_decided` events the Claude driver's canUseTool
// gate produces, and this pins what lib/runner.ts does with them. The card is
// persisted answerably, the task is flagged as needing you while parked, the
// flag drops only when nothing is waiting, a turn that dies mid-prompt settles
// the card instead of leaving live buttons, and an unattended auto-deny parks
// the queue instead of draining it into the same wall.
//
// Same seam trick as tests/agentDriver.test.ts: only the SDK-driving module is
// swapped, so the registry, runner, store, and event bus all run for real.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, listMessages, listPendingMessages, addPendingMessage } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { abortTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import type { PermissionRequest, StreamEvent, TaskStreamEvent, ToolData } from "@/lib/types";

const REQUEST: PermissionRequest = {
  id: "perm:tu_1",
  tool: "Bash",
  title: "❯ npm test",
  detail: "npm test",
  scope: { scope: "project", match_kind: "bash_prefix", value: "npm test", label: "Always allow `npm test …` here" },
  expiresAt: 0,
};

function fixture() {
  const project = createProject({ name: "PermProj", repo_path: "" });
  const task = createTask({ project_id: project.id, title: "Gated task", description: "" });
  return { project, task: getTask(task.id)! };
}

// Every event the runner publishes for a task, resolved at turn_end.
function collect(taskId: string): { events: TaskStreamEvent[]; done: Promise<void> } {
  const events: TaskStreamEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const unsub = subscribe(taskId, (ev) => {
    events.push(ev);
    if (ev.type === "turn_end") { unsub(); resolve(); }
  });
  return { events, done };
}

const toolRows = (taskId: string): ToolData[] =>
  listMessages(taskId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as ToolData);

/** Drive the fake driver: yield `before`, park on `gate`, then yield `after`. */
function scriptParked(before: StreamEvent[], gate: Promise<StreamEvent[]>, after: StreamEvent[] = []) {
  runTurnMock.mockImplementation(async function* () {
    for (const ev of before) yield ev;
    for (const ev of await gate) yield ev;
    for (const ev of after) yield ev;
  });
}

beforeEach(() => runTurnMock.mockReset());

describe("permission prompts through the runner", () => {
  it("persists an answerable card, flags the task, then settles it on the decision", async () => {
    const { project, task } = fixture();
    let release!: (evs: StreamEvent[]) => void;
    const gate = new Promise<StreamEvent[]>((r) => (release = r));
    scriptParked(
      [{ type: "session", sessionId: "s1" }, { type: "permission", request: REQUEST }],
      gate,
      [{ type: "done", sessionId: "s1" }]
    );

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");

    // Parked: the card is persisted with its id (so a reload can still answer
    // the right prompt) and the task reads as needing you mid-turn.
    await vi.waitFor(() => expect(getTask(task.id)?.awaiting_input).toBe(1));
    const parked = toolRows(task.id).find((d) => d.permission)!;
    expect(parked.permission?.request.id).toBe(REQUEST.id);
    expect(parked.permission?.request.detail).toBe("npm test");
    expect(parked.permission?.outcome).toBeUndefined();
    expect(events.some((e) => e.type === "permission")).toBe(true);

    release([
      { type: "permission_decided", id: REQUEST.id, outcome: { decision: "allow_always", remembered: "Always allow `npm test …` here" } },
    ]);
    await done;

    const settled = toolRows(task.id).find((d) => d.permission)!;
    expect(settled.permission?.outcome?.decision).toBe("allow_always");
    expect(settled.permission?.outcome?.remembered).toContain("npm test");
    expect(events.some((e) => e.type === "permission_decided")).toBe(true);
  });

  it("keeps 'needs you' up until the LAST prompt is settled", async () => {
    const { project, task } = fixture();
    const second = { ...REQUEST, id: "perm:tu_2", title: "❯ git push" };
    let release!: (evs: StreamEvent[]) => void;
    const gate = new Promise<StreamEvent[]>((r) => (release = r));
    scriptParked(
      [
        { type: "session", sessionId: "s1" },
        { type: "permission", request: REQUEST },
        { type: "permission", request: second },
        { type: "permission_decided", id: REQUEST.id, outcome: { decision: "allow_once" } },
      ],
      gate,
      [{ type: "done", sessionId: "s1" }]
    );

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    // One of two answered; still waiting on the other.
    await vi.waitFor(() => {
      const rows = toolRows(task.id);
      expect(rows.filter((d) => d.permission?.outcome).length).toBe(1);
    });
    expect(getTask(task.id)?.awaiting_input).toBe(1);

    release([{ type: "permission_decided", id: second.id, outcome: { decision: "deny", note: "not yet" } }]);
    await done;
    const rows = toolRows(task.id);
    expect(rows.filter((d) => d.permission?.outcome).length).toBe(2);
  });

  it("settles a card the turn died on, so it never renders live buttons forever", async () => {
    const { project, task } = fixture();
    // Parks and never decides. The Stop below tears the turn down under it, and
    // the real driver behaves the same way: its event queue closes with the SDK
    // stream, so the gate's own deny event is dropped and nothing settles the
    // card unless the runner does it.
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "permission", request: REQUEST } as StreamEvent;
      await new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
    });

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await vi.waitFor(() => expect(toolRows(task.id).some((d) => d.permission)).toBe(true));

    abortTurn(task.id);
    await done;

    const row = toolRows(task.id).find((d) => d.permission)!;
    expect(row.permission?.outcome).toMatchObject({ decision: "deny", auto: true, reason: "interrupted" });
    const decided = events.filter((e) => e.type === "permission_decided");
    expect(decided.length).toBe(1);
  });

  it("parks queued follow-ups after an unattended auto-deny instead of draining them", async () => {
    const { project, task } = fixture();
    scriptParked(
      [
        { type: "session", sessionId: "s1" },
        { type: "permission", request: REQUEST },
        {
          type: "permission_decided",
          id: REQUEST.id,
          outcome: { decision: "deny", auto: true, reason: "unattended", note: "Nobody was watching." },
        },
        { type: "done", sessionId: "s1" },
      ],
      Promise.resolve([])
    );
    addPendingMessage(task.id, task.generation, "and then deploy it");

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    // Still queued: a follow-up would have hit the same unanswerable prompt.
    expect(listPendingMessages(task.id).map((p) => p.content)).toEqual(["and then deploy it"]);
    expect(events.some((e) => e.type === "notice" && e.content.includes("kept in the queue"))).toBe(true);
  });

  it("drains the queue normally when the user actually answered", async () => {
    const { project, task } = fixture();
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "permission", request: REQUEST } as StreamEvent;
      yield { type: "permission_decided", id: REQUEST.id, outcome: { decision: "allow_once" } } as StreamEvent;
      yield { type: "done", sessionId: "s1" } as StreamEvent;
    });
    addPendingMessage(task.id, task.generation, "next thing");

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    // The follow-up was dequeued and run (the second turn re-uses the script).
    await vi.waitFor(() => expect(listPendingMessages(task.id)).toHaveLength(0));
  });
});

// A refusal the CLI makes on its own (the "auto" classifier vetoing a call, a
// deny rule, `dontAsk`) never reaches canUseTool, so no card was ever raised
// and there is nothing for the user to answer. The runner makes sure that
// decision still lands somewhere honest instead of reading as an ordinary
// tool failure: as an already-settled permission card on the very tool call it
// killed. The wire shape is pinned in tests/claudePermissionMode.test.ts against
// messages captured from the live CLI.
describe("a refusal the CLI made without a card", () => {
  const TOOL: StreamEvent = { type: "tool", id: "tu_rm", title: "❯ rm -rf build", detail: "rm -rf build" };
  const DENIED: StreamEvent = {
    type: "permission_denied",
    id: "tu_rm",
    tool: "Bash",
    reasonType: "subcommandResults",
    reason: "Permission to use Bash with command rm -rf build has been denied.",
  };

  it("settles a decided card onto the tool call, carrying the input nobody got to judge", async () => {
    const { project, task } = fixture();
    scriptParked(
      [{ type: "session", sessionId: "s1" }, TOOL, DENIED, { type: "done", sessionId: "s1" }],
      Promise.resolve([])
    );

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    // ONE row, not a tool card plus a notice floating beside it.
    const rows = toolRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].permission).toEqual({
      request: { id: "tu_rm", tool: "Bash", title: "❯ rm -rf build", detail: "rm -rf build", diff: undefined, expiresAt: 0 },
      outcome: {
        decision: "deny",
        auto: true,
        reason: "blocked",
        blockedBy: "subcommandResults",
        note: "Permission to use Bash with command rm -rf build has been denied.",
      },
    });
    expect(listMessages(task.id).some((m) => m.role === "system")).toBe(false);
  });

  it("never parks the task on the user mid-turn — the decision is already made", async () => {
    // The distinction that matters against an ordinary `permission`: this card
    // has no buttons, so flagging "Needs your input" while the turn is still
    // running would wedge the row on something nobody can ever answer. Checked
    // with the turn held open, since a completed turn flags the task anyway.
    const { project, task } = fixture();
    let release!: (evs: StreamEvent[]) => void;
    const gate = new Promise<StreamEvent[]>((r) => (release = r));
    scriptParked([{ type: "session", sessionId: "s1" }, TOOL, DENIED], gate, [{ type: "done", sessionId: "s1" }]);

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await vi.waitFor(() => expect(toolRows(task.id)[0]?.permission?.outcome).toBeTruthy());

    expect(getTask(task.id)!.awaiting_input).toBe(0);
    release([]);
    await done;
    expect(events.some((e) => e.type === "permission")).toBe(false);
  });

  it("gives three refusals in one turn three cards, each on its own call", async () => {
    const { project, task } = fixture();
    scriptParked(
      [
        { type: "session", sessionId: "s1" },
        ...["a", "b", "c"].flatMap((k): StreamEvent[] => [
          { type: "tool", id: `tu_${k}`, title: `❯ cmd ${k}`, detail: `cmd ${k}` },
          { type: "permission_denied", id: `tu_${k}`, tool: "Bash", reasonType: "classifier" },
        ]),
        { type: "done", sessionId: "s1" },
      ],
      Promise.resolve([])
    );

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    const rows = toolRows(task.id);
    expect(rows.map((r) => r.permission?.request.detail)).toEqual(["cmd a", "cmd b", "cmd c"]);
    expect(rows.every((r) => r.permission?.outcome?.reason === "blocked")).toBe(true);
  });

  it("still shows a refusal from inside a subagent, whose tool call never reached us", async () => {
    const { project, task } = fixture();
    scriptParked(
      [
        { type: "session", sessionId: "s1" },
        { type: "permission_denied", id: "tu_sub", tool: "Write", reasonType: "classifier", agentId: "agent_7" },
        { type: "done", sessionId: "s1" },
      ],
      Promise.resolve([])
    );

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    const rows = toolRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Write (in a subagent)");
    // No input to show; saying so beats inventing one.
    expect(rows[0].permission?.request.detail).toBe("");
    expect(rows[0].permission?.outcome?.reason).toBe("blocked");
  });

  it("hides the CLI's is_error tool_result behind the card rather than showing both", async () => {
    // The tool_result still arrives and is still recorded; the card just wins
    // the render, so "rm: Permission to use Bash has been denied" doesn't read
    // as the command having been run and failed.
    const { project, task } = fixture();
    scriptParked(
      [
        { type: "session", sessionId: "s1" },
        TOOL,
        DENIED,
        { type: "tool_result", id: "tu_rm", content: "Permission to use Bash has been denied.", isError: true },
        { type: "done", sessionId: "s1" },
      ],
      Promise.resolve([])
    );

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    await done;

    const row = toolRows(task.id)[0];
    expect(row.isError).toBe(true);
    expect(row.permission?.outcome?.reason).toBe("blocked");
  });
});
