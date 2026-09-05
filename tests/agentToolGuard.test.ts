/* Pins guardToolHandler (lib/agentToolGuard.mjs): nothing reaches the model
 * as a "fine" result unless the call actually answered. An empty or missing
 * result cannot be told apart from a real success, so the guard rewrites it
 * into a loud failure.
 *
 * This covers the pure module, which both ends of the seam share. That it
 * survives a real MCP round trip is pinned separately, in
 * tests/calandriaMcp.test.ts.
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
  toolCutoffNotice,
} from "@/lib/agentToolGuard.mjs";

/** The shape every guarded answer has to have, whatever went wrong. */
function expectLoudFailure(res: unknown, tool: string) {
  const r = res as { isError?: boolean; content?: { type: string; text: string }[] };
  expect(r.isError).toBe(true);
  expect(r.content?.length).toBeGreaterThan(0);
  const text = r.content![0].text;
  // Non-empty, names the tool, and is prose instead of a bare token: the model
  // relays it to the user without needing to know this module exists.
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
    // Signature-transparent by contract: it wraps handlers regardless of
    // their argument shape.
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
    // The instruction matters as much as the message: the risk is a session
    // reporting work it never did.
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
    // constructed with "", either of which would collapse the message to
    // nothing.
    for (const thrown of ["just a string", { code: 500 }, new Error(""), new Error("   "), null, undefined]) {
      const guarded = guardToolHandler("list_tasks", async () => {
        throw thrown;
      });
      expectLoudFailure(await guarded({}, {}), "list_tasks");
    }
  });

  it("rewrites an empty result as a failure — the bug this module is named for", async () => {
    // Every shape an empty result can take. None of them may reach the model
    // looking like a success.
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
    // The bound is why this needs more than a try/catch: the CLI's own
    // per-call MCP timeout defaults to ~27.7 hours, and the SDK host awaits an
    // in-process handler indefinitely, so nothing below would end this wait.
    const guarded = guardToolHandler("create_pr", () => new Promise(() => {}), { timeoutMs: 20 });
    const text = expectLoudFailure(await guarded({}, {}), "create_pr");
    expect(text).toMatch(/did not answer within/i);
    // The work may still be in flight: a push that lands after the timeout is
    // real. "Nothing was done" here would be false, so the message says verify.
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

/* The failure above the seam: the CLI answers a Calandria tool call itself
 * and no handler ever runs, so nothing the guard wraps can see it. The
 * Claude driver's stream pump classifies the CLI's sentence with these
 * helpers. */
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
    // The abort can land after the request went out, so the message avoids
    // claiming nothing happened and instead instructs to verify.
    expect(msg).toMatch(/may or may not/);
    expect(msg).not.toMatch(/nothing was done/);
  });

  it("tells the user what is measured to help, and names the tool", () => {
    const msg = toolCutoffNotice("mcp__calandria__suggest_task");
    expect(msg).toContain("mcp__calandria__suggest_task");
    // The recovery a person can actually perform: a fresh session.
    expect(msg).toContain("/clear");
    // And the user-facing line must not be mistaken for the CLI's own.
    expect(isCliInterruptedToolResult(msg)).toBe(false);
  });
});

/* The observation hooks: where the server-side record of a call is written
 * (lib/agentToolLog.ts). They observe, and can never become a fourth way for
 * a call to fail. */
describe("guardToolHandler's onStart / onSettle hooks", () => {
  it("reports arrival, then each of the four outcomes with a duration", async () => {
    const seen: { outcome: string; ms: number }[] = [];
    let started = 0;
    const opts = (timeoutMs?: number) => ({
      timeoutMs,
      onStart: () => {
        started++;
      },
      onSettle: (outcome: string, ms: number) => {
        seen.push({ outcome, ms });
      },
    });
    await guardToolHandler("t", async () => ok("fine"), opts())({});
    await guardToolHandler("t", async () => {
      throw new Error("boom");
    }, opts())({});
    await guardToolHandler("t", async () => ({ content: [] }), opts())({});
    await guardToolHandler("t", () => new Promise(() => {}), opts(20))({});
    expect(started).toBe(4);
    expect(seen.map((s) => s.outcome)).toEqual(["ok", "error", "blank", "timeout"]);
    for (const s of seen) expect(s.ms).toBeGreaterThanOrEqual(0);
    // The timeout branch reports how long it waited, not zero. One millisecond
    // of slack: a Node timer fires on the event loop's millisecond clock while
    // the guard measures with Date.now(), so the two can disagree by a tick
    // (issue #209).
    expect(seen[3].ms).toBeGreaterThanOrEqual(19);
  });

  it("never lets a throwing observer change the answer", async () => {
    const guarded = guardToolHandler("t", async () => ok("fine"), {
      onStart: () => {
        throw new Error("observer down");
      },
      onSettle: () => {
        throw new Error("observer down");
      },
    });
    expect(await guarded({})).toEqual(ok("fine"));
  });

  it("is optional: a handler guarded without hooks is guarded as before", async () => {
    expect(await guardToolHandler("t", async () => ok("fine"))({})).toEqual(ok("fine"));
    expectLoudFailure(await guardToolHandler("t", async () => ({ content: [] }))({}), "t");
  });
});
