// submit_review / get_review / withdraw_review over the real stdio bridge and the
// real internal routes. The model supplies the payload; the server supplies who
// is submitting. None of the tools can complete, waive or accept anything.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { POST as submitEp } from "@/app/api/internal/agent-tools/submit-review/route";
import { POST as getEp } from "@/app/api/internal/agent-tools/get-review/route";
import { POST as withdrawEp } from "@/app/api/internal/agent-tools/withdraw-review/route";
import { getDb } from "@/lib/db";
import { getTask } from "@/lib/store";
import { commitFile } from "./helpers";
import { docBody, reviewTask } from "./reviewFixture";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "calandria-mcp.mjs");
const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
  "/api/internal/agent-tools/submit-review": submitEp,
  "/api/internal/agent-tools/get-review": getEp,
  "/api/internal/agent-tools/withdraw-review": withdrawEp,
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        const handler = ROUTES[(req.url || "").split("?")[0]];
        if (!handler) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `no test route for ${req.url}` }));
          return;
        }
        const out = await handler(new NextRequest(`http://127.0.0.1${req.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw }));
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
beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function connect(callerId: string, projectId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: { CALANDRIA_TASK_ID: callerId, CALANDRIA_PROJECT_ID: projectId, CALANDRIA_BASE_URL: baseUrl, SERVICE_TOKEN: "t", PATH: process.env.PATH || "" },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
type R = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as R;

describe("review tools over the stdio bridge", () => {
  it("submits, reads, revises and withdraws without completing the task", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    const client = await connect(f.taskId, f.project.id);
    try {
      const body = docBody({ idempotencyKey: "first-1" });
      const sub = await call(client, "submit_review", body);
      expect(sub.isError).toBeFalsy();
      expect(sub.content[0].text).toMatch(/state pending/);
      expect(getTask(f.taskId)!.status).toBe("in_progress");
      const reqRow = getDb().prepare("SELECT * FROM review_requests WHERE owner_task_id = ?").get(f.taskId) as { id: string; required: number; version: number; current_submission_id: string };
      expect(reqRow.required).toBe(1);

      // Idempotent replay returns the same receipt, without a second row.
      const again = await call(client, "submit_review", body);
      expect(again.content[0].text).toBe(sub.content[0].text);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM review_submissions").get()).toMatchObject({ n: 1 });

      // The model cannot name another submitter: unknown keys are refused.
      const forged = await call(client, "submit_review", { ...docBody({ idempotencyKey: "forge" }), taskId: "someone-else" });
      expect(forged.isError).toBe(true);

      const read = JSON.parse((await call(client, "get_review", {})).content[0].text);
      expect(read.requests[0]).toMatchObject({ id: reqRow.id, state: "pending", version: 1, required: true });

      const wd = await call(client, "withdraw_review", { requestId: reqRow.id, expectedVersion: 1, idempotencyKey: "wd-1", reason: "superseded by a new plan" });
      expect(wd.isError).toBeFalsy();
      expect(wd.content[0].text).toMatch(/stays unsatisfied/);
      expect(getDb().prepare("SELECT state, version FROM review_requests WHERE id = ?").get(reqRow.id)).toMatchObject({ state: "withdrawn", version: 2 });
      expect(getDb().prepare("SELECT actor_kind, action FROM review_actions").get()).toMatchObject({ actor_kind: "agent", action: "withdraw" });

      const noReason = await call(client, "withdraw_review", { requestId: reqRow.id, expectedVersion: 2, idempotencyKey: "wd-2", reason: "  " });
      expect(noReason.isError).toBe(true);

      // Resubmission re-enters pending and keeps the requirement.
      const rev = await call(client, "submit_review", docBody({ requestId: reqRow.id, expectedVersion: 2, expectedSubmissionId: reqRow.current_submission_id, idempotencyKey: "rev-1" }));
      expect(rev.isError).toBeFalsy();
      expect(getDb().prepare("SELECT state, required FROM review_requests WHERE id = ?").get(reqRow.id)).toMatchObject({ state: "pending", required: 1 });
    } finally {
      await client.close();
    }
  });

  it("refuses a required submission on a done task, and creation while the flag is off", async () => {
    const f = await reviewTask();
    await commitFile(f.wt.path, "docs/plan.md", "# Plan\n", "add plan");
    const client = await connect(f.taskId, f.project.id);
    try {
      delete process.env.CALANDRIA_REVIEW_REQUESTS;
      const off = await call(client, "submit_review", docBody({ idempotencyKey: "off-1" }));
      expect(off.isError).toBe(true);
      expect(off.content[0].text).toMatch(/creation_disabled/);
      process.env.CALANDRIA_REVIEW_REQUESTS = "1";
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(f.taskId);
      const done = await call(client, "submit_review", docBody({ idempotencyKey: "done-1" }));
      expect(done.isError).toBe(true);
      expect(done.content[0].text).toMatch(/terminal_task/);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM review_requests WHERE owner_task_id = ?").get(f.taskId)).toMatchObject({ n: 0 });
    } finally {
      await client.close();
    }
  });
});
