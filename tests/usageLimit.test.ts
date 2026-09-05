import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// Same seam as tests/authFailure.test.ts: the Claude driver module is mocked so
// the runner's real error/queue handling runs without the SDK (or a real login)
// anywhere near it. The registry maps "claude" to this module, so
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
import { USAGE_LIMIT_NOTICE, isUsageLimit } from "@/lib/usageLimit";
import { AUTH_EXPIRED_NOTICE, isAuthFailure } from "@/lib/authFailure";
import { isPromptTooLong } from "@/lib/promptLimits";
import { getAgentAuthBroken, clearAgentAuthBroken } from "@/lib/agents/connections";
import type { TaskStreamEvent } from "@/lib/types";

// The raw wire form of a spent Claude subscription: message|reset-epoch. The
// driver appends a human-readable reset time when the SDK reported one; the
// classifier must match either form.
const LIMIT_HIT = "Claude AI usage limit reached|1753898400";

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

describe("usage-limit recovery", () => {
  it("appends the notice and parks the queue instead of draining it into the dead quota", async () => {
    const project = createProject({ name: "P", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T", description: "d" });
    // Two follow-ups the user typed while the turn was live (what POST /messages
    // parks in pending_messages). They must survive the spent quota.
    addPendingMessage(task.id, task.generation, "and then deploy it");
    addPendingMessage(task.id, task.generation, "and write a test");

    // The session opens, then the quota turns out to be spent: the real shape
    // of a mid-run limit hit (it fails at the API, not at spawn).
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-1" };
      throw new Error(LIMIT_HIT);
    });

    const w = watch(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await w.done;

    // The transcript carries the provider's own words AND the durable notice
    // the UI renders as the informational recovery hint (no button, since
    // recovery means waiting for the reset).
    const errMsg = listMessages(task.id).find((m) => m.role === "system" && m.content.includes(USAGE_LIMIT_NOTICE));
    expect(errMsg).toBeTruthy();
    expect(errMsg!.content).toContain("usage limit reached");
    // One ⚠: the runner prefixes it, so the renderer must not add a second.
    expect(errMsg!.content.startsWith("⚠ ")).toBe(true);
    expect(errMsg!.content).not.toContain("⚠ ⚠");

    // A spent quota is NOT a dead login: no instance-wide auth flag, no banner.
    expect(getAgentAuthBroken("claude")).toBeNull();
    expect(w.events.some((e) => e.type === "agent_auth")).toBe(false);
    expect(listMessages(task.id).some((m) => m.content.includes(AUTH_EXPIRED_NOTICE))).toBe(false);

    // The queue is untouched: no dequeue, no second (identically failing) turn.
    expect(listPendingMessages(task.id)).toHaveLength(2);
    expect(w.events.some((e) => e.type === "dequeued")).toBe(false);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    // …and the transcript says so, with the reset-flavored tail (not "reconnect").
    const kept = listMessages(task.id).find((m) => m.content.includes("kept in the queue"));
    expect(kept).toBeTruthy();
    expect(kept!.content).toContain("once the limit resets");

    // The turn still settles: nothing is left spinning.
    expect(getTask(task.id)!.running).toBe(0);
  });

  it("parks the queue on a soft mid-stream usage-limit error too", async () => {
    const project = createProject({ name: "P2", repo_path: "" });
    const task = createTask({ project_id: project.id, title: "T2", description: "d" });
    addPendingMessage(task.id, task.generation, "follow-up");

    // The driver's pump reports the limit as a soft error event (with the reset
    // time it folded in from rate_limit_event), not a throw.
    runTurnMock.mockImplementation(async function* () {
      yield { type: "session", sessionId: "sess-2" };
      yield { type: "error", content: `${LIMIT_HIT} — resets at 7/30/2026, 3:00:00 PM` };
      yield { type: "done", sessionId: "sess-2" };
    });

    const w = watch(task.id, "turn_end");
    startTurn(task, project, "hi", "");
    await w.done;

    expect(listMessages(task.id).some((m) => m.content.includes(USAGE_LIMIT_NOTICE))).toBe(true);
    expect(listPendingMessages(task.id)).toHaveLength(1);
    expect(w.events.some((e) => e.type === "dequeued")).toBe(false);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
  });
});

describe("isUsageLimit — spent-quota detection", () => {
  it("matches the Claude subscription signatures", () => {
    expect(isUsageLimit(LIMIT_HIT)).toBe(true);
    expect(isUsageLimit("5-hour limit reached ∙ resets 3pm")).toBe(true);
    expect(isUsageLimit("Weekly limit reached — resets Thursday")).toBe(true);
    expect(isUsageLimit("You've hit your usage limit. Upgrade to continue.")).toBe(true);
  });

  it("matches the API / Codex rate-limit and quota signatures", () => {
    expect(isUsageLimit('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}')).toBe(true);
    expect(isUsageLimit("rate limit exceeded, retry after 60s")).toBe(true);
    expect(isUsageLimit("You exceeded your current quota, please check your plan and billing details.")).toBe(true);
    expect(isUsageLimit("429 insufficient_quota")).toBe(true);
    expect(isUsageLimit("HTTP 429 Too Many Requests")).toBe(true);
  });

  it("does not fire on unrelated failures (or on the other two recoverable ones)", () => {
    // The other two classifiers own these, checked earlier in the runner, but
    // they must not double-match here either.
    expect(isUsageLimit("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(false);
    expect(isUsageLimit("API Error: 400 prompt is too long: 250000 tokens > 204698 maximum")).toBe(false);
    // Generic failures with limit-adjacent words but no quota meaning.
    expect(isUsageLimit("git: file size exceeds limit of 100MB")).toBe(false);
    expect(isUsageLimit("ENOSPC: no space left on device")).toBe(false);
    expect(isUsageLimit("Run ended: error_during_execution")).toBe(false);
    expect(isUsageLimit("request failed with status 404 not found")).toBe(false);
    expect(isUsageLimit("")).toBe(false);
    expect(isUsageLimit(null)).toBe(false);
    expect(isUsageLimit(undefined)).toBe(false);
  });

  it("stays disjoint from the classifiers checked before it", () => {
    // The runner checks isPromptTooLong → isAuthFailure → isUsageLimit; a
    // usage-limit message claimed by an earlier classifier would render the
    // wrong recovery, so the raw limit string must not match either one.
    expect(isPromptTooLong(LIMIT_HIT)).toBe(false);
    expect(isAuthFailure(LIMIT_HIT)).toBe(false);
  });
});
