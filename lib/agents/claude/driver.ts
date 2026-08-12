// The Claude Code driver — the Agent SDK behind the AgentDriver seam
// (lib/agents/types.ts). This is the moved lib/claude.ts: runTurn() drives one
// user turn (resume or fresh session; project context appended to the Claude
// Code system prompt), mounts the suggest_task / expose_service MCP tools, and
// normalizes SDK messages into the StreamEvent contract. The one-shot helpers
// (summarize / draft / recap) and the wizard's auth flow (delegating to
// lib/claude-auth.ts) round out the interface.

import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Project, Task, StreamEvent, AskQuestion, TurnUsage, PermissionOutcome, PermissionRequest } from "../../types";
import type { AgentDriver, OneShotResult } from "../types";
import { CLAUDE_CAPABILITIES } from "./capabilities";
import { getSetting, listPermissionRules, addPermissionRule } from "../../store";
import { createSuggestedTask, registerExposedService, resolveTitleRefs } from "../../agentTools";
import { SUGGEST_TASK, EXPOSE_SERVICE } from "../../agentToolDefs.mjs";
import { waitForAnswer } from "../../asks";
import {
  allowedByRules,
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

function orchestratorServer(project: Project, onSuggest: (title: string) => void, onExpose: (info: { name: string; url: string }) => void) {
  // Titles created this session, so `blocked_by` can reference earlier suggestions
  // by title (not just id) — friendlier for the model when planning a roadmap.
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
      tool(
        SUGGEST_TASK.name,
        SUGGEST_TASK.description,
        {
          title: z.string().describe(SUGGEST_TASK.params.title),
          description: z.string().describe(SUGGEST_TASK.params.description),
          priority: z.enum(["hi", "med", "lo"]).default("med"),
          blocked_by: z.array(z.string()).optional().describe(SUGGEST_TASK.params.blocked_by),
        },
        async (args: { title: string; description: string; priority: "hi" | "med" | "lo"; blocked_by?: string[] }) => {
          // Resolve refs (id passes through; a title from earlier this session maps
          // to its id) then create + wire deps via the shared logic. Record this
          // task's title→id so later suggestions can reference it by title.
          const { task, text } = createSuggestedTask(project, {
            title: args.title,
            description: args.description,
            priority: args.priority,
            blocked_by: resolveTitleRefs(args.blocked_by, createdByTitle),
          });
          // A null task = the project was deleted mid-turn; `text` already says so.
          if (task) {
            createdByTitle.set(args.title, task.id);
            onSuggest(args.title);
          }
          return { content: [{ type: "text", text }] };
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

// The task's run permission. null (and any unknown value) keeps the app default of
// bypassPermissions — sessions auto-approve tools and run unattended. "plan" makes
// Claude propose a plan without editing; "acceptEdits" auto-accepts file edits only.
function permissionModeFor(m: string | null): "bypassPermissions" | "acceptEdits" | "plan" {
  return m === "acceptEdits" || m === "plan" ? m : "bypassPermissions";
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
  const suggested: string[] = [];
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
  // a blanket allow. Under "Accept edits" / "Plan mode" every call the SDK
  // doesn't auto-approve arrives here — and this is what makes those modes mean
  // something rather than being Auto-run with a different label. Known-safe
  // tools and calls already covered by a remembered project rule pass silently;
  // anything else parks the turn on a card the user answers, through the very
  // same registry + /answer route an AskUserQuestion uses (lib/permissions.ts).
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
      expiresAt: promptDeadline(PERMISSION_PROMPT_TIMEOUT_MS, PERMISSION_UNATTENDED_MS),
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
      // Prefer the task's isolated worktree; fall back to the shared repo path
      // (non-git projects, or worktree creation skipped).
      cwd: task.worktree_path || project.repo_path || process.cwd(),
      resume: task.session_id ?? undefined,
      // Per-task model selection ("opus"/"sonnet"/"haiku" alias). Omit to inherit
      // Claude Code's default model.
      ...(task.model ? { model: task.model } : {}),
      // Reasoning preset → thinking budget + effort (Off/Think/Think hard/Ultrathink).
      // Omitted keys leave Claude Code's default thinking.
      ...reasoningOptions(reasoning),
      systemPrompt: { type: "preset", preset: "claude_code", append: buildProjectContext(project, task) },
      // Permission mode (default bypassPermissions; "plan" proposes without editing).
      permissionMode,
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      mcpServers: {
        orchestrator: orchestratorServer(
          project,
          (t) => suggested.push(t),
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

  for (const t of suggested) yield { type: "suggested", title: t };
  yield { type: "done", sessionId };
}

/**
 * Summarize a transcript into a concise handoff note for the /clear flow.
 * One-shot, no tools — just text in, summary out.
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
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
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

/**
 * Draft a fresh "what we're building" project-context document by actually
 * reading the codebase. Unlike the one-shot summarizers above, this runs a
 * short read-only agent loop (Read/Grep/Glob/Bash) in the project's repo so
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
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      maxTurns: 40,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
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
 * user returns after time away. One-shot, no tools. `digest` is the assembled
 * recent activity (task summaries, statuses, recent commits). Describes what
 * happened only — deliberately no next-step suggestions.
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
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      pathToClaudeCodeExecutable: CLAUDE_PATH,
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
  capabilities: CLAUDE_CAPABILITIES,
  runTurn,
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
