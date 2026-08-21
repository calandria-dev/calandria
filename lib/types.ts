export type Priority = "hi" | "med" | "lo";
/** The one legal-value set for `priority` columns — no CHECK constraint backs them, so this is it. */
export const PRIORITIES: Priority[] = ["hi", "med", "lo"];
export type Status = "not_started" | "in_progress" | "on_hold" | "done" | "cancelled";
export type MsgRole = "user" | "assistant" | "tool" | "system" | "session_break";

export interface Project {
  id: string;
  name: string;
  icon: string;
  sub: string; // short tagline, e.g. "notes app"
  color: string; // accent color for the project glyph
  context: string; // "what we're building" — description, stack & conventions (single field)
  building: string; // legacy — kept for back-compat, folded into context
  conventions: string; // legacy — kept for back-compat, folded into context
  repo_path: string; // working dir for Claude Code
  branch: string; // git branch (context only)
  dev_command: string; // long-running dev server command supervised by lib/services.ts ("" = none)
  setup_command: string; // optional one-shot setup command (install/migrate/etc.)
  test_command: string; // optional one-shot test command
  port: number; // deterministic per-project port, injected as PORT into services + the PTY
  default_agent: string; // agent driver new tasks in this project run under (lib/agents/registry.ts)
  send_context: number; // 1 = include the saved project context in new agent sessions (default for new tasks)
  recap: string; // last LLM "where you left off" recap (auto-generated when idle)
  recap_at: number; // when the recap was generated (0 = none)
  recap_covers_at: number; // the project's last-activity ts the recap was based on
  // Detached "Refresh with AI" job (drafts run in the background; see lib/contextRefresh.ts).
  refresh_status: "idle" | "running" | "done" | "error";
  refresh_draft: string; // drafted context awaiting the user's review (when status="done")
  refresh_error: string; // failure message (when status="error")
  refresh_started_at: number; // when the current/last job started (ms epoch, 0 = never)
  position: number; // manual sidebar order (ascending)
  deprecated: number; // 1 = hidden in the sidebar's "deprecated" area, not built on
  seeded: number; // 1 = the built-in "Welcome" tutorial project (see lib/db.ts seedIfEmpty)
  created_at: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number; // 1 = Claude-proposed, idle in the suggested tray
  agent: string; // agent driver this task's sessions run under (default "claude"; see lib/agents/)
  send_context: number; // 1 = include the saved project context in this task's sessions (seeded from projects.send_context)
  model: string | null; // chosen model alias ("fable"|"opus"|"sonnet"|"haiku"); null = inherit default
  resolved_model: string | null; // model the SDK actually ran last turn (for the badge)
  reasoning: string | null; // thinking preset ("off"|"think"|"think_hard"|"ultrathink"); null = inherit default
  permission_mode: string | null; // run permission ("acceptEdits"|"plan"); null = bypassPermissions (default)
  session_id: string | null; // the agent's opaque session/thread id for the current generation
  worktree_path: string; // isolated git worktree this task runs in ("" = runs in repo_path)
  work_branch: string; // the worktree's branch (e.g. "orch/<id>")
  base_sha: string; // commit the worktree branched from — the stable diff/merge base
  merged_at: number; // when this task's branch was merged back (0 = not merged)
  pr_url: string; // GitHub PR opened from this task's branch via "Create PR" ("" = none)
  generation: number; // increments on each /clear
  position: number; // manual order within the project (list groups + board columns, ascending)
  started: number; // 1 once the initial prompt has been sent
  auto_start: number; // 1 = start automatically when the last unfinished blocker is marked done (lib/autoStart.ts)
  withdrawn_reason: string; // why an agent retracted this suggestion ("" = not withdrawn); only meaningful with status "cancelled" + suggested 1
  running: number; // 1 while a Claude turn is actively streaming
  awaiting_input: number; // 1 when it's your turn: Claude's turn ended mid-task, or it's parked on an AskUserQuestion
  schedule_id: string | null; // the schedule that minted this task (lib/scheduler.ts); null = created by hand
  runbook_id: string | null; // the runbook that dispatched this task (lib/dispatch.ts); null = not from one
  // When a snooze ends (ms epoch; 0 = never snoozed / indicator cleared). Ahead
  // of now the task is drawn in the Snoozed category and hidden from the "needs
  // you" surfaces; behind it, the task is back in its own status group with a
  // "was snoozed" chip. `status` is deliberately untouched by a snooze — that's
  // what makes going back to the previous category free rather than restored.
  snoozed_until: number;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  task_id: string;
  generation: number;
  role: MsgRole;
  content: string;
  created_at: number;
}

