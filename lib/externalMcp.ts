// The Calandria tool set for agents running OUTSIDE Calandria, served over
// Streamable HTTP by app/api/mcp/route.ts. Same names, descriptions and policy
// functions as the in-session tools (lib/agentToolDefs.mjs, lib/agentTools.ts,
// lib/runbookTools.ts), with three differences that follow from the caller
// having no task of its own:
//
// - Every "which project" parameter is required. resolveTargetProject is passed
//   no calling project, so an omitted one is refused, never defaulted.
// - Writes are attributed to EXTERNAL_ACTOR, a synthetic actor whose id matches
//   no task row (task_agent_edits.actor_task_id has no foreign key for exactly
//   this). Edits to accepted tasks get the same "Changed by agent" chip and
//   Revert as an in-session edit.
// - The session-bound tools are absent: ask_user, expose_service, create_pr,
//   set_base_branch, report_base_rewrite, report_issue and the environment
//   settings pair all act on a calling session's own worktree or transcript.
//   `attachments` is absent too, since it copies files out of the caller's
//   worktree.
//
// Every handler answers through lib/agentToolGuard.mjs, like every other
// Calandria tool. Pinned SDK-free in tests/importGraph.test.ts, so the
// auto-start sweep a cleared blocker triggers is injected by the route
// (`onBlockerCleared`), the same split the internal agent-tools routes make
// with updateTaskForAgent's `autoStartDependents` flag.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CREATE_RUNBOOK,
  GET_TASK,
  LIST_PROJECTS,
  LIST_PROVIDERS,
  LIST_RUNBOOKS,
  LIST_TAGS,
  LIST_TASKS,
  MOVE_TASK,
  SUGGEST_TASK,
  UPDATE_RUNBOOK,
  UPDATE_TAG,
  UPDATE_TASK,
  WITHDRAW_SUGGESTION,
} from "./agentToolDefs.mjs";
import { guardToolHandler } from "./agentToolGuard.mjs";
import {
  createSuggestedTask,
  getTaskForAgent,
  listProjectsForAgent,
  listProvidersForAgent,
  listTagsForAgent,
  listTasksForAgent,
  moveTasksForAgent,
  resolveTagRefs,
  resolveTargetProject,
  updateTagForAgent,
  updateTaskForAgent,
  withdrawSuggestionForAgent,
  type AgentEditActor,
} from "./agentTools";
import { createRunbookForAgent, listRunbooksForAgent, updateRunbookForAgent } from "./runbookTools";
import { logAgentToolArrival } from "./agentToolLog";
import { AGENT_TOOL_TIMEOUT_MS } from "./config";
import { publish, publishGlobal } from "./events";
import type { Priority, Status } from "./types";

/** Who an external call is recorded as, on the board's agent-edit chip and audit rows. */
export const EXTERNAL_ACTOR: AgentEditActor = {
  id: "external-mcp",
  title: "External MCP client",
  agent: "external",
};

/** The tools this endpoint serves, in registration order. */
export const EXTERNAL_MCP_TOOLS = [
  LIST_PROJECTS.name,
  LIST_PROVIDERS.name,
  LIST_TASKS.name,
  GET_TASK.name,
  LIST_TAGS.name,
  SUGGEST_TASK.name,
  UPDATE_TASK.name,
  WITHDRAW_SUGGESTION.name,
  MOVE_TASK.name,
  UPDATE_TAG.name,
  CREATE_RUNBOOK.name,
  LIST_RUNBOOKS.name,
  UPDATE_RUNBOOK.name,
] as const;

const PROJECT_REQUIRED =
  "Project id, or its exact name (case-insensitive), from `list_projects`. Required: an external " +
  "client has no project of its own. An unrecognized value is refused.";

// Typed copies of the defs' enum lists (plain .mjs data), so a parsed value
// reaches the policy functions as a Priority/Status, not a string.
const PRIORITIES = SUGGEST_TASK.priorities as [Priority, ...Priority[]];
const STATUSES = UPDATE_TASK.statuses as [Status, ...Status[]];

