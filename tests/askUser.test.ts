import { describe, expect, it, vi } from "vitest";

// The ask_user bridge flow (lib/agentTools.startAskUser): persists + publishes
// the same interactive ask card the Claude driver's hook produces, parks a
// detached waiter on lib/asks.ts, and settles a poll-able outcome the stdio MCP
// bridge's wait endpoint hands back to the agent.

import { createProject, createTask, getTask, listMessages } from "../lib/store";
import { startAskUser } from "../lib/agentTools";
import { submitAnswer, takeAskOutcome, ASK_INTERRUPTED_NOTE } from "../lib/asks";
import { registerTurn, abortTurn, unregisterTurn } from "../lib/abort";
import { subscribe } from "../lib/events";
import type { ToolData, TaskStreamEvent, AskQuestion } from "../lib/types";

const QUESTIONS: AskQuestion[] = [
  { question: "Which approach?", header: "Approach", options: [{ label: "Option A" }, { label: "Option B" }] },
];

function makeTask() {
  const project = createProject({ name: "AskProj" });
  const task = createTask({ project_id: project.id, title: "Ask task", description: "" });
  return task;
}

describe("startAskUser", () => {
  it("publishes the ask card, resolves on answer, settles a take-once outcome", async () => {
    const task = makeTask();
    const controller = new AbortController();
    registerTurn(task.id, controller);
    const events: TaskStreamEvent[] = [];
    const unsub = subscribe(task.id, (ev) => events.push(ev));

    try {
      const { askId } = startAskUser(getTask(task.id)!, QUESTIONS);

      // The card is persisted (reload-safe) and the task flagged as waiting.
      const row = listMessages(task.id).find((m) => m.role === "tool")!;
      const data = JSON.parse(row.content) as ToolData;
      expect(data.ask?.id).toBe(askId);
      expect(data.ask?.questions).toEqual(QUESTIONS);
      expect(getTask(task.id)?.awaiting_input).toBe(1);
      expect(events.some((e) => e.type === "ask")).toBe(true);

      // Answering through the same path the /answer route uses resolves it.
      expect(submitAnswer(task.id, askId, [["Option A"]])).toBe(true);
      // waitForAnswer's resolution handler writes the message, flips
      // awaiting_input, and publishes ask_answered all in one synchronous
      // continuation, so awaiting_input hitting 0 proves the whole thing ran.
      await vi.waitFor(() => expect(getTask(task.id)?.awaiting_input).toBe(0));

      const answered = JSON.parse(listMessages(task.id).find((m) => m.id === row.id)!.content) as ToolData;
      expect(answered.ask?.answers).toEqual([["Option A"]]);
      expect(getTask(task.id)?.awaiting_input).toBe(0);
      expect(events.some((e) => e.type === "ask_answered")).toBe(true);

      // The bridge polls the outcome; it reads exactly once.
      const outcome = takeAskOutcome(task.id, askId);
      expect(outcome).toContain("Option A");
      expect(takeAskOutcome(task.id, askId)).toBeNull();
    } finally {
      unsub();
      unregisterTurn(task.id, controller);
    }
  });

  it("settles a dismissal when the turn is stopped before an answer", async () => {
    const task = makeTask();
    const controller = new AbortController();
    registerTurn(task.id, controller);
    const events: TaskStreamEvent[] = [];
    const unsub = subscribe(task.id, (ev) => events.push(ev));

    try {
      const { askId } = startAskUser(getTask(task.id)!, QUESTIONS);
      abortTurn(task.id);

      // takeAskOutcome is take-once, so poll it directly rather than sleeping
      // then reading separately — the successful poll IS the one real read.
      await vi.waitFor(() => expect(takeAskOutcome(task.id, askId)).toMatch(/dismissed/));
      // The parked waiter is gone — answering now reports nothing waiting, the
      // /answer route's resume-as-normal-reply fallback.
      expect(submitAnswer(task.id, askId, [["Option A"]])).toBe(false);

      // The dismissal isn't just the bridge's poll-once outcome text — it's
      // recorded on the persisted transcript row too, the same way a Stopped
      // permission card is, so a reload doesn't show live option buttons for a
      // question nobody can ever answer.
      const row = JSON.parse(listMessages(task.id).find((m) => m.role === "tool")!.content) as ToolData;
      expect(row.ask?.dismissed).toEqual({ reason: "interrupted", note: ASK_INTERRUPTED_NOTE });
      expect(row.ask?.answers).toBeUndefined();
      expect(getTask(task.id)?.awaiting_input).toBe(0);
      expect(events.some((e) => e.type === "ask_dismissed")).toBe(true);
    } finally {
      unsub();
      unregisterTurn(task.id, controller);
    }
  });
});
