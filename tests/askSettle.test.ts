import { describe, it, expect, beforeEach, vi } from "vitest";

// A question card is settled on every non-answer path, the same as a
// permission card (tests/permissionGate.test.ts): a turn dying under a live
// ask, the driver's own dismissal, and a process restart with one parked.
// Every case settles the row with a DISMISSAL, never a fabricated answer, so
// the transcript never claims the user picked something they never picked.
const { runTurnMock } = vi.hoisted(() => ({ runTurnMock: vi.fn() }));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown) =>
      runTurnMock(task, project, userText, ac),
  },
}));

import { createProject, createTask, getTask, listMessages, addMessage } from "@/lib/store";
import { startTurn } from "@/lib/runner";
import { abortTurn } from "@/lib/abort";
import { subscribe } from "@/lib/events";
import { settleOpenCards, getDb } from "@/lib/db";
import { ASK_INTERRUPTED_NOTE, ASK_RESTARTED_NOTE } from "@/lib/asks";
import type { AskQuestion, StreamEvent, TaskStreamEvent, ToolData, PermissionRequest } from "@/lib/types";

const QUESTIONS: AskQuestion[] = [
  { question: "Which approach?", header: "Approach", options: [{ label: "Option A" }, { label: "Option B" }] },
];

const REQUEST: PermissionRequest = {
  id: "perm:tu_1",
  tool: "Bash",
  title: "❯ npm test",
  detail: "npm test",
  scope: { scope: "project", match_kind: "bash_prefix", value: "npm test", label: "Always allow `npm test …` here" },
  expiresAt: 0,
};

function fixture() {
  const project = createProject({ name: "AskSettleProj", repo_path: "" });
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

describe("ask cards through the runner", () => {
  it("settles a question the turn died on, so it never renders live options forever", async () => {
    const { project, task } = fixture();
    // Parks and never decides; the Stop below tears the turn down under it,
    // the same as the permission card's equivalent case. The driver's event
    // queue closes with the SDK stream, so nothing settles the card unless
    // the runner's finally backstop does.
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "ask", id: "ask_1", questions: QUESTIONS } as StreamEvent;
      await new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
    });

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await vi.waitFor(() => expect(toolRows(task.id).some((d) => d.ask)).toBe(true));

    abortTurn(task.id);
    await done;

    const row = toolRows(task.id).find((d) => d.ask)!;
    expect(row.ask?.dismissed).toMatchObject({ reason: "interrupted" });
    expect(row.ask?.answers).toBeUndefined();
    expect(row.ask?.questions).toEqual(QUESTIONS);
    const dismissed = events.filter((e) => e.type === "ask_dismissed");
    expect(dismissed.length).toBe(1);
  });

  it("records the driver's own dismissal instead of leaving the card blank", async () => {
    const { project, task } = fixture();
    // Checked mid-turn, right after the dismissal lands: awaiting_input drops
    // to 0 the moment nothing is left parked (lib/runner.ts's ask_dismissed
    // branch), the same as ask_answered's. It is not re-checked after `done`,
    // because turn-end unconditionally re-flags an opened, non-scheduled
    // turn's awaiting_input to 1 (the generic "your turn to reply" signal),
    // unrelated to whether a question was ever asked.
    let release!: (evs: StreamEvent[]) => void;
    const gate = new Promise<StreamEvent[]>((r) => (release = r));
    scriptParked(
      [
        { type: "session", sessionId: "s1" },
        { type: "ask", id: "ask_1", questions: QUESTIONS },
        { type: "ask_dismissed", id: "ask_1", dismissal: { reason: "interrupted", note: ASK_INTERRUPTED_NOTE } },
      ],
      gate,
      [{ type: "done", sessionId: "s1" }]
    );

    const { done } = collect(task.id);
    startTurn(task, project, "go", "");
    // awaiting_input starts at 0 too (never yet flagged). Waiting on the
    // dismissed row itself avoids a check that passes before the ask, or its
    // dismissal, was ever written.
    await vi.waitFor(() => expect(toolRows(task.id).find((d) => d.ask)?.ask?.dismissed).toBeTruthy());

    const row = toolRows(task.id).find((d) => d.ask)!;
    expect(row.ask?.dismissed).toEqual({ reason: "interrupted", note: ASK_INTERRUPTED_NOTE });
    expect(row.ask?.answers).toBeUndefined();
    expect(getTask(task.id)?.awaiting_input).toBe(0);

    release([]);
    await done;
  });

  it("leaves an answered question alone when the turn is later torn down", async () => {
    const { project, task } = fixture();
    // Answered, then the connection dies under it anyway (a Stop racing an
    // answer that already landed). The finally backstop's guard, dismissed
    // only when `!t.data.ask.answers`, must not overwrite a real answer.
    runTurnMock.mockImplementation(async function* (_t: unknown, _p: unknown, _u: string, ac?: AbortController) {
      yield { type: "session", sessionId: "s1" } as StreamEvent;
      yield { type: "ask", id: "ask_1", questions: QUESTIONS } as StreamEvent;
      yield { type: "ask_answered", id: "ask_1", answers: [["Option A"]] } as StreamEvent;
      await new Promise<void>((r) => ac?.signal.addEventListener("abort", () => r(), { once: true }));
    });

    const { events, done } = collect(task.id);
    startTurn(task, project, "go", "");
    await vi.waitFor(() => expect(toolRows(task.id).find((d) => d.ask)?.ask?.answers).toEqual([["Option A"]]));

    abortTurn(task.id);
    await done;

    const row = toolRows(task.id).find((d) => d.ask)!;
    expect(row.ask?.answers).toEqual([["Option A"]]);
    expect(row.ask?.dismissed).toBeUndefined();
    expect(events.some((e) => e.type === "ask_dismissed")).toBe(false);
  });
});