export interface Summary {
  id: string;
  task_id: string;
  generation: number;
  summary: string;
  created_at: number;
}

// A follow-up the user typed while a turn was still running. Parked in the
// pending_messages table (FIFO per task) and shown as "queued" in the
// transcript; the runner dequeues the oldest one as the next turn when the
// current turn ends. Distinct from `messages` (the committed transcript).
export interface PendingMessage {
  id: string;
  task_id: string;
  generation: number;
  content: string;
  created_at: number;
}

export interface Session {
  id: string;
  project_id: string;
  task_id: string;
  generation: number;
  // The agent's own opaque session/thread id (named for the first driver; any
  // driver's id — e.g. a Codex thread id — lands in this same column).
  claude_session_id: string | null;
  started_at: number;
  ended_at: number | null;
}

// ---------- managed services (lib/services.ts) ----------

// A supervised process belonging to a project. `kind` is the configured slot the
// service maps to ("dev"/"setup"/"test"), or "exposed" for a server Claude
// registered at runtime via the expose_service MCP tool (we don't own that
// process, we only track its url). The orchestrator can start/stop/restart the
// configured kinds; an exposed entry is informational (its url is reportable).
export type ServiceStatus = "stopped" | "starting" | "running" | "exited" | "errored";
export type ServiceKind = "dev" | "setup" | "test" | "exposed";
// Who can open a service's public URL: private = the instance's own session
// auth, shared = anyone holding the tokened link (?t=…), public = anyone.
export type ServiceVisibility = "private" | "shared" | "public";

export interface ServiceInfo {
  projectId: string;
  name: string; // unique per project — the kind for configured services, or Claude's chosen name
  kind: ServiceKind;
  command: string; // the shell command (empty for an exposed, externally-started service)
  status: ServiceStatus;
  pid: number | null;
  exitCode: number | null;
  port: number; // the port injected as PORT (configured) or reported by expose_service
  url: string | null; // browseable URL once running/exposed
  startedAt: number | null;
  managed: boolean; // true if the orchestrator owns the process (can stop/restart)
  slug: string | null; // public hostname label (<slug>--<host>); null until first persisted
  visibility: ServiceVisibility;
  shareUrl: string | null; // tokened link (url?t=…) when visibility is "shared"
  // Human-readable supervisor-level failure (port already in use, spawn failed).
  // Distinct from a nonzero exit, which the logs explain; cleared on next start.
  error: string | null;
}

// One captured line of a service's combined stdout/stderr.
export interface ServiceLogLine {
  ts: number;
  stream: "stdout" | "stderr" | "system"; // "system" = supervisor notice (started/exited)
  text: string;
}

// Live events on a project's services SSE stream (GET .../services/stream).
export type ServiceEvent =
  | { type: "snapshot"; services: ServiceInfo[]; logs: Record<string, ServiceLogLine[]> }
  | { type: "status"; service: ServiceInfo }
  | { type: "log"; name: string; line: ServiceLogLine }
  | { type: "removed"; name: string };

// A multiple-choice question Claude raised via the AskUserQuestion tool.
export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header: string; // short chip label (≤12 chars)
  multiSelect?: boolean;
  options: AskOption[];
}
// answers[i] = the chosen value(s) for question i — option labels and/or the
// free-text typed into "Other". One entry per question, in question order.
export type AskAnswers = string[][];

// ---------- tool permission prompts (lib/permissions.ts) ----------

// What the user picked on a permission card. "allow_always" additionally
// records a project-scoped rule so the same call isn't asked about again.
export type PermissionDecision = "allow_once" | "allow_always" | "deny";

