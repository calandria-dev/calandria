#!/usr/bin/env node
/* Portable stdio MCP bridge — gives non-Claude agent CLIs (Codex today, any
 * future one) the orchestrator's task tools (suggest_task / list_tasks /
 * get_task / update_task / withdraw_suggestion), its runbook tools
 * (create_runbook / list_runbooks / update_runbook), list_projects,
 * expose_service and ask_user.
 *
 * The Claude driver mounts these as an in-process SDK MCP server, a construct
 * that only exists inside the Claude Agent SDK. This is the portable equivalent:
 * a plain-Node stdio MCP server (@modelcontextprotocol/sdk) the CLI spawns and
 * talks to over stdio. It's a thin proxy — every tool call POSTs to the app's
 * internal endpoints (app/api/internal/agent-tools/*), which run the SAME shared
 * logic (lib/agentTools.ts) the in-process server calls.
 *
 * Per-turn wiring comes from env, injected by the driver when it registers this
 * server (lib/agents/codex/driver.ts):
 *   ORCH_TASK_ID     the task this turn belongs to
 *   ORCH_PROJECT_ID  the owning project (tasks/services are created under it)
 *   ORCH_BASE_URL    the app's loopback origin (e.g. http://127.0.0.1:3000)
 *   SERVICE_TOKEN    the per-instance secret the internal endpoints require
 *
 * Tool names / descriptions / param docs come from lib/agentToolDefs.mjs so this
 * bridge and the in-process server never drift. Plain .mjs: this file AND
 * agentToolDefs.mjs must be COPY'd into the runtime image (see Dockerfile).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SUGGEST_TASK, EXPOSE_SERVICE, ASK_USER, LIST_PROJECTS, LIST_TASKS, GET_TASK, UPDATE_TASK, WITHDRAW_SUGGESTION, CREATE_RUNBOOK, LIST_RUNBOOKS, UPDATE_RUNBOOK } from "../lib/agentToolDefs.mjs";

const TASK_ID = process.env.ORCH_TASK_ID || "";
const PROJECT_ID = process.env.ORCH_PROJECT_ID || "";
const BASE_URL = (process.env.ORCH_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";

// Titles created this turn → their task ids, so `blocked_by` can reference an
// earlier suggestion by title (mirrors the in-process server's per-turn map).
// This process lives exactly one turn, so the map is naturally turn-scoped.
//
// Keyed by (project, title), because a suggestion can be filed into ANY project
// and dependencies never cross one — the same title in two projects is two
// unrelated tasks. Unlike the in-process server this bridge only knows the
// project REF the model typed (an id, a name, or nothing for "here"), not the
// row it resolves to, so each title is recorded under every alias of its target
// (the ref as typed, the resolved id, the resolved name, and "" when the target
// is the session's own project). A ref that still misses simply passes through
// as a literal and the server reports it as unusable — never a silent bad dep.
// Two suggestions sharing a title in one project store AMBIGUOUS instead of an
// id, so the ref resolves to nothing rather than to a coin flip.
const createdByTitle = new Map();
const AMBIGUOUS = "\u0000ambiguous";
const norm = (s) => (s ?? "").trim().toLowerCase();
const titleKey = (projectAlias, title) => `${norm(projectAlias)}\u0000${title}`;

/** POST a tool call to an internal endpoint; return its `text` (thrown on error). */
async function callInternal(path, payload) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/internal/agent-tools/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": SERVICE_TOKEN },
      body: JSON.stringify({ projectId: PROJECT_ID, taskId: TASK_ID, ...payload }),
    });
  } catch (e) {
    throw new Error(`orchestrator unreachable at ${BASE_URL}: ${e?.message || e}`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body (e.g. a 403 text) — handled below */
  }
  if (!res.ok) throw new Error((data && data.error) || `orchestrator returned ${res.status}`);
  return data;
}

const server = new McpServer({ name: "orchestrator", version: "1.0.0" });

