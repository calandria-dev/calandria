// The Claude Code driver — the Agent SDK behind the AgentDriver seam
// (lib/agents/types.ts). This is the moved lib/claude.ts: runTurn() drives one
// user turn (resume or fresh session; project context appended to the Claude
// Code system prompt), mounts the Calandria MCP tools (suggest_task /
// list_projects / list_tasks / get_task / update_task / withdraw_suggestion /
// expose_service), and normalizes SDK messages into the StreamEvent contract.
// The one-shot helpers
// (summarize / draft / recap) and the wizard's auth flow (delegating to
// lib/claude-auth.ts) round out the interface.

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSummary, CanUseTool, PermissionMode, PermissionResult, SDKUserMessage, SessionCronSummary, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { planSessionCrons, cronThatWoke, lingerNote, describeCron, cancelledCronsNotice, wakeTimeLabel, type PlannedCron } from "./sessionCrons";
import { z } from "zod";
import type {
  Project,
  Task,
  StreamEvent,
  AskQuestion,
  TurnUsage,
  Priority,
  Status as TaskStatus,
  PermissionOutcome,
  PermissionRequest,
} from "../../types";
import type { AgentDriver, OneShotOptions, OneShotResult, TurnHooks } from "../types";
import { claudeCapabilities } from "./capabilities";
import { listClaudeCommands, recordMcpPrompts } from "./commands";
import { getClaudePlanUsage, recordClaudeRateLimit } from "./planUsage";
import { getSetting, listPermissionRules, addPermissionRule } from "../../store";
import { registerTurnInput, unregisterTurnInput, type TurnInputHandle } from "../../turnInput";
import {
  createSuggestedTask,
  getTaskForAgent,
  listTagsForAgent,
  listProjectsForAgent,
  listTasksForAgent,
  moveTasksForAgent,
  registerExposedService,
  rememberSuggestedTitle,
  resolveTagRefs,
  resolveTargetProject,
  resolveTitleRefs,
  setBaseBranchForAgent,
  updateTagForAgent,
  updateTaskForAgent,
  withdrawSuggestionForAgent,
} from "../../agentTools";
import { SUGGEST_TASK, EXPOSE_SERVICE, LIST_PROJECTS, LIST_TASKS, LIST_TAGS, GET_TASK, UPDATE_TASK, MOVE_TASK, UPDATE_TAG, SET_BASE_BRANCH, CREATE_PR, WITHDRAW_SUGGESTION, CREATE_RUNBOOK, LIST_RUNBOOKS, UPDATE_RUNBOOK } from "../../agentToolDefs.mjs";
import { createPrForAgent } from "../../prTools";
import { createRunbookForAgent, listRunbooksForAgent, updateRunbookForAgent } from "../../runbookTools";
import { publishGlobal } from "../../events";
import { waitForAnswer, ASK_DISMISSED_REPLY, ASK_INTERRUPTED_NOTE } from "../../asks";
import {
  allowedByRules,
  blockedReason,
  denyMessage,
  describePermission,
  isAlwaysAllowed,
  parseDecision,
  promptDeadline,
  scopeOfferFor,
  waitForPermission,
  DENIED_BY_USER,
  DENIED_TIMED_OUT,
  DENIED_UNATTENDED,
} from "../../permissions";
import {
  AGENT_TOOL_TIMEOUT_MS,
  BACKGROUND_LINGER_ENABLED,
  BACKGROUND_LINGER_MS,
  CLAUDE_CLI_PATH as CLAUDE_PATH,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PERMISSION_UNATTENDED_MS,
} from "../../config";
import { guardToolHandler, isCalandriaToolName, isCliInterruptedToolResult, toolInterruptedMessage } from "../../agentToolGuard.mjs";
import { createLogger } from "../../log.mjs";
import { interactionDenied, UNATTENDED_ASK_DENIAL, UNATTENDED_ASK_NOTE } from "../../runContext";
import { isUsageLimit } from "../../usageLimit";
import { hasApiKey, looksLikeApiKey, setApiKey, clearApiKey } from "../../anthropic-key";
import {
  buildProjectContext,
  describeToolUse,
  summarizeResult,
  summarizeFailure,
  formatAnswers,
  makeQueue,
  resultText,
  clip,
  clipKeepTail,
  buildTagRefreshPrompt,
  type ResultKind,
} from "../shared";
import {
  claudeStatus,
  startClaudeLogin,
  getClaudeLogin,
  submitClaudeCode,
  cancelClaudeLogin,
  verifyTurn,
} from "../../claude-auth";
import { claudeUsage, claudeSubagentTokens, claudeMessageModel } from "./usage";
import { agentTurnEnv } from "../../agentEnv";

const log = createLogger("claude");

// Which on-disk setting sources every Claude query loads, pinned explicitly
// rather than left to the SDK default (sdk.d.ts: "when omitted, all sources
// are loaded, matches CLI defaults") — so an SDK bump can change that default
// without silently changing what a task trusts. Written out here so there is
// a line to grep for and a test to fail (tests/claudeSettingSources.test.ts).
//
// Each source is a JSON file the SDK merges in, and none of the keys it can
// carry are inert: `hooks` runs literal shell commands on tool/session events,
// entirely outside canUseTool — the permission gate never sees a hook fire.
// `permissions.allow` is auto-approved without a canUseTool call at all, and
// `env` reaches every subprocess a tool spawns. Loading a source is handing it
// that surface, not just its intent.
//
// 'user' (~/.claude/settings.json) is the operator's own machine, outside any
// task's worktree — a task can't write it, so it carries no more trust than
// the person running Calandria already has.
//
// 'project' (<worktree>/.claude/settings.json) is what loads CLAUDE.md, and a
// task's worktree is exactly where an agent's own writes land — so this file
// is as writable as anything else the agent touches. It stays in because it's
// tracked: it shows up in the same diff (TaskChanges) the user reviews before
// anything merges, so a hook smuggled in here is a hook the review step is
// supposed to catch.
//
// 'local' (<worktree>/.claude/settings.local.json) is dropped. It resolves
// against the same worktree, so it's just as agent-writable as 'project' —
// but by convention it's gitignored, meaning it never appears in that diff.
// An agent running under an auto-accept edit policy (Write pre-approved, no
// canUseTool round-trip) can create this file with a PreToolUse hook, and the
// very next turn that hook runs as a shell command with no permission check
// in between — the classifier, the permission card, all of it bypassed,
// because settingSources loaded the file before either had a chance to look
// at it. 'project' is worktree-writable too, but at least a human reviewing
// the diff has a shot at catching it; 'local' guarantees they never see it.
//
// The other half — these files are re-read from disk on EVERY turn, so
// nothing stopped a worktree's settings.json from drifting between the turn a
// human reviewed and the turn that runs next — is closed by
// WATCHED_SETTINGS_FILES below (issue #43), not by narrowing this list.
//
// EXPORTED because it is load-bearing outside this file too: the schedule
// preflight (lib/schedule/commands.ts) opens a throwaway session purely to read
// the slash-command registry a scheduled turn would get, and validates against
// it. A second hardcoded copy there would mean the two could drift — and a
// drifted registry doesn't degrade quietly: an unknown command settles the run
// `failed` and mints nothing, every morning. Pinned by
// tests/claudeSettingSources.test.ts, which drives the real probe through the
// mocked SDK and reads the sources back.
export const SETTING_SOURCES: SettingSource[] = ["user", "project"];

// Where each source resolves, for the sources that resolve INSIDE the task's
// own working directory — the ones a turn can rewrite for the next turn.
//
// A total Record over the SDK's SettingSource union on purpose, so the mapping
// can't fall behind the union: if a future SDK adds a tier, this stops
// compiling and somebody has to say where it lives and whether a task can write
// it, rather than the new source quietly joining SETTING_SOURCES unwatched.
// 'user' is ~/.claude/settings.json — the operator's own machine, outside every
// worktree and no more trusted than the person running Calandria — so it maps
// to null and is deliberately not watched: it changes when the operator changes
// it, and holding a turn on that would be a card raised against yourself.
export const WORKTREE_SETTINGS_FILE: Record<SettingSource, string | null> = {
  user: null,
  project: ".claude/settings.json",
  local: ".claude/settings.local.json",
};

// What the runner hashes before every turn on a Claude task (issue #43).
//
// DERIVED from SETTING_SOURCES rather than written out, which is the whole
// point: the two facts — "which sources a turn loads" and "which files drift
// detection covers" — are one fact with one source of truth, so re-adding
// 'local' to the list above extends the gate to it in the same edit instead of
// re-opening the hole under a second, silent name. Pinned by
// tests/claudeSettingSources.test.ts, which asserts the DERIVATION rather than
// the current value; the runner half is tests/settingsDrift.test.ts.
export const WATCHED_SETTINGS_FILES: string[] = SETTING_SOURCES.flatMap(
  (source) => WORKTREE_SETTINGS_FILE[source] ?? []
);

// Where a session for this task runs: its isolated worktree, falling back to
// the shared repo path (non-git projects, or worktree creation skipped).
// Shared with command discovery deliberately — `.claude/commands` in the
// checked-out repo is part of the answer, so the menu is only telling the truth
// while it's rooted where the turn will be.
function sessionCwd(task: Task, project: Project): string {
  return task.worktree_path || project.repo_path || process.cwd();
}