// How a remembered rule matches a later call:
//   bash_prefix — Bash commands whose leading tokens match (`npm test …`)
//   bash_exact  — one literal command line, for anything not safely generalizable
// Bash-only on purpose: a command is the one tool input a user can read in full
// and generalize honestly. "Always allow WebFetch here" would grant every URL,
// so non-Bash tools get allow-once plus a session-scoped don't-ask-again
// instead — see the note in lib/permissions.ts.
export type PermissionMatchKind = "bash_prefix" | "bash_exact";

// A remembered "always allow" (permission_rules table), scoped to one project.
export interface PermissionRule {
  id: string;
  project_id: string;
  tool: string;
  match_kind: PermissionMatchKind;
  value: string;
  created_at: number;
}

// What "always allow" would remember, rendered on the card so the user approves
// the exact rule they're creating rather than an implied one. "project" stores
// a permission_rules row; "session" only hands the CLI its own don't-ask-again
// payload, which dies with the session and is never persisted.
export interface PermissionScopeOffer {
  scope: "project" | "session";
  match_kind?: PermissionMatchKind;
  value: string;
  label: string;
}

// One parked permission prompt. `id` is the SDK's toolUseID, and it doubles as
// the ask-registry key — the decision travels back through the same
// waitForAnswer/submitAnswer machinery an AskUserQuestion uses.
export interface PermissionRequest {
  id: string;
  tool: string;
  /** Headline: the CLI's own prompt sentence when it supplies one, else a derived title. */
  title: string;
  /** The input worth judging — the full command for Bash, the path for a write. */
  detail: string;
  /** Optional one-line subtitle from the CLI ("Claude will have write access to…"). */
  description?: string;
  diff?: DiffLine[];
  /** Absent when the call can't be generalized into a rule honestly. */
  scope?: PermissionScopeOffer;
  /** ms epoch after which the prompt auto-denies itself; 0 = parks indefinitely. */
  expiresAt: number;
}

// How a permission prompt settled. `auto` marks a decision nobody made — an
// unattended or expired prompt that failed closed, or a call the CLI refused
// on its own before a card ever existed ("blocked").
export interface PermissionOutcome {
  decision: PermissionDecision;
  /** True for a decision nobody made — the gate failed closed on its own. */
  auto?: boolean;
  /**
   * Why the gate decided without the user. "unattended" is the one the runner
   * acts on: it means nobody was there, so queued follow-ups are parked rather
   * than drained straight into the same wall (mirrors a dead-login turn).
   * "blocked" is the odd one out — it isn't OUR gate deciding at all, it's the
   * CLI refusing before canUseTool was consulted (see the permission_denied
   * StreamEvent), so the card it settles was never answerable.
   */
  reason?: "unattended" | "timeout" | "interrupted" | "blocked";
  /**
   * On `reason: "blocked"` only: the SDK's `decision_reason_type` discriminator
   * verbatim — 'classifier', 'mode', 'rule', 'subcommandResults', … Stored raw
   * and phrased at render time on purpose: the CLI mints values the SDK's own
   * docs don't list (`subcommandResults` is a real one), and a sentence baked
   * into a persisted transcript can never be re-worded.
   */
  blockedBy?: string;
  /** The rule label recorded on "always allow". */
  remembered?: string;
  /** The user's typed reason, or why the gate decided on its own. */
  note?: string;
}

// Token usage + dollar cost for one Claude turn, parsed from the SDK result
// message. Persisted per turn (task_usage table) and summed for cumulative spend.
export interface TurnUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

// Cumulative usage totals across one task (or project): summed turn usage plus
// `total_tokens` (the four token counts combined) and the turn count.
export interface UsageTotals extends TurnUsage {
  total_tokens: number;
  turns: number;
}

// One rendered diff line: added (+, green), removed (-, red), or unchanged
// context (" ", dim). Used by both the capped peek and the full expanded diff.
export type DiffLine = { sign: "+" | "-" | " "; text: string };

// An always-visible "peek" at a tool's effect — mimics Claude Code's `⎿` line.
// `count`: a one-liner (Read N lines / Found N matches) with no content shown.
// `diff`: a -/+ hunk for Edits/Writes.  `lines`: a short snippet (Bash output)
// with a +N-more affordance.  `todos`: a rendered checklist.
export type ToolPeek =
  | { kind: "count"; text: string }
  | { kind: "diff"; added: number; removed: number; label?: string; lines: DiffLine[]; truncated?: number }
  | { kind: "lines"; label?: string; lines: string[]; truncated?: number }
  | { kind: "todos"; items: { text: string; status: string }[] };

