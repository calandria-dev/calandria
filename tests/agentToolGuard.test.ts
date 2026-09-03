/* The guard that makes an agent tool's failure LOUD (lib/agentToolGuard.mjs).
 *
 * The bug it exists for: mid-turn, every Calandria tool call started returning
 * no content and no error, and the sessions could not tell that apart from a
 * quiet success — they reported a withdrawal, a runbook and a pull request that
 * were never written. So the property under test is one sentence: NOTHING gets
 * back to the model that reads as "fine" unless the call actually answered.
 *
 * Everything here is the pure module, which both ends of the seam share. That it
 * survives a real MCP round trip is pinned separately, in tests/calandriaMcp.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  guardToolHandler,
  isBlankToolResult,
  toolErrorResult,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  CLI_INTERRUPTED_TOOL_RESULT,
  isCliInterruptedToolResult,
  isCalandriaToolName,
  toolInterruptedMessage,
} from "@/lib/agentToolGuard.mjs";

/** The shape every guarded answer has to have, whatever went wrong. */
function expectLoudFailure(res: unknown, tool: string) {
  const r = res as { isError?: boolean; content?: { type: string; text: string }[] };
  expect(r.isError).toBe(true);
  expect(r.content?.length).toBeGreaterThan(0);
  const text = r.content![0].text;
  // Non-empty, names the tool, and is prose rather than a bare token — the model
  // has to be able to relay it to the user without knowing this module exists.
  expect(text.trim().length).toBeGreaterThan(20);
  expect(text).toContain(tool);
  return text;
}

const ok = (text: string) => ({ content: [{ type: "text", text }] });

describe("guardToolHandler", () => {
  it("passes a healthy result through untouched, isError included", async () => {
    // The guard must not reshape the answers that already work: a refusal is a
    // legitimate answer, and it arrives as isError with text, exactly like a
    // guarded failure would. Rewriting it would lose the refusal's reason.
    const refusal = { content: [{ type: "text", text: "Refused: that runbook is fired by a schedule." }], isError: true };
    const guarded = guardToolHandler("update_runbook", async () => refusal);
    expect(await guarded({}, {})).toBe(refusal);

    const happy = ok('{"tasks":[]}');
    expect(await guardToolHandler("list_tasks", async () => happy)({}, {})).toBe(happy);
  });

  it("forwards every argument the MCP server passes", async () => {
    // Signature-transparent by contract: it is dropped over handlers whose
    // arguments it knows nothing about.
    const seen: unknown[] = [];
    const guarded = guardToolHandler("get_task", async (...args: unknown[]) => {
      seen.push(...args);
      return ok("detail");
    });
    await guarded({ task: "t-1" }, { signal: "extra" });
    expect(seen).toEqual([{ task: "t-1" }, { signal: "extra" }]);
  });

  it("turns a rejected handler into an error naming the tool and the cause", async () => {
    const guarded = guardToolHandler("create_pr", async () => {
      throw new Error("gh exited 1: No commits between main and calandria/x");
    });
    const text = expectLoudFailure(await guarded({}, {}), "create_pr");
    expect(text).toContain("No commits between main");
    // The instruction matters as much as the message: the failure mode being
    // fixed is a session REPORTING work it never did.
    expect(text).toMatch(/do not report this as done/i);
  });

  it("catches a handler that throws synchronously, before returning a promise", async () => {
    const guarded = guardToolHandler("suggest_task", () => {
      throw new TypeError("Cannot read properties of undefined");
    });
    expect(expectLoudFailure(await guarded({}, {}), "suggest_task")).toContain("Cannot read properties");
  });

  it("stays loud when what was thrown is not an Error, or carries no message", async () => {
    // `String(e)` on a bare object is "[object Object]" and an Error can be
    // constructed with "" — either would collapse the message to nothing, which
    // is the exact failure this file is about.
    for (const thrown of ["just a string", { code: 500 }, new Error(""), new Error("   "), null, undefined]) {
      const guarded = guardToolHandler("list_tasks", async () => {
        throw thrown;
      });
      expectLoudFailure(await guarded({}, {}), "list_tasks");
    }
  });

  it("rewrites an empty result as a failure — the bug this module is named for", async () => {
    // Every shape the wild occurrences could have produced. None of them may
    // reach the model looking like a success.
    const empties: unknown[] = [
      undefined,
      null,
      "",
      {},
      { content: [] },
      { content: null },
      { content: [{ type: "text", text: "" }] },
      { content: [{ type: "text", text: "   \n  " }] },
      { content: [{ type: "text" }] },
      { content: [{ type: "text", text: "" }, { type: "text", text: "  " }] },
      // An empty ERROR is still empty: create_pr's own handler sets isError when
      // it has no URL, so a blank text there would be a flag with nothing on it.
      { content: [{ type: "text", text: "" }], isError: true },
    ];
    for (const value of empties) {
      const guarded = guardToolHandler("withdraw_suggestion", async () => value);
      const text = expectLoudFailure(await guarded({}, {}), "withdraw_suggestion");
      expect(text).toMatch(/empty result/i);
      expect(text).toMatch(/nothing was done/i);
    }
  });

  it("does not mistake a non-text answer for an empty one", async () => {
    // structuredContent alone, and a real content part sitting beside blank
    // text, are both legitimate answers. Rewriting them would discard data.
    const structured = { content: [], structuredContent: { tasks: [] } };
    expect(await guardToolHandler("list_tasks", async () => structured)({}, {})).toBe(structured);

    const withImage = { content: [{ type: "text", text: "" }, { type: "image", data: "…", mimeType: "image/png" }] };
    expect(await guardToolHandler("get_task", async () => withImage)({}, {})).toBe(withImage);
  });

  it("abandons a handler that never answers, and says so without claiming nothing happened", async () => {
    // The bound is the whole reason this is not just a try/catch: the CLI's own
    // per-call MCP timeout defaults to ~27.7 hours and the SDK host awaits an
    // in-process handler forever, so nothing below would ever end this wait.
    const guarded = guardToolHandler("create_pr", () => new Promise(() => {}), { timeoutMs: 20 });
    const text = expectLoudFailure(await guarded({}, {}), "create_pr");
    expect(text).toMatch(/did not answer within/i);
    // The work may still be in flight — a push that lands after we gave up is
    // real. "Nothing was done" here would be a lie, so it must say verify.
    expect(text).toMatch(/verify/i);
    expect(text).not.toMatch(/nothing was done/i);
  });

  it("lets a slow-but-finishing call through", async () => {
    const answer = ok("done");
    const guarded = guardToolHandler("create_pr", async () => {
      await new Promise((r) => setTimeout(r, 25));
      return answer;
    }, { timeoutMs: 2_000 });
    expect(await guarded({}, {})).toBe(answer);
  });

  it("treats timeoutMs 0 as unbounded, which is what ask_user needs", async () => {
    // That tool is parked on a HUMAN and its own 24h poll is the deadline that
    // belongs there; a ten-minute bound would kill every interactive ask.
    const answer = ok("the user said yes");
    const guarded = guardToolHandler("ask_user", async () => {
      await new Promise((r) => setTimeout(r, 30));
      return answer;
    }, { timeoutMs: 0 });
    expect(await guarded({}, {})).toBe(answer);
  });

  it("falls back to the shared default when given no bound, or a nonsense one", async () => {
    // The bridge reads the knob out of the environment, where it can be absent
    // or garbage; it must not end up unbounded by accident.
    expect(DEFAULT_AGENT_TOOL_TIMEOUT_MS).toBeGreaterThan(0);
    for (const opts of [undefined, {}, { timeoutMs: -1 }, { timeoutMs: "soon" }]) {
      const answer = ok("fine");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const guarded = guardToolHandler("list_tasks", async () => answer, opts as any);
      expect(await guarded({}, {})).toBe(answer);
    }
  });
});

