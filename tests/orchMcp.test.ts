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
      } else if (req.url?.endsWith("/list-tasks")) {
        res.end(
          JSON.stringify({
            ok: true,
            project: body.project ? "Other Project" : "Here",
            tasks: [{ id: "task-xyz", title: "Mine", status: "in_progress", current: true }],
          })
        );
      } else if (req.url?.endsWith("/get-task")) {
        // Mirrors the real endpoint's default: no `task` means the caller's own.
        res.end(JSON.stringify({ ok: true, task: { id: body.task || body.taskId, title: "Mine", description: "my brief" } }));
      } else if (req.url?.endsWith("/update-task")) {
        res.end(JSON.stringify({ ok: true, id: body.taskId, title: body.title, text: `Updated "${body.title}".` }));
      } else if (req.url?.endsWith("/withdraw-suggestion")) {
        res.end(JSON.stringify({ ok: true, id: body.task, status: "cancelled", text: `Withdrew "${body.task}".` }));
      } else if (req.url?.endsWith("/create-runbook")) {
        res.end(JSON.stringify({ ok: true, id: "rb-1", name: body.name, project_id: "proj-abc", text: `Saved runbook "${body.name}".` }));
      } else if (req.url?.endsWith("/list-runbooks")) {
        res.end(JSON.stringify({ ok: true, project: "Here", runbooks: [], text: "[]" }));
      } else if (req.url?.endsWith("/update-runbook")) {
        // Stand in for the real policy: a runbook a schedule fires is refused,
        // with the reason travelling back as the tool's error text.
        if (body.runbook === "rb-scheduled") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: `"Morning sweep" fires this runbook, so editing it would silently change unattended work.` }));
          return;
        }
        res.end(JSON.stringify({ ok: true, id: body.runbook, name: body.name, text: `Updated runbook "${body.name}".` }));
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
  it("exposes the full orchestrator tool set over stdio", async () => {
    const { client, close } = await connectBridge();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "ask_user",
        "create_runbook",
        "expose_service",
        "get_task",
        "list_projects",
        "list_runbooks",
        "list_tasks",
        "suggest_task",
        "update_runbook",
        "update_task",
        "withdraw_suggestion",
      ]);
      // No delete_runbook, and that is a policy rather than an omission: delete
      // is hard delete with no undo here, so retiring a recipe stays the user's
      // call. See lib/runbookTools.ts.
      expect(tools.map((t) => t.name)).not.toContain("delete_runbook");
      // Descriptions come from the shared defs — sanity check they're populated.
      expect(tools.find((t) => t.name === "suggest_task")?.description).toContain("Suggested tray");
    } finally {
      await close();
    }
  });

  it("lets the model name update_task's target, but never offers it the caller's identity", async () => {
    const { client, close } = await connectBridge();
    try {
      const { tools } = await client.listTools();
      // `task` is the target the model picks; it is optional, so omitting it
      // still means "my own row". What is deliberately absent is `taskId` —
      // the CALLER, which callInternal supplies from ORCH_TASK_ID. If the model
      // could set that, naming any row would be enough to be treated as owning
      // it. Whether the named target may actually be written is the server's
      // call, proved end-to-end in tests/codexUpdateTaskPolicy.test.ts.
      const schema = tools.find((t) => t.name === "update_task")!.inputSchema as {
        properties?: Record<string, { enum?: string[] }>;
      };
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["blocked_by", "description", "priority", "status", "task", "title"]);
      // Cancelling is the user's call: on the caller's own row it would abort
      // the very turn making the call.
      expect(schema.properties!.status.enum).not.toContain("cancelled");
      expect(schema.properties!.status.enum).toContain("done");
    } finally {
      await close();
    }
  });

  it("never offers create_runbook the agent id it will be recorded under", async () => {
    const { client, close } = await connectBridge();
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "create_runbook")!.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      // `created_by` is deliberately absent. The endpoint reads the agent off
      // the CALLER'S task row, so a model can't file a recipe under another
      // agent's name — the card shows that value to the user as provenance.
      expect(Object.keys(schema.properties ?? {})).not.toContain("created_by");
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
        ["description", "name", "permission_mode", "priority", "project", "prompt"]
      );
      expect((schema.required ?? []).sort()).toEqual(["description", "name", "prompt"]);

      const res = await client.callTool({
        name: "create_runbook",
        arguments: { name: "Sweep", description: "d", prompt: "/sweep" },
      });
      expect((res.content as { text: string }[])[0].text).toContain("Sweep");
      const call = calls.find((c) => c.path.endsWith("/create-runbook"))!;
      // The caller identity the bridge supplies from ORCH_TASK_ID, not the model.
      expect(call.body.taskId).toBe("task-xyz");
    } finally {
      await close();
    }
  });

  it("relays update_runbook's refusal for a schedule-linked runbook, with the reason", async () => {
    const { client, close } = await connectBridge();
    try {
      // The refusal has to reach the MODEL as text it can act on: "you may not"
      // with no reason leaves it nothing to tell the user and nothing to try
      // instead. The policy itself lives in lib/runbookTools.ts and is proved
      // in tests/runbookAgentTools.test.ts; this pins that it survives the trip.
      const res = await client.callTool({
        name: "update_runbook",
        arguments: { runbook: "rb-scheduled", prompt: "/hijacked" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0].text).toContain("Morning sweep");
    } finally {
      await close();
    }
  });

  it("makes withdraw_suggestion's target and reason the model's to supply, and both mandatory", async () => {
    const { client, close } = await connectBridge();
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "withdraw_suggestion")!.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      // `taskId` is absent for the same reason it is on update_task: the CALLER
      // comes from ORCH_TASK_ID via callInternal, and a model that could set it
      // would own any row it could name.
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["reason", "task"]);
      // Both required — a retraction with no target is meaningless and one with
      // no explanation is worse than none. Whether the named target may actually
      // be withdrawn is the server's call, proved in tests/agentTools.test.ts.
      expect([...(schema.required ?? [])].sort()).toEqual(["reason", "task"]);
    } finally {
      await close();
    }
  });

  it("forwards a model-named withdraw target without letting it displace the caller", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      // Same shape as the update_task case: the bridge holds no policy, it just
      // must not let the model's `task` become the trusted `taskId`.
      const res = (await client.callTool({
        name: "withdraw_suggestion",
        arguments: { task: "task-someone-else", reason: "already covered by the parser rewrite" },
      })) as { content: { text: string }[] };
      expect(res.content[0].text).toContain("Withdrew");
      const call = calls.find((c) => c.path.endsWith("/withdraw-suggestion"))!;
      expect(call.body).toMatchObject({
        taskId: "task-xyz",
        task: "task-someone-else",
        reason: "already covered by the parser rewrite",
      });
      expect(call.token).toBe("smoke-token");
    } finally {
      await close();
    }
  });

  it("proxies list_tasks, defaulting to this session's own board", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({ name: "list_tasks", arguments: {} })) as { content: { text: string }[] };
      const call = calls.find((c) => c.path.endsWith("/list-tasks"))!;
      expect(call.body).toMatchObject({ projectId: "proj-abc", taskId: "task-xyz" });
      expect(call.token).toBe("smoke-token");
      const parsed = JSON.parse(res.content[0].text) as { project: string; tasks: { current: boolean }[] };
      expect(parsed.project).toBe("Here");
      expect(parsed.tasks[0].current).toBe(true);

      // A `project` ref travels through for the server to resolve strictly.
      await client.callTool({ name: "list_tasks", arguments: { project: "Other Project", include_done: true } });
      expect(calls.filter((c) => c.path.endsWith("/list-tasks"))[1].body).toMatchObject({
        project: "Other Project",
        include_done: true,
      });
    } finally {
      await close();
    }
  });

  it("proxies get_task, leaving the 'my own task' default to the server", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({ name: "get_task", arguments: {} })) as { content: { text: string }[] };
      // The bridge doesn't substitute ORCH_TASK_ID itself — it always sends it
      // as `taskId`, and the endpoint falls back to it when `task` is absent.
      expect(calls.find((c) => c.path.endsWith("/get-task"))!.body).toMatchObject({ taskId: "task-xyz" });
      expect(JSON.parse(res.content[0].text)).toMatchObject({ id: "task-xyz", description: "my brief" });

      await client.callTool({ name: "get_task", arguments: { task: "task-other" } });
      expect(calls.filter((c) => c.path.endsWith("/get-task"))[1].body).toMatchObject({ task: "task-other" });
    } finally {
      await close();
    }
  });

  it("proxies update_task with only the fields the model set", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      const res = (await client.callTool({
        name: "update_task",
        arguments: { title: "Renamed", status: "done" },
      })) as { content: { text: string }[] };
      expect(res.content[0].text).toContain('Updated "Renamed"');
      const call = calls.find((c) => c.path.endsWith("/update-task"))!;
      expect(call.body).toMatchObject({ taskId: "task-xyz", title: "Renamed", status: "done" });
      expect(call.token).toBe("smoke-token");
      // Omitted fields must not travel as nulls — the endpoint treats
      // "field present" as "write this", so a null would blank the column.
      expect(call.body.priority).toBeUndefined();
      expect(call.body.description).toBeUndefined();
      // No `task` either, so the endpoint applies its own-row default.
      expect(call.body.task).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("forwards a model-named update_task target without letting it displace the caller", async () => {
    calls.length = 0;
    const { client, close } = await connectBridge();
    try {
      // The bridge holds no policy — it passes the id straight through. What it
      // must NOT do is let that id become the caller: `taskId` stays ORCH_TASK_ID.
      await client.callTool({ name: "update_task", arguments: { task: "task-someone-else", title: "Sharpened" } });
      const call = calls.find((c) => c.path.endsWith("/update-task"))!;
      expect(call.body).toMatchObject({ taskId: "task-xyz", task: "task-someone-else", title: "Sharpened" });
    } finally {
      await close();
    }
  });

  it("forwards update_task's blocked_by verbatim — ids only, no title lookup", async () => {
    calls.length = 0;
    nextId = 0;
    const { client, close } = await connectBridge();
    try {
      // File a task so its title IS in the bridge's per-turn map…
      await client.callTool({ name: "suggest_task", arguments: { title: "First", description: "" } });
      // …then wire dependencies the way the two-phase recipe does: with the id.
      await client.callTool({ name: "update_task", arguments: { task: "id-1", blocked_by: ["id-0"] } });
      expect(calls.find((c) => c.path.endsWith("/update-task"))!.body).toMatchObject({
        taskId: "task-xyz",
        task: "id-1",
        blocked_by: ["id-0"],
      });

      // A TITLE is not resolved here, unlike suggest_task's version of the
      // param: the map dies with this process, so the same string would work
      // this turn and be refused the next. It travels as typed and the endpoint
      // refuses the call, which is a message the model can act on.
      calls.length = 0;
      await client.callTool({ name: "update_task", arguments: { task: "id-1", blocked_by: ["First"] } });
      expect(calls.find((c) => c.path.endsWith("/update-task"))!.body.blocked_by).toEqual(["First"]);
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