// Server-sent stream events from a Claude turn.
export type StreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "model"; model: string }
  | { type: "assistant"; content: string }
  | { type: "tool"; id: string; title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[] }
  | { type: "tool_result"; id: string; content: string; isError: boolean; peek?: ToolPeek }
  | { type: "ask"; id: string; questions: AskQuestion[] }
  | { type: "ask_answered"; id: string; answers: AskAnswers }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission_decided"; id: string; outcome: PermissionOutcome }
  // A tool call the CLI refused BY ITSELF, without ever consulting canUseTool —
  // the "auto" classifier vetoing it, a deny rule in the loaded settings. There
  // was no card, so there is nothing to answer and nothing parked on the user.
  // `id` is the tool_use id, which is what lets the transcript settle this onto
  // the call it killed instead of floating a loose notice beside it. (Verified
  // against the live CLI: a denial from our OWN canUseTool does not also emit
  // this, so the two paths can't double-render the same refusal.)
  | { type: "permission_denied"; id: string; tool: string; reasonType?: string; reason?: string; agentId?: string }
  // A suggested task was filed. `projectId` is the project it landed IN, which
  // is not necessarily the one the turn is running in (suggest_task can target
  // any project) — the receiving tray is the one that has to refresh.
  | { type: "suggested"; title: string; projectId: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "notice"; content: string } // a quiet, non-error system note (e.g. "caught up to main")
  | { type: "error"; content: string }
  | { type: "done"; sessionId: string | null };

// Events as delivered over the task event bus and the GET /messages SSE tail.
// Turn events are enriched with the persisted DB message id (+ generation) so
// reconnecting clients can upsert idempotently instead of blindly appending:
// `msgId` is the row the event created (assistant/tool/ask/notice/error/user)
// or updated in place (tool_result/ask_answered). `snapshot` opens every
// stream — the full persisted transcript plus whether a turn is live — and
// `turn_end` marks the runner's finally block (running flag is off, task row
// settled), letting clients refresh without owning the turn's lifetime.
// `queued` is a follow-up parked while a turn runs; `dequeued` removes a parked
// follow-up from the transcript — either because the runner is now running it
// as the next turn, or because it was cancelled. `snapshot` carries the parked
// queue too, so a reload mid-run re-renders the queued bubbles.
// `ts` mirrors the persisted row's created_at (ms epoch) so a live-tail bubble
// carries the same clock a reconnect's snapshot row would.
export type TaskStreamEvent =
  | (StreamEvent & { msgId?: string; generation?: number; ts?: number })
  | { type: "user"; content: string; msgId: string; generation: number; ts?: number }
  | { type: "queued"; msgId: string; content: string; generation: number; ts?: number }
  | { type: "dequeued"; msgId: string }
  | { type: "snapshot"; messages: Message[]; pending: PendingMessage[]; running: boolean }
  | AgentAuthEvent
  | { type: "turn_end" };

// An agent's credentials died (broken=true) or started working again
// (broken=false). Published by the runner on the failing/succeeding task's
// channel — but it's really an INSTANCE-wide fact (one login per agent, shared
// by every task), so GET /api/events relays it verbatim to every tab, where it
// drives the titlebar reconnect banner. See lib/authFailure.ts.
export type AgentAuthEvent = {
  type: "agent_auth";
  agent: string;
  broken: boolean;
  reason: string | null;
};