describe("isBlankToolResult", () => {
  it("is the single predicate both ends of the seam agree on", () => {
    expect(isBlankToolResult(undefined)).toBe(true);
    expect(isBlankToolResult({ content: [] })).toBe(true);
    expect(isBlankToolResult({ content: [{ type: "text", text: " " }] })).toBe(true);
    expect(isBlankToolResult({ content: [{ type: "text", text: "x" }] })).toBe(false);
    expect(isBlankToolResult(toolErrorResult("something went wrong"))).toBe(false);
  });
});

/* The failure ABOVE the seam: the CLI answers a Calandria tool call itself and
 * no handler ever runs, so nothing the guard wraps can see it. Measured
 * 2026-09-02 on task CrDHcuyuDt1PmLu0PDd1K; the Claude driver's stream pump
 * classifies the CLI's sentence with these helpers. */
describe("the CLI's own interrupted tool result", () => {
  const CLI_TEXT =
    "The tool call was interrupted before a result was received. It may or may not have " +
    "completed on the server \u2014 verify before assuming it succeeded, and retry if needed.";

  it("recognizes the CLI's sentence and nothing else", () => {
    expect(isCliInterruptedToolResult(CLI_TEXT)).toBe(true);
    expect(CLI_TEXT.includes(CLI_INTERRUPTED_TOOL_RESULT)).toBe(true);
    expect(isCliInterruptedToolResult(undefined)).toBe(false);
    expect(isCliInterruptedToolResult("")).toBe(false);
    // The guard's own wordings must never be mistaken for the CLI's, or a real
    // handler failure would be relabelled as one that never ran.
    expect(isCliInterruptedToolResult(toolInterruptedMessage("create_pr"))).toBe(false);
  });

  it("only claims a call for Calandria when the name says so", () => {
    expect(isCalandriaToolName("mcp__calandria__create_pr")).toBe(true);
    expect(isCalandriaToolName("calandria__suggest_task")).toBe(true);
    expect(isCalandriaToolName("Bash")).toBe(false);
    expect(isCalandriaToolName("mcp__context7__query-docs")).toBe(false);
    expect(isCalandriaToolName(undefined)).toBe(false);
  });

  it("names the tool and refuses to promise the call did nothing", () => {
    const msg = toolInterruptedMessage("mcp__calandria__create_pr");
    expect(msg).toContain("mcp__calandria__create_pr");
    // The abort can land after the request went out, so "nothing happened" is
    // not ours to say — the instruction is to go and look.
    expect(msg).toMatch(/may or may not/);
    expect(msg).not.toMatch(/nothing was done/);
  });
});
