// The Claude Code driver — the Agent SDK behind the AgentDriver seam
// (lib/agents/types.ts). This is the moved lib/claude.ts: runTurn() drives one
// user turn (resume or fresh session; project context appended to the Claude
// Code system prompt), mounts the orchestrator MCP tools (suggest_task /
// list_projects / list_tasks / get_task / update_task / withdraw_suggestion /
// expose_service), and normalizes SDK messages into the StreamEvent contract.
// The one-shot helpers
// (summarize / draft / recap) and the wizard's auth flow (delegating to
// lib/claude-auth.ts) round out the interface.

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionMode, PermissionResult, SettingSource } from "@anthropic-ai/claude-agent-sdk";
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
import type { AgentDriver, OneShotResult } from "../types";
import { claudeCapabilities } from "./capabilities";
import { listClaudeCommands } from "./commands";
import { getSetting, listPermissionRules, addPermissionRule } from "../../store";
import {
  createSuggestedTask,
  getTaskForAgent,
  listProjectsForAgent,
  listTasksForAgent,
  registerExposedService,
  rememberSuggestedTitle,
  resolveTargetProject,
  resolveTitleRefs,
  updateTaskForAgent,
  withdrawSuggestionForAgent,
} from "../../agentTools";
import { SUGGEST_TASK, EXPOSE_SERVICE, LIST_PROJECTS, LIST_TASKS, GET_TASK, UPDATE_TASK, WITHDRAW_SUGGESTION } from "../../agentToolDefs.mjs";
import { waitForAnswer } from "../../asks";
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
  CLAUDE_CLI_PATH as CLAUDE_PATH,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PERMISSION_UNATTENDED_MS,
} from "../../config";
import { interactionDenied, UNATTENDED_ASK_DENIAL, UNATTENDED_ASK_NOTE } from "../../runContext";
import { isUsageLimit } from "../../usageLimit";
import { hasApiKey, looksLikeApiKey, setApiKey, clearApiKey } from "../../anthropic-key";
import {
  buildProjectContext,
  describeToolUse,
  summarizeResult,
  formatAnswers,
  makeQueue,
  resultText,
  clip,
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
import { claudeUsage } from "./usage";

// Which on-disk setting sources every Claude query loads. This is EXACTLY the
// SDK's own default ("when omitted, all sources are loaded (matches CLI
// defaults)") — pinned explicitly rather than inherited, because the default is
// what makes a task session feel like the user's own `claude` terminal: their
// ~/.claude settings, MCP servers, plugins and skills, plus every CLAUDE.md the
// SDK discovers from `project`. That's a deliberate product decision, and an SDK
// bump that changed the default would silently strip all of it with no symptom
// beyond the agent quietly getting worse. Written out here so there is a line to
// grep for, a test to fail (tests/claudeSettingSources.test.ts), and a comment
// that says the inheritance is wanted.
//
// 'project' is load-bearing twice over: it's what loads CLAUDE.md, and a task
// runs in its own worktree, so ".claude/" here means the checked-out repo's.
//
// This is settings inheritance only; it grants nothing. What an inherited MCP
// server may actually DO is decided downstream by permissionMode + canUseTool
// like any other tool — auto-approved under bypassPermissions, screened by the
// classifier under the "auto" default, and a permission card otherwise.
//
// EXPORTED because it is load-bearing outside this file too: the schedule
// preflight (lib/schedule/commands.ts) opens a throwaway session purely to read
// the slash-command registry a scheduled turn would get, and validates against
// it. A second hardcoded copy there would mean the two could drift — and a
// drifted registry doesn't degrade quietly: an unknown command settles the run
// `failed` and mints nothing, every morning. Pinned by
// tests/claudeSettingSources.test.ts, which drives the real probe through the
// mocked SDK and reads the sources back.
export const SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

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
// session the user is sitting in: it has no orchestrator bridge, no transcript,
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

function orchestratorServer(
  project: Project,
  task: Task,
  onSuggest: (s: { title: string; projectId: string }) => void,
  onExpose: (info: { name: string; url: string }) => void
) {
  // Titles created this session, so `blocked_by` can reference earlier suggestions
  // by title (not just id) — friendlier for the model when planning a roadmap.
  // Keyed by (target project, title): a suggestion can be filed into any project
  // and dependencies never cross one, so the same title in two projects is two
  // unrelated tasks rather than an ambiguous ref.
  const createdByTitle = new Map<string, string>();
  return createSdkMcpServer({
    name: "orchestrator",
    version: "1.0.0",
    tools: [
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
        },
        async (args: { title: string; description: string; priority: "hi" | "med" | "lo"; project?: string; blocked_by?: string[] }) => {
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
          const { task, text } = createSuggestedTask(target.project, {
            title: args.title,
            description: args.description,
            priority: args.priority,
            blocked_by: resolveTitleRefs(args.blocked_by, createdByTitle, target.project.id),
          });
          // A null task = the project was deleted mid-turn; `text` already says so.
          if (task) {
            rememberSuggestedTitle(createdByTitle, target.project.id, args.title, task.id);
            onSuggest({ title: args.title, projectId: target.project.id });
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
        },
        async (args: { project?: string; include_done?: boolean }) => {
          // Same strict resolution suggest_task uses — reads are inert, but a
          // board silently listed from the wrong project is still a lie.
          const target = resolveTargetProject(project, args.project);
          if ("error" in target) return { content: [{ type: "text", text: target.error }], isError: true };
          const tasks = listTasksForAgent(target.project, task.id, args.include_done ?? false);
          return { content: [{ type: "text", text: JSON.stringify({ project: target.project.name, tasks }, null, 2) }] };
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
        },
        async (args: { task?: string; title?: string; description?: string; priority?: Priority; status?: TaskStatus; blocked_by?: string[] }) => {
          // The closed-over `task` is the CALLER — the snapshot taken at turn
          // start, and the one identity the model can't influence. `args.task`
          // is the target it named; updateTaskForAgent decides whether that may
          // be written and re-reads both rows first, so a task deleted or
          // started mid-turn is a refusal rather than a stale write.
          const { task: updated, text, autoStartDependents } = updateTaskForAgent(task, args.task, args);
          if (autoStartDependents && updated) {
            // Imported at CALL time, not module load: lib/autoStart reaches
            // lib/runner, which imports the driver registry, which imports this
            // file — a static import would close that cycle at init.
            const { maybeAutoStartDependents } = await import("../../autoStart");
            maybeAutoStartDependents(updated.id);
          }
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
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
          if (autoStartDependents && updated) {
            // Cancelling cleared a blocker. Imported at CALL time for the same
            // cycle reason as update_task's copy above.
            const { maybeAutoStartDependents } = await import("../../autoStart");
            maybeAutoStartDependents(updated.id);
          }
          return { content: [{ type: "text", text }], ...(updated ? {} : { isError: true }) };
        }
      ),
    ],
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
// default back to Auto-run in Settings.
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
  abortController?: AbortController
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
  // that's also unset, fall through to Claude Code's built-in (no thinking override,
  // bypassPermissions).
  // App defaults are agent-scoped ("default_reasoning:<agent>"), falling back to
  // the legacy un-suffixed key so pre-existing settings still apply.
  const reasoning = task.reasoning ?? getSetting(`default_reasoning:${task.agent}`) ?? getSetting("default_reasoning");
  const permission = task.permission_mode ?? getSetting(`default_permission_mode:${task.agent}`) ?? getSetting("default_permission_mode");

  // Chat attachments travel as "[Attached image: /abs/path]" (images) or
  // "[Attached file: /abs/path]" (a large text paste diverted to a file) marker
  // lines in the message text (composed in app/orchestrator/format.ts; files
  // live outside the worktree, see lib/uploads.ts). The Read tool renders images
  // natively and reads text files as text — this nudge makes Claude actually
  // open them. Prompt-only: the persisted transcript keeps the bare markers.
  const prompt = /^\[Attached (image|file): .+\]$/m.test(userText)
    ? `${userText}\n\n(Read each attached image/file with the Read tool before responding.)`
    : userText;

  const permissionMode = permissionModeFor(permission);

  // The permission gate. It must be PROVIDED in every mode, because CLI ≥2.1
  // only puts AskUserQuestion in the model's tool list when the host signals it
  // can field interactive prompts by passing canUseTool — without it the tool
  // simply doesn't exist and Claude can never ask (verified against 2.1.198).
  //
  // Under "Auto-run" (bypassPermissions) the SDK never consults it, so it stays
  // a blanket allow. In every OTHER mode each call the CLI doesn't auto-approve
  // arrives here — and this is what makes those modes mean something rather than
  // being Auto-run with a different label. What reaches the gate differs per
  // mode, which is the whole point of offering them: "Guarded auto" escalates
  // only what its classifier won't vouch for, "Accept edits" lets writes through
  // and stops at commands, "Ask when needed" stops at anything not pre-approved,
  // "Plan mode" stops at leaving the plan. Known-safe tools and calls already
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

  const response = query({
    prompt,
    options: {
      cwd: sessionCwd(task, project),
      resume: task.session_id ?? undefined,
      // Per-task model selection ("opus"/"sonnet"/"haiku" alias). Omit to inherit
      // Claude Code's default model.
      ...(task.model ? { model: task.model } : {}),
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
        orchestrator: orchestratorServer(
          project,
          task,
          // Straight onto the queue, like expose_service's notice below: the
          // suggestion is already committed, and holding it until the turn ends
          // would keep the receiving tray stale for as long as the turn runs —
          // hours, if it parks on a question.
          ({ title, projectId }) => queue.push({ type: "suggested", title, projectId }),
          ({ name, url }) => queue.push({ type: "notice", content: `Service "${name}" is live at ${url}` })
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
                  reason = "The user dismissed the question without answering.";
                }
                return {
                  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
                };
              },
            ],
          },
        ],
      },
    },
  });

  // Pump SDK messages into the queue. Runs concurrently with the hook (which
  // pushes ask events while this is parked awaiting the tool result).
  const pump = (async () => {
    try {
      for await (const message of response) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          queue.push({ type: "session", sessionId });
          // The init message reports the model the SDK actually resolved (e.g. when
          // "default" maps to Opus). Surface it so the UI can badge the live model.
          const resolved = (message as { model?: string }).model;
          if (resolved) queue.push({ type: "model", model: resolved });
        } else if (message.type === "system" && message.subtype === "permission_denied") {
          // A tool call the CLI refused WITHOUT ever consulting canUseTool, so
          // there was no card and the user was never given the choice. Under
          // "Guarded auto" that's the classifier vetoing a call it judged
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
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              queue.push({ type: "assistant", content: block.text });
            } else if (block.type === "tool_use") {
              // AskUserQuestion is rendered as an interactive card by the hook.
              if (block.name === "AskUserQuestion") continue;
              const { title, detail, peek, diff, resultKind } = describeToolUse(block.name, block.input as Record<string, unknown>);
              if (resultKind) resultKinds.set(block.id, resultKind);
              queue.push({ type: "tool", id: block.id, title, detail, peek, diff });
            }
          }
        } else if (message.type === "user") {
          // Tool results come back as user-role messages with tool_result blocks.
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
                const b = block as { tool_use_id: string; content: unknown; is_error?: boolean };
                // The deny-result of an answered ask is already shown via ask_answered.
                if (askIds.has(b.tool_use_id)) continue;
                const raw = resultText(b.content);
                const kind = resultKinds.get(b.tool_use_id);
                // Summarize from the raw (pre-clip) output so counts are exact.
                const peek = kind && !b.is_error ? summarizeResult(kind, raw) : undefined;
                queue.push({ type: "tool_result", id: b.tool_use_id, content: clip(raw, 6000), isError: !!b.is_error, peek });
              }
            }
          }
        } else if (message.type === "rate_limit_event") {
          // Subscription rate-limit telemetry (status/utilization/resetsAt).
          // Not surfaced as a transcript event — just remember the reset time
          // so a subsequent usage-limit failure can say when the quota heals.
          const resetsAt = message.rate_limit_info?.resetsAt;
          if (typeof resetsAt === "number") limitResetsAt = resetsAt;
        } else if (message.type === "result") {
          // Per-turn spend: the result message carries this turn's dollar cost
          // and token counts. Persisted by the consumer for cumulative totals.
          queue.push({
            type: "usage",
            usage: claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> }),
          });
          if (message.subtype !== "success" && "result" in message === false) {
            queue.push({ type: "error", content: withResetTime(`Run ended: ${message.subtype}`) });
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
async function summarizeTranscript(transcript: string, project: Project): Promise<OneShotResult> {
  const response = query({
    prompt:
      `Summarize the following Claude Code session into a concise handoff note for a fresh session ` +
      `continuing the same task. Cover: what was done, the current state of the code, decisions made, ` +
      `and what remains. Be specific about files and follow-ups. Output only the note.\n\n` +
      `=== TRANSCRIPT ===\n${transcript}`,
    options: {
      cwd: project.repo_path || process.cwd(),
      ...TEXT_ONE_SHOT,
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
  }
  return { text: out.trim() || "(no summary produced)", usage };
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
async function draftProjectContext(project: Project, digest: string): Promise<OneShotResult> {
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
      `If the project has a dev server, note how it starts and that it must bind the PORT env var the ` +
      `orchestrator injects, and (when the framework enforces host checks) the one-liner that allows the ` +
      `orchestrator's proxied hostname: Vite → server.allowedHosts including process.env.ORCH_PUBLIC_HOST, ` +
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
      settingSources: DRAFT_SETTING_SOURCES,
      tools: DRAFT_TOOLS,
      maxTurns: 40,
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
  }
  // Extract just the wrapped document; fall back to the raw text if the model
  // didn't emit the markers (then strip a stray fence if it wrapped the whole
  // thing in one).
  const open = out.indexOf(CTX_OPEN);
  const close = out.lastIndexOf(CTX_CLOSE);
  let doc = open !== -1 && close > open ? out.slice(open + CTX_OPEN.length, close) : out;
  doc = doc.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
  return { text: doc || "(no context produced)", usage };
}

/**
 * Generate a short "where you left off" recap for a project, shown when the
 * user returns after time away. One-shot, genuinely no tools (see
 * TEXT_ONE_SHOT). `digest` is the assembled recent activity (task summaries,
 * statuses, recent commits). Describes what happened only — deliberately no
 * next-step suggestions.
 */
async function summarizeProjectRecap(project: Project, digest: string): Promise<OneShotResult> {
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
    },
  });

  let out = "";
  let usage: TurnUsage | undefined;
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") out += block.text;
      }
    } else if (message.type === "result") usage = claudeUsage(message as unknown as { total_cost_usd?: number; usage?: Record<string, number> });
  }
  return { text: out.trim() || "(no recap produced)", usage };
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
  // What a turn on this task would actually expand — read from the same
  // settings a turn loads, rooted at the same cwd. See ./commands.ts.
  //
  // `null` there is "couldn't find out", a distinction the schedule validator
  // needs and the menu does not: an unreachable CLI costs the composer its long
  // tail and nothing else, so both failures land on the same empty list.
  listCommands: async (task, project) =>
    (await listClaudeCommands(sessionCwd(task, project), SETTING_SOURCES)) ?? [],
  summarizeTranscript,
  draftProjectContext,
  summarizeProjectRecap,
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
