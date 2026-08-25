import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGroup, createProject, createTask, getTask, getTaskDeps, listGroups, listTasks, updateTask } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";
import { POST as suggestTaskEp } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as listGroupsEp } from "@/app/api/internal/agent-tools/list-groups/route";

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

// The real handlers, keyed by the path the bridge posts to. Only the endpoints
// these tests exercise are mounted: an unrouted path 404s loudly rather than
// being served by the wrong one.
const ROUTES: Record<string, (req: NextRequest) => Promise<Response>> = {
  "/api/internal/agent-tools/update-task": updateTaskEp,
  "/api/internal/agent-tools/suggest-task": suggestTaskEp,
  "/api/internal/agent-tools/list-groups": listGroupsEp,
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        // Hand the bridge's POST to the real handler for that path, unmodified.
        const handler = ROUTES[(req.url || "").split("?")[0]];
        if (!handler) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: `no test route for ${req.url}` }));
          return;
        }
        const out = await handler(
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

/** Spawn the real bridge with `callerId` as its env-injected CALANDRIA_TASK_ID. */
async function connectBridge(callerId: string, projectId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SCRIPT],
    env: {
      CALANDRIA_TASK_ID: callerId,
      CALANDRIA_PROJECT_ID: projectId,
      CALANDRIA_BASE_URL: baseUrl,
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

  it("orders a plan in two phases, and refuses to order the caller's own row", async () => {
    // The whole point of the parameter: a planning turn files its tasks, gets
    // ids back, and comes BACK to say what waits on what. Driven over the real
    // bridge because this is where the model names the target, and asserted on
    // the DB because a "Blocked by 1 task(s)" that wrote no edge is the exact
    // failure this feature is meant to end.
    const project = createProject({ name: "Codex-Order" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const first = createSuggestedTask(project, { title: "Phase one", description: "" }).task!;
    const second = createSuggestedTask(project, { title: "Phase two", description: "" }).task!;

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      const ok = (await client.callTool({
        name: "update_task",
        arguments: { task: second.id, blocked_by: [first.id] },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTaskDeps(second.id)).toEqual([first.id]);

      // The caller's own row is refused — it's already running, so an edge on it
      // would gate nothing and mislabel the board.
      const own = (await client.callTool({
        name: "update_task",
        arguments: { blocked_by: [first.id] },
      })) as ToolResult;
      expect(own.isError).toBe(true);
      expect(own.content[0].text).toContain("on_hold");
      expect(getTaskDeps(caller.id)).toEqual([]);

      // A ref the server can't use fails the WHOLE call: the edge already there
      // survives rather than being replaced by the half we recognized.
      const bad = (await client.callTool({
        name: "update_task",
        arguments: { task: second.id, blocked_by: [first.id, "ghost"] },
      })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(getTaskDeps(second.id)).toEqual([first.id]);
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

// Groups over the same wire. The Codex path is where the MODEL names both the
// project a task is filed into AND the group it lands in, so the two rules that
// make grouping safe have to be shown together here rather than assumed:
// suggest_task creates a group in the project the task ACTUALLY landed in, and
// update_task refuses one it doesn't recognize instead of minting a near-twin.
describe("group, end to end over the Codex bridge", () => {
  it("groups a cross-project suggestion in the TARGET project, creating the group there", async () => {
    const here = createProject({ name: "Codex-GroupHere" });
    const there = createProject({ name: "Codex-GroupThere" });
    const caller = createTask({ project_id: here.id, title: "Planner", description: "" });
    // A same-named group in the CALLER's project: if resolution ran before the
    // project did, the suggestion would be grouped into this one — a group
    // spanning two repos, which the schema and the UI both forbid.
    const decoy = createGroup({ project_id: here.id, name: "Auth migration" });

    const { client, close } = await connectBridge(caller.id, here.id);
    try {
      const res = (await client.callTool({
        name: "suggest_task",
        arguments: { title: "Ported route", description: "", project: "Codex-GroupThere", group: "Auth migration" },
      })) as ToolResult;
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('Created group "Auth migration" in Codex-GroupThere.');

      const landed = listTasks(there.id).find((t) => t.title === "Ported route")!;
      const made = listGroups(there.id);
      expect(made).toHaveLength(1);
      expect(landed.group_id).toBe(made[0].id);
      expect(landed.group_id).not.toBe(decoy.id);
      // Provenance is the CALLER's task id, which the model never sends — the
      // bridge only forwards CALANDRIA_TASK_ID.
      expect(made[0].origin_task_id).toBe(caller.id);

      // The second step of the plan reuses it rather than minting a twin.
      const again = (await client.callTool({
        name: "suggest_task",
        arguments: { title: "Second step", description: "", project: "Codex-GroupThere", group: "Auth migration" },
      })) as ToolResult;
      expect(again.content[0].text).toContain('Filed under group "Auth migration".');
      expect(listGroups(there.id)).toHaveLength(1);

      // …and list_groups reads it back with the members, in one call.
      const listed = (await client.callTool({ name: "list_groups", arguments: { project: "Codex-GroupThere" } })) as ToolResult;
      const parsed = JSON.parse(listed.content[0].text) as { groups: { name: string; counts: { total: number }; tasks: { title: string }[] }[] };
      expect(parsed.groups.map((g) => g.name)).toEqual(["Auth migration"]);
      expect(parsed.groups[0].counts.total).toBe(2);
      expect(parsed.groups[0].tasks.map((t) => t.title).sort()).toEqual(["Ported route", "Second step"]);
    } finally {
      await close();
    }
  });

  it("refuses an unknown group on update_task, and the rest of that call never lands", async () => {
    const project = createProject({ name: "Codex-GroupStrict" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const inert = createSuggestedTask(project, { title: "Inert", description: "" }).task!;
    const real = createGroup({ project_id: project.id, name: "Auth migration" });

    const { client, close } = await connectBridge(caller.id, project.id);
    try {
      // Strict where suggest_task creates: the task already exists, so a typo
      // here would split a feature the user is filtering by in two.
      const bad = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, title: "Sharpened", group: "Auth migraton" },
      })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain("Nothing was changed");
      // Neither half landed, and nothing was created for the misspelling.
      expect(getTask(inert.id)).toMatchObject({ title: "Inert", group_id: null });
      expect(listGroups(project.id).map((g) => g.id)).toEqual([real.id]);

      // The exact name works, and "" takes it back out.
      const ok = (await client.callTool({
        name: "update_task",
        arguments: { task: inert.id, group: "Auth migration" },
      })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(getTask(inert.id)!.group_id).toBe(real.id);

      const cleared = (await client.callTool({ name: "update_task", arguments: { task: inert.id, group: "" } })) as ToolResult;
      expect(cleared.isError).toBeFalsy();
      expect(getTask(inert.id)!.group_id).toBeNull();
    } finally {
      await close();
    }
  });
});