// The one-shots below are a different animal, and they get a different policy.
// A handoff note or a four-bullet recap is an internal transformation, not a
// session the user is sitting in: it has no Calandria bridge, no transcript,
// no way to answer a prompt. Inheriting the full session config made every one
// of them spawn the user's entire MCP fleet — measured on this machine: 10
// servers, 146 MCP tools in context, ~8s of a ~5s job — purely to offer tools
// the job can never use.
//
// So the one-shots isolate CAPABILITY and inherit CONFIG — the same split the
// Codex driver's oneShot() already makes (read-only sandbox, no network, the
// user's MCP servers unmounted, but ~/.codex/config.toml still read for auth
// and model). Four levers do it, and NONE of them was set before:
//
//   tools           — the REAL restriction. `allowedTools` is NOT one: the SDK
//                     defines it as "auto-allowed without prompting", and under
//                     bypassPermissions everything is auto-allowed anyway. All
//                     three helpers passed `allowedTools` and got the full
//                     toolset regardless — verified against CLI 2.1.228, where
//                     `allowedTools: []` happily ran Read and the "read-only"
//                     draft agent below happily ran Write.
//   strictMcpConfig — drops MCP from settings, .mcp.json and plugins. `tools`
//                     alone doesn't: it governs built-ins only, so the fleet
//                     survived it (146 tools left, 0 of them built-in).
//   settings        — inline overrides, merged over whatever the sources below
//                     loaded. `disableAllHooks` is the one that matters: the
//                     user's hooks live in ~/.claude/settings.json and a
//                     SessionStart hook injects context into a four-bullet
//                     recap whether or not any tool exists to hook. Verified
//                     both ways — with it the injection is gone, and the same
//                     run still authenticates. (`managedSettings` does NOT work
//                     here: the SDK filters that tier restrictive-only and the
//                     key doesn't survive. Also don't reach for it — it
//                     impersonates the IT policy tier and a real one displaces
//                     it.) `autoMemoryEnabled: false` keeps the user's private
//                     per-project memory out of an internal transformation.
//   settingSources  — kept at ["user"], NOT []. This is where isolate-everything
//                     advice goes wrong: ~/.claude/settings.json is also where a
//                     user's `env` block, `apiKeyHelper` and model aliases live,
//                     so it is load-bearing for AUTH and provider ROUTING, not
//                     just for MCP and plugins. Measured on a Vertex-configured
//                     machine with those vars absent from the server's own
//                     environment (the normal case — the server is started from
//                     a plain shell, not from inside a Claude session): `[]`
//                     fails the run outright with "Not logged in", `["user"]`
//                     succeeds with 0 tools and 0 MCP servers. Isolating here
//                     would break recap and /clear for every Bedrock / Vertex /
//                     proxy / apiKeyHelper user while their ordinary turns kept
//                     working — the worst shape of bug we could ship.
//
// 'project' and 'local' are dropped from the text-only helpers: their only
// remaining contribution is the repo's CLAUDE.md, which for a pure text
// transformation is thousands of tokens that can only skew the output.
// draftProjectContext keeps 'project' — see its own note.
const ONE_SHOT_SETTING_SOURCES: SettingSource[] = ["user"];

// What all three one-shots share, whatever tools they end up with.
const ONE_SHOT_BASE = {
  strictMcpConfig: true,
  // The Skill tool isn't in any one-shot's `tools`, so this is belt-and-braces
  // against the discovery pass rather than a second gate.
  skills: [] as string[],
  // These runs are unresumable by construction — nothing stores their session
  // id. Persisting would only litter ~/.claude/projects with recap turns the
  // user's own `claude --resume` list then has to show them.
  persistSession: false,
  settings: { disableAllHooks: true, autoMemoryEnabled: false },
  // Belt-and-braces too: a one-shot has no UI to answer a permission card, so
  // if a future edit adds a tool it must not start prompting into the void.
  permissionMode: "bypassPermissions" as PermissionMode,
  pathToClaudeCodeExecutable: CLAUDE_PATH,
};

// The two text-only one-shots (handoff note, recap): no tools at all, one turn,
// and only the user's own settings, for auth.
const TEXT_ONE_SHOT = {
  ...ONE_SHOT_BASE,
  settingSources: ONE_SHOT_SETTING_SOURCES,
  tools: [] as string[],
  maxTurns: 1,
};

/**
 * Every tool on the server above goes through lib/agentToolGuard.mjs, applied to
 * the ARRAY rather than written into each handler. Two reasons it is done here
 * and not fourteen times below: a tool added later cannot forget to be loud, and
 * there is nowhere for the two ends of the seam to drift apart (the stdio bridge
 * wraps its own registrations the same way, with the same module).
 *
 * The guard only ever replaces an answer that isn't one — a throw, a call that
 * ran past its bound, or the empty result this whole thing is named for. A
 * handler that returns normally is passed through untouched, `isError` included.
 *
 * The generic keeps each tool's own argument types: `never` parameters are
 * assignable from any handler's, so this constraint accepts the heterogeneous
 * array without widening any tool to `any`.
 */
function guardTools<T extends { name: string; handler: (args: never, extra: never) => Promise<unknown> }>(tools: T[]): T[] {
  return tools.map((t) => ({ ...t, handler: guardToolHandler(t.name, t.handler, { timeoutMs: AGENT_TOOL_TIMEOUT_MS }) }) as T);
}

