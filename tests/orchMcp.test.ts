import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Smoke test for the portable stdio MCP bridge (scripts/orch-mcp.mjs). We stand
// up a tiny fake "app" HTTP server that records the internal calls the bridge
// makes and returns canned tool text, spawn the real bridge over stdio, and
// drive it with the MCP client SDK — the same protocol Codex speaks to it.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "orch-mcp.mjs");

interface Received {
  path: string;
  token: string | undefined;
  body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl: string;
const calls: Received[] = [];
let nextId = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url || "", token: req.headers["x-service-token"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/suggest-task")) {
        const id = `id-${nextId++}`;
        // Stand in for resolveTargetProject: any `project` ref resolves to the
        // one "other" project, and omitting it means the session's own. The
        // bridge keys its title map off what comes back here.
        const other = { projectId: "proj-other", projectName: "Other Project" };
        const here = { projectId: "proj-abc", projectName: "Here" };
        const resolved = body.project ? other : here;
        res.end(JSON.stringify({ ok: true, id, title: body.title, ...resolved, text: `Suggested "${body.title}" (id: ${id}).` }));
      } else if (req.url?.endsWith("/list-projects")) {
        res.end(JSON.stringify({ ok: true, projects: [{ id: "proj-abc", name: "Here", repo_path: "/repos/here", current: true }] }));
      } else if (req.url?.endsWith("/expose-service")) {
        const url = `http://localhost:${body.port}`;
        res.end(JSON.stringify({ ok: true, name: body.name, url, text: `Registered "${body.name}" at ${url}.` }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connectBridge() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: {
      ORCH_TASK_ID: "task-xyz",
      ORCH_PROJECT_ID: "proj-abc",
      ORCH_BASE_URL: baseUrl,
      SERVICE_TOKEN: "smoke-token",
      PATH: process.env.PATH || "",
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe("orch-mcp stdio bridge", () => {
  it("exposes suggest_task, list_projects, expose_service and ask_user over stdio", async () => {
    const { client, close } = await connectBridge();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["ask_user", "expose_service", "list_projects", "suggest_task"]);
      // Descriptions come from the shared defs — sanity check they're populated.
      expect(tools.find((t) => t.name === "suggest_task")?.description).toContain("Suggested tray");
    } finally {
      await close();
    }
  });

  it("proxies suggest_task with project/task/token and resolves title refs", async () => {
    calls.length = 0;
    nextId = 0;
    const { client, close } = await connectBridge();
    try {
      const r1 = (await client.callTool({
        name: "suggest_task",
        arguments: { title: "First", description: "do first", priority: "hi" },
      })) as { content: { type: string; text: string }[] };
      expect(r1.content[0].text).toContain("id-0");

      // Reference the first task BY TITLE — the bridge should resolve it to id-0.
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Second", description: "do second", blocked_by: ["First"] },
      });

      const first = calls.find((c) => c.body.title === "First")!;
      expect(first.path).toBe("/api/internal/agent-tools/suggest-task");
      expect(first.token).toBe("smoke-token");
      expect(first.body).toMatchObject({ projectId: "proj-abc", taskId: "task-xyz", priority: "hi" });

      const second = calls.find((c) => c.body.title === "Second")!;
      expect(second.body.blocked_by).toEqual(["id-0"]);
    } finally {
      await close();
    }
  });

  it("forwards the target project and keeps title refs from crossing projects", async () => {
    calls.length = 0;
    nextId = 0;
    const { client, close } = await connectBridge();
    try {
      // File a blocker into ANOTHER project, naming it the way the model would.
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Blocker", description: "", project: "Other Project" },
      });
      const blocker = calls.find((c) => c.body.title === "Blocker")!;
      expect(blocker.body.project).toBe("Other Project");

      // Same title, same project — resolves to the id the endpoint returned,
      // even though this call names the project by ID rather than by name.
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Same project", description: "", project: "proj-other", blocked_by: ["Blocker"] },
      });
      expect(calls.find((c) => c.body.title === "Same project")!.body.blocked_by).toEqual(["id-0"]);

      // Same title, DIFFERENT project (this session's own): must NOT resolve —
      // dependencies never cross projects, so it travels on as a literal for
      // the server to report as unusable.
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Other project", description: "", blocked_by: ["Blocker"] },
      });
      expect(calls.find((c) => c.body.title === "Other project")!.body.blocked_by).toEqual(["Blocker"]);
    } finally {
      await close();
    }
  });

  it("stops resolving a title once two tasks in one project share it", async () => {
    calls.length = 0;
    nextId = 0;
    const { client, close } = await connectBridge();
    try {
      for (const description of ["one", "two"]) {
        await client.callTool({ name: "suggest_task", arguments: { title: "Dup", description } });
      }
      await client.callTool({
        name: "suggest_task",
        arguments: { title: "Dependent", description: "", blocked_by: ["Dup"] },
      });
      // Neither id would be more correct than the other, so the ref travels on
      // as a literal for the server to report as unusable.
      expect(calls.find((c) => c.body.title === "Dependent")!.body.blocked_by).toEqual(["Dup"]);
    } finally {
      await close();
    }
  });

  it("proxies list_projects and returns the project list as text", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({ name: "list_projects", arguments: {} })) as {
        content: { type: string; text: string }[];
      };
      expect(calls.find((c) => c.path.endsWith("/list-projects"))!.body).toMatchObject({ projectId: "proj-abc" });
      expect(JSON.parse(res.content[0].text)).toEqual([
        { id: "proj-abc", name: "Here", repo_path: "/repos/here", current: true },
      ]);
    } finally {
      await close();
    }
  });

  it("proxies expose_service and returns the URL text", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({
        name: "expose_service",
        arguments: { name: "dev", port: 4300 },
      })) as { content: { type: string; text: string }[] };
      expect(res.content[0].text).toContain("http://localhost:4300");
      const call = calls.find((c) => c.path.endsWith("/expose-service"))!;
      expect(call.body).toMatchObject({ projectId: "proj-abc", name: "dev", port: 4300 });
      expect(call.token).toBe("smoke-token");
    } finally {
      await close();
    }
  });
});