server.registerTool(
  EXPOSE_SERVICE.name,
  {
    description: EXPOSE_SERVICE.description,
    inputSchema: {
      name: z.string().describe(EXPOSE_SERVICE.params.name),
      port: z.number().int().positive().describe(EXPOSE_SERVICE.params.port),
    },
  },
  async ({ name, port }) => {
    const data = await callInternal("expose-service", { name, port });
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  LIST_PROJECTS.name,
  { description: LIST_PROJECTS.description, inputSchema: {} },
  async () => {
    const data = await callInternal("list-projects", {});
    return { content: [{ type: "text", text: JSON.stringify(data.projects ?? [], null, 2) }] };
  }
);

server.registerTool(
  SUGGEST_TASK.name,
  {
    description: SUGGEST_TASK.description,
    inputSchema: {
      title: z.string().describe(SUGGEST_TASK.params.title),
      description: z.string().describe(SUGGEST_TASK.params.description),
      priority: z.enum(SUGGEST_TASK.priorities).default(SUGGEST_TASK.defaultPriority),
      project: z.string().optional().describe(SUGGEST_TASK.params.project),
      blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
    },
  },
  async ({ title, description, priority, project, blocked_by }) => {
    // Resolve refs (id passes through; a title from earlier this turn, filed
    // into the same project → its id) before handing off — the endpoint just
    // forwards ids to setTaskDeps, which only keeps same-project ones.
    const deps = (blocked_by ?? []).map((ref) => {
      const hit = createdByTitle.get(titleKey(project, ref));
      return hit && hit !== AMBIGUOUS ? hit : ref;
    });
    const data = await callInternal("suggest-task", { title, description, priority, project, blocked_by: deps });
    if (data.id) {
      // The ref as typed is the alias that always exists ("" when omitted); the
      // resolved id/name (echoed by the endpoint) additionally let a later call
      // name the same project a different way, and "" lets it drop `project`
      // entirely when the target was this session's own project.
      // Deduped: the aliases overlap (filing into this session's own project
      // without naming it yields "" twice), and a repeat would look like two
      // tasks sharing a title and poison the entry.
      const aliases = [project ?? "", data.projectId, data.projectName, data.projectId === PROJECT_ID ? "" : null];
      for (const key of new Set(aliases.filter((a) => a != null).map((a) => titleKey(a, title)))) {
        createdByTitle.set(key, createdByTitle.has(key) ? AMBIGUOUS : data.id);
      }
    }
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  LIST_TASKS.name,
  {
    description: LIST_TASKS.description,
    inputSchema: {
      project: z.string().optional().describe(LIST_TASKS.params.project),
      include_done: z.boolean().optional().describe(LIST_TASKS.params.include_done),
    },
  },
  async ({ project, include_done }) => {
    const data = await callInternal("list-tasks", { project, include_done });
    return { content: [{ type: "text", text: JSON.stringify({ project: data.project, tasks: data.tasks ?? [] }, null, 2) }] };
  }
);

server.registerTool(
  GET_TASK.name,
  { description: GET_TASK.description, inputSchema: { task: z.string().optional().describe(GET_TASK.params.task) } },
  async ({ task }) => {
    // Omitted `task` means "my own", which only the server can resolve — the
    // endpoint falls back to ORCH_TASK_ID, sent on every call by callInternal.
    const data = await callInternal("get-task", { task });
    return { content: [{ type: "text", text: JSON.stringify(data.task, null, 2) }] };
  }
);

server.registerTool(
  UPDATE_TASK.name,
  {
    description: UPDATE_TASK.description,
    inputSchema: {
      task: z.string().optional().describe(UPDATE_TASK.params.task),
      title: z.string().optional().describe(UPDATE_TASK.params.title),
      description: z.string().optional().describe(UPDATE_TASK.params.description),
      priority: z.enum(UPDATE_TASK.priorities).optional().describe(UPDATE_TASK.params.priority),
      status: z.enum(UPDATE_TASK.statuses).optional().describe(UPDATE_TASK.params.status),
      // Ids only — no title lookup against `createdByTitle` the way suggest_task
      // does. That map dies with this process (one turn), so the same string
      // would resolve in one turn and be refused in the next; the two-phase
      // recipe hands the model real ids anyway.
      blocked_by: z.array(z.string()).optional().describe(UPDATE_TASK.params.blocked_by),
    },
  },
  async ({ task, title, description, priority, status, blocked_by }) => {
    // `task` is the target the MODEL chose, and it is forwarded unvalidated —
    // this bridge deliberately holds no policy. The endpoint decides what may
    // be written, against ORCH_TASK_ID (sent by callInternal as the trusted
    // caller identity, which nothing here can override).
    const data = await callInternal("update-task", { task, title, description, priority, status, blocked_by });
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  WITHDRAW_SUGGESTION.name,
  {
    description: WITHDRAW_SUGGESTION.description,
    inputSchema: {
      task: z.string().describe(WITHDRAW_SUGGESTION.params.task),
      reason: z.string().describe(WITHDRAW_SUGGESTION.params.reason),
    },
  },
  async ({ task, reason }) => {
    // Both values are the MODEL's, forwarded unvalidated — the bridge holds no
    // policy here either. The endpoint decides whether that target is an inert
    // tray suggestion, against ORCH_TASK_ID as the trusted caller identity.
    const data = await callInternal("withdraw-suggestion", { task, reason });
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  ASK_USER.name,
  {
    description: ASK_USER.description,
    inputSchema: {
      questions: z
        .array(
          z.object({
            question: z.string().describe("The full question to ask the user."),
            header: z.string().max(24).optional().describe("Short chip label for the question (≤12 chars ideal)."),
            multiSelect: z.boolean().optional().describe("Allow choosing more than one option."),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .min(1)
              .max(8)
              .describe("2–4 choices work best. The user can always type a free-text answer too."),
          })
        )
        .min(1)
        .max(4)
        .describe(ASK_USER.params.questions),
    },
  },
  async ({ questions }) => {
    // Start the ask (persists + publishes the interactive card), then poll for
    // the outcome. Polling instead of one held request: the user may take hours,
    // far beyond any HTTP timeout, and the ask survives page reloads server-side.
    const { askId } = await callInternal("ask-user", { questions });
    const deadline = Date.now() + 24 * 60 * 60 * 1000; // mirror the Claude hook's ~1-day cap
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await callInternal("ask-user/wait", { askId });
      if (r.status === "done") return { content: [{ type: "text", text: r.text }] };
      if (Date.now() > deadline) {
        return { content: [{ type: "text", text: "The user did not answer the question. Proceed with your best judgment." }] };
      }
    }
  }
);

// ---- runbooks: a saved recipe the user can dispatch later. Inert until they
// do, which is why create needs no review gate — but also why there is no
// delete verb, and why update is refused for any runbook a schedule fires. The
// bridge holds none of that policy; lib/runbookTools.ts does, shared with the
// in-process Claude server so the two cannot drift.
server.registerTool(
  CREATE_RUNBOOK.name,
  {
    description: CREATE_RUNBOOK.description,
    inputSchema: {
      name: z.string().describe(CREATE_RUNBOOK.params.name),
      description: z.string().describe(CREATE_RUNBOOK.params.description),
      prompt: z.string().describe(CREATE_RUNBOOK.params.prompt),
      priority: z.enum(["hi", "med", "lo"]).optional().describe(CREATE_RUNBOOK.params.priority),
      permission_mode: z.string().optional().describe(CREATE_RUNBOOK.params.permission_mode),
      project: z.string().optional().describe(CREATE_RUNBOOK.params.project),
    },
  },
  async (args) => {
    // No agent id is sent: the endpoint reads it off the CALLER'S row, so a
    // model cannot file a recipe under another agent's name.
    const data = await callInternal("create-runbook", args);
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  LIST_RUNBOOKS.name,
  {
    description: LIST_RUNBOOKS.description,
    inputSchema: { project: z.string().optional().describe(LIST_RUNBOOKS.params.project) },
  },
  async ({ project }) => {
    const data = await callInternal("list-runbooks", { project });
    return { content: [{ type: "text", text: data.text }] };
  }
);

server.registerTool(
  UPDATE_RUNBOOK.name,
  {
    description: UPDATE_RUNBOOK.description,
    inputSchema: {
      runbook: z.string().describe(UPDATE_RUNBOOK.params.runbook),
      name: z.string().optional().describe(UPDATE_RUNBOOK.params.name),
      description: z.string().optional().describe(UPDATE_RUNBOOK.params.description),
      prompt: z.string().optional().describe(UPDATE_RUNBOOK.params.prompt),
      priority: z.enum(["hi", "med", "lo"]).optional().describe(UPDATE_RUNBOOK.params.priority),
      permission_mode: z.string().optional().describe(UPDATE_RUNBOOK.params.permission_mode),
    },
  },
  async (args) => {
    const data = await callInternal("update-runbook", args);
    return { content: [{ type: "text", text: data.text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
