// The agent-driver seam. The app never talks to a specific coding agent
// directly — every call site resolves an AgentDriver through
// lib/agents/registry.ts (keyed by tasks.agent / projects.default_agent) and
// speaks this interface. Adding an agent (Codex, Gemini, …) is a new driver
// module + a registry entry, with no edits to the runner, routes, or UI data
// flow — the same swappable-seam pattern as lib/billing/ and
// lib/control-plane/provisioner/.

import type { PlanUsageSnapshot, Project, Task, StreamEvent, TurnUsage } from "../types";

export type { StreamEvent };

// One selectable model in a driver's picker. `value` is what's persisted in
// tasks.model (null there = inherit the driver's default); `contextWindow` is
// the model's token window, driving the context-occupancy gauge. `group` is an
// optional section heading — drivers with long lists (Claude Code offers a
// dozen-plus pins) split them so the picker stays scannable; consecutive
// options sharing a group render under one header.
export interface AgentModelOption {
  value: string;
  label: string;
  sub: string; // short picker subtitle, e.g. "most capable"
  contextWindow: number;
  group?: string;
}

// A reasoning preset / permission mode a driver supports. `value` is what's
// persisted in tasks.reasoning / tasks.permission_mode (null = driver default).
export interface AgentPickerOption {
  value: string;
  label: string;
  sub: string;
}

/**
 * What a driver can do, as data. Exposed to the client (GET /api/agents) so
 * the UI renders model/reasoning/permission pickers and gates features
 * (asks, cost display, resume) from the descriptor instead of hardcoding
 * per-agent knowledge.
 */
export interface AgentCapabilities {
  models: AgentModelOption[];
  reasoningOptions: AgentPickerOption[];
  permissionModes: AgentPickerOption[];
  /** Can surface interactive AskUserQuestion-style prompts mid-turn ("ask" events). */
  supportsAsks: boolean;
  /** Can mount the orchestrator's MCP tools (suggest_task / expose_service). */
  supportsMcpTools: boolean;
  /**
   * On top of the orchestrator's own tools, whether a task session also gets
   * the MCP servers the user configured for this agent's CLI (~/.claude for
   * Claude, ~/.codex/config.toml for Codex).
   *
   * This is a REAL functional difference between the agents, not a config
   * detail, so it's modeled here rather than left implicit: a Claude task can
   * call the user's own MCP tools and an otherwise-identical Codex task cannot.
   * Codex is false because `codex exec` has no approver, so inherited tools are
   * visible but every call is cancelled — the driver unmounts them instead of
   * offering tools that can't work (lib/agents/codex/mcp.ts).
   */
  inheritsUserMcpServers: boolean;
  /**
   * One line of driver-supplied detail for the flag above, rendered next to it
   * in Settings → Agents. The verdict is the boolean; the WHY is per-driver
   * (which config file the servers come from, why they're unmounted, which env
   * var opts back in), so it's data here rather than a per-agent string in the
   * UI — same reason the flag is. null = the verdict says everything.
   */
  userMcpServersNote: string | null;
  /**
   * run_in_background work survives the model's turn: the driver holds the
   * session open (bounded by BACKGROUND_LINGER_MS) until the tasks settle and
   * their completion notifications wake the model into a continuation turn.
   * False = background tasks die with the turn's CLI process, and
   * buildProjectContext (lib/agents/shared.ts) warns the model off them —
   * without the warning the shell tool's own docs promise a notification that
   * never comes.
   */
  backgroundTasksLinger: boolean;
  /** Usage events carry a real dollar cost (not just token counts). */
  reportsCostUsd: boolean;
  /**
   * The dollar cost in usage events is an ESTIMATE (token counts × published
   * API prices) rather than a billed amount — set by drivers whose auth
   * reports tokens only (Codex on a ChatGPT plan). The UI shows the figure
   * with an ~ and labels it estimated. Mutually exclusive with reportsCostUsd.
   */
  costIsEstimated: boolean;
  /**
   * The turn stream emits `context` events — the agent's own report of how
   * many tokens the window currently holds (StreamEvent in lib/types.ts).
   * False = the gauge is derived from the last usage report instead, which
   * on a tool-heavy turn sums many requests and over-reads; the UI labels
   * that figure an estimate. Codex is false: `codex exec`'s JSONL carries
   * only the thread's running totals on turn.completed (the per-request
   * `last_token_usage` exists in the binary, but only on the app-server
   * protocol the SDK doesn't speak).
   */
  reportsContext: boolean;
  /** Turns can resume a prior session/thread id (tasks.session_id). */
  supportsResume: boolean;
  /**
   * Placeholder for the "I have an API key instead" field, e.g. "sk-ant-…".
   * null = this agent has no per-token API-key path (subscription login only),
   * so the client hides the api-key toggle.
   */
  apiKeyHint: string | null;
  /**
   * How the subscription login completes, so the generic connect UI knows what
   * to render: "paste_code" — the user pastes an authorization code back into
   * the app (Claude); "device_code" — the app shows a one-time code the user
   * enters in the browser, then polls until it lands (Codex).
   */
  loginStyle: "paste_code" | "device_code";
}

