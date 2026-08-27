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
  work_branch: string; // the worktree's branch (e.g. "calandria/<id>")
  base_sha: string; // commit the worktree branched from — the stable diff/merge base
  merged_at: number; // when this task's branch was merged back (0 = not merged)
  pr_url: string; // GitHub PR opened from this task's branch via "Create PR" ("" = none)
  generation: number; // increments on each /clear
  position: number; // manual order within the project (list groups + board columns, ascending)
  started: number; // 1 once the initial prompt has been sent
  auto_start: number; // 1 = start automatically when the last unfinished blocker is marked done (lib/autoStart.ts)
  withdrawn_reason: string; // why an agent retracted this suggestion ("" = not withdrawn); only meaningful with status "cancelled" + suggested 1
  agent_edited_at: number; // ms epoch of the most recent unreviewed agent edit (task_agent_edits); 0 = nothing outstanding
  running: number; // 1 while a Claude turn is actively streaming
  awaiting_input: number; // 1 when it's your turn: Claude's turn ended mid-task, or it's parked on an AskUserQuestion
  background_pending: number; // 1 while the turn lingers on background work (model turn ended, run_in_background tasks still running; the session wakes itself when they settle) — running stays 1 the whole time
  background_note: string; // what the linger is waiting on, phrased for the activity line ("waiting to wake at 12:00"); "" whenever background_pending is 0
  schedule_id: string | null; // the schedule that minted this task (lib/scheduler.ts); null = created by hand
  runbook_id: string | null; // the runbook that dispatched this task (lib/dispatch.ts); null = not from one
  group_id: string | null; // the task group this belongs to (task_groups.id); null = ungrouped. One group per task.
  // When a snooze ends (ms epoch; 0 = never snoozed / indicator cleared). Ahead
  // of now the task is drawn in the Snoozed category and hidden from the "needs
  // you" surfaces; behind it, the task is back in its own status group with a
  // "was snoozed" chip. `status` is deliberately untouched by a snooze — that's
  // what makes going back to the previous category free rather than restored.
  snoozed_until: number;
  // Queued to start on its own at this instant (ms epoch; 0 = not queued) —
  // "start at the usage-window reset" (lib/deferredStart.ts). For a never-
  // started task the sweep launches its first turn; for a started one it
  // resumes the session (the oldest queued follow-up, or a continue prompt).
  // Consumed by ANY turn launch, so a task started by hand can't fire twice.
  start_at: number;
  // Context-window occupancy as the agent's own stream last REPORTED it: the
  // input-side tokens (fresh + cache read + cache written) of the latest
  // main-session model request. Written by the runner from `context` events,
  // reset to NULL by /clear. NULL = never measured — a driver that doesn't
  // report it (Codex), or a task that predates the column — and the gauge
  // falls back to a per-turn usage heuristic and says so (see getTaskContext).
  context_measured: number | null;
  created_at: number;
  updated_at: number;
}

/** A field `update_task` can rewrite on a task the user already accepted. */
export type AgentEditField = "title" | "description" | "priority" | "status" | "group" | "blocked_by";

/** One field's before/after inside a recorded agent edit. */
export interface AgentEditChange {
  field: AgentEditField;
  /** Rendered for the diff panel — a title, a priority, a group name, "3 tasks". */
  before: string;
  after: string;
  /**
   * What Revert writes back: a string for the scalar fields, the group id (or
   * null) for `group`, the complete blocker id list for `blocked_by`. Kept
   * separate from `before` because the readable form is lossy — a group NAME
   * can't be written back, and "2 tasks" names no ids.
   */
  before_value: string | string[] | null;
}

/**
 * One `update_task` write that used to be refused (not the caller's own row,
 * not an unreviewed tray suggestion) and now goes through, on a task the user
 * already accepted. The audit trail behind the "changed since you accepted
 * it" chip, its diff panel, and its per-edit Revert.
 */