function calandriaServer(
  project: Project,
  task: Task,
  onSuggest: (s: { title: string; projectId: string; taskId: string }) => void,
  onExpose: (info: { name: string; url: string }) => void,
  // Injected, never imported: see TurnHooks in lib/agents/types.ts for why this
  // file must not name lib/autoStart.ts. Absent = nothing to notify (a driver
  // run outside the runner), so the sweep is simply skipped.
  hooks?: TurnHooks
) {
  // Titles created this session, so `blocked_by` can reference earlier suggestions
  // by title (not just id) — friendlier for the model when planning a roadmap.
  // Keyed by (target project, title): a suggestion can be filed into any project
  // and dependencies never cross one, so the same title in two projects is two
  // unrelated tasks rather than an ambiguous ref.
  const createdByTitle = new Map<string, string>();
  return createSdkMcpServer({
    name: "calandria",
    version: "1.0.0",
    tools: guardTools([
      tool(
        EXPOSE_SERVICE.name,
        EXPOSE_SERVICE.description,
        {
          name: z.string().describe(EXPOSE_SERVICE.params.name),
          port: z.number().int().positive().describe(EXPOSE_SERVICE.params.port),
        },
        async (args: { name: string; port: number }) => {
          const { info, url, text } = registerExposedService(project, args.name, args.port);
          onExpose({ name: info.name, url });
          return { content: [{ type: "text", text }] };
        }
      ),
      tool(LIST_PROJECTS.name, LIST_PROJECTS.description, {}, async () => ({
        content: [{ type: "text", text: JSON.stringify(listProjectsForAgent(project.id), null, 2) }],
      })),
      tool(
        SUGGEST_TASK.name,
        SUGGEST_TASK.description,
        {
          title: z.string().describe(SUGGEST_TASK.params.title),
          description: z.string().describe(SUGGEST_TASK.params.description),
          priority: z.enum(["hi", "med", "lo"]).default("med"),
          project: z.string().optional().describe(SUGGEST_TASK.params.project),
          blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
          tags: z.array(z.string()).optional().describe(SUGGEST_TASK.params.tags),
          provider: z.enum(["local", "cloud"]).optional().describe(SUGGEST_TASK.params.provider),
          model: z.string().optional().describe(SUGGEST_TASK.params.model),
        },
        async (args: { title: string; description: string; priority: "hi" | "med" | "lo"; project?: string; blocked_by?: string[]; tags?: string[]; provider?: "local" | "cloud"; model?: string }) => {
          // Which project this lands in, before anything else: the task's agent,
          // send_context and board position all come from it, and a wrong answer
          // is a misfiled task rather than a visible failure. Strict — an
          // unrecognized name is refused, never quietly treated as "here".
          const target = resolveTargetProject(project, args.project);
          if ("error" in target) return { content: [{ type: "text", text: target.error }], isError: true };

          // Resolve refs (id passes through; a title from earlier this session,
          // filed into the SAME project, maps to its id) then create + wire deps
          // via the shared logic. Record this task's title→id so later
          // suggestions into that project can reference it by title.
          // Aliased before the destructure below shadows the closed-over
          // caller — `task` inside this block is the task being CREATED.
          const originTaskId = task.id;
          const { task: created, text } = createSuggestedTask(target.project, {
            title: args.title,
            description: args.description,
            priority: args.priority,
            blocked_by: resolveTitleRefs(args.blocked_by, createdByTitle, target.project.id),
            // Resolved (and created on a miss) inside the TARGET project by
            // createSuggestedTask — a cross-project suggestion tags where it
            // lands. The origin is the closed-over caller, never a parameter.
            tags: args.tags,
            origin_task_id: originTaskId,
            provider: args.provider,
            model: args.model,
          });
          // A null task = the project was deleted mid-turn; `text` already says so.
          if (created) {
            rememberSuggestedTitle(createdByTitle, target.project.id, args.title, created.id);
            onSuggest({ title: args.title, projectId: target.project.id, taskId: created.id });
          }
          return { content: [{ type: "text", text }] };
        }
      ),
      tool(
        LIST_TASKS.name,
        LIST_TASKS.description,
        {
          project: z.string().optional().describe(LIST_TASKS.params.project),
          include_done: z.boolean().optional().describe(LIST_TASKS.params.include_done),
          tag: z.string().optional().describe(LIST_TASKS.params.tag),
        },
        async (args: { project?: string; include_done?: boolean; tag?: string }) => {
          // Same strict resolution suggest_task uses — reads are inert, but a
          // board silently listed from the wrong project is still a lie.
          const target = resolveTargetProject(project, args.project);
          if ("error" in target) return { content: [{ type: "text", text: target.error }], isError: true };
          // …and the same for the tag filter: an unrecognized one must not
          // quietly hand back the whole board as if the feature had that many
          // members. Never creates — this is a read.
          const tag = resolveTagRefs(target.project, args.tag ? [args.tag] : []);
          if ("error" in tag)
            return { content: [{ type: "text", text: `Could not list tasks: ${tag.error}.` }], isError: true };
          const tasks = listTasksForAgent(target.project, task.id, args.include_done ?? false, tag.tags[0]?.id ?? null);
          return { content: [{ type: "text", text: JSON.stringify({ project: target.project.name, tasks }, null, 2) }] };
        }
      ),
      tool(
        LIST_TAGS.name,
        LIST_TAGS.description,
        { project: z.string().optional().describe(LIST_TAGS.params.project) },
        async (args: { project?: string }) => {
          const target = resolveTargetProject(project, args.project);
          if ("error" in target) return { content: [{ type: "text", text: target.error }], isError: true };
          const tags = listTagsForAgent(target.project);
          return { content: [{ type: "text", text: JSON.stringify({ project: target.project.name, tags }, null, 2) }] };
        }
      ),
      tool(
        GET_TASK.name,
        GET_TASK.description,
        { task: z.string().optional().describe(GET_TASK.params.task) },
        async (args: { task?: string }) => {
          const id = args.task?.trim() || task.id;
          const detail = getTaskForAgent(id, task.id);
          if (!detail) return { content: [{ type: "text", text: `No task with id "${id}". Call list_tasks for the ids.` }], isError: true };
          return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
        }
      ),
      tool(
        UPDATE_TASK.name,
        UPDATE_TASK.description,
        {
          task: z.string().optional().describe(UPDATE_TASK.params.task),
          title: z.string().optional().describe(UPDATE_TASK.params.title),
          description: z.string().optional().describe(UPDATE_TASK.params.description),
          // Spelled out rather than read from UPDATE_TASK.priorities/.statuses:
          // the defs are plain .mjs, so TS widens those arrays to string[] and
          // z.enum loses the literal union. Same trade suggest_task makes above;
          // tests/codexMcpBridge.test.ts pins these against the shared arrays.
          priority: z.enum(["hi", "med", "lo"]).optional().describe(UPDATE_TASK.params.priority),
          status: z.enum(["not_started", "in_progress", "on_hold", "done"]).optional().describe(UPDATE_TASK.params.status),
          blocked_by: z.array(z.string()).optional().describe(UPDATE_TASK.params.blocked_by),
          tags: z.array(z.string()).optional().describe(UPDATE_TASK.params.tags),
        },
        async (args: { task?: string; title?: string; description?: string; priority?: Priority; status?: TaskStatus; blocked_by?: string[]; tags?: string[] }) => {
          // The closed-over `task` is the CALLER — the snapshot taken at turn
          // start, and the one identity the model can't influence. `args.task`
          // is the target it named; updateTaskForAgent decides whether that may
          // be written and re-reads both rows first, so a task deleted or
          // started mid-turn is a refusal rather than a stale write.
          const { task: updated, text, autoStartDependents } = updateTaskForAgent(task, args.task, args);
          // Reported to the launcher, not acted on here: the sweep lives in
          // lib/autoStart.ts and this file must not reach it (TurnHooks).
          if (autoStartDependents && updated) hooks?.onTaskCleared(updated.id);
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
        }
      ),
      tool(
        MOVE_TASK.name,
        MOVE_TASK.description,
        {
          tasks: z.array(z.string()).describe(MOVE_TASK.params.tasks),
          project: z.string().describe(MOVE_TASK.params.project),
        },
        async (args: { tasks: string[]; project: string }) => {
          // Same trust split as update_task: the closed-over `task` is the
          // caller (the server's word), `args.tasks` the targets (the model's).
          // No discard acknowledgement is accepted here on purpose — a started
          // task's checkout can only be destroyed with the user's per-task
          // answer, which they give from the board.
          const { ok, text } = await moveTasksForAgent(task, args.tasks, args.project);
          return { content: [{ type: "text", text }], ...(ok ? {} : { isError: true }) };
        }
      ),
      tool(
        WITHDRAW_SUGGESTION.name,
        WITHDRAW_SUGGESTION.description,
        {
          task: z.string().describe(WITHDRAW_SUGGESTION.params.task),
          reason: z.string().describe(WITHDRAW_SUGGESTION.params.reason),
        },
        async (args: { task: string; reason: string }) => {
          // Same trust split as update_task: the closed-over `task` is the
          // caller (the server's word), `args.task` the target (the model's).
          // Eligibility is the shared isInertSuggestion, so a row this tool will
          // withdraw is exactly a row update_task would edit.
          const { task: updated, text, autoStartDependents } = withdrawSuggestionForAgent(task, args.task, args.reason);
          // Cancelling cleared a blocker — same hand-off as update_task's above.
          if (autoStartDependents && updated) hooks?.onTaskCleared(updated.id);
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
        }
      ),
      tool(
        SET_BASE_BRANCH.name,
        SET_BASE_BRANCH.description,
        {
          branch: z.string().describe(SET_BASE_BRANCH.params.branch),
          task: z.string().optional().describe(SET_BASE_BRANCH.params.task),
        },
        async (args: { branch: string; task?: string }) => {
          // Same trust split as update_task: the closed-over `task` is the
          // caller (the server's word), `args.task` the target (the model's).
          // Everything else — the refusals, the git, the reconciliation — is in
          // lib/baseBranch.ts, shared with POST /api/tasks/[id]/base-branch.
          const { task: updated, text } = await setBaseBranchForAgent(task, args.task, args.branch);
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
        }
      ),
      // Only on a project that lands by pull request. On a merge project there
      // is nothing for it to open, so it is absent rather than present-and-
      // refusing: an offered tool reads as a sanctioned move, and the session
      // has already been told (landingSentence) that this project merges.
      // The bridge gates the same way, off CALANDRIA_LANDING_MODE.
      ...(project.landing_mode === "pr"
        ? [
            tool(
              CREATE_PR.name,
              CREATE_PR.description,
              {
                title: z.string().optional().describe(CREATE_PR.params.title),
                body: z.string().optional().describe(CREATE_PR.params.body),
              },
              async (args: { title?: string; body?: string }) => {
                // Own row only — no target parameter, so nothing here is the
                // model's word for WHICH task. The closed-over `task` is the
                // caller, and lib/prTools.ts re-reads it: this turn's snapshot
                // predates its own worktree cut.
                const { url, text } = await createPrForAgent(task, args, (id) => hooks?.onPrOpened(id));
                return { content: [{ type: "text", text }], ...(url ? {} : { isError: true }) };
              }
            ),
          ]
        : []),
      tool(
        UPDATE_TAG.name,
        UPDATE_TAG.description,
        {
          tag: z.string().describe(UPDATE_TAG.params.tag),
          name: z.string().optional().describe(UPDATE_TAG.params.name),
          description: z.string().optional().describe(UPDATE_TAG.params.description),
          color: z.string().optional().describe(UPDATE_TAG.params.color),
          base_branch: z.string().optional().describe(UPDATE_TAG.params.base_branch),
        },
        async (args: { tag: string; name?: string; description?: string; color?: string; base_branch?: string }) => {
          // Tags never span projects, so this is scoped to the session's own —
          // no resolveTargetProject, and no `project` param to get wrong.
          const { tag: updated, text } = updateTagForAgent(project, args.tag, args);
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
        }
      ),
      tool(
        CREATE_RUNBOOK.name,
        CREATE_RUNBOOK.description,
        {
          name: z.string().describe(CREATE_RUNBOOK.params.name),
          description: z.string().describe(CREATE_RUNBOOK.params.description),
          prompt: z.string().describe(CREATE_RUNBOOK.params.prompt),
          priority: z.enum(["hi", "med", "lo"]).optional().describe(CREATE_RUNBOOK.params.priority),
          permission_mode: z.string().optional().describe(CREATE_RUNBOOK.params.permission_mode),
          project: z.string().optional().describe(CREATE_RUNBOOK.params.project),
        },
        async (args: { name: string; description: string; prompt: string; priority?: "hi" | "med" | "lo"; permission_mode?: string; project?: string }) => {
          // The agent id is the SERVER's word (this driver is Claude), never a
          // parameter — a model must not be able to file a recipe under another
          // agent's name.
          const { runbook, text } = createRunbookForAgent(project, args, "claude");
          // Refresh whichever project's card gained the row — which, thanks to
          // `project`, isn't necessarily the one on screen.
          if (runbook) publishGlobal("", { type: "runbooks_changed", projectId: runbook.project_id });
          return { content: [{ type: "text", text }], ...(runbook ? {} : { isError: true }) };
        }
      ),
      tool(
        LIST_RUNBOOKS.name,
        LIST_RUNBOOKS.description,
        { project: z.string().optional().describe(LIST_RUNBOOKS.params.project) },
        async (args: { project?: string }) => {
          const out = listRunbooksForAgent(project, args.project);
          if ("error" in out) return { content: [{ type: "text", text: out.error }], isError: true };
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        }
      ),
      tool(
        UPDATE_RUNBOOK.name,
        UPDATE_RUNBOOK.description,
        {
          runbook: z.string().describe(UPDATE_RUNBOOK.params.runbook),
          name: z.string().optional().describe(UPDATE_RUNBOOK.params.name),
          description: z.string().optional().describe(UPDATE_RUNBOOK.params.description),
          prompt: z.string().optional().describe(UPDATE_RUNBOOK.params.prompt),
          priority: z.enum(["hi", "med", "lo"]).optional().describe(UPDATE_RUNBOOK.params.priority),
          permission_mode: z.string().optional().describe(UPDATE_RUNBOOK.params.permission_mode),
        },
        async (args: { runbook: string; name?: string; description?: string; prompt?: string; priority?: "hi" | "med" | "lo"; permission_mode?: string }) => {
          const { runbook: updated, text } = updateRunbookForAgent(project, args.runbook, args);
          if (updated) publishGlobal("", { type: "runbooks_changed", projectId: updated.project_id });
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
        }
      ),
    ]),
  });
}

// Map the UI reasoning preset to the SDK's thinking controls. `maxThinkingTokens`
// is Claude Code's native thinking-budget knob (mirrors the think / think hard /
// ultrathink keywords) and the binary translates it per model — 0 disables, any
// nonzero value enables thinking. On adaptive-only models a budget is treated as
// on/off, so we also scale `effort` to keep higher presets visibly thinking more
// there. null = inherit Claude Code's default (no override).
const REASONING: Record<string, { maxThinkingTokens: number; effort?: "medium" | "high" | "xhigh" }> = {
  off: { maxThinkingTokens: 0 },
  think: { maxThinkingTokens: 4_000, effort: "medium" },
  think_hard: { maxThinkingTokens: 10_000, effort: "high" },
  ultrathink: { maxThinkingTokens: 31_999, effort: "xhigh" },
};

function reasoningOptions(level: string | null): { maxThinkingTokens?: number; effort?: "medium" | "high" | "xhigh" } {
  const r = level ? REASONING[level] : undefined;
  if (!r) return {};
  return r.effort ? { maxThinkingTokens: r.maxThinkingTokens, effort: r.effort } : { maxThinkingTokens: r.maxThinkingTokens };
}

// Every permission mode this driver honors, as the SDK's own union so a value
// the CLI would reject can't reach `--permission-mode`. Spelled out here rather
// than derived from CLAUDE_CAPABILITIES because that module is deliberately
// SDK-free and types its values as plain strings — the same trade the MCP tool
// enums above make, and pinned the same way: tests/claudePermissionMode.test.ts
// asserts this list and the picker's list are exactly each other.
const PERMISSION_MODES: readonly PermissionMode[] = ["bypassPermissions", "auto", "acceptEdits", "default", "plan"];

// What a task runs as when nothing else says. Reached by the picker's "Default"
// head (task.permission_mode null) with no app-level default set, and by any
// unrecognized value — a mode from another agent's list, or a stale row.
//
// "auto" rather than bypassPermissions: now that canUseTool is a real gate, the
// classifier silently approves what it judges safe and escalates only the rest
// to a card, so a task is screened without a click per Read. The cost is on
// UNATTENDED work — an escalated call with nobody watching auto-denies after
// PERMISSION_UNATTENDED_MS and parks the queue (lib/permissions.ts) instead of
// running on. Fleets that must never stop to ask should set the app-level
// default back to bypassPermissions in Settings.
const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

