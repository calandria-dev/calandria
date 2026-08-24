import { describe, it, expect, beforeEach, vi } from "vitest";

// What a turn that DECLARED itself unattended does when something asks for a
// human. lib/runContext.ts promises `interactionPolicy: "deny"` settles "any
// permission/ask request at once"; lib/permissions.ts honored the permission
// half from the start, and this file covers the half that was missing.
//
// An ask is the more dangerous of the two, for a reason that isn't obvious:
// canUseTool is short-circuited under bypassPermissions (which is what a
// schedule uses by default and what the docs recommend), but the driver's
// AskUserQuestion hook fires in EVERY mode. So the one interactive path an
// bypassPermissions schedule cannot dodge was also the one with no deadline — it parked
// on lib/asks.ts forever, holding the turn slot, the CLI child and the
// schedule's overlap lock, which turns every future occurrence of that schedule
// into `skipped_overlap`. The schedule goes quiet, permanently, and the only
// trace is a run stuck at "running".
//
// The real driver runs; only the SDK is swapped (same shape as
// tests/claudePermissionMode.test.ts).
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: (cfg: unknown) => cfg,
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
}));

import { claudeDriver } from "@/lib/agents/claude/driver";
import { startAskUser } from "@/lib/agentTools";
import { submitAnswer, takeAskOutcome } from "@/lib/asks";
import { createProject, createTask, getTask } from "@/lib/store";
import { SCHEDULED_RUN_CONTEXT, clearRunContext, getRunContext, setRunContext } from "@/lib/runContext";
import type { AskQuestion, Project, StreamEvent, Task } from "@/lib/types";

type QueryArgs = { prompt: string; options: Record<string, unknown> };
type HookResult = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
type Hook = (input: unknown, toolUseId?: string) => Promise<HookResult>;

const QUESTIONS: AskQuestion[] = [
  {
    header: "Deploy?",
    question: "Should I deploy the release branch to production now?",
    options: [{ label: "Yes" }, { label: "No" }] as AskQuestion["options"],
  },
];

function fixture(): { project: Project; task: Task } {
  const project = createProject({ name: `Unattended ${Math.random().toString(36).slice(2)}`, repo_path: "" });
  const task = createTask({ project_id: project.id, title: "Scheduled", description: "" });
  return { project, task: getTask(task.id)! };
}

