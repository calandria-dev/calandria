#!/usr/bin/env node
// A fake `codex` binary for tests/codexAppServer.test.ts: speaks just enough
// of the app-server v2 JSON-RPC protocol (stdio, one JSON object per line) to
// drive the transport in lib/agents/codex/appServerTurn.ts through a turn,
// including the server → client approval request that is the reason the
// transport exists. Shapes follow the bindings `codex app-server generate-ts`
// emits for codex-cli 0.153.0.
//
// Driven by env:
//   FAKE_CODEX_SCENARIO   command | fileChange | ask | interrupt | resumeFails | dies
//   FAKE_CODEX_LOG        JSONL file: every request/notification we received,
//                         plus {"argv": [...]} first, and {"decision": …} once
//                         an approval is answered.
// Anything but `app-server` as the subcommand (e.g. `--version`, `doctor`)
// prints something plausible and exits.

import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;
const record = (obj) => {
  if (log) fs.appendFileSync(log, `${JSON.stringify(obj)}\n`);
};
record({ argv, cwd: process.cwd() });

if (argv[0] !== "app-server") {
  if (argv[0] === "--version") process.stdout.write("codex-cli 0.153.0-fake\n");
  process.exit(0);
}

const scenario = process.env.FAKE_CODEX_SCENARIO || "command";
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => out({ jsonrpc: "2.0", method, params, emittedAtMs: Date.now() });

let nextServerId = 1000;
const pendingServer = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pendingServer.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });

const THREAD = "thread-fake-1";
// `resetsAt` is a Unix timestamp in SECONDS, fixed so the test can assert on it.
const RATE_LIMIT_RESETS = Math.floor(Date.parse("2026-09-02T21:00:00Z") / 1000);
let turnId = null;
let threadId = THREAD;
let interrupted = false;
let stopped = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // A response to one of OUR requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const r = pendingServer.get(msg.id);
    if (r) {
      pendingServer.delete(msg.id);
      record({ response: msg });
      r(msg);
    }
    return;
  }
  record({ method: msg.method, params: msg.params });
  const reply = (result) => out({ id: msg.id, result });
  const fail = (message) => out({ id: msg.id, error: { code: -32600, message } });
  switch (msg.method) {
    case "initialize":
      reply({ userAgent: "fake", codexHome: "/nowhere", platformFamily: "unix", platformOs: "linux" });
      // The real server pushes these before anything is asked of it.
      notify("configWarning", { summary: "fake warning: nothing is wrong", details: null });
      return;
    case "initialized":
      return;
    case "thread/start":
      threadId = THREAD;
      notify("thread/started", { thread: thread(threadId) });
      reply({ thread: thread(threadId), model: "gpt-fake", cwd: msg.params?.cwd, approvalPolicy: msg.params?.approvalPolicy, sandbox: {} });
      return;
    case "thread/resume":
      if (scenario === "resumeFails") {
        fail(`thread ${msg.params?.threadId} not found`);
        return;
      }
      threadId = msg.params?.threadId;
      reply({ thread: thread(threadId), model: "gpt-fake", cwd: msg.params?.cwd });
      return;
    case "turn/start":
      turnId = "turn-fake-1";
      reply({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
      void runTurn();
      return;
    case "turn/interrupt":
      interrupted = true;
      reply({});
      return;
    default:
      fail(`fake does not implement ${msg.method}`);
  }
});

