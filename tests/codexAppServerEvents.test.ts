import { describe, it, expect } from "vitest";
import { mapNotification, newAppServerTurnState, toSdkItem, diffLinesOf, unwrapShellCommand } from "@/lib/agents/codex/appServerEvents";
import { flattenConfigOverrides } from "@/lib/agents/codex/appServerClient";

// The app-server → exec-shape adapter (lib/agents/codex/appServerEvents.ts),
// unit-tested where the transport test can't reach: status spellings, the
// turn-id filter, usage accounting, and the config flattener that has to
// match the SDK's byte for byte.

describe("app-server item respelling", () => {
  it("maps command, patch and MCP statuses onto the exec protocol's", () => {
    expect(toSdkItem({ type: "commandExecution", id: "c", command: "ls", status: "declined", aggregatedOutput: "no", exitCode: 1 })).toEqual({
      id: "c",
      type: "command_execution",
      command: "ls",
      aggregated_output: "no",
      exit_code: 1,
      status: "failed",
    });
    expect(toSdkItem({ type: "commandExecution", id: "c", command: "ls", status: "inProgress", aggregatedOutput: null, exitCode: null })).toMatchObject({ status: "in_progress" });
    expect(toSdkItem({ type: "fileChange", id: "f", status: "declined", changes: [{ path: "a", kind: "add", diff: "" }] })).toMatchObject({ type: "file_change", status: "failed", changes: [{ path: "a", kind: "add" }] });
    expect(toSdkItem({ type: "mcpToolCall", id: "m", server: "calandria", tool: "list_tasks", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "ok" }], structuredContent: null } })).toMatchObject({
      type: "mcp_tool_call",
      server: "calandria",
      tool: "list_tasks",
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(toSdkItem({ type: "reasoning", id: "r", summary: ["a", "b"], content: [] })).toEqual({ id: "r", type: "reasoning", text: "a\nb" });
    expect(toSdkItem({ type: "webSearch", id: "w", query: "q" })).toEqual({ id: "w", type: "web_search", query: "q" });
    expect(toSdkItem({ type: "userMessage", id: "u" })).toBeNull();
  });

  it("ignores notifications for another turn, and buffers nothing before the turn is known", () => {
    const st = newAppServerTurnState();
    const item = { type: "agentMessage", id: "a", text: "hi" };
    expect(mapNotification("item/completed", { turnId: "other", item }, st).events).toEqual([]);
    st.turnId = "t1";
    expect(mapNotification("item/completed", { turnId: "other", item }, st).events).toEqual([]);
    expect(mapNotification("item/completed", { turnId: "t1", item }, st).events).toEqual([{ type: "item.completed", item: { id: "a", type: "agent_message", text: "hi" } }]);
  });

  it("maps agent-message and reasoning deltas, and joins reasoning paragraphs", () => {
    const st = newAppServerTurnState();
    st.turnId = "t1";
    // A delta belongs to no ThreadEvent, it rides `delta`. The completed
    // item still carries the persisted text.
    expect(mapNotification("item/agentMessage/delta", { turnId: "t1", itemId: "m", delta: "all " }, st)).toEqual({
      events: [],
      delta: { id: "m", kind: "assistant", text: "all " },
    });
    // An empty delta is nothing to type; a delta for another turn is not ours.
    expect(mapNotification("item/agentMessage/delta", { turnId: "t1", itemId: "m", delta: "" }, st).delta).toBeUndefined();
    expect(mapNotification("item/agentMessage/delta", { turnId: "other", itemId: "m", delta: "x" }, st).delta).toBeUndefined();
    // Reasoning arrives as indexed paragraphs; the completed item joins them
    // with newlines, so the live text has to gain the same break.
    expect(mapNotification("item/reasoning/summaryTextDelta", { turnId: "t1", itemId: "r", summaryIndex: 0, delta: "first" }, st).delta).toEqual({ id: "r", kind: "reasoning", text: "first" });
    expect(mapNotification("item/reasoning/summaryTextDelta", { turnId: "t1", itemId: "r", summaryIndex: 0, delta: " half" }, st).delta).toEqual({ id: "r", kind: "reasoning", text: " half" });
    expect(mapNotification("item/reasoning/summaryTextDelta", { turnId: "t1", itemId: "r", summaryIndex: 1, delta: "second" }, st).delta).toEqual({ id: "r", kind: "reasoning", text: "\nsecond" });
  });

  it("decodes command output deltas, holding back a character split across two chunks", () => {
    const st = newAppServerTurnState();
    st.turnId = "t1";
    const b64 = (buf: Buffer) => buf.toString("base64");
    // Output is not a reply, so it rides `outputDelta` and never `delta`: it
    // grows the tool row's peek rather than a bubble.
    expect(mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "c", chunk: b64(Buffer.from("step 1\n")) }, st)).toEqual({
      events: [],
      outputDelta: { id: "c", text: "step 1\n" },
    });
    // The chunks are base64 over BYTES, so a multi-byte character can straddle
    // two of them. The first half decodes to nothing at all (there is no
    // fragment to publish yet) and the second completes the character, rather
    // than each side becoming its own replacement glyph.
    const first = mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "c", chunk: b64(Buffer.concat([Buffer.from("caf"), Buffer.from([0xc3])])) }, st);
    expect(first.outputDelta).toEqual({ id: "c", text: "caf" });
    const second = mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "c", chunk: b64(Buffer.concat([Buffer.from([0xa9]), Buffer.from("\n")])) }, st);
    expect(second.outputDelta).toEqual({ id: "c", text: "é\n" });
    // A decoder per item: two commands interleaving their output must not
    // splice one's half-character onto the other's next chunk.
    mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "d", chunk: b64(Buffer.from([0xc3])) }, st);
    expect(mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "c", chunk: b64(Buffer.from("ok")) }, st).outputDelta).toEqual({ id: "c", text: "ok" });
    expect(mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "d", chunk: b64(Buffer.from([0xa9])) }, st).outputDelta).toEqual({ id: "d", text: "é" });
    // An empty chunk is nothing to show; another turn's output is not ours.
    expect(mapNotification("item/commandExecution/outputDelta", { turnId: "t1", itemId: "c", chunk: "" }, st).outputDelta).toBeUndefined();
    expect(mapNotification("item/commandExecution/outputDelta", { turnId: "other", itemId: "c", chunk: b64(Buffer.from("x")) }, st).outputDelta).toBeUndefined();
  });

  it("reports usage once, on turn end, from the latest total; context from the last request", () => {
    const st = newAppServerTurnState();
    st.turnId = "t1";
    const u1 = mapNotification("thread/tokenUsage/updated", { turnId: "t1", tokenUsage: { total: { inputTokens: 100, outputTokens: 5 }, last: { inputTokens: 80, cachedInputTokens: 20 } } }, st);
    expect(u1.events).toEqual([]);
    expect(u1.contextTokens).toBe(100);
    mapNotification("thread/tokenUsage/updated", { turnId: "t1", tokenUsage: { total: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 9, reasoningOutputTokens: 2 } } }, st);
    const end = mapNotification("turn/completed", { threadId: "x", turn: { id: "t1", status: "completed" } }, st);
    expect(end.turnEnded).toBe("completed");
    expect(end.events).toEqual([
      { type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 2 } },
    ]);
  });

  it("turns a failed turn into usage plus turn.failed, and skips retried errors", () => {
    const st = newAppServerTurnState();
    st.turnId = "t1";
    expect(mapNotification("error", { turnId: "t1", willRetry: true, error: { message: "429" } }, st).events).toEqual([]);
    expect(mapNotification("error", { turnId: "t1", willRetry: false, error: { message: "boom" } }, st).events).toEqual([{ type: "error", message: "boom" }]);
    const end = mapNotification("turn/completed", { turn: { id: "t1", status: "failed", error: { message: "model failed" } } }, st);
    expect(end.turnEnded).toBe("failed");
    expect(end.events).toEqual([{ type: "turn.failed", error: { message: "model failed" } }]);
  });

  it("surfaces a config warning once per turn and hands every warning to the classifier", () => {
    const st = newAppServerTurnState();
    const a = mapNotification("configWarning", { summary: "approval_policy is disallowed by requirements" }, st);
    expect(a.notice).toContain("disallowed");
    expect(a.warning).toContain("disallowed");
    const b = mapNotification("configWarning", { summary: "approval_policy is disallowed by requirements" }, st);
    expect(b.notice).toBeUndefined();
    expect(b.warning).toContain("disallowed");
    expect(mapNotification("warning", { message: "w" }, st)).toMatchObject({ warning: "w" });
  });

  it("renders the running plan as the exec protocol's todo list", () => {
    const st = newAppServerTurnState();
    st.turnId = "t1";
    const m = mapNotification("turn/plan/updated", { turnId: "t1", plan: [{ step: "a", status: "completed" }, { step: "b", status: "pending" }] }, st);
    expect(m.events).toEqual([{ type: "item.updated", item: { id: "plan:t1", type: "todo_list", items: [{ text: "a", completed: true }, { text: "b", completed: false }] } }]);
  });
});

