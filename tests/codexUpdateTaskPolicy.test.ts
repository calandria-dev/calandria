import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";

// update_task's cross-task policy, proved END TO END on the Codex path.
//
// tests/orchMcp.test.ts drives the same bridge against a FAKE app server, so it
// can only show what the bridge forwards. This file closes the loop: the real
// scripts/orch-mcp.mjs runs as its own process and its calls are served by the
// REAL route handler against the REAL database.
//
// That matters because this is the one path where the MODEL names the write
// target. On the Claude side the driver closes over the task and the id never
// leaves the process; here it crosses a wire, so "the bridge doesn't enforce
// it" and "the server does" have to be demonstrated together rather than
// assumed. Every case below asks the bridge to write a row it must not, and
// checks the DB afterwards — a refusal that still wrote would pass a
// text-only assertion.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "orch-mcp.mjs");

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        // Hand the bridge's POST to the real handler, unmodified.
        const out = await updateTaskEp(
          new NextRequest(`http://127.0.0.1${req.url}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
          })
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

/** Spawn the real bridge with `callerId` as its env-injected ORCH_TASK_ID. */
async function connectBridge(callerId: string, projectId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: {
      ORCH_TASK_ID: callerId,
      ORCH_PROJECT_ID: projectId,
      ORCH_BASE_URL: baseUrl,
      SERVICE_TOKEN: "policy-token",
      PATH: process.env.PATH || "",
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

describe("update_task policy, end to end over the Codex bridge", () => {
  it("writes an inert tray suggestion the model names, and refuses everything else", async () => {
    const project = createProject({ name: "Codex-Policy" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });

    // One row per rule, so a failure names which rule broke.
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;
    const started = createSuggestedTask(project, { title: "Started", description: "" }).task!;
    updateTask(started.id, { suggested: 0, started: 1 });
    const running = createSuggestedTask(project, { title: "Running", description: "" }).task!;
    updateTask(running.id, { running: 1 });
    const accepted = createSuggestedTask(project, { title: "Accepted", description: "" }).task!;
    updateTask(accepted.id, { suggested: 0 });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // The permitted cross-task write: an unreviewed suggestion.
      const ok = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, title: "Sharpened", priority: "hi" },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTask(inert.id)).toMatchObject({ title: "Sharpened", priority: "hi" });

      // Everything the model must not reach. The bridge surfaces the endpoint's
      // 400 as a tool error, and the row is byte-identical afterwards.
      for (const row of [started, running, accepted]) {
        const before = getTask(row.id)!;
        const res = (await client.callTool({
          name: "update_task",
          arguments: { task: row.id, title: "Hijacked", status: "done" },
        })) as ToolResult;
        expect(res.isError, `${row.title} should have been refused`).toBe(true);
        expect(getTask(row.id)).toEqual(before);
      }

      // A row that doesn't exist is a refusal, never a fallback to the caller.
      const ghost = (await client.callTool({
        name: "update_task",
        arguments: { task: "ghost", title: "Hijacked" },
      })) as ToolResult;
      expect(ghost.isError).toBe(true);
      expect(getTask(caller.id)!.title).toBe("Caller");
    } finally {
      await close();
    }
  });

  it("still defaults to the caller's own row, which the model cannot redirect", async () => {
    const project = createProject({ name: "Codex-Own" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const bystander = createTask({ project_id: project.id, title: "Bystander", description: "" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      await client.callTool({ name: "update_task", arguments: { title: "Renamed", status: "in_progress" } });
      expect(getTask(caller.id)).toMatchObject({ title: "Renamed", status: "in_progress" });

      // `taskId` is not in the tool's schema, so the model can't send one — but
      // prove the endpoint ignores a stray one rather than trusting it, since
      // that field is what decides whose row counts as "own".
      const res = await fetch(`${baseUrl}/api/internal/agent-tools/update-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: caller.id, task: bystander.id, title: "Hijacked" }),
      });
      expect(res.status).toBe(400);
      expect(getTask(bystander.id)!.title).toBe("Bystander");
    } finally {
      await close();
    }
  });

  it("refuses to cancel a suggestion it is otherwise allowed to edit", async () => {
    const project = createProject({ name: "Codex-Cancel" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // "cancelled" isn't in the tool's status enum, so the MCP layer turns it
      // into a validation error and the bridge is never reached.
      const res = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, status: "cancelled" },
      })) as ToolResult;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("status");
      expect(getTask(inert.id)!.status).toBe("not_started");

      // Neither layer is load-bearing alone: bypass the schema entirely and
      // prove the ENDPOINT refuses it too, on a row it would happily retitle.
      const direct = await fetch(`${baseUrl}/api/internal/agent-tools/update-task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: caller.id, task: inert.id, status: "cancelled" }),
      });
      expect(direct.status).toBe(400);
      expect(getTask(inert.id)!.status).toBe("not_started");
    } finally {
      await close();
    }
  });
});
