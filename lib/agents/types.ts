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
  /** Can mount Calandria's MCP tools (suggest_task / expose_service). */
  supportsMcpTools: boolean;
  /**
   * On top of Calandria's own tools, whether a task session also gets
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
   * One line of driver-supplied detail about how hosted LiteLLM-gateway MCP
   * servers (projects.gateway_mcp / tasks.gateway_mcp, lib/gatewayMcp.ts) mount
   * for THIS driver, alongside the verdict `inheritsUserMcpServers` states for
   * the user's own CLI-configured servers — a separate selection with its own
   * per-driver caveat. Codex's names the bypass-only mount and the
   * per-server auto-approval `codex exec` needs; Antigravity's names the
   * alias-to-hyphen slugging its policy engine forces. null = nothing special
   * to say — the server mounts exactly like Calandria's own tools (Claude).
   */
  gatewayMcpNote: string | null;
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
  /**
   * The agent can dispatch subagents of its own, so buildProjectContext
   * (lib/agents/shared.ts) may tell a session to push bulk context collection
   * into them. False = the block is omitted rather than describing a tool the
   * session doesn't have; Codex has no subagent verb at all.
   */
  dispatchesSubagents: boolean;
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
  /**
   * TRUE when the login can finish WITHOUT the user pasting anything back —
   * Antigravity's OAuth redirect lands on Google's own callback page, which
   * completes the sign-in for the waiting CLI, so a user who never copies the
   * code is nonetheless signed in. The connect card therefore polls the
   * driver's authStatus() alongside its login poll while the code box is
   * showing, instead of waiting for a paste that will never come.
   *
   * False for Claude (the code IS the exchange) and for Codex, whose device
   * flow already lands on its own and is polled through the login session.
   * Costs a real CLI probe per poll, so it stays opt-in per driver.
   */
  loginCompletesOutOfBand: boolean;
  /**
   * One extra sentence the connect card shows under its sign-in CTA — the
   * per-agent caveat that the generic prose can't carry. Antigravity's is the
   * container one: `agy` keeps its OAuth token in the D-Bus Secret Service,
   * which the published image has no daemon for, so a containerized instance
   * connects with `GEMINI_API_KEY` instead. null = nothing to add.
   */
  connectHint: string | null;
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
  /**
   * The model this run ACTUALLY used, as the driver observed it — not the id
   * `OneShotOptions.model` asked for, which is null whenever the job inherits
   * the driver's own default. Optional: a driver with no way to see it omits
   * this and the recorded row falls back to what was requested.
   */
  model?: string | null;
}

/**
 * Per-call overrides for a one-shot. `model` is the id the caller resolved from
 * the job's tier setting (see lib/agents/oneshots.ts); null/undefined means
 * "inherit whatever the driver's own default is", which is what every one-shot
 * did before the setting existed.
 */