// Coarse cross-task lifecycle events on the always-open GET /api/events stream
// (the wildcard channel of lib/events.ts). One event per turn boundary — turn
// launched, parked on a question, question answered, suggestion created, turn
// ended — carrying the task row's settled running/awaiting_input/status (the
// runner persists before it publishes, so these are authoritative) plus the
// project's fresh awaiting count. This is what keeps spinners, project badges,
// and the "N need you" pill live for tasks whose transcript stream isn't open.
export type GlobalTaskEvent = {
  type: "task";
  event: "turn_started" | "awaiting_input" | "ask_answered" | "suggested" | "turn_end";
  taskId: string;
  projectId: string;
  running: boolean;
  awaiting_input: boolean;
  status: Status;
  /** In-progress tasks awaiting the user across this task's project. */
  awaiting_count: number;
  /**
   * On a "suggested" event only: the project the new task was filed INTO.
   * Usually the same as `projectId`, but suggest_task can target any project,
   * and then it's the only field naming the tray that gained a row — every
   * other field on this payload describes the task that DID the suggesting.
   */
  suggestedProjectId?: string;
};

// Everything GET /api/events can send. Task lifecycle is the bulk of it;
// agent_auth rides the same stream because a dead login affects every task in
// every project at once, so there's nothing task-shaped to hang it off.
export type GlobalEvent = GlobalTaskEvent | AgentAuthEvent;

// How a tool call is stored (JSON) in a "tool" message's content.
export interface ToolData {
  title: string;
  detail?: string;
  result?: string;
  isError?: boolean;
  // Always-visible summary/snippet of the call's effect (see ToolPeek). Input-
  // derived peeks (diff/todos/write) are set with the tool event; result-derived
  // peeks (read count, bash output) are filled in when the tool_result arrives.
  peek?: ToolPeek;
  // Full colored diff for Edit/Write, rendered in the expanded body (the peek
  // shows a capped slice of the same lines). Absent on older persisted messages,
  // which fall back to the plaintext `detail`.
  diff?: DiffLine[];
  // Present when this "tool" message is an AskUserQuestion prompt. `id` is the
  // tool_use id (stored here so it survives a reload — there's no DB column for
  // it). `answers` is absent while awaiting the user, set once answered.
  ask?: { id: string; questions: AskQuestion[]; answers?: AskAnswers };
  // Present when this "tool" message is a permission prompt (the canUseTool
  // gate under "Accept edits" / "Plan mode"). Same shape of deal as `ask`: the
  // request is persisted so a reload re-renders an answerable card, and
  // `outcome` is absent while the turn is parked, set once it settles.
  permission?: { request: PermissionRequest; outcome?: PermissionOutcome };
}

/** A recurring prompt. See docs/superpowers/specs/2026-08-14-scheduled-tasks-design.md. */
export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  days_mask: number;   // Sun=1 … Sat=64; weekdays = 62
  time_of_day: string; // 'HH:MM' wall clock in `timezone`
  timezone: string;    // IANA zone name
  enabled: number;
  agent: string;
  permission_mode: string | null;
  send_context: number;
  priority: Priority;
  catch_up_ms: number;  // -1 = inherit the instance default
  next_fire_at: number; // cached from lib/schedule/time.ts
  /**
   * The runbook this schedule fires, if any. When set, fireSchedule() reads the
   * prompt and dispatch config from that row instead of the columns above —
   * which stay populated as the fallback, and are refreshed from the runbook if
   * it is ever deleted (see deleteRunbook).
   */
  runbook_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A saved task-launch preset. See docs/superpowers/specs/2026-08-20-runbooks-design.md. */
export interface Runbook {
  id: string;
  project_id: string;
  name: string;
  description: string;
  /** The first user message of every task this dispatches — so a /slash command expands. */
  prompt: string;
  agent: string;
  permission_mode: string | null;
  send_context: number;
  priority: Priority;
  position: number;
  /** '' = written by the user; otherwise the agent id that filed it. */
  created_by: string;
  created_at: number;
  updated_at: number;
}

export type ScheduleRunStatus =
  | "claimed" | "running" | "succeeded" | "failed" | "stopped" | "interrupted"
  | "missed" | "skipped_overlap";

export type ScheduleTrigger = "scheduled" | "catch_up" | "manual";

/** One occurrence of a schedule — including occurrences that never ran. */
export interface ScheduleRun {
  id: string;
  schedule_id: string;
  scheduled_for: number;
  claimed_at: number;
  fired_at: number;
  finished_at: number;
  task_id: string | null;
  status: ScheduleRunStatus;
  trigger: ScheduleTrigger;
  detail: string;
  dst_adjusted: string;
}