const TASK_REQUIRED = "Task id, from `list_tasks`. Required: an external client has no task of its own.";

const INSTRUCTIONS =
  "Calandria's task board, reached from outside Calandria. You are not running as a Calandria " +
  "task, so every tool that takes `project` needs it (call `list_projects` first), and " +
  "`update_task` and `get_task` need `task`. Tool descriptions that mention \"this session\" or " +
  "\"your worktree\" describe in-session agents; here there is none. `suggest_task` files into the " +
  "user's Suggested tray for review. Edits to tasks the user already accepted are shown on the " +
  "board as changed by an agent, with a one-click revert. To order a plan, file every task with " +
  "`suggest_task`, wait for the ids, then call `update_task` with `blocked_by` per dependent task.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const refused = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));

export interface ExternalMcpHooks {
  /** A write moved this task to a terminal status; its auto_start dependents may now launch. */
  onBlockerCleared: (taskId: string) => void;
}

/**
 * A fresh server with every external tool registered. Built per request: the
 * route runs the transport stateless, so nothing here outlives one call.
 */
export function buildExternalMcpServer(hooks: ExternalMcpHooks): McpServer {
  const server = new McpServer({ name: "calandria", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  // The guard wrap and the arrival log, applied to every tool registered below.
  // The SDK's registerTool overloads don't survive a generic wrapper, so the
  // handler type is loosened here and the schemas stay checked at each call site.
  const register = <S extends z.ZodRawShape>(
    name: string,
    config: {
      description: string;
      inputSchema: S;
      annotations: Required<
        Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "openWorldHint" | "idempotentHint">
      >;
    },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
  ) => {
    const guarded = guardToolHandler(name, handler, {
      timeoutMs: AGENT_TOOL_TIMEOUT_MS,
      onStart: () => logAgentToolArrival(name, "external"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, config, guarded);
  };

  register(LIST_PROJECTS.name, {
    description: LIST_PROJECTS.description,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () =>
    json(listProjectsForAgent(""))
  );

  register(LIST_PROVIDERS.name, {
    description: LIST_PROVIDERS.description,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () =>
    json(listProvidersForAgent())
  );

  register(
    LIST_TASKS.name,
    {
      description: LIST_TASKS.description,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        project: z.string().describe(PROJECT_REQUIRED),
        include_done: z.boolean().optional().describe(LIST_TASKS.params.include_done),
        tags: z.array(z.string()).optional().describe(LIST_TASKS.params.tags),
        match: z.enum(["any", "all"]).optional().describe(LIST_TASKS.params.match),
      },
    },
    async ({ project, include_done, tags, match }) => {
      const target = resolveTargetProject(null, project, "Nothing was listed.");
      if ("error" in target) return refused(target.error);
      const tagRefs = resolveTagRefs(target.project, tags ?? []);
      if ("error" in tagRefs) return refused(`Could not list tasks: ${tagRefs.error}.`);
      const tasks = listTasksForAgent(target.project, "", include_done === true, {
        ids: tagRefs.tags.map((t) => t.id),
        match: match ?? "any",
      });
      return json({ project: target.project.name, tasks });
    }
  );

  register(
    GET_TASK.name,
    {
      description: GET_TASK.description,
      inputSchema: { task: z.string().describe(TASK_REQUIRED) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ task }) => {
      const id = task.trim();
      const detail = id ? getTaskForAgent(id, "") : null;
      return detail ? json(detail) : refused(`No task with id "${id}". Call list_tasks for the ids.`);
    }
  );

  register(
    LIST_TAGS.name,
    {
      description: LIST_TAGS.description,
      inputSchema: { project: z.string().describe(PROJECT_REQUIRED) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ project }) => {
      const target = resolveTargetProject(null, project, "Nothing was listed.");
      if ("error" in target) return refused(target.error);
      return json({ project: target.project.name, tags: listTagsForAgent(target.project) });
    }
  );

  register(
    SUGGEST_TASK.name,
    {
      description: SUGGEST_TASK.description,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      inputSchema: {
        title: z.string().describe(SUGGEST_TASK.params.title),
        description: z.string().describe(SUGGEST_TASK.params.description),
        priority: z.enum(PRIORITIES).default(SUGGEST_TASK.defaultPriority as Priority),
        project: z.string().describe(PROJECT_REQUIRED),
        blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
        tags: z.array(z.string()).optional().describe(SUGGEST_TASK.params.tags),
        environment: z.string().optional().describe(SUGGEST_TASK.params.environment),
        provider: z.string().optional().describe(SUGGEST_TASK.params.provider),
        model: z.string().optional().describe(SUGGEST_TASK.params.model),
        reasoning: z
          .enum(["off", "think", "think_hard", "ultrathink"])
          .nullable()
          .optional()
          .describe(SUGGEST_TASK.params.reasoning),
      },
    },
    async ({ title, description, priority, project, blocked_by, tags, environment, provider, model, reasoning }) => {
      if (!title.trim()) return refused("A task needs a title. Nothing was created.");
      const target = resolveTargetProject(null, project);
      if ("error" in target) return refused(target.error);
      const { task, text: out } = createSuggestedTask(target.project, {
        title,
        description,
        priority,
        blocked_by,
        tags,
        origin_task_id: null,
        environment,
        provider,
        model,
        reasoning,
      });
      if (!task) return refused(out);
      // Keyed by the new task: /api/events re-reads that row, and the
      // `suggested` event is what refreshes the target project's tray live.
      publish(task.id, { type: "suggested", title: task.title, projectId: target.project.id, taskId: task.id });
      return text(out);
    }
  );

  register(
    UPDATE_TASK.name,
    {
      description: UPDATE_TASK.description,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        task: z.string().describe(TASK_REQUIRED),
        title: z.string().optional().describe(UPDATE_TASK.params.title),
        description: z.string().optional().describe(UPDATE_TASK.params.description),
        priority: z.enum(PRIORITIES).optional().describe(UPDATE_TASK.params.priority),
        status: z.enum(STATUSES).optional().describe(UPDATE_TASK.params.status),
        blocked_by: z.array(z.string()).optional().describe(UPDATE_TASK.params.blocked_by),
        tags: z.array(z.string()).optional().describe(UPDATE_TASK.params.tags),
      },
    },
    async ({ task, ...fields }) => {
      // An empty ref would make updateTaskForAgent target the caller's own
      // row, and this caller has none.
      if (!task.trim()) return refused(`\`task\` is required. ${TASK_REQUIRED} Nothing was changed.`);
      const { task: updated, text: out, autoStartDependents: sweep } = await updateTaskForAgent(EXTERNAL_ACTOR, task, fields);
      if (!updated) return refused(out);
      if (sweep) hooks.onBlockerCleared(updated.id);
      return text(out);
    }
  );

  register(
    WITHDRAW_SUGGESTION.name,
    {
      description: WITHDRAW_SUGGESTION.description,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        task: z.string().describe(WITHDRAW_SUGGESTION.params.task),
        reason: z.string().describe(WITHDRAW_SUGGESTION.params.reason),
      },
    },
    async ({ task, reason }) => {
      const { task: updated, text: out, autoStartDependents: sweep } = withdrawSuggestionForAgent(EXTERNAL_ACTOR, task, reason);
      if (!updated) return refused(out);
      if (sweep) hooks.onBlockerCleared(updated.id);
      return text(out);
    }
  );

  register(
    MOVE_TASK.name,
    {
      description: MOVE_TASK.description,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        tasks: z.array(z.string()).describe(MOVE_TASK.params.tasks),
        project: z.string().describe(MOVE_TASK.params.project),
      },
    },
    async ({ tasks, project }) => {
      const { ok, text: out } = await moveTasksForAgent(EXTERNAL_ACTOR, tasks, project);
      return ok ? text(out) : refused(out);
    }
  );

  register(
    UPDATE_TAG.name,
    {
      description: UPDATE_TAG.description,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        project: z.string().describe(PROJECT_REQUIRED),
        tag: z.string().describe(UPDATE_TAG.params.tag),
        name: z.string().optional().describe(UPDATE_TAG.params.name),
        description: z.string().optional().describe(UPDATE_TAG.params.description),
        color: z.string().optional().describe(UPDATE_TAG.params.color),
        base_branch: z.string().optional().describe(UPDATE_TAG.params.base_branch),
      },
    },
    async ({ project, tag, ...fields }) => {
      const target = resolveTargetProject(null, project, "Nothing was changed.");
      if ("error" in target) return refused(target.error);
      const { tag: updated, text: out } = updateTagForAgent(target.project, tag, fields);
      return updated ? text(out) : refused(out);
    }
  );

  register(
    CREATE_RUNBOOK.name,
    {
      description: CREATE_RUNBOOK.description,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      inputSchema: {
        name: z.string().describe(CREATE_RUNBOOK.params.name),
        description: z.string().describe(CREATE_RUNBOOK.params.description),
        prompt: z.string().describe(CREATE_RUNBOOK.params.prompt),
        priority: z.enum(PRIORITIES).optional().describe(CREATE_RUNBOOK.params.priority),
        permission_mode: z.string().optional().describe(CREATE_RUNBOOK.params.permission_mode),
        project: z.string().describe(PROJECT_REQUIRED),
        environment: z.string().optional().describe(CREATE_RUNBOOK.params.environment),
        provider: z.string().optional().describe(CREATE_RUNBOOK.params.provider),
        model: z.string().optional().describe(CREATE_RUNBOOK.params.model),
      },
    },
    async ({ project, ...input }) => {
      const target = resolveTargetProject(null, project);
      if ("error" in target) return refused(target.error);
      // The resolved project is passed as the "current" one, so the runbook
      // lands there; created_by records the external actor.
      const { runbook, text: out } = createRunbookForAgent(target.project, input, EXTERNAL_ACTOR.agent);
      if (!runbook) return refused(out);
      publishGlobal("", { type: "runbooks_changed", projectId: runbook.project_id });
      return text(out);
    }
  );

  register(
    LIST_RUNBOOKS.name,
    {
      description: LIST_RUNBOOKS.description,
      inputSchema: { project: z.string().describe(PROJECT_REQUIRED) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ project }) => {
      const target = resolveTargetProject(null, project, "Nothing was listed.");
      if ("error" in target) return refused(target.error);
      const out = listRunbooksForAgent(target.project, undefined);
      return "error" in out ? refused(out.error) : json(out);
    }
  );

  register(
    UPDATE_RUNBOOK.name,
    {
      description: UPDATE_RUNBOOK.description,
      // Each nonempty patch stamps updated_at, so repeating a call has an additional effect.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      inputSchema: {
        runbook: z.string().describe(UPDATE_RUNBOOK.params.runbook),
        name: z.string().optional().describe(UPDATE_RUNBOOK.params.name),
        description: z.string().optional().describe(UPDATE_RUNBOOK.params.description),
        prompt: z.string().optional().describe(UPDATE_RUNBOOK.params.prompt),
        priority: z.enum(PRIORITIES).optional().describe(UPDATE_RUNBOOK.params.priority),
        permission_mode: z.string().optional().describe(UPDATE_RUNBOOK.params.permission_mode),
        provider: z.string().optional().describe(UPDATE_RUNBOOK.params.provider),
        model: z.string().optional().describe(UPDATE_RUNBOOK.params.model),
      },
    },
    async ({ runbook, ...fields }) => {
      // Runbook ids are global, so no project is needed to find one.
      const { runbook: updated, text: out } = updateRunbookForAgent(null, runbook, fields);
      if (!updated) return refused(out);
      publishGlobal("", { type: "runbooks_changed", projectId: updated.project_id });
      return text(out);
    }
  );

  return server;
}
