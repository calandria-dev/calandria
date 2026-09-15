import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, createTask, listMessages, updateTask } from "@/lib/store";
import { registerTurn, unregisterTurn } from "@/lib/abort";
import { resetToolCutoffNotices } from "@/lib/agentToolCutoff";
import { POST as listTagsEp } from "@/app/api/internal/agent-tools/list-tags/route";
import { POST as toolCutoffEp } from "@/app/api/internal/agent-tools/tool-cutoff/route";

// The stdio bridge's half of the CLI tool-call cutoff (issue #364).
//
// The in-process Claude transport detects a cutoff by reading the tool_result
// the CLI wrote, which the bridge never sees. What the bridge DOES see is the
// protocol event underneath the dangerous half of that failure: the CLI sends
// notifications/cancelled for a request it already dispatched, the MCP SDK
// aborts the handler's signal and then drops the result instead of sending it.
// Calandria did the work, and the model will never learn what it answered.
//
// Same shape as tests/codexUpdateTaskPolicy.test.ts, for the same reason: the
// detection crosses a process boundary and an HTTP hop, so "the bridge notices"
// and "the server records it" have to be demonstrated together. The real
// scripts/calandria-mcp.mjs runs as its own process, its calls are served by the
// real route handlers, and the assertion is on the transcript rows in the DB.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "calandria-mcp.mjs");

const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
  "/api/internal/agent-tools/list-tags": listTagsEp,
  "/api/internal/agent-tools/tool-cutoff": toolCutoffEp,
};

// Held open long enough for a cancellation to land while the handler is still
// in flight. A call that has already answered cannot demonstrate a result being
// thrown away. Only the tool path is slowed; the bridge's own cutoff report must
// answer immediately, since the process it runs in may be about to be killed.
const SLOW_PATH = "/api/internal/agent-tools/list-tags";
let slowMs = 0;