export interface TaskAgentEdit {
  id: string;
  task_id: string;
  project_id: string;
  /** The task whose session made the change; "" if that row is gone. */
  actor_task_id: string;
  actor_title: string;
  actor_agent: string;
  changes: AgentEditChange[];
  created_at: number;
  /** ms epoch the user reverted this edit; 0 = still applied. */
  reverted_at: number;
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

// A review comment left on a task's diff (Changes tab), anchored to a file +
// side + line range from the patch at comment time. `side` disambiguates old-
// file vs new-file line numbers, which are independent counters that otherwise
// collide (a comment on deleted line 3 and one on context line 3 would render
// under the same row). `anchor_sha` is the diff's HEAD when the comment was
// written — TaskChanges only inlines a comment at its line when this matches
// the currently loaded diff's head; otherwise it renders in a collapsed
// "Outdated comments" section rather than guess-matching to a moved line.
// null anchor_sha (pre-fix rows) is always treated as outdated.
// sent_to_agent (0/1) marks a comment that also kicked off a turn, vs. one
// filed purely for the record.
export interface TaskComment {
  id: string;
  task_id: string;
  file: string;
  side: "old" | "new";
  line_start: number;
  line_end: number;
  body: string;
  sent_to_agent: number;
  anchor_sha: string | null;
  created_at: number;
}

// A passage comment from the document collaboration modal (CollabDoc) — the
// document twin of TaskComment. Anchored by the rendered text the user selected
// (`quote`, re-found in the document by text search) plus the nearest heading
// above it, not by a line number: the selection happens in the rendered view,
// and prose moves. `anchor_sha` is the FILE's git blob id (the file route's
// `sha`) when the comment was written — not the worktree HEAD, because the
// modal reads the file itself and an agent edits documents without committing,
// so HEAD would miss exactly the change a review cares about. A sent comment
// whose anchor no longer matches is shown as outdated; an unsent one stays a
// live draft regardless (the user decides whether it still applies) and is
// flagged when its quote can't be found in the current text. Rows outlive the
// modal so a review survives a reload or a rail collapse; `sent_to_agent` rows
// are read-only.
export interface TaskDocComment {
  id: string;
  task_id: string;
  file: string;
  quote: string;
  heading: string | null;
  body: string;
  sent_to_agent: number;
  anchor_sha: string | null;
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
// process, we only track its url). Calandria can start/stop/restart the
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
  managed: boolean; // true if Calandria owns the process (can stop/restart)
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

// One rolling rate-limit window of a subscription plan (Claude Pro/Max's
// 5-hour session and 7-day week), as the usage display renders it. `id` is the
// provider's window key ("five_hour", "seven_day", "seven_day_sonnet", …);
// `utilization` is percent spent (0–100); `resetsAt` epoch ms, null when the
// provider didn't say.
export interface PlanUsageWindow {
  id: string;
  label: string;
  utilization: number;
  resetsAt: number | null;
}

// Instance-wide snapshot of one agent's subscription-plan usage — what the
// titlebar meter renders. Two sources merged server-side (see
// lib/agents/claude/planUsage.ts): `windows` come from the provider's usage
// API (cached, conservatively refetched), while the `status*` trio is the
// PASSIVE signal — the latest rate-limit telemetry a turn we were already
// running carried, which is fresher than any poll and free.
export interface PlanUsageSnapshot {
  /** False = nothing to show (no subscription login, or no data yet). */
  available: boolean;
  /** Why unavailable/stale, human-readable (shown in the popover footer). */
  reason: string | null;
  /** Subscription tier when known ("max", "pro"), for the popover title. */
  plan: string | null;
  windows: PlanUsageWindow[];
  /** Latest passive telemetry: are turns currently allowed? */
  status: "allowed" | "allowed_warning" | "rejected" | null;
  /** Which window the passive status is about (a PlanUsageWindow id). */
  statusWindow: string | null;
  /** When the binding limit resets (epoch ms), from the passive signal. */
  statusResetsAt: number | null;
  /** When `windows` was last fetched from the usage API (epoch ms). */
  fetchedAt: number | null;
  /** The last refetch failed; `windows` is being served from an older fetch. */
  stale: boolean;
}

// One rendered diff line: added (+, green), removed (-, red), or unchanged
// context (" ", dim). Used by both the capped peek and the full expanded diff.
export type DiffLine = { sign: "+" | "-" | " "; text: string };

// An always-visible "peek" at a tool's effect — mimics Claude Code's `⎿` line.
// `count`: a one-liner (Read N lines / Found N matches) with no content shown.
// `diff`: a -/+ hunk for Edits/Writes.  `lines`: a short snippet (Bash output)
// with a +N-more affordance.  `todos`: a rendered checklist.  `fail`: an
// error result shown TAIL-first — the exit status when the agent reported one,
// then the last lines of output, because a shell puts the message that
// explains a non-zero exit at the end (stderr after stdout), and the head of
// a failed `cat a b` is just the contents of `a`. `omitted` counts the earlier
// lines the full body holds.
export type ToolPeek =
  | { kind: "count"; text: string }
  | { kind: "diff"; added: number; removed: number; label?: string; lines: DiffLine[]; truncated?: number }
  | { kind: "lines"; label?: string; lines: string[]; truncated?: number }
  | { kind: "todos"; items: { text: string; status: string }[] }
  | { kind: "fail"; label?: string; lines: string[]; omitted?: number };

// Server-sent stream events from a Claude turn.
export type StreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "model"; model: string }
  | { type: "assistant"; content: string }
  // `file` is the path a file-WRITING call touched (Write/Edit, a Codex
  // single-file patch), as the agent spelled it — absolute in practice. The
  // runner resolves it against the task's worktree before persisting, so the
  // transcript card can open the file in collaboration mode without asking git
  // whether it's tracked (an ignored scratch doc never reaches the diff).
  | { type: "tool"; id: string; title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[]; file?: string }
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
  // How full the context window is RIGHT NOW: the input-side token count
  // (input + cache_read + cache_creation) of the latest model request in the
  // main session, as reported by the agent's own stream. Emitted whenever the
  // figure changes, so the gauge moves mid-turn. Distinct from `usage`, which
  // is the turn's SPEND — one turn is many API requests (every tool round-trip
  // re-reads the whole context) plus any subagents, and a usage report sums
  // all of them, so deriving occupancy from it read "7.6M tokens" against a
  // 200k window on a tool-heavy turn. Subagent sidechains are excluded: they
  // have their own windows.
  | { type: "context"; tokens: number }
  | { type: "notice"; content: string } // a quiet, non-error system note (e.g. "caught up to main")
  // The model's turn ended but run_in_background work is still running — or a
  // session-scoped wakeup (ScheduleWakeup / CronCreate / /loop) is pending —
  // and the driver is holding the session open for it (optionally bounded by
  // BACKGROUND_LINGER_MS). The runner flips tasks.background_pending on and
  // persists `note` as tasks.background_note so the UI can say "working in
  // background" / "waiting to wake at 12:00" instead of a generic spinner —
  // and instead of the lie this feature exists to kill, where the turn ended,
  // the work died with the CLI process, and the row said "needs your input"
  // about a notification (or a wake) that was never coming. `kind` is the
  // CLI's task type for background work, "wakeup" for a one-shot cron and
  // "cron" for a recurring one; `wakeAt` (ms epoch) is a cron's next fire.
  | { type: "background_pending"; tasks: { id: string; kind: string; description: string; wakeAt?: number }[]; note: string }
  // A lingered-on background task settled and its notification woke the model
  // (status completed/failed/stopped), or a pending wakeup fired (status
  // "woke"): a fresh turn is about to stream with NO user message behind it.
  // `summary` is the CLI's own account of what settled — or, for a wake, the
  // driver's account of which schedule fired and the prompt it submitted —
  // persisted so the transcript explains the unprompted continuation.
  | { type: "background_resumed"; status: "completed" | "failed" | "stopped" | "woke"; summary: string }
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
  event: "turn_started" | "awaiting_input" | "ask_answered" | "suggested" | "turn_end" | "background";
  taskId: string;
  projectId: string;
  running: boolean;
  awaiting_input: boolean;
  /** Turn lingering on run_in_background work (running stays true) — the "working in background" indicator. */
  background_pending: boolean;
  /** What the linger is waiting on ("waiting to wake at 12:00"); "" when not lingering. */
  background_note: string;
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
  // Worktree-relative path of the file this call wrote or edited — set only
  // when the runner could place the agent's path INSIDE the task's worktree,
  // so the transcript's Collaborate button never points the file route at
  // something it would refuse. Absent on older rows and on non-file tools.
  file?: string;
  // Present when this "tool" message is an AskUserQuestion prompt. `id` is the
  // tool_use id (stored here so it survives a reload — there's no DB column for
  // it). `answers` is absent while awaiting the user, set once answered.
  ask?: { id: string; questions: AskQuestion[]; answers?: AskAnswers };
  // Present when this "tool" message is a permission prompt (the canUseTool
  // gate under acceptEdits / plan). Same shape of deal as `ask`: the
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

/**
 * A named, project-scoped container of tasks — "the auth migration", "the
 * mobile PWA". Not a task: no session, no worktree, no status of its own.
 * See docs/superpowers/specs/2026-08-24-task-grouping-design.md.
 */
export interface TaskGroup {
  id: string;
  project_id: string;
  name: string;
  description: string;
  /** Badge tint (hex from GROUP_COLORS), or null for the neutral badge. */
  color: string | null;
  /** The session that filed this group, when an agent did; null when the user made it. */
  origin_task_id: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  /**
   * Derived per read, never stored. `done`/`cancelled` are terminal the way
   * lib/autoStart's blocks() counts them (a withdrawn suggestion is cancelled);
   * `awaiting` uses the same NEEDS_YOU predicate as the project badge.
   */
  counts: { total: number; done: number; cancelled: number; running: number; awaiting: number };
}

/** The badge tints a group may carry — the project palette, so the two read as one system. */
export const GROUP_COLORS = ["#C2603C", "#3E7CA8", "#6B6F8C", "#5C8C5A", "#9A6E14", "#9E5BA0"] as const;

/**
 * Validate a badge tint off the wire: undefined/null/"" clear it, anything
 * else must be a palette entry. Shared by the create and edit routes so the
 * two can't accept different colors.
 */
export function parseGroupColor(v: unknown): { ok: true; color: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, color: null };
  if (typeof v !== "string" || !(GROUP_COLORS as readonly string[]).includes(v)) {
    return { ok: false, error: `color must be one of: ${GROUP_COLORS.join(", ")}` };
  }
  return { ok: true, color: v };
}

/** Every member terminal, and at least one member: the group's derived "done". */
export function groupIsDone(g: Pick<TaskGroup, "counts">): boolean {
  return g.counts.total > 0 && g.counts.done + g.counts.cancelled === g.counts.total;
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
