import { describe, it, expect } from "vitest";
import { pendingPromptIds, isPendingPrompt, promptsAreLive } from "@/app/shell/pendingPrompt";
import type { Msg, TaskRow } from "@/app/shell/types";
import type { ToolData } from "@/lib/types";

let seq = 0;
function msg(role: Msg["role"], content: string, gen = 1): Msg {
  return { id: `m${++seq}`, role, content, generation: gen };
}
function tool(data: Partial<ToolData>, gen = 1): Msg {
  return msg("tool", JSON.stringify({ title: "t", ...data }), gen);
}
const ask = (answered = false, gen = 1) =>
  tool({ ask: { id: "a1", questions: [{ question: "which?", options: [] }] as never, ...(answered ? { answers: { which: ["yes"] } as never } : {}) } }, gen);
const perm = (settled = false, gen = 1) =>
  tool({ permission: { request: { id: "p1" } as never, ...(settled ? { outcome: { decision: "allow" } as never } : {}) } }, gen);

const task = (over: Partial<TaskRow> = {}) => ({ status: "in_progress", awaiting_input: 1, ...over }) as TaskRow;

describe("isPendingPrompt", () => {
  it("is true only for an unanswered ask or an undecided permission card", () => {
    expect(isPendingPrompt(ask())).toBe(true);
    expect(isPendingPrompt(perm())).toBe(true);
    expect(isPendingPrompt(ask(true))).toBe(false);
    expect(isPendingPrompt(perm(true))).toBe(false);
  });

  it("ignores ordinary tool rows, prose and unparseable content", () => {
    expect(isPendingPrompt(tool({ title: "Bash", result: "ok" }))).toBe(false);
    expect(isPendingPrompt(msg("assistant", "thinking out loud"))).toBe(false);
    expect(isPendingPrompt(msg("tool", "not json at all"))).toBe(false);
  });
});

describe("pendingPromptIds", () => {
  it("picks the open question out from under everything that streamed in after it", () => {
    // The reported bug: a subagent returns enough output to bury the card.
    const q = ask();
    const messages = [
      msg("user", "go"),
      msg("assistant", "on it"),
      q,
      tool({ title: "Task(explore)", result: "x".repeat(20000) }),
      tool({ title: "Task(explore)", result: "y".repeat(20000) }),
      msg("assistant", "here is what the subagent found"),
    ];
    expect(pendingPromptIds(messages, true)).toEqual([q.id]);
  });

  it("returns every card of a parallel batch, in transcript order", () => {
    const a = perm();
    const b = perm();
    expect(pendingPromptIds([msg("user", "go"), a, tool({ title: "Read" }), b], true)).toEqual([a.id, b.id]);
  });

  it("drops a card once it is answered or settled", () => {
    expect(pendingPromptIds([msg("user", "go"), ask(true), perm(true)], true)).toEqual([]);
  });

  it("ignores a question the user has already typed past", () => {
    // Answering after the turn ended sends the answer as an ordinary message,
    // so a user message below the card means it was answered in prose or
    // abandoned. Either way nothing is owed.
    expect(pendingPromptIds([msg("user", "go"), ask(), msg("user", "never mind, do this instead")], true)).toEqual([]);
  });

  it("ignores a question from before a /clear", () => {
    const old = ask(false, 1);
    const messages = [msg("user", "go", 1), old, msg("session_break", "summary", 1), msg("user", "fresh start", 2)];
    expect(pendingPromptIds(messages, true)).toEqual([]);
    // ...and still finds one asked in the CURRENT generation.
    const now = ask(false, 2);
    expect(pendingPromptIds([...messages, now], true)).toEqual([now.id]);
  });

  it("returns nothing when the caller says no prompt is live", () => {
    // A Stop leaves the row unanswered forever — nothing backfills an ask card
    // — so "no answers" alone must never be enough to dock it.
    expect(pendingPromptIds([msg("user", "go"), ask()], false)).toEqual([]);
  });

  it("is quiet on an empty or queued-only transcript", () => {
    expect(pendingPromptIds([], true)).toEqual([]);
    expect(pendingPromptIds([msg("queued", "later")], true)).toEqual([]);
  });
});

describe("promptsAreLive", () => {
  it("is true while the turn runs, whatever the flag says", () => {
    expect(promptsAreLive(task({ awaiting_input: 0 }), true)).toBe(true);
  });

  it("stays true for a turn that ENDED on a question, since the card still answers", () => {
    expect(promptsAreLive(task({ awaiting_input: 1 }), false)).toBe(true);
  });

  it("is false once the task is terminal or nothing is awaited", () => {
    expect(promptsAreLive(task({ status: "done" }), false)).toBe(false);
    expect(promptsAreLive(task({ status: "cancelled" }), false)).toBe(false);
    expect(promptsAreLive(task({ awaiting_input: 0 }), false)).toBe(false);
  });
});