// ---------- auth surface (shape after lib/claude-auth.ts) ----------

export interface AgentAuthStatus {
  authenticated: boolean;
  method: string | null; // how the account is signed in (raw provider text)
  email: string | null;
  plan: string | null;
  error: string | null;
}

// A headless device-style login in progress (start → awaiting code → success).
export interface AgentLoginSession {
  status: "starting" | "awaiting" | "submitting" | "success" | "error";
  url: string | null; // the authorize URL for the user to open
  code?: string | null; // device-code drivers: the one-time code to enter in the browser
  email: string | null;
  plan: string | null;
  error: string | null;
  log: string; // tail of the login terminal output, for the UI's pane
}

export interface AgentVerifyResult {
  ok: boolean;
  output: string;
  error: string | null;
}

export interface OneShotResult {
  text: string;
  usage?: TurnUsage;
}

/**
 * One slash command a task session would expand — a skill, a plugin command, a
 * user/project command in `.claude/commands`, or one of the CLI's built-ins.
 * `name` carries no leading slash and may be namespaced (`plugin:command`).
 *
 * These are the agent's OWN commands, discovered from its config; Calandria adds
 * its own (`/clear`) on top in the composer. Which of them the menu actually
 * offers is decided by lib/agentCommands.ts.
 */
export interface AgentCommand {
  name: string;
  description: string;
  /** Usage hint for the arguments, e.g. "<file>". Empty when the command takes none. */
  argumentHint?: string;
  /**
   * Other names that resolve to this same command (the CLI maps /cost and
   * /stats onto /usage). Carried so the menu can MATCH on them — dropping them
   * would leave a user who knows the alias unable to find the command, which is
   * the exact discoverability hole this whole surface exists to close. The
   * canonical `name` is still what's displayed and inserted.
   */
  aliases?: string[];
}

/**
 * The "I have an API key instead" alternative to the subscription login, as a
 * small surface a driver optionally provides (mirrors lib/anthropic-key.ts /
 * lib/openai-key.ts). The key is persisted to a 0600 file on the volume and
 * mirrored into process.env so the agent's children bill per-token against it.
 * Drivers without a per-token path simply omit `apiKey`.
 */
export interface AgentApiKeyAuth {
  /** Placeholder for the input, e.g. "sk-ant-…". Also surfaced via capabilities.apiKeyHint. */
  hint: string;
  /** Loose shape check; the real validation is the verify turn working. */
  looksValid(key: string): boolean;
  /** Whether a key is currently persisted. */
  has(): boolean;
  /** Persist + apply the key. */
  set(key: string): void;
  /** Forget the key. */
  clear(): void;
}