export interface OneShotOptions {
  model?: string | null;
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
 * Side effects a turn's TOOL CALLS need, handed to the driver by whoever
 * launched the turn (lib/runner.ts's startTurn, from its caller) instead of
 * being imported by the driver itself.
 *
 * There is exactly one, and it exists because of the module graph rather than
 * because drivers wanted a plugin point. `update_task`/`withdraw_suggestion`
 * can move a task to a terminal status, which stops it blocking its
 * dependents, and launching those is lib/autoStart.ts's job — a module that
 * reaches lib/runner.ts, which resolves this driver through
 * lib/agents/registry.ts. A driver importing it back closes the cycle
 *
 *   autoStart → runner → agents/registry → agents/claude/driver → autoStart
 *
 * that broke EVERY auto-start in production once already (issue #40; the
 * dynamic import that stopped the symptom left the cycle in place). Naming a
 * callback instead of the module keeps the graph a DAG: the driver knows "a
 * task went terminal", not what the app does about it — and the layer that
 * does know is the one that already owns the launch. The Codex path has always
 * worked this way, with lib/agentTools.ts returning an `autoStartDependents`
 * flag its route acts on; this is the same split for the in-process driver,
 * whose "route" is the runner. Pinned by tests/importGraph.test.ts.
 */
export interface TurnHooks {
  /**
   * `taskId` just reached a terminal status (done or cancelled) via one of this
   * turn's tool calls, so anything waiting on it may now be startable.
   * Fire-and-forget: not awaited, and whatever it starts must swallow its own
   * failures — a tool result must never depend on a launch succeeding.
   */
  onTaskCleared(taskId: string): void;
  /**
   * `taskId` just had a PR opened (or updated) by one of this turn's tool
   * calls, so its GitHub state is worth reading and the sweep worth starting.
   *
   * Injected for the same reason as `onTaskCleared`, and it became necessary
   * the moment reclaiming a landed PR was added: lib/prState.ts now reaches
   * lib/reclaim.ts, which reaches a launcher, so lib/prTools.ts — which the
   * driver imports for `create_pr` — importing prState would close exactly the
   * registry → driver → … → runner → registry cycle that killed auto-start.
   * Fire-and-forget, same contract: not awaited, swallows its own failures.
   */
  onPrOpened(taskId: string): void;
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
   *
   * `hooks` carries the side effects a driver must not import for itself (see
   * TurnHooks). Optional in the signature so a driver that mounts no Calandria
   * tools can ignore it entirely; the runner always passes what its caller
   * gave it.
   */
  runTurn(task: Task, project: Project, userText: string, abort?: AbortController, hooks?: TurnHooks): AsyncGenerator<StreamEvent>;

  /**
   * Files INSIDE the task's working directory that this driver re-reads from
   * disk at the start of every turn and then obeys — worktree-relative paths.
   *
   * These are the files that are configuration to the agent and ordinary
   * writable files to the task: `.claude/settings.json` carries `hooks` (literal
   * shell commands run on tool/session events, outside canUseTool entirely),
   * `permissions.allow` (auto-approval with no gate call at all) and `env`. An
   * agent can write one in turn N and have it take effect in turn N+1, and so
   * can a commit the base branch brought in, with nothing between the write and
   * the run but a human happening to read the diff (issue #43).
   *
   * Naming them here is what lets the runner hash each one before the turn
   * starts and hold the turn on a card when it has changed since the turn this
   * task last ran (lib/settingsDrift.ts). It is the driver's list because only
   * the driver knows which files its CLI loads: the Claude driver derives it
   * from SETTING_SOURCES, so re-adding a source re-derives the watch list
   * rather than leaving a new one unwatched.
   *
   * OPTIONAL. Omitted (or empty) means "this agent loads nothing from the
   * worktree that it will then execute" — Codex, whose config is ~/.codex only
   * — and the gate is skipped entirely for that agent's tasks.
   */
  watchedSettingsFiles?: string[];

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
  // All four are OPTIONAL: a driver can ship runTurn() alone and the app
  // backstops the missing helper with the configured utility agent (see
  // lib/agents/oneshots.ts). summarizeTranscript is task-scoped (runs on the
  // task's own agent so the work bills the right login); the rest are
  // project-scoped and run on the utility agent.

  //
  // `opts` is TRAILING-OPTIONAL on all three so a driver that ignores it (or
  // predates it) still satisfies the interface — a missing model means the same
  // thing as no setting: inherit the driver's own default.

  /** Condense a session transcript into a handoff note for the /clear flow. */
  summarizeTranscript?(transcript: string, project: Project, opts?: OneShotOptions): Promise<OneShotResult>;
  /** Draft a fresh "what we're building" context by exploring the repo (read-only). */
  draftProjectContext?(project: Project, digest: string, opts?: OneShotOptions): Promise<OneShotResult>;
  /** Short "where you left off" recap from a recent-activity digest. */
  summarizeProjectRecap?(project: Project, digest: string, opts?: OneShotOptions): Promise<OneShotResult>;
  /**
   * Check a tag's plan against the code and say what's gone stale — the
   * "Refresh tag" button (lib/tagRefresh.ts). `digest` carries the tag, its
   * saved description and every member's brief; the driver explores the repo
   * READ-ONLY and returns a JSON plan (parsed by parseTagPlan()) rather than
   * writing anything. The server applies it, so the edits land as revertable
   * agent edits instead of unattended writes nobody can see.
   */
  planTagRefresh?(project: Project, digest: string, opts?: OneShotOptions): Promise<OneShotResult>;

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