function thread(id) {
  return { id, sessionId: id, preview: "", status: { type: "idle" }, cwd: process.cwd(), turns: [] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn() {
  const base = { threadId, turnId };
  notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null } });

  if (scenario === "dies") {
    await sleep(20);
    process.stderr.write("fake: simulated crash\n");
    process.exit(3);
  }

  if (scenario === "command" || scenario === "resumeFails") {
    const item = { type: "commandExecution", id: "item-cmd", command: "npm test", cwd: process.cwd(), status: "inProgress", aggregatedOutput: null, exitCode: null, commandActions: [], source: "agent" };
    notify("item/started", { ...base, item, startedAtMs: Date.now() });
    const answer = await ask("item/commandExecution/requestApproval", {
      ...base,
      itemId: "item-cmd",
      kind: "command",
      command: "npm test",
      cwd: process.cwd(),
      reason: "the sandbox refused to run it",
      startedAtMs: Date.now(),
      environmentId: null,
    });
    const decision = answer.error ? `error:${answer.error.message}` : JSON.stringify(answer.result?.decision);
    record({ decision });
    const ok = !answer.error && answer.result?.decision !== "decline" && answer.result?.decision !== "cancel";
    notify("item/completed", {
      ...base,
      item: { ...item, status: ok ? "completed" : "declined", aggregatedOutput: `decision=${decision}`, exitCode: ok ? 0 : 1 },
      completedAtMs: Date.now(),
    });
  }

  if (scenario === "fileChange") {
    const item = {
      type: "fileChange",
      id: "item-patch",
      status: "inProgress",
      changes: [{ path: "src/a.ts", kind: "update", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" }],
    };
    notify("item/started", { ...base, item, startedAtMs: Date.now() });
    const answer = await ask("item/fileChange/requestApproval", { ...base, itemId: "item-patch", reason: null, grantRoot: "/outside", startedAtMs: Date.now() });
    record({ decision: JSON.stringify(answer.result?.decision ?? answer.error) });
    const ok = answer.result?.decision === "accept" || answer.result?.decision === "acceptForSession";
    notify("item/completed", { ...base, item: { ...item, status: ok ? "completed" : "declined" }, completedAtMs: Date.now() });
  }

  if (scenario === "ask") {
    const answer = await ask("item/tool/requestUserInput", {
      ...base,
      itemId: "item-q",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{ id: "q1", header: "Colour", question: "Which colour?", isOther: true, isSecret: false, options: [{ label: "red", description: "" }, { label: "blue", description: "" }] }],
    });
    record({ decision: JSON.stringify(answer.result ?? answer.error) });
  }

  if (scenario === "interrupt") {
    notify("item/started", { ...base, item: { type: "commandExecution", id: "item-slow", command: "sleep 100", status: "inProgress", commandActions: [], source: "agent" }, startedAtMs: Date.now() });
    while (!interrupted && !stopped) await sleep(10);
    notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "interrupted", error: null } });
    return;
  }

  // Reasoning streams as indexed summary paragraphs before the reply does.
  notify("item/started", { ...base, item: { type: "reasoning", id: "item-r", summary: [], content: [] }, startedAtMs: Date.now() });
  notify("item/reasoning/summaryTextDelta", { ...base, itemId: "item-r", summaryIndex: 0, delta: "weighing " });
  notify("item/reasoning/summaryTextDelta", { ...base, itemId: "item-r", summaryIndex: 0, delta: "options" });
  notify("item/completed", { ...base, item: { type: "reasoning", id: "item-r", summary: ["weighing options"], content: [] }, completedAtMs: Date.now() });
  notify("item/started", { ...base, item: { type: "agentMessage", id: "item-msg", text: "", phase: null }, startedAtMs: Date.now() });
  notify("item/agentMessage/delta", { ...base, itemId: "item-msg", delta: "all " });
  notify("item/agentMessage/delta", { ...base, itemId: "item-msg", delta: "done" });
  notify("item/completed", { ...base, item: { type: "agentMessage", id: "item-msg", text: "all done", phase: null }, completedAtMs: Date.now() });
  notify("turn/plan/updated", { ...base, explanation: null, plan: [{ step: "run tests", status: "completed" }, { step: "report", status: "inProgress" }] });
  // The server pushes the account's limits mid-turn; the same RateLimitSnapshot
  // `account/rateLimits/read` answers with, which is what lets the plan-usage
  // meter coast without spawning its own app-server.
  notify("account/rateLimits/updated", {
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: RATE_LIMIT_RESETS },
      secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: RATE_LIMIT_RESETS + 86400 },
      rateLimitReachedType: null,
      spendControlReached: false,
    },
  });
  notify("thread/tokenUsage/updated", {
    ...base,
    tokenUsage: {
      total: { totalTokens: 1260, inputTokens: 1000, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 },
      last: { totalTokens: 860, inputTokens: 800, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 },
      modelContextWindow: 272000,
    },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "completed", error: null } });
}

process.on("SIGTERM", () => {
  stopped = true;
  process.exit(0);
});