/** Run one turn, invoking the AskUserQuestion hook mid-stream. */
async function askDuringTurn(
  task: Task,
  project: Project,
  answer?: string[][]
): Promise<{ result?: HookResult; events: StreamEvent[] }> {
  let result: HookResult | undefined;
  const events: StreamEvent[] = [];
  queryMock.mockImplementation((args: QueryArgs) => ({
    async *[Symbol.asyncIterator]() {
      const hook = (args.options.hooks as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0].hooks[0];
      const pending = hook({ tool_input: { questions: QUESTIONS } }, "tu_ask");
      // Only meaningful on the attended counter-pin below: the waiter only
      // exists once the hook has actually parked, so the retry IS the sync.
      if (answer) await vi.waitFor(() => expect(submitAnswer(task.id, "tu_ask", answer)).toBe(true));
      result = await pending;
      // The CLI hands the hook's decision back as the tool's result, exactly as
      // it does for an answered ask.
      yield {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tu_ask",
            content: result?.hookSpecificOutput?.permissionDecisionReason ?? "",
          }],
        },
      };
    },
  }));
  for await (const ev of claudeDriver.runTurn(task, project, "go")) events.push(ev);
  return { result, events };
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("an AskUserQuestion inside a scheduled turn", () => {
  it("is declined at once instead of parking the turn forever", async () => {
    const { project, task } = fixture();
    setRunContext(task.id, { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: "run-1" });
    // The bug was unbounded: no deadline, no signal, no watcher heuristic. The
    // fix decides at once, with no timer at all involved — proven here by
    // resolving under fake timers without ever needing to advance the clock,
    // rather than checking a loose real wall-clock bound.
    vi.useFakeTimers();
    try {
      const { result } = await askDuringTurn(task, project);
      expect(vi.getTimerCount()).toBe(0);

      expect(result?.hookSpecificOutput?.permissionDecision).toBe("deny");
      // Written for the MODEL: it has to stop, not re-ask in a loop.
      expect(result?.hookSpecificOutput?.permissionDecisionReason).toMatch(/scheduled run/i);
      expect(result?.hookSpecificOutput?.permissionDecisionReason).toMatch(/do not ask again/i);
    } finally {
      vi.useRealTimers();
      clearRunContext(task.id);
    }
  });

  it("leaves the question on the record, as a card that arrives already settled", async () => {
    const { project, task } = fixture();
    setRunContext(task.id, { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: "run-2" });
    try {
      const { events } = await askDuringTurn(task, project);

      // NOT an ask card: an ask card promises an answer is coming, and this one
      // never was. A decided permission card is what this actually is — a
      // request that was refused, with the question preserved so the user can
      // see what the run wanted.
      expect(events.some((e) => e.type === "ask")).toBe(false);
      const card = events.find((e) => e.type === "permission") as Extract<StreamEvent, { type: "permission" }>;
      expect(card).toBeDefined();
      expect(card.request.tool).toBe("AskUserQuestion");
      expect(card.request.title).toContain("Deploy?");
      expect(card.request.detail).toContain("deploy the release branch");

      const decided = events.find((e) => e.type === "permission_decided") as Extract<StreamEvent, { type: "permission_decided" }>;
      expect(decided.id).toBe(card.request.id);
      // `unattended` is the reason the runner acts on: it parks the pending
      // queue and settles the schedule run as failed rather than green.
      expect(decided.outcome).toMatchObject({ decision: "deny", auto: true, reason: "unattended" });
      expect(decided.outcome.note).toMatch(/nobody is watching/i);
      // The hook's refusal comes back as the tool's result, and it is text
      // written for the model. The card is the user-facing record; the raw
      // instruction must not be a second one beside it.
      expect(events.some((e) => e.type === "tool_result")).toBe(false);
    } finally {
      clearRunContext(task.id);
    }
  });

  it("still parks and waits for a real answer on an ordinary turn", async () => {
    // The counter-pin. Nothing about the ordinary interactive path may change:
    // a question the USER's turn asks has no deadline on purpose.
    const { project, task } = fixture();
    expect(getRunContext(task.id)).toBeUndefined();
    const { result, events } = await askDuringTurn(task, project, [["Yes"]]);

    expect(events.some((e) => e.type === "ask")).toBe(true);
    expect(events.some((e) => e.type === "permission")).toBe(false);
    const answered = events.find((e) => e.type === "ask_answered") as Extract<StreamEvent, { type: "ask_answered" }>;
    expect(answered.answers).toEqual([["Yes"]]);
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
    expect(result?.hookSpecificOutput?.permissionDecisionReason).toContain("Yes");
  });
});

describe("ask_user through the MCP bridge inside a scheduled turn", () => {
  it("settles immediately, on the record, and marks the run as cut short", async () => {
    // The Codex half of the same hazard: the bridge POLLS for an outcome across
    // processes, so an unanswerable ask means it polls until the process dies.
    const { task } = fixture();
    const ctx = { ...SCHEDULED_RUN_CONTEXT, scheduleRunId: "run-3" };
    setRunContext(task.id, ctx);
    try {
      const { askId } = startAskUser(getTask(task.id)!, QUESTIONS);

      // The very next poll returns, with text written for the model.
      const outcome = takeAskOutcome(task.id, askId);
      expect(outcome).toMatch(/scheduled run/i);
      // Nothing is parked, so nothing can be answered later either.
      expect(submitAnswer(task.id, askId, [["Yes"]])).toBe(false);
      // And nothing is asked of the user: no "Needs your input" for a question
      // that was already refused.
      expect(getTask(task.id)!.awaiting_input).toBe(0);
      // Recorded so lib/runner.ts settles the schedule run as failed — this
      // path emits no permission event of its own for the runner to see.
      expect(ctx.deniedInteractions).toBe(1);
    } finally {
      clearRunContext(task.id);
    }
  });

  it("still parks an ordinary turn's ask_user", async () => {
    const { task } = fixture();
    const { askId } = startAskUser(getTask(task.id)!, QUESTIONS);
    expect(getTask(task.id)!.awaiting_input).toBe(1);
    expect(takeAskOutcome(task.id, askId)).toBeNull();
    expect(submitAnswer(task.id, askId, [["Yes"]])).toBe(true);
  });
});