describe("diff and config helpers", () => {
  it("unwraps the CLI's shell wrapper so rules match the command a human typed", () => {
    // Captured from a live 0.153.0 approval request.
    expect(unwrapShellCommand("/bin/zsh -lc 'cat /etc/hostname'")).toBe("cat /etc/hostname");
    expect(unwrapShellCommand(`bash -c "git commit -m 'x'"`)).toBe("git commit -m 'x'");
    expect(unwrapShellCommand(String.raw`/bin/sh -lc 'echo '\''hi'\'''`)).toBe("echo 'hi'");
    expect(unwrapShellCommand("npm test")).toBe("npm test");
    expect(unwrapShellCommand("zsh -lc ''")).toBe("zsh -lc ''");
  });

  it("keeps hunk lines and drops headers", () => {
    expect(diffLinesOf("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n")).toEqual([
      { sign: " ", text: "@@ -1,2 +1,2 @@" },
      { sign: " ", text: "ctx" },
      { sign: "-", text: "old" },
      { sign: "+", text: "new" },
    ]);
  });

  it("flattens nested config into the SDK's dotted TOML overrides", () => {
    expect(
      flattenConfigOverrides({
        mcp_servers: { calandria: { command: "/usr/bin/node", args: ["x.mjs"], tool_timeout_sec: 86400, env: { A: "1" } } },
        model_provider: "calandria-local",
        sandbox_workspace_write: { writable_roots: ["/a", "/b"], network_access: true },
        empty: {},
      }),
    ).toEqual([
      'mcp_servers.calandria.command="/usr/bin/node"',
      'mcp_servers.calandria.args=["x.mjs"]',
      "mcp_servers.calandria.tool_timeout_sec=86400",
      'mcp_servers.calandria.env.A="1"',
      'model_provider="calandria-local"',
      'sandbox_workspace_write.writable_roots=["/a", "/b"]',
      "sandbox_workspace_write.network_access=true",
      "empty={}",
    ]);
  });
});