// The task's run permission, resolved to a mode the SDK accepts.
function permissionModeFor(m: string | null): PermissionMode {
  return PERMISSION_MODES.includes(m as PermissionMode) ? (m as PermissionMode) : DEFAULT_PERMISSION_MODE;
}

// One AbortSignal that trips when ANY of its inputs does, plus the teardown to
// stop listening. A parked permission prompt has two ways to die — the turn's
// Stop button and the SDK's own per-request cancellation — and must answer to
// both; leaking the listeners would pile up one per prompt on a long turn.
function linkSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose: () => void } {
  const live = signals.filter((s): s is AbortSignal => !!s);
  const ac = new AbortController();
  const trip = () => ac.abort();
  if (live.some((s) => s.aborted)) trip();
  else for (const s of live) s.addEventListener("abort", trip, { once: true });
  return { signal: ac.signal, dispose: () => { for (const s of live) s.removeEventListener("abort", trip); } };
}

/**
 * Run one user turn against Claude Code and yield stream events.
 * Resumes the task's existing session when present; otherwise starts a fresh
 * session seeded with the project context.
 */
async function* runTurn(
  task: Task,
  project: Project,
  userText: string,
  abortController?: AbortController,
  hooks?: TurnHooks
): AsyncGenerator<StreamEvent> {
  let sessionId: string | null = task.session_id;
  // AskUserQuestion tool_use ids — surfaced as interactive "ask" cards by the
  // hook, so their generic tool_use / tool_result blocks are suppressed below.
  const askIds = new Set<string>();
  // Fallback-id uniquifier: one assistant message can carry several asks, and
  // the pending-ask registry keys by id — a shared fallback would collide.
  let askSeq = 0;
  // tool_use id -> how to summarize its eventual result into a peek.
  const resultKinds = new Map<string, ResultKind>();
  // tool_use id -> tool name, for Calandria's own tools only. The CLI can
  // answer one of these itself without the call ever reaching a handler, and
  // this is the only place that is visible (see lib/agentToolGuard.mjs).
  const calandriaCalls = new Map<string, string>();
  // tool_use ids whose tool_result has streamed. A task_notification for a
  // call NOT yet in here is a foreground completion — the CLI announces
  // every Bash/Agent task it registers (measured on 2.1.240: task_started +
  // task_notification, summary = the call's own description, then the
  // tool_result in the same instant) — and the card is about to carry the
  // result, so the line would only repeat the description. One that IS in
  // here settled a backgrounded call: its card holds a "running in the
  // background" placeholder, so the notification is the only news.
  const resultSeen = new Set<string>();
  // Fallback-id uniquifier for permission prompts, for the same reason as
  // askSeq: the SDK normally supplies a toolUseID, but the registry keys on it.
  let permSeq = 0;
  // Same again for a CLI-side refusal. tool_use_id is required by the SDK type,
  // so this only fires if a build ever ships one without — and an undefined id
  // would collapse every denial in the turn onto one transcript card.
  let deniedSeq = 0;
  const queue = makeQueue<StreamEvent>();
  // Latest usage-limit reset time the SDK reported this turn (rate_limit_event,
  // for claude.ai subscription users). When the turn then dies on a usage-limit
  // error, the raw error text usually says WHAT happened but not WHEN it heals —
  // this timestamp does, so withResetTime() folds it into the error event and it
  // lands in the persisted transcript line (the durable channel the UI renders).
  let limitResetsAt: number | null = null;
  // Append the reset time to a usage-limit error's text, human-readably. The
  // SDK reports `resetsAt` as a unix timestamp — epoch seconds in practice, but
  // tolerate milliseconds defensively (values past ~2001 in ms terms).
  const withResetTime = (text: string): string => {
    if (limitResetsAt == null || !isUsageLimit(text)) return text;
    const ms = limitResetsAt > 1e12 ? limitResetsAt : limitResetsAt * 1000;
    return `${text} — resets at ${new Date(ms).toLocaleString()}`;
  };

  // Resolve the run controls with a two-level fallback: the task's own choice wins;
  // when it's null ("Default"), inherit the app-level default set in Settings; when
  // that's also unset, fall through to Claude Code's built-in (its own default
  // model, no thinking override, bypassPermissions).
  // App defaults are agent-scoped ("default_reasoning:<agent>"), falling back to
  // the legacy un-suffixed key so pre-existing settings still apply.
  const reasoning = task.reasoning ?? getSetting(`default_reasoning:${task.agent}`) ?? getSetting("default_reasoning");
  const permission = task.permission_mode ?? getSetting(`default_permission_mode:${task.agent}`) ?? getSetting("default_permission_mode");
  // The model default is agent-scoped ONLY — no legacy un-suffixed key to read,
  // and none worth minting: a model id names one provider's catalog, so an
  // instance-wide "opus" would be a value Codex could never run.
  const model = task.model ?? getSetting(`default_model:${task.agent}`);

  // Chat attachments travel as "[Attached image: /abs/path]" (images) or
  // "[Attached file: /abs/path]" (any other type) marker lines in the message
  // text (composed in app/shell/format.ts; files live outside the worktree, see
  // lib/uploads.ts). The bytes are deliberately NOT in the prompt — the nudge
  // hands over a staged path and leaves the how to Claude, since Read renders
  // images and text natively but a PDF, an archive or a spreadsheet needs a
  // shell tool. Prompt-only: the persisted transcript keeps the bare markers.
  const prompt = /^\[Attached (image|file): .+\]$/m.test(userText)
    ? `${userText}\n\nEach attachment above is a file staged on disk at that absolute path, outside the worktree. Inspect the ones you need before responding — the Read tool handles images and text; for any other format use whatever shell tooling suits it. Don't assume the contents from the filename.`
    : userText;

  const permissionMode = permissionModeFor(permission);

  // The permission gate. It must be PROVIDED in every mode, because CLI ≥2.1
  // only puts AskUserQuestion in the model's tool list when the host signals it
  // can field interactive prompts by passing canUseTool — without it the tool
  // simply doesn't exist and Claude can never ask (verified against 2.1.198).
  //
  // Under bypassPermissions the SDK never consults it, so it stays
  // a blanket allow. In every OTHER mode each call the CLI doesn't auto-approve
  // arrives here — and this is what makes those modes mean something rather than
  // being bypassPermissions with a different label. What reaches the gate
  // differs per mode, which is the whole point of offering them: "auto"
  // escalates only what its classifier won't vouch for, acceptEdits lets writes
  // through and stops at commands, "default" stops at anything not pre-approved,
  // plan stops at leaving the plan. Known-safe tools and calls already
  // covered by a remembered project rule pass silently; anything else parks the
  // turn on a card the user answers, through the very same registry + /answer
  // route an AskUserQuestion uses (lib/permissions.ts).
  const canUseTool: CanUseTool = async (toolName, input, opts) => {
    const allow = (): PermissionResult => ({ behavior: "allow" as const, updatedInput: input });
    if (permissionMode === "bypassPermissions") return allow();
    // `blockedPath` is the CLI saying this call reaches somewhere it shouldn't
    // (outside the worktree, typically) — the one case the read-only allowlist
    // must NOT swallow, since it's the CLI's own warning.
    if (isAlwaysAllowed(toolName, opts.blockedPath)) return allow();
    // Re-read the rules per call, not per turn: an "always allow" answered
    // earlier in THIS turn has to take effect immediately, and a rule the user
    // revokes mid-turn has to stop applying just as fast.
    if (!opts.blockedPath && allowedByRules(listPermissionRules(project.id), toolName, input)) return allow();

    const described = describePermission(toolName, input);
    // NAMESPACED, not the bare toolUseID: the runner keys its transcript rows
    // by tool_use id, and the model's own tool_use block for this very call
    // carries the same id — an un-prefixed key would let the two rows clobber
    // each other and land the decision on the wrong card.
    const id = `perm:${opts.toolUseID || `${sessionId ?? "x"}-${permSeq++}`}`;
    // Durable rules are Bash-only (see lib/permissions.ts). For everything else
    // the CLI's own `suggestions` payload is offered instead: it stops the
    // re-asking for the rest of THIS session and is never persisted.
    const scope = scopeOfferFor(toolName, input)
      ?? (opts.suggestions?.length ? { scope: "session" as const, value: toolName, label: "Don't ask again this session" } : undefined);
    const request: PermissionRequest = {
      id,
      tool: toolName,
      // The CLI renders its own prompt sentence ("Claude wants to run …") and
      // knows things we can't see from the input alone, so prefer it; fall back
      // to the same title the transcript would give the tool call.
      title: opts.title?.trim() || described.title,
      detail: described.detail,
      description: opts.blockedPath
        ? `Reaches outside the task's working directory: ${opts.blockedPath}`
        : opts.description?.trim() || opts.decisionReason?.trim() || undefined,
      diff: described.diff,
      scope,
      expiresAt: promptDeadline(PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS, task.id),
    };
    queue.push({ type: "permission", request });
    const settle = (outcome: PermissionOutcome) => queue.push({ type: "permission_decided", id, outcome });

    // Two signals matter: the turn's (Stop) and the SDK's per-request one — a
    // cancelled control request must stop being answerable even if the turn
    // itself lives on.
    const linked = linkSignals(abortController?.signal, opts.signal);
    let waited;
    try {
      waited = await waitForPermission({
        taskId: task.id,
        id,
        signal: linked.signal,
        attendedMs: PERMISSION_PROMPT_TIMEOUT_MS,
        unattendedMs: PERMISSION_UNATTENDED_MS,
      });
    } finally {
      linked.dispose();
    }

    // Every non-answer path denies — the gate fails CLOSED, so a stopped,
    // unwatched, or expired turn can never leak an unapproved tool call.
    if ("aborted" in waited) {
      const note = "The session was stopped before this was approved.";
      settle({ decision: "deny", auto: true, reason: "interrupted", note });
      return { behavior: "deny", message: note };
    }
    if ("expired" in waited) {
      const note = waited.expired === "unattended" ? DENIED_UNATTENDED : DENIED_TIMED_OUT;
      settle({ decision: "deny", auto: true, reason: waited.expired, note });
      return { behavior: "deny", message: denyMessage(request.title, note) };
    }

    const { decision, note } = parseDecision(waited.answers);
    if (decision === "deny") {
      settle({ decision, note: note || undefined });
      return { behavior: "deny", message: denyMessage(request.title, note || DENIED_BY_USER) };
    }
    let remembered: string | undefined;
    if (decision === "allow_always" && scope?.scope === "project" && scope.match_kind) {
      addPermissionRule({ project_id: project.id, tool: toolName, match_kind: scope.match_kind, value: scope.value });
      remembered = scope.label;
    } else if (decision === "allow_always" && scope?.scope === "session") {
      remembered = scope.label;
    }
    settle({ decision, remembered });
    // `suggestions` is the CLI's own "stop asking for this in this session"
    // payload. Handing it back on an always-allow covers what our project rules
    // deliberately can't: non-Bash tools, and path grants we don't model.
    return decision === "allow_always" && opts.suggestions?.length
      ? { behavior: "allow", updatedInput: input, updatedPermissions: opts.suggestions }
      : allow();
  };

  // --- Background linger (measured against CLI 2.1.240 / SDK 0.3.159; the
  // spike record lives in this feature's commit message) ---
  //
  // In single-prompt mode the CLI exits ~5s after the result message and KILLS
  // every run_in_background child with it — "you will be notified when it
  // completes" never happens. Streaming-input mode fixes both halves: with the
  // prompt iterable held open the CLI stays alive after the result, background
  // tasks run to completion, and their task_notification re-invokes the model
  // into a fresh turn with NO user message — which streams through this same
  // pump as a continuation of the generation.
  //
  // The turn-end signal is the Stop hook's `background_tasks` payload: the
  // SDK-documented field whose stated purpose is distinguishing "session is
  // done" from "session is paused waiting for background work to wake it". It
  // fires before every result message (verified), so by the time the pump sees
  // a result it already knows whether work is pending. (The CLI also emits a
  // `background_tasks_changed` system message with the same array, but that
  // subtype exists nowhere in sdk.d.ts — an undocumented passthrough that can
  // drift with CLI releases, so it is deliberately not load-bearing here.)
  // `session_crons` (ScheduleWakeup / CronCreate / /loop) rides the same Stop
  // payload and is the second linger trigger (measured separately, on the same
  // CLI — see sessionCrons.ts for the record): a cron fires ONLY while the CLI
  // is alive, and closing the input exits it within ~300ms with the wake simply
  // gone — the same broken promise, in the class the first cut excluded. Held
  // open, the wake arrives as a bare second `init` (same session id, no user
  // message, no task_notification), so it gets its own wake accounting below.
  // Which crons are honored is planSessionCrons()'s decision, stated there:
  // everything under the unbounded default (a recurring /loop cron holds the
  // session open until the user stops it — by design, and visible on the row),
  // only what fits the window on a bounded instance. Whatever is NOT honored is
  // named in a transcript notice when the input closes (endTurn), so neither
  // the user nor the model's next turn waits on a wake that died with the
  // process.
  //
  // Closing the held-open iterable is the whole teardown: the CLI gives still-
  // running tasks a ~5s grace, kills them (task_updated status:"killed"), and
  // exits — so Stop, the SIGTERM drain, and the (optional) linger deadline all
  // converge on closeInput(). By default there is NO deadline: the lingering
  // state is visible in the UI with its age, so a session held too long is
  // the user's to kick (Stop), not the harness's to kill — an automatic cut
  // destroys real work to enforce a bound nobody asked for. When an operator
  // sets BACKGROUND_LINGER_MS > 0, that deadline bounds the WHOLE linger
  // phase from its first entry (one timer, never reset by wake turns): a
  // deadline reset per wake would let a task chain sleeps forever, and one
  // cleared on wake would hang the query if a notification ever arrives
  // without a wake turn behind it (skip_transcript housekeeping tasks).
  let pendingBg: BackgroundTaskSummary[] = [];
  let pendingCrons: SessionCronSummary[] = [];
  // The crons the current linger is holding the session open for (a subset of
  // pendingCrons on a bounded instance), so a wake init can say which fired.
  let lingerCrons: PlannedCron[] = [];
  let lingering = false;
  let closing = false;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  // First linger entry — the anchor the deadline (and the window-fit check for
  // crons) is measured from; 0 until the turn first lingers.
  let lingerSince = 0;
  const lingerDeadline = () => (BACKGROUND_LINGER_MS > 0 ? (lingerSince || Date.now()) + BACKGROUND_LINGER_MS : null);
  // Cron ids already named in a cancellation notice this turn: a doomed wakeup
  // stays in every later Stop payload (it's still registered, still doomed),
  // and one notice per wakeup is honest — one per Stop is noise.
  const noticedCrons = new Set<string>();
  const cancelNotice = (crons: SessionCronSummary[], reason: string, now: number) => {
    const fresh = planSessionCrons(crons, { now, enabled: false, deadline: null }).cancelled.filter((c) => !noticedCrons.has(c.id));
    if (!fresh.length) return null;
    for (const c of fresh) noticedCrons.add(c.id);
    return cancelledCronsNotice(fresh, reason, now);
  };
  // Cumulative-cost baseline: in streaming-input mode each result message's
  // token counts cover only its own turn segment, but total_cost_usd is the
  // running SESSION total (measured: wake turn reported the first result's
  // cost plus its own marginal spend). Report the delta or every wake turn
  // re-bills the whole session. A total below the baseline would mean the
  // report is per-turn after all — taken at face value, codex-style, rather
  // than clamped into a lie.
  let costBaseline = 0;
  // Last context-occupancy figure emitted, so the gauge only moves when the
  // number does — the CLI splits one API response into several assistant
  // messages (one per content block) that all carry the same usage.
  let lastContext = 0;
  // What has already been reported as PARTIAL spend for the assistant message
  // currently arriving, keyed by its id. Same split as above — one API response
  // becomes several messages carrying the same usage — but where the gauge can
  // simply ignore an unchanged number, spend summed per message would bill that
  // response once per content block. So each copy reports only its GROWTH over
  // the last one: an identical repeat contributes nothing, and an
  // `output_tokens` figure that was a mid-stream snapshot on the first copy
  // still lands in full. Copies of one response arrive consecutively, so one
  // slot is enough; a message with no id gets its own so two of them never
  // collapse into each other.
  let partialFor: string | undefined;
  let partialSeq = 0;
  let partialSent = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  // The held-open input is a real message CHANNEL, not just a latch: the CLI
  // reads stdin for the life of the query, so a message the user sends while
  // the turn lingers can be yielded straight into the open session as a second
  // SDKUserMessage instead of waiting in pending_messages for a linger that is
  // unbounded by default. Measured (CLI 2.1.240 / SDK 0.3.159, live): a message
  // pushed after the first result IS accepted and starts a fresh turn on the
  // same session, announced by a bare second `init` — the same shape a cron
  // wake takes, and with no user echo on the wire either, which is why the
  // wake branch below must not read an injected turn's init as a wakeup.
  // Closing the channel is what ends the query, exactly as the latch did.
  const input = makeQueue<SDKUserMessage>();
  const closeInput = () => input.close();
  const userMessage = (text: string) =>
    ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } }) as SDKUserMessage;
  // Close the held-open input and let the CLI exit. `reason` is why any wakeup
  // the last Stop hook reported is about to die with the process — the honesty
  // fallback: whichever path closes (nothing honored at result time, the
  // deadline, Stop, a transport error), a cron still pending at that moment
  // will never fire, and the notice says so once. A caller that has already
  // named the crons in its own notice passes `null`.
  const endTurn = (reason: string | null = "the session closed before it fired") => {
    if (closing) return;
    closing = true;
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    const notice = reason ? cancelNotice(pendingCrons, reason, Date.now()) : null;
    if (notice) queue.push({ type: "notice", content: notice });
    closeInput();
  };
  async function* promptStream(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(prompt);
    // Held open past the result so background tasks survive it: this drains
    // anything sendMidTurn() pushes (a message the user sent mid-linger) and
    // returns only when endTurn() closes the channel (no pending work / Stop /
    // deadline), upon which the CLI exits.
    for await (const m of input.drain()) yield m;
  }
  // Take a user message into the LIVE session, or refuse it. The only state
  // that can take one is the linger: the model's turn is over, nothing is in
  // flight, and the message simply opens the next turn — whereas mid-thought
  // it would arrive in the middle of the model's reasoning, which is what
  // pending_messages is for. Refusing (false) is the caller's cue to queue.
  //
  // Synchronous, because lib/runner.ts persists + publishes the message in the
  // same tick: nothing may interleave between the CLI accepting it and the
  // transcript recording it.
  // Re-lingering after this is what keeps the injected turn from costing the
  // user the work they were waiting on, and it is measured, not assumed: the
  // injected turn's own Stop hook reports the still-running background task
  // (and a pending wakeup) exactly as the previous one did, so the result
  // handler below re-enters the linger and the work runs to completion.
  const sendMidTurn = (text: string): boolean => {
    if (closing || !lingering) return false;
    // A real model turn starts now, so the session is no longer "working in
    // background" — the runner drops the flag on its side and this stops the
    // pump reading the injected turn's `init` as a scheduled wakeup firing.
    lingering = false;
    // The user is demonstrably watching, so the deadline (bounded instances
    // only) starts over rather than counting a wait the user just ended: clear
    // the armed timer and drop the anchor so the NEXT linger re-anchors from
    // its own entry. `noticedCrons` is cleared with it — a wakeup named as
    // out-of-window belonged to the window that just closed, and the fresh
    // linger re-plans it against the new deadline (it may now fit, and if it
    // still doesn't it is named again beside the new wait).
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    lingerSince = 0;
    noticedCrons.clear();
    input.push(userMessage(text));
    return true;
  };
  const armLingerDeadline = () => {
    if (lingerTimer || BACKGROUND_LINGER_MS <= 0) return;
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (closing) return;
      const cut = pendingBg.map((t) => t.command || t.description).filter(Boolean).join("; ");
      const now = Date.now();
      // Everything the last Stop reported dies here — background work AND any
      // wakeup, honored or not — so one notice names all of it.
      const crons = planSessionCrons(pendingCrons, { now, enabled: false, deadline: null }).cancelled.filter((c) => !noticedCrons.has(c.id));
      for (const c of crons) noticedCrons.add(c.id);
      queue.push({
        type: "notice",
        content:
          `⚠ Background work exceeded the linger window (${Math.round(BACKGROUND_LINGER_MS / 60000)}m) and was stopped` +
          (cut ? `: ${clip(cut, 500)}` : "") +
          `. Don't assume it finished.` +
          (crons.length ? ` Scheduled wakeup${crons.length > 1 ? "s" : ""} cancelled with it: ${crons.map((c) => describeCron(c, now)).join("; ")}.` : ""),
      });
      endTurn(null);
    }, BACKGROUND_LINGER_MS);
    // Let the process exit if something else tears the turn down first.
    lingerTimer.unref?.();
  };

  // Hoisted because the init handler below records this session's MCP prompt
  // commands against it, and the menu's cache is keyed by exactly this cwd.
  const cwd = sessionCwd(task, project);

  const response = query({
    prompt: promptStream(),
    options: {
      cwd,
      // Drops NODE_ENV and repoints PORT at the project's own port — see
      // lib/agentEnv.ts for why a turn can't just inherit the server's env.
      env: agentTurnEnv(project, task),
      resume: task.session_id ?? undefined,
      // Model selection ("opus"/"sonnet"/"haiku" alias) — the task's own pick,
      // else this agent's Settings default. Omit to inherit Claude Code's own.
      ...(model ? { model } : {}),
      // Reasoning preset → thinking budget + effort (Off/Think/Think hard/Ultrathink).
      // Omitted keys leave Claude Code's default thinking.
      ...reasoningOptions(reasoning),
      systemPrompt: { type: "preset", preset: "claude_code", append: buildProjectContext(project, task) },
      // Inherit the user's own Claude Code configuration — see SETTING_SOURCES.
      settingSources: SETTING_SOURCES,
      // Permission mode (default bypassPermissions; "plan" proposes without editing).
      permissionMode,
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      mcpServers: {
        calandria: calandriaServer(
          project,
          task,
          // Straight onto the queue, like expose_service's notice below: the
          // suggestion is already committed, and holding it until the turn ends
          // would keep the receiving tray stale for as long as the turn runs —
          // hours, if it parks on a question.
          ({ title, projectId, taskId }) => queue.push({ type: "suggested", title, projectId, taskId }),
          ({ name, url }) => queue.push({ type: "notice", content: `Service "${name}" is live at ${url}` }),
          hooks
        ),
      },
      // Lets the Stop button interrupt the stream mid-turn (see lib/abort.ts).
      abortController,
      // The real permission gate (defined above); also what makes the CLI
      // expose AskUserQuestion at all. An answered/dismissed ask is resolved by
      // the PreToolUse hook below before permissions are ever checked, so the
      // two interactive paths never collide.
      canUseTool,
      // bypassPermissions auto-resolves AskUserQuestion with no UI, so the
      // questions never reach the user. This hook intercepts that one tool: it
      // surfaces the questions to the UI (an "ask" event), parks until the user
      // answers, then returns their choices as the tool result so Claude
      // continues in the same session. Everything else stays auto-approved.
      hooks: {
        PreToolUse: [
          {
            matcher: "AskUserQuestion",
            timeout: 86_400, // ~1 day: never time out while the user is deciding
            hooks: [
              async (input, toolUseId) => {
                const ti = (input as { tool_input?: { questions?: AskQuestion[] } }).tool_input;
                const questions = (ti?.questions ?? []) as AskQuestion[];
                const id = toolUseId || (input as { tool_use_id?: string }).tool_use_id || `ask-${sessionId ?? "x"}-${askSeq++}`;
                // A turn that DECLARED itself unattended (a scheduled firing)
                // has nobody to ask, and this hook is the one interactive path
                // that fires in every permission mode — bypassPermissions
                // short-circuits canUseTool, but not this. Parking here holds
                // the turn slot, the CLI child and the schedule's overlap lock
                // open forever, which turns every future occurrence into
                // `skipped_overlap`: the schedule goes quiet, permanently, with
                // nothing in the ledger to say why.
                //
                // So settle it now, and settle it VISIBLY. It rides the
                // permission-card machinery rather than the ask machinery on
                // purpose: an ask card implies an answer is coming, while a
                // decided permission card is exactly what this is — a request
                // that was refused, on the record, with the question preserved
                // so the user can see what the run wanted. It also lands the
                // refusal in the one place the runner already watches, so the
                // run settles `failed` with an actionable reason instead of a
                // green "ran".
                if (interactionDenied(task.id)) {
                  // Registered exactly as an answered ask is, so the hook's own
                  // deny text — written for the model, and long — is suppressed
                  // when it comes back as a tool_result. The card below is the
                  // user-facing record; the raw refusal is not a second one.
                  askIds.add(id);
                  const asked = questions.map((q) => q.header?.trim() || q.question?.trim()).filter(Boolean).join(" · ");
                  queue.push({
                    type: "permission",
                    request: {
                      id,
                      tool: "AskUserQuestion",
                      title: asked ? `Question for you: ${clip(asked, 200)}` : "The agent asked a question",
                      detail: questions.map((q) => q.question).filter(Boolean).join("\n\n"),
                      expiresAt: Date.now(),
                    },
                  });
                  queue.push({
                    type: "permission_decided",
                    id,
                    outcome: { decision: "deny", auto: true, reason: "unattended", note: UNATTENDED_ASK_NOTE },
                  });
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: UNATTENDED_ASK_DENIAL,
                    },
                  };
                }
                askIds.add(id);
                queue.push({ type: "ask", id, questions });
                let reason: string;
                try {
                  const answers = await waitForAnswer(task.id, id, questions, abortController?.signal);
                  queue.push({ type: "ask_answered", id, answers });
                  reason = formatAnswers(questions, answers);
                } catch {
                  // Turn torn down (Stop / disconnect) before an answer arrived.
                  // Settle the card here the way canUseTool's settle() does on
                  // its abort path: an ask with neither answers nor a dismissal
                  // renders live option buttons forever, indistinguishable from
                  // a question somebody is actually waiting on.
                  queue.push({ type: "ask_dismissed", id, dismissal: { reason: "interrupted", note: ASK_INTERRUPTED_NOTE } });
                  reason = ASK_DISMISSED_REPLY;
                }
                return {
                  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
                };
              },
            ],
          },
        ],
        // The linger signal (see the block above): fires before every result
        // message with the authoritative in-flight background-task list —
        // empty when the session is genuinely done, populated when it is
        // paused waiting for background work to wake it.
        Stop: [
          {
            hooks: [
              async (input) => {
                const i = input as { background_tasks?: BackgroundTaskSummary[]; session_crons?: SessionCronSummary[] };
                pendingBg = i.background_tasks ?? [];
                pendingCrons = i.session_crons ?? [];
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  // Publish the input channel for the life of this turn, so POST /messages can
  // reach it (lib/turnInput.ts → lib/runner.ts sendToLingeringTurn). Registered
  // after query() so a throw from the spawn can't leave a handle pointing at a
  // turn that never started; released in the pump's finally, which runs however
  // the stream ends.
  const inputHandle: TurnInputHandle = { send: sendMidTurn };
  registerTurnInput(task.id, inputHandle);

  // Pump SDK messages into the queue. Runs concurrently with the hook (which
  // pushes ask events while this is parked awaiting the tool result).
  const pump = (async () => {
    try {
      for await (const message of response) {
        if (message.type === "system" && message.subtype === "init") {
          // A wakeup firing mid-linger arrives as exactly this — a second
          // init on the same session, with no user message and no
          // task_notification (measured) — so this is the cron wake signal.
          // Only claimed when crons were being waited on: a background task's
          // wake is its notification, which precedes its init (measured, and
          // pinned by the linger test), so that path has already left the
          // lingering state by the time its init streams. A message the user
          // sent mid-linger produces an identical bare init (measured) and is
          // excluded the same way — sendMidTurn() drops `lingering` in the same
          // tick it accepts the message, so the wake it announces is the user's,
          // not a wakeup's, and the transcript already shows their message.
          if (lingering && !closing && lingerCrons.length > 0) {
            lingering = false;
            const now = Date.now();
            const woke = cronThatWoke(lingerCrons, now);
            queue.push({
              type: "background_resumed",
              status: "woke",
              summary: woke
                ? `Scheduled wakeup fired${woke.recurring ? ` (\`${woke.schedule}\`)` : ` (${wakeTimeLabel(woke.fireAt, now)})`}: ${clip(woke.prompt, 300)}`
                : "Scheduled wakeup fired",
            });
          }
          sessionId = message.session_id;
          queue.push({ type: "session", sessionId });
          // The composer's "/" menu can't discover MCP prompt commands on its
          // own — they exist only on this message, and getting them any other
          // way means spawning the user's whole MCP fleet on a keystroke
          // (lib/agents/claude/commands.ts). This session already paid for that
          // fleet, so hand its list to the menu's cache on the way past.
          recordMcpPrompts(cwd, SETTING_SOURCES, message.slash_commands);
          // The init message reports the model the SDK actually resolved (e.g. when
          // "default" maps to Opus). Surface it so the UI can badge the live model.
          const resolved = (message as { model?: string }).model;
          if (resolved) queue.push({ type: "model", model: resolved });
        } else if (message.type === "system" && message.subtype === "permission_denied") {
          // A tool call the CLI refused WITHOUT ever consulting canUseTool, so
          // there was no card and the user was never given the choice. Under
          // "auto" that's the classifier vetoing a call it judged
          // unsafe; it can also be a deny rule in the loaded settings. Reachable
          // in normal use now that "auto" is the default mode, and the only
          // other trace is an is_error tool_result the transcript renders as a
          // plain tool failure.
          //
          // Carries the tool_use id, which is the whole point: the runner
          // settles this onto the transcript card the call ALREADY created, so
          // it reads as "this call, refused, here's what it was" instead of a
          // notice floating beside it — and three denials in a turn are three
          // decided cards, not three identical loose lines.
          queue.push({
            type: "permission_denied",
            id: message.tool_use_id || `denied-${sessionId ?? "x"}-${deniedSeq++}`,
            tool: message.tool_name,
            reasonType: message.decision_reason_type,
            // NOT message.message verbatim — that field is written for the
            // model, and the `mode` denial is ~700 chars of instruction.
            reason: blockedReason(message.decision_reason, message.message),
            ...(message.agent_id ? { agentId: message.agent_id } : {}),
          });
        } else if (message.type === "assistant") {
          // Context-window occupancy: each assistant message carries ITS API
          // request's usage, and the request's input side (fresh + cache read
          // + cache written) is precisely how many tokens the window held when
          // it was sent. The LAST main-session one is the current figure. The
          // result message's usage is useless for this — it's the SUM over
          // every request in the turn (each tool round-trip re-reads the whole
          // context) plus every subagent, which is spend, not occupancy.
          // Subagent messages arrive with parent_tool_use_id set and describe
          // THEIR window, so they're skipped; a synthesized error message
          // carries zero usage and is skipped by the > 0 guard.
          if (message.parent_tool_use_id == null) {
            const u = message.message.usage;
            const ctx = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
            if (ctx > 0 && ctx !== lastContext) {
              lastContext = ctx;
              queue.push({ type: "context", tokens: ctx });
            }
            // The same numbers are also this request's SPEND, and reporting it
            // as it happens is what stops a Stopped turn recording nothing: the
            // result message is the only other source and a turn can run for
            // half an hour of tool calls without producing one, so a Stop three
            // minutes or thirty into that segment used to write zero tokens for
            // work the API had already billed. These are provisional — the
            // result message's usage is exactly the sum over the main-session
            // assistant messages of its segment (verified to the token; see
            // claudeSubagentTokens), so the runner drops what it accumulated
            // here the moment a full report arrives rather than billing both.
            // Sidechains are excluded for the reason above and because summing
            // their messages undercounts by half; a Stopped turn's subagent
            // spend is therefore unrecorded, which is the same floor the
            // stored token totals have always been.
            const seen = {
              input_tokens: u?.input_tokens ?? 0,
              output_tokens: u?.output_tokens ?? 0,
              cache_read_tokens: u?.cache_read_input_tokens ?? 0,
              cache_creation_tokens: u?.cache_creation_input_tokens ?? 0,
            };
            const mid = message.message.id || `anon-${partialSeq++}`;
            if (mid !== partialFor) {
              partialFor = mid;
              partialSent = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
            }
            const partial: TurnUsage = { cost_usd: 0, ...partialSent };
            let any = false;
            for (const k of Object.keys(partialSent) as (keyof typeof partialSent)[]) {
              const grew = Math.max(0, seen[k] - partialSent[k]);
              partial[k] = grew;
              if (grew > 0) {
                partialSent[k] = seen[k];
                any = true;
              }
            }
            if (any) queue.push({ type: "usage", usage: partial, partial: true });
          }
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              queue.push({ type: "assistant", content: block.text });
            } else if (block.type === "tool_use") {
              // AskUserQuestion is rendered as an interactive card by the hook.
              if (block.name === "AskUserQuestion") continue;
              const { title, detail, peek, diff, resultKind, file } = describeToolUse(block.name, block.input as Record<string, unknown>);
              if (resultKind) resultKinds.set(block.id, resultKind);
              if (isCalandriaToolName(block.name)) calandriaCalls.set(block.id, block.name);
              // The tool's own name travels with the row: the runner matches
              // on it to settle a suggestion card onto a suggest_task call, and
              // the title it would otherwise have to match is human prose.
              queue.push({ type: "tool", id: block.id, name: block.name, title, detail, peek, diff, file });
            }
          }
        } else if (message.type === "user") {
          // Tool results come back as user-role messages with tool_result blocks.
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
                const b = block as { tool_use_id: string; content: unknown; is_error?: boolean };
                resultSeen.add(b.tool_use_id);
                // The deny-result of an answered ask is already shown via ask_answered.
                if (askIds.has(b.tool_use_id)) continue;
                let raw = resultText(b.content);
                // A Calandria tool the CLI answered on its own behalf: it cut
                // the call off above the MCP seam, so lib/agentToolGuard.mjs
                // never saw it and the sentence the model is holding is the
                // CLI's. Say whose it is and what to do about it, and log it —
                // otherwise a turn whose Calandria calls all failed still
                // reports `turn ok` with nothing in the journal to find it by.
                const cut = calandriaCalls.get(b.tool_use_id);
                if (cut && isCliInterruptedToolResult(raw)) {
                  log.warn("agent tool call cut off before Calandria answered", {
                    task: task.id,
                    tool: cut,
                    tool_use_id: b.tool_use_id,
                  });
                  raw = toolInterruptedMessage(cut);
                }
                const kind = resultKinds.get(b.tool_use_id);
                // Summarize from the raw (pre-clip) output so counts are exact.
                // A failure ("Exit code N" + output, stderr last) is peeked
                // tail-first and clipped from the middle: the reason for a
                // non-zero exit sits at the END, and a head-only clip used to
                // drop it, so a long failed command read as good output
                // under a red ✗ with nothing to explain the ✗.
                const peek = b.is_error ? summarizeFailure(raw) : kind ? summarizeResult(kind, raw) : undefined;
                const content = b.is_error ? clipKeepTail(raw, 6000) : clip(raw, 6000);
                queue.push({ type: "tool_result", id: b.tool_use_id, content, isError: !!b.is_error, peek });
              }
            }
          }
        } else if (message.type === "system" && message.subtype === "task_notification") {
          // A background task settled. While lingering this is the wake signal:
          // the CLI re-invokes the model with no user message and the new turn
          // streams through this same pump — surface the transition so the
          // runner can drop the background_pending state and record WHY fresh
          // content is streaming. Mid-turn (not lingering) it's just context; a
          // notice keeps the transcript honest. After endTurn() it's the CLI
          // killing what we asked it to kill — silence, not news.
          if (!closing) {
            if (lingering) {
              lingering = false;
              queue.push({ type: "background_resumed", status: message.status, summary: message.summary });
            } else if (
              !message.skip_transcript &&
              (!message.tool_use_id || resultSeen.has(message.tool_use_id))
            ) {
              // Mid-turn, only a settled BACKGROUND task is news (see
              // resultSeen); a foreground completion is the card's to show,
              // and the CLI's own "housekeeping, hide from the transcript"
              // flag is honored as documented. The tone travels in the glyph:
              // a failure warns, the rest is a quiet note.
              const failed = message.status === "failed" || /exit code [1-9]/i.test(message.summary);
              queue.push({ type: "notice", content: failed ? `⚠ ${message.summary}` : message.summary });
            }
          }
        } else if (message.type === "rate_limit_event") {
          // Subscription rate-limit telemetry (status/utilization/resetsAt).
          // Not surfaced as a transcript event — it feeds the instance-wide
          // plan-usage snapshot (the titlebar session/week meter reads it via
          // GET /api/plan-usage), and the reset time is remembered so a
          // subsequent usage-limit failure can say when the quota heals.
          recordClaudeRateLimit(message.rate_limit_info);
          const resetsAt = message.rate_limit_info?.resetsAt;
          if (typeof resetsAt === "number") limitResetsAt = resetsAt;
        } else if (message.type === "result") {
          // Per-turn spend: the result message carries this turn segment's
          // token counts, but a cumulative session dollar total — delta it
          // against the previous result (see costBaseline above).
          const usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
          // ...and those token counts are the MAIN SESSION's alone, while the
          // dollar figure beside them covers the subagents too. Measure the
          // gap so the chip can say so instead of quietly reporting a fan-out
          // as if this session had burned it (claudeSubagentTokens documents
          // how that was verified against the live CLI).
          const subagent = claudeSubagentTokens(message as unknown as Parameters<typeof claudeSubagentTokens>[0]);
          if (subagent > 0) usage.subagent_tokens = subagent;
          if (usage.cost_usd >= costBaseline) {
            const total = usage.cost_usd;
            usage.cost_usd = total - costBaseline;
            costBaseline = total;
          }
          queue.push({ type: "usage", usage });
          if (message.subtype !== "success" && "result" in message === false) {
            queue.push({ type: "error", content: withResetTime(`Run ended: ${message.subtype}`) });
          }
          // The linger decision. The Stop hook has already fired for this turn
          // (verified ordering), so pendingBg/pendingCrons are current: nothing
          // to honor → the session is done, close the input and let the CLI
          // exit (naming any wakeup that dies with it); something to honor →
          // hold the query open so the work survives, tell the runner what the
          // session is waiting on, and start the (optional) bounded wait for
          // the task_notification / wake-init.
          if (!closing) {
            const now = Date.now();
            const bg = BACKGROUND_LINGER_ENABLED ? pendingBg : [];
            const plan = planSessionCrons(pendingCrons, { now, enabled: BACKGROUND_LINGER_ENABLED, deadline: lingerDeadline() });
            if (bg.length > 0 || plan.linger.length > 0) {
              lingering = true;
              lingerSince ||= now;
              lingerCrons = plan.linger;
              // A wakeup that won't be waited for is dead the moment this
              // linger ends, and nothing later will re-plan it (the deadline
              // is fixed from first entry) — say so now, beside the wait.
              const notice = cancelNotice(plan.cancelled, `beyond this instance's ${Math.round(BACKGROUND_LINGER_MS / 60000)}-minute linger window`, now);
              if (notice) queue.push({ type: "notice", content: notice });
              queue.push({
                type: "background_pending",
                tasks: [
                  ...bg.map((t) => ({ id: t.id, kind: t.type, description: clip(t.command || t.description, 300) })),
                  ...plan.linger.map((c) => ({ id: c.id, kind: c.recurring ? "cron" : "wakeup", description: clip(c.prompt, 300), ...(c.fireAt !== null ? { wakeAt: c.fireAt } : {}) })),
                ],
                note: lingerNote(bg.length, plan.linger, now),
              });
              armLingerDeadline();
            } else {
              endTurn(
                !BACKGROUND_LINGER_ENABLED
                  ? "lingering is off on this instance (CALANDRIA_BACKGROUND_LINGER), so the session closed at the end of the turn"
                  : `beyond this instance's ${Math.round(BACKGROUND_LINGER_MS / 60000)}-minute linger window`,
              );
            }
          }
        }
      }
    } catch (err) {
      // An abort (Stop button / disconnect) ends the stream deliberately — not an
      // error. The partial transcript is already persisted by the consumer.
      if (!abortController?.signal.aborted) {
        queue.push({ type: "error", content: withResetTime(err instanceof Error ? err.message : String(err)) });
      }
    } finally {
      // However the stream ended (clean close, Stop, a thrown transport
      // error), release the held-open prompt generator and the linger timer —
      // a parked generator would otherwise pin this turn's closure forever —
      // and take the input channel off the registry so a message arriving now
      // is queued rather than pushed into a session that is gone.
      unregisterTurnInput(task.id, inputHandle);
      endTurn();
      queue.close();
    }
  })();

  for await (const ev of queue.drain()) yield ev;
  await pump;

  yield { type: "done", sessionId };
}

/**
 * Summarize a transcript into a concise handoff note for the /clear flow.
 * One-shot, genuinely no tools — just text in, summary out (see TEXT_ONE_SHOT).
 */
// The tier setting the caller resolved, in the shape query() wants. Omitted when
// unset, so a one-shot keeps inheriting Claude Code's own configured default —
// the behavior every one-shot had before the setting existed.
const oneShotModel = (opts?: OneShotOptions) => (opts?.model ? { model: opts.model } : {});

async function summarizeTranscript(transcript: string, project: Project, opts?: OneShotOptions): Promise<OneShotResult> {
  const response = query({
    prompt:
      `Summarize the following Claude Code session into a concise handoff note for a fresh session ` +
      `continuing the same task. Cover: what was done, the current state of the code, decisions made, ` +
      `and what remains. Be specific about files and follow-ups. Output only the note.\n\n` +
      `=== TRANSCRIPT ===\n${transcript}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      ...TEXT_ONE_SHOT,
      ...oneShotModel(opts),
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  // First reading wins — init's resolved model, else the result's rollup.
  let model: string | null = null;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") {
      usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
      model ??= claudeMessageModel(message);
    } else if (message.type === "system") model ??= claudeMessageModel(message);
  }
  return { text: out.trim() || "(no summary produced)", usage, model };
}

// Delimiters Claude wraps the final context document in, so we can extract just
// the document and drop any interim narration ("Let me look at…", "I have enough
// to write the context.") the agent loop emits in the same final message.
const CTX_OPEN = "<<<CONTEXT>>>";
const CTX_CLOSE = "<<<END_CONTEXT>>>";

// The draft agent's tools. Unlike the two summarizers this one genuinely needs
// to look at the repo — but only to LOOK. Bash is deliberately absent: under
// bypassPermissions with no canUseTool it is unreviewed arbitrary execution in
// the user's own checkout, for a job whose output is a paragraph of prose, and
// the recent-activity half it used to be wanted for (git log) is handed in via
// `digest` already. Read/Grep/Glob cover reading files, searching content and
// walking the tree. Before this was a `tools` list it was an `allowedTools`
// list, which restricts nothing — the "read-only" draft agent could Write, and
// in a probe against CLI 2.1.228 it did.
const DRAFT_TOOLS = ["Read", "Grep", "Glob"];

// The one one-shot that keeps 'project': its whole job is to describe THIS
// repo, and 'project' is what loads CLAUDE.md — the single most useful file it
// can read. 'local' stays off, though: it adds only the gitignored
// CLAUDE.local.md and .claude/settings.local.json, one developer's private
// overrides leaking into a document written for everyone.
const DRAFT_SETTING_SOURCES: SettingSource[] = ["user", "project"];

/**
 * Draft a fresh "what we're building" project-context document by actually
 * reading the codebase. Unlike the one-shot summarizers above, this runs a
 * short read-only agent loop (Read/Grep/Glob) in the project's repo so
 * Claude can explore the current state of the code and write context that
 * reflects what the project has become. `digest` seeds it with the existing
 * context and recent git activity. Returns markdown the user reviews before
 * saving — we deliberately don't persist here.
 */
async function draftProjectContext(project: Project, digest: string, opts?: OneShotOptions): Promise<OneShotResult> {
  const response = query({
    prompt:
      `You are refreshing the saved "project context" for the project "${project.name}". ` +
      `This context is prepended to every new Claude Code session in this project, so it must get a ` +
      `fresh session up to speed fast and accurately reflect what the project IS NOW — not what it was ` +
      `when first described.\n\n` +
      `Explore the repository in your working directory using the read-only tools available to you ` +
      `(read key files, list the tree, grep for patterns, check package manifests and configs, skim the ` +
      `README and entry points). Then write the new context.\n\n` +
      `Cover, concisely: what the app does and its purpose; the tech stack and key dependencies; how the ` +
      `code is organized (the directories/modules that matter and what lives where); important conventions, ` +
      `patterns, and constraints; how to run/build/test it; and any other orientation a new contributor needs. ` +
      `Prefer concrete file paths over vague description. Be accurate — only state what you verified in the code. ` +
      `Do not invent features that aren't there.\n\n` +
      `If the project has a dev server, note how it starts and that it must bind the PORT env var ` +
      `Calandria injects, and (when the framework enforces host checks) the one-liner that allows ` +
      `Calandria's proxied hostname: Vite → server.allowedHosts including process.env.CALANDRIA_PUBLIC_HOST, ` +
      `Next → allowedDevOrigins in next.config; CRA/webpack-dev-server needs nothing (pre-cleared via env).\n\n` +
      `Write the context as plain markdown (no code fences around the whole thing), tight and ` +
      `information-dense, ~200–500 words. Wrap ONLY the final document between a line containing ` +
      `${CTX_OPEN} and a line containing ${CTX_CLOSE}. Put nothing but the document between those ` +
      `markers — any thinking-out-loud goes before the opening marker.\n\n` +
      `=== EXISTING SAVED CONTEXT (may be stale) ===\n${project.context || "(none)"}\n\n` +
      `=== RECENT ACTIVITY ===\n${digest || "(none)"}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      ...ONE_SHOT_BASE,
      ...oneShotModel(opts),
      settingSources: DRAFT_SETTING_SOURCES,
      tools: DRAFT_TOOLS,
      maxTurns: 40,
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  // First reading wins — init's resolved model, else the result's rollup.
  let model: string | null = null;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") {
      usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
      model ??= claudeMessageModel(message);
    } else if (message.type === "system") model ??= claudeMessageModel(message);
  }
  // Extract just the wrapped document; fall back to the raw text if the model
  // didn't emit the markers (then strip a stray fence if it wrapped the whole
  // thing in one).
  const open = out.indexOf(CTX_OPEN);
  const close = out.lastIndexOf(CTX_CLOSE);
  let doc = open !== -1 && close > open ? out.slice(open + CTX_OPEN.length, close) : out;
  doc = doc.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
  return { text: doc || "(no context produced)", usage, model };
}

/**
 * Check a tag's plan against the code ("Refresh tag"). Same read-only shape as
 * draftProjectContext — Read/Grep/Glob in the project's own checkout, no Bash —
 * because this run's whole output is a JSON plan the SERVER applies. The agent
 * deciding a task is stale and the app writing that decision down are kept
 * apart on purpose: it is what makes every change land as a revertable agent
 * edit instead of an unattended write.
 *
 * Returns the raw text; the caller parses it with parseTagPlan().
 */
async function planTagRefresh(project: Project, digest: string, opts?: OneShotOptions): Promise<OneShotResult> {
  const response = query({
    prompt: buildTagRefreshPrompt(project, digest),
    options: {
      cwd: project.repo_path || process.cwd(),
      ...ONE_SHOT_BASE,
      ...oneShotModel(opts),
      settingSources: DRAFT_SETTING_SOURCES,
      tools: DRAFT_TOOLS,
      maxTurns: 40,
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  // First reading wins — init's resolved model, else the result's rollup.
  let model: string | null = null;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") {
      usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
      model ??= claudeMessageModel(message);
    } else if (message.type === "system") model ??= claudeMessageModel(message);
  }
  return { text: out, usage, model };
}

/**
 * Generate a short "where you left off" recap for a project, shown when the
 * user returns after time away. One-shot, genuinely no tools (see
 * TEXT_ONE_SHOT). `digest` is the assembled recent activity (task summaries,
 * statuses, recent commits). Describes what happened only — deliberately no
 * next-step suggestions.
 */
async function summarizeProjectRecap(project: Project, digest: string, opts?: OneShotOptions): Promise<OneShotResult> {
  const response = query({
    prompt:
      `Write a very short "where I left off" recap for the project "${project.name}", shown when the user returns ` +
      `after time away so they can quickly regain context. Output ONLY 2–4 terse markdown bullet points ` +
      `("- " each), one line each, ideally under ~12 words. Be concrete about features, files, and tasks. ` +
      `No headings, no intro/outro sentence, no next steps or TODOs — recap only what has already happened.\n\n` +
      `=== PROJECT CONTEXT ===\n${project.context || "(none)"}\n\n=== RECENT ACTIVITY ===\n${digest}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      ...TEXT_ONE_SHOT,
      ...oneShotModel(opts),
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  // First reading wins — init's resolved model, else the result's rollup.
  let model: string | null = null;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") {
      usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
      model ??= claudeMessageModel(message);
    } else if (message.type === "system") model ??= claudeMessageModel(message);
  }
  return { text: out.trim() || "(no recap produced)", usage, model };
}

export const claudeDriver: AgentDriver = {
  id: "claude",
  label: "Claude Code",
  // A getter, not a constant: the model list depends on which backend the
  // instance routes through and on the alias mappings in the user's own
  // settings, both of which are read from disk (./provider.ts). GET /api/agents
  // therefore serves what a turn on this machine would really resolve, and
  // picks up a settings edit without a restart.
  get capabilities() {
    return claudeCapabilities();
  },
  runTurn,
  // The worktree files a turn loads and obeys, so the runner can hold a turn
  // whose settings changed under it (issue #43 — see WATCHED_SETTINGS_FILES).
  watchedSettingsFiles: WATCHED_SETTINGS_FILES,
  // What a turn on this task would actually expand — read from the same
  // settings a turn loads, rooted at the same cwd. See ./commands.ts.
  //
  // `null` there is "couldn't find out", a distinction the schedule validator
  // needs and the menu does not: an unreachable CLI costs the composer its long
  // tail and nothing else, so both failures land on the same empty list.
  listCommands: async (task, project) =>
    (await listClaudeCommands(sessionCwd(task, project), SETTING_SOURCES)) ?? [],
  // Session/week plan usage for the titlebar meter — passive rate_limit_event
  // telemetry merged with a conservatively-cached /api/oauth/usage fetch (see
  // ./planUsage.ts for why both sources are needed).
  planUsage: getClaudePlanUsage,
  summarizeTranscript,
  draftProjectContext,
  summarizeProjectRecap,
  planTagRefresh,
  // Auth delegates to lib/claude-auth.ts (the headless `claude auth login`
  // flow); the interface shapes were modeled on it, so this is a direct map.
  authStatus: claudeStatus,
  startLogin: startClaudeLogin,
  getLogin: getClaudeLogin,
  submitLoginCode: submitClaudeCode,
  cancelLogin: cancelClaudeLogin,
  verify: verifyTurn,
  // The "I have an API key instead" path (lib/anthropic-key.ts).
  apiKey: { hint: "sk-ant-…", looksValid: looksLikeApiKey, has: hasApiKey, set: setApiKey, clear: clearApiKey },
};