let server: http.Server;
let baseUrl: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        const url = (req.url || "").split("?")[0];
        const handler = ROUTES[url];
        if (!handler) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: `no test route for ${req.url}` }));
          return;
        }
        if (url === SLOW_PATH && slowMs > 0) await sleep(slowMs);
        const out = await handler(
          new NextRequest(`http://127.0.0.1${req.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw })
        );
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(await out.text());
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connectBridge(callerId: string, projectId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: {
      CALANDRIA_TASK_ID: callerId,
      CALANDRIA_PROJECT_ID: projectId,
      CALANDRIA_BASE_URL: baseUrl,
      SERVICE_TOKEN: "cutoff-token",
      PATH: process.env.PATH || "",
    },
    // Keep the bridge's stderr off the test output: it writes one line per
    // cutoff on purpose, so the occurrence survives an unreachable app.
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** Cancel a call the bridge has already picked up, the way a CLI's MCP client does. */
async function cancelMidFlight(client: Client) {
  const ac = new AbortController();
  // The client rejects with the abort, which is expected and not the subject.
  const call = client.callTool({ name: "list_tags", arguments: {} }, undefined, { signal: ac.signal }).catch(() => null);
  await sleep(250);
  ac.abort("test cancelled the call");
  await call;
}

/**
 * A live turn for the task, which is what tells a cut-off apart from a Stop.
 * Returns its controller so a case can abort it to stage the Stop.
 */
function liveTurn(taskId: string): AbortController {
  const controller = new AbortController();
  registerTurn(taskId, controller);
  return controller;
}

/** The transcript notices the turn has been given, newest last. */
function notices(taskId: string): string[] {
  return listMessages(taskId)
    .filter((m) => m.role === "system")
    .map((m) => m.content);
}

/** The report crosses a process boundary, so give it a moment to land. */
async function waitForNotices(taskId: string, count: number): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const found = notices(taskId);
    if (found.length >= count) return found;
    await sleep(100);
  }
  return notices(taskId);
}

describe("a cancelled bridge tool call, end to end over the real bridge", () => {
  it("is reported once per turn, names the tool, and warns that the work may have landed", async () => {
    resetToolCutoffNotices();
    const project = createProject({ name: "Cutoff" });
    const task = createTask({ project_id: project.id, title: "Caller", description: "" });
    const turn = liveTurn(task.id);
    slowMs = 3000;

    const { client, close } = await connectBridge(task.id, project.id);
    try {
      await cancelMidFlight(client);
      const first = await waitForNotices(task.id, 1);
      expect(first).toHaveLength(1);
      // Names the tool, so the transcript says which call was lost.
      expect(first[0]).toContain("list_tags");
      // The distinguishing claim: this call DID reach Calandria, so the work
      // may have landed and a retry may repeat it. The in-process wording
      // ("nothing was done") would be wrong here.
      expect(first[0]).toMatch(/may still have taken effect/);
      expect(first[0]).not.toContain("nothing was done");
      // The recovery a person can actually perform.
      expect(first[0]).toContain("/clear");

      // Once this starts it tends to repeat for the rest of the session, so the
      // user is told once and not once per call.
      await cancelMidFlight(client);
      await sleep(600);
      expect(notices(task.id)).toHaveLength(1);
    } finally {
      slowMs = 0;
      unregisterTurn(task.id, turn);
      await close();
    }
  }, 30_000);

  it("tells the next generation again, since /clear is the advice it was given", async () => {
    resetToolCutoffNotices();
    const project = createProject({ name: "Cutoff-Gen" });
    const task = createTask({ project_id: project.id, title: "Caller", description: "" });
    const turn = liveTurn(task.id);
    slowMs = 3000;

    const { client, close } = await connectBridge(task.id, project.id);
    try {
      await cancelMidFlight(client);
      expect(await waitForNotices(task.id, 1)).toHaveLength(1);

      // What `/clear` does: end this generation and start the next one. A
      // recurrence there is news again, not a repeat of what was already said.
      updateTask(task.id, { generation: task.generation + 1 });
      await cancelMidFlight(client);
      expect(await waitForNotices(task.id, 2)).toHaveLength(2);
    } finally {
      slowMs = 0;
      unregisterTurn(task.id, turn);
      await close();
    }
  }, 30_000);

  it("leaves an uncancelled call alone", async () => {
    resetToolCutoffNotices();
    const project = createProject({ name: "Cutoff-Clean" });
    const task = createTask({ project_id: project.id, title: "Caller", description: "" });
    const turn = liveTurn(task.id);

    const { client, close } = await connectBridge(task.id, project.id);
    try {
      const res = (await client.callTool({ name: "list_tags", arguments: {} })) as { isError?: boolean };
      expect(res.isError).toBeFalsy();
      await sleep(400);
      expect(notices(task.id)).toEqual([]);
    } finally {
      unregisterTurn(task.id, turn);
      await close();
    }
  }, 30_000);

  it("says nothing when the turn was Stopped, which cancels every call in flight", async () => {
    resetToolCutoffNotices();
    const project = createProject({ name: "Cutoff-Stopped" });
    const task = createTask({ project_id: project.id, title: "Caller", description: "" });
    const turn = liveTurn(task.id);
    slowMs = 3000;

    const { client, close } = await connectBridge(task.id, project.id);
    try {
      // What Stop and /clear do: abort the turn's own controller, tearing down
      // every tool call with it. The user asked for that, so a warning about a
      // discarded answer would be on every stopped turn.
      turn.abort();
      await cancelMidFlight(client);
      await sleep(600);
      expect(notices(task.id)).toEqual([]);
    } finally {
      slowMs = 0;
      unregisterTurn(task.id, turn);
      await close();
    }
  }, 30_000);

  it("says nothing once the turn is over, since the cancellation is then teardown", async () => {
    resetToolCutoffNotices();
    const project = createProject({ name: "Cutoff-Ended" });
    const task = createTask({ project_id: project.id, title: "Caller", description: "" });
    slowMs = 3000;

    // No turn registered at all: the bridge reports synchronously on the abort,
    // so a live turn is still registered when a real cut-off is seen.
    const { client, close } = await connectBridge(task.id, project.id);
    try {
      await cancelMidFlight(client);
      await sleep(600);
      expect(notices(task.id)).toEqual([]);
    } finally {
      slowMs = 0;
      await close();
    }
  }, 30_000);
});