// The crash-recovery pass: nothing in memory (the waiter registry, the
// runner's turn state) survives a restart, so an ask a live turn left parked
// is settled from the DB, the same policy as the permission card's.
describe("settleOpenCards", () => {
  it("dismisses an unanswered ask, leaves an answered one alone, and settles a permission card too — idempotently", async () => {
    const project = createProject({ name: "RestartProj", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "Restart task", description: "" });

    const unanswered: ToolData = { title: "Question for you", ask: { id: "a1", questions: QUESTIONS } };
    const answered: ToolData = { title: "Question for you", ask: { id: "a2", questions: QUESTIONS, answers: [["Option A"]] } };
    const permission: ToolData = { title: "Permission needed", permission: { request: REQUEST } };

    const unansweredRow = addMessage(task.id, task.generation, "tool", JSON.stringify(unanswered));
    const answeredRow = addMessage(task.id, task.generation, "tool", JSON.stringify(answered));
    const permissionRow = addMessage(task.id, task.generation, "tool", JSON.stringify(permission));

    const result = settleOpenCards(getDb());
    expect(result).toEqual({ permissions: 1, asks: 1 });

    const rows = listMessages(task.id);
    const unansweredAfter = JSON.parse(rows.find((m) => m.id === unansweredRow.id)!.content) as ToolData;
    expect(unansweredAfter.ask?.dismissed).toEqual({ reason: "restarted", note: ASK_RESTARTED_NOTE });
    expect(unansweredAfter.ask?.answers).toBeUndefined();

    const answeredAfter = JSON.parse(rows.find((m) => m.id === answeredRow.id)!.content) as ToolData;
    expect(answeredAfter.ask?.dismissed).toBeUndefined();
    expect(answeredAfter.ask?.answers).toEqual([["Option A"]]);

    const permissionAfter = JSON.parse(rows.find((m) => m.id === permissionRow.id)!.content) as ToolData;
    expect(permissionAfter.permission?.outcome).toBeTruthy();

    // A second pass over the same rows finds nothing left open.
    expect(settleOpenCards(getDb())).toEqual({ permissions: 0, asks: 0 });
  });
});