/**
 * A pluggable coding-agent backend.
 *
 * `runTurn` is THE contract: one user turn in, a stream of normalized
 * StreamEvents out (session/model/assistant/tool/tool_result/ask/ask_answered/
 * suggested/usage/notice/error/done — see lib/types.ts). Drivers normalize
 * their native event stream into it; everything downstream (lib/runner.ts
 * persistence + publish, the SSE tail, the UI) is agent-agnostic.
 *
 * The session/thread id a driver reports via "session"/"done" events is opaque
 * to the app — it's stored in tasks.session_id / sessions.claude_session_id
 * and handed back verbatim on resume (a Codex thread id fits the same column).
 */
export interface AgentDriver {
  id: string; // persisted in tasks.agent / projects.default_agent
  label: string; // human name, e.g. "Claude Code"
  capabilities: AgentCapabilities;

  /**
   * Run one user turn. Resumes task.session_id when set, otherwise starts a
   * fresh session seeded with the project context. `abort` (the Stop button)
   * must end the stream without emitting an error event.
   */
  runTurn(task: Task, project: Project, userText: string, abort?: AbortController): AsyncGenerator<StreamEvent>;

  /**
   * The slash commands a turn on this task WOULD expand, so the composer's "/"
   * menu can offer them instead of guessing. Scoped to the task because the
   * answer depends on its worktree: `.claude/commands` in the checked-out repo
   * counts, and two tasks on different projects get different lists.
   *
   * OPTIONAL. A driver whose agent has no command surface (Codex) omits it and
   * the menu falls back to Calandria's own commands alone — the same
   * implement-what-you-support rule as the one-shot helpers above. Must be
   * cheap and non-mutating: it runs on a keystroke, not a turn.
   */
  listCommands?(task: Task, project: Project): Promise<AgentCommand[]>;

  /**
   * Subscription-plan usage (session/week rate-limit windows) for the login
   * this driver runs on, feeding the titlebar meter via GET /api/plan-usage.
   *
   * OPTIONAL, same rule as listCommands: an agent whose auth has no metered
   * plan (or no way to read it) omits it and the meter simply doesn't render
   * for that agent. Must be cheap on the cached path — the client polls it —
   * with any real fetch of a provider API rate-limit-respecting and
   * instance-cached inside the driver (see lib/agents/claude/planUsage.ts).
   * `null` = nothing to show (feature off, or not a subscription login).
   */
  planUsage?(): Promise<PlanUsageSnapshot | null>;

  // ---------- one-shot helpers (no session, text in → text out) ----------
  //
  // All three are OPTIONAL: a driver can ship runTurn() alone and the app
  // backstops the missing helper with the configured utility agent (see
  // lib/agents/oneshots.ts). summarizeTranscript is task-scoped (runs on the
  // task's own agent so the work bills the right login); draft/recap are
  // project-scoped and run on the utility agent.

  /** Condense a session transcript into a handoff note for the /clear flow. */
  summarizeTranscript?(transcript: string, project: Project): Promise<OneShotResult>;
  /** Draft a fresh "what we're building" context by exploring the repo (read-only). */
  draftProjectContext?(project: Project, digest: string): Promise<OneShotResult>;
  /** Short "where you left off" recap from a recent-activity digest. */
  summarizeProjectRecap?(project: Project, digest: string): Promise<OneShotResult>;

  // ---------- auth (the setup wizard's connect / verify flow) ----------

  /** Whether the agent's CLI/SDK is signed in, and as whom. */
  authStatus(): Promise<AgentAuthStatus>;
  /** Start (or rejoin) a headless login; resolves once the authorize URL is known. */
  startLogin(): Promise<AgentLoginSession>;
  /** The in-progress login, if any (for the UI's poll loop). */
  getLogin(): AgentLoginSession | null;
  /** Hand the pasted authorization code to the waiting login. */
  submitLoginCode(code: string): Promise<AgentLoginSession>;
  /** Abandon an in-progress login. */
  cancelLogin(): void;
  /** Prove the connection works by running a real one-shot test turn. */
  verify(): Promise<AgentVerifyResult>;
  /** The per-token API-key path, if this agent supports one (else undefined). */
  apiKey?: AgentApiKeyAuth;
}
