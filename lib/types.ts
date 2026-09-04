export type Priority = "hi" | "med" | "lo";
/** The full set of legal `priority` values. No CHECK constraint backs the column, so this array is the source of truth. */
export const PRIORITIES: Priority[] = ["hi", "med", "lo"];
export type Status = "not_started" | "in_progress" | "on_hold" | "done" | "cancelled";
export type MsgRole = "user" | "assistant" | "tool" | "system" | "session_break";

/**
 * How a project's work lands: a local merge of the task branch into the base
 * branch, or a pull request against it.
 *
 * This is a property of the repository, not a preference. If the base branch
 * requires a pull request, merge mode cannot land anything there.
 * `buildProjectContext` (lib/agents/shared.ts) writes a different sentence
 * for each mode.
 *
 * No CHECK constraint backs the column. `isLandingMode` validates a value;
 * anything invalid falls back to "merge".
 */
export type LandingMode = "merge" | "pr";
export const LANDING_MODES: LandingMode[] = ["merge", "pr"];
export const isLandingMode = (v: unknown): v is LandingMode => v === "merge" || v === "pr";

export interface Project {
  id: string;
  name: string;
  icon: string;
  sub: string; // short tagline, e.g. "notes app"
  color: string; // accent color for the project glyph
  context: string; // "what we're building": description, stack and conventions, in a single field
  building: string; // legacy field, kept for backward compatibility; folded into context
  conventions: string; // legacy field, kept for backward compatibility; folded into context
  repo_path: string; // working dir for Claude Code
  branch: string; // the project's DEFAULT base branch: what a task is cut from, syncs to and merges into unless the task names its own (lib/baseBranch.ts)
  landing_mode: LandingMode; // how work lands on the base branch: "merge" (local merge) or "pr" (base is protected, finish by opening a PR)
  auto_reclaim: number; // 1 = reclaim a task's checkout + local branch by itself once its work lands (lib/reclaim.ts)
  dev_command: string; // long-running dev server command supervised by lib/services.ts ("" = none)
  setup_command: string; // optional one-shot setup command (install/migrate/etc.)
  test_command: string; // optional one-shot test command
  port: number; // deterministic per-project port, injected as PORT into services + the PTY
  default_agent: string; // agent driver new tasks in this project run under (lib/agents/registry.ts)
  send_context: number; // 1 = include the saved project context in new agent sessions (default for new tasks)
  agent_env: string; // provider override for every task's turns, as JSON over the lib/agentEnv.ts allowlist ("" = the agent's own cloud login)
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
  // Per-task LiteLLM virtual keys (docs/AGENTS.md, LiteLLM section), only
  // meaningful once CALANDRIA_LITELLM_ADMIN_KEY is set. Caps what a minted
  // key's /key/generate call requests.
  gateway_max_budget: number | null; // dollars; null = no max_budget sent (unlimited)
  gateway_key_duration: string; // a LiteLLM duration string ("30d"); "" = no duration sent (never auto-expires on LiteLLM's clock)
  // Hosted MCP servers this project mounts on every task's turn
  // (docs/AGENTS.md, LiteLLM section): a JSON array of gateway aliases
  // (lib/gatewayMcp.ts). Independent of agent_env's model-provider kind, so a
  // cloud-login task can still reach the gateway's hosted tools. "[]" = none
  // selected, the default for every project.
  gateway_mcp: string;
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
  agent_env: string; // per-task provider override laid over the project's (lib/agentEnv.ts); "" = inherit the project's
  model: string | null; // chosen model alias ("fable"|"opus"|"sonnet"|"haiku"); null = inherit default
  resolved_model: string | null; // model the SDK actually ran last turn (for the badge)
  reasoning: string | null; // thinking preset ("off"|"think"|"think_hard"|"ultrathink"); null = inherit default
  permission_mode: string | null; // run permission ("acceptEdits"|"plan"); null = bypassPermissions (default)
  session_id: string | null; // the agent's opaque session/thread id for the current generation
  worktree_path: string; // isolated git worktree this task runs in ("" = runs in repo_path)
  work_branch: string; // the worktree's branch (e.g. "calandria/<id>")
  base_sha: string; // commit the worktree branched from; the stable diff/merge base
  // The branch this task is based on: what it was cut from, what Sync catches
  // it up to, and what Merge lands it into. "" = inherit the project's default
  // (projects.branch). Written back by the launch paths when the worktree is
  // cut, since base_sha is then pinned to that branch. Changing it afterward
  // is a retarget that requires reconciliation. Resolution and policy:
  // lib/baseBranch.ts.
  base_branch: string;
  merged_at: number; // when this task's branch was merged back (0 = not merged)
  pr_url: string; // GitHub PR opened from this task's branch via "Create PR" ("" = none)
  // Live PR state, refreshed from `gh pr view` by lib/prState.ts. See the
  // schema comment in lib/db.ts for what each one means and why pr_merged_at is
  // not merged_at.
  pr_number: number; // the number parsed out of pr_url when the PR was created (0 = none)
  pr_state: string; // "open" | "merged" | "closed" ("" = never refreshed)
  pr_checks: string; // "pending" | "passing" | "failing" | "none" ("" = never refreshed)
  pr_review: string; // gh's reviewDecision (APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; "" = not required)
  pr_merged_at: number; // when GITHUB merged it (0 = not merged there); distinct from merged_at, the local merge
  pr_synced_at: number; // when we last heard from GitHub (0 = never); the staleness clock every trigger reads
  pr_draft: number; // 1 while the PR is a draft: open, but unmergeable by anyone
  pr_merge_state: string; // gh's mergeStateStatus (CLEAN / BLOCKED / DIRTY / BEHIND / UNSTABLE; "" = unknown)
  pr_failing: string; // JSON PrFailingCheck[]: the red entries behind pr_checks='failing' ("" when nothing is red)
  generation: number; // increments on each /clear
  position: number; // manual order within the project (list groups + board columns, ascending)
  started: number; // 1 once the initial prompt has been sent
  auto_start: number; // 1 = start automatically when the last unfinished blocker is marked done (lib/autoStart.ts)
  withdrawn_reason: string; // why an agent retracted this suggestion ("" = not withdrawn); only meaningful with status "cancelled" + suggested 1
  agent_edited_at: number; // ms epoch of the most recent unreviewed agent edit (task_agent_edits); 0 = nothing outstanding
  running: number; // 1 while a Claude turn is actively streaming
  awaiting_input: number; // 1 when it's your turn: Claude's turn ended mid-task, or it's parked on an AskUserQuestion
  background_pending: number; // 1 while the turn lingers on background work (model turn ended, run_in_background tasks still running; the turn resumes when they settle). running stays 1 the whole time
  background_note: string; // what the linger is waiting on, phrased for the activity line ("waiting to wake at 12:00"); "" whenever background_pending is 0
  schedule_id: string | null; // the schedule that minted this task (lib/scheduler.ts); null = created by hand
  runbook_id: string | null; // the runbook that dispatched this task (lib/dispatch.ts); null = not from one
  // When a snooze ends (ms epoch; 0 = never snoozed / indicator cleared). Ahead
  // of now, the task is drawn in the Snoozed category and hidden from the
  // "needs you" surfaces. Behind it, the task is back in its own status group
  // with a "was snoozed" chip. `status` is untouched by a snooze, so returning
  // to the previous category needs no restore step.
  snoozed_until: number;
  // When an unattended run finished cleanly and nobody has acknowledged it yet
  // (ms epoch; 0 = nothing outstanding). A scheduled turn that succeeds sets
  // this instead of awaiting_input, since it isn't waiting on an answer but
  // isn't still working either (issue #28). Cleared by the next turn that
  // starts on the task and by any explicit status write. `status` itself is
  // untouched, the same as a snooze.
  unread_run_at: number;
  // When this task is queued to start on its own (ms epoch; 0 = not queued):
  // "start at the usage-window reset" (lib/deferredStart.ts). For a
  // never-started task the sweep launches its first turn; for a started one
  // it resumes the session (the oldest queued follow-up, or a continue
  // prompt). Consumed by any turn launch, so a task started by hand can't
  // fire twice.
  start_at: number;
  // Context-window occupancy as the agent's own stream last reported it: the
  // input-side tokens (fresh + cache read + cache written) of the latest
  // main-session model request. Written by the runner from `context` events,
  // reset to null by /clear. Null means never measured, either a driver that
  // doesn't report it (Codex) or a task that predates the column; the gauge
  // then falls back to a per-turn usage heuristic and says so (see
  // getTaskContext).
  context_measured: number | null;
  // The task's minted LiteLLM virtual key (docs/AGENTS.md, LiteLLM section),
  // or "" when using the instance key, not a gateway task, or per-task keys
  // are off. getTask()/listTasks() always return "" here; the real value
  // never leaves lib/store.ts's narrow accessors (taskGatewayKeyState,
  // setTaskGatewayKey), called only by lib/runner.ts and lib/gatewayKeys.ts.
  // lib/runner.ts populates this field on its own in-memory `task` object,
  // never a value returned by getTask/listTasks, just before the driver
  // call, the same way it self-heals worktree_path in place. A route that
  // spreads a task into JSON can never carry a live key.
  gateway_key: string;
  // Per-task override of the project's hosted-MCP selection
  // (lib/gatewayMcp.ts). Null inherits the project's `gateway_mcp`; a JSON
  // array (including "[]") replaces it outright, so a task can mount none of
  // the project's servers without touching the project row.
  gateway_mcp: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * A field an agent tool can rewrite on a task the user already accepted.
 *
 * Two of these aren't written by `update_task`: `base_branch` belongs to
 * `set_base_branch`, which retargets a worktree, and `project` belongs to
 * `move_task`, which re-parents the row and everything keyed to it. Both land
 * in the same audit trail, so the "Changed by agent" chip covers them too,
 * and their Revert re-runs the operation (`retargetTaskBase` and
 * `moveTasksToProject`) instead of writing the column directly (see
 * app/api/tasks/[id]/agent-edits/route.ts).
 */
export type AgentEditField = "title" | "description" | "priority" | "status" | "tags" | "blocked_by" | "base_branch" | "project";

/** One field's before/after inside a recorded agent edit. */
export interface AgentEditChange {
  field: AgentEditField;
  /** Rendered for the diff panel: a title, a priority, a tag list, "3 tasks". */
  before: string;
  after: string;
  /**
   * What Revert writes back: a string for the scalar fields, the complete tag
   * id list for `tags`, the complete blocker id list for `blocked_by`. Kept
   * separate from `before` because the readable form is lossy: a tag name
   * can't be written back, and "2 tasks" names no ids.
   */
  before_value: string | string[] | null;
  /**
   * What the edit left the field holding, in the same shape. Revert compares
   * this against the live row before writing `before_value` back, so it can
   * refuse instead of overwriting a change made since, whether the user's own
   * or a later agent edit. Absent on rows recorded before this field existed;
   * for those the scalar fields compare through `after` instead, and tags and
   * blocked_by are reverted unchecked.
   */
  after_value?: string | string[] | null;
}

/**
 * One `update_task` write on a task the user already accepted, whether or not
 * the caller is the task's own session. The audit trail behind the "changed
 * since you accepted it" chip, its diff panel, and its per-edit Revert.
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
  /**
   * ms epoch the user pressed Keep changes while this edit was outstanding;
   * 0 = never. Lets a later revert clear the chip: without it, an acked row
   * would read as still outstanding, and a fresh edit's chip could only be
   * cleared by a second ack.
   */
  acknowledged_at: number;
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

// A review comment left on a task's diff (Changes tab), anchored to a file,
// side and line range from the patch at comment time. `side` disambiguates
// old-file vs new-file line numbers, which are independent counters that
// otherwise collide (a comment on deleted line 3 and one on context line 3
// would render under the same row). `anchor_sha` is the diff's HEAD when the
// comment was written. TaskChanges only inlines a comment at its line when
// this matches the currently loaded diff's head; otherwise it renders in a
// collapsed "Outdated comments" section instead of guess-matching to a moved
// line. A null anchor_sha is always treated as outdated. sent_to_agent (0/1)
// marks a comment that also kicked off a turn, as opposed to one filed purely
// for the record.
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

// A passage comment from the document collaboration modal (CollabDoc), the
// document twin of TaskComment. Anchored by the rendered text the user
// selected (`quote`, re-found in the document by text search) plus the
// nearest heading above it, rather than a line number, since the selection
// happens in the rendered view and prose moves. `anchor_sha` is the file's
// git blob id (the file route's `sha`) when the comment was written, not the
// worktree HEAD: the modal reads the file itself, and an agent can edit
// documents without committing, so HEAD would miss the change a review cares
// about. A sent comment whose anchor no longer matches is shown as outdated;
// an unsent one stays a live draft regardless, letting the user decide
// whether it still applies, and is flagged when its quote can't be found in
// the current text. Rows outlive the modal, so a review survives a reload or
// a rail collapse. `sent_to_agent` rows are read-only.
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
  // The agent's own opaque session/thread id, named for the first driver
  // supported. Any driver's id, including a Codex thread id, lands in this
  // same column.
  claude_session_id: string | null;
  started_at: number;
  ended_at: number | null;
}

// ---------- managed services (lib/services.ts) ----------

// A supervised process belonging to a project. `kind` is the configured slot
// the service maps to ("dev"/"setup"/"test"), or "exposed" for a server the
// agent registered at runtime via the expose_service MCP tool; Calandria does
// not own that process, only tracks its url. Calandria can start/stop/restart
// the configured kinds. An exposed entry is informational: its url is
// reportable, nothing more.
export type ServiceStatus = "stopped" | "starting" | "running" | "exited" | "errored";
export type ServiceKind = "dev" | "setup" | "test" | "exposed";
// Who can open a service's public URL: private = the instance's own session
// auth, shared = anyone holding the tokened link (?t=…), public = anyone.
export type ServiceVisibility = "private" | "shared" | "public";

export interface ServiceInfo {
  projectId: string;
  name: string; // unique per project: the kind for configured services, or the agent's chosen name
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
// answers[i] is the chosen value(s) for question i: option labels, free text
// typed into "Other", or both. One entry per question, in question order.
export type AskAnswers = string[][];

// Why a question card stopped being answerable without ever being answered:
// the turn was stopped or errored ("interrupted"), or the process died under
// it ("restarted"). The counterpart of PermissionOutcome on the other
// interactive card. Kept apart from AskAnswers because a dismissal is not a
// choice, and the transcript must never read as though the user made one.
export interface AskDismissal {
  reason: "interrupted" | "restarted";
  note: string;
}

// ---------- tool permission prompts (lib/permissions.ts) ----------

// What the user picked on a permission card. "allow_always" additionally
// records a project-scoped rule so the same call isn't asked about again.
export type PermissionDecision = "allow_once" | "allow_always" | "deny";

// How a remembered rule matches a later call:
//   bash_prefix - Bash commands whose leading tokens match (`npm test …`)
//   bash_exact  - one literal command line, for anything not safely generalizable
//   mcp_server  - every tool call from one hosted MCP server (`mcp__<alias>__*`)
// Bash was the only kind until hosted gateway MCP servers (docs/AGENTS.md,
// LiteLLM section): "always allow WebFetch here" would grant every URL, but
// "always allow <alias>'s tools" names a whole server the user picked in
// project settings, which is as readable and generalizable as a command line
// since it names the alias rather than a wildcard the user never saw. Every
// other non-Bash tool still gets allow-once plus a session-scoped
// don't-ask-again instead; see the note in lib/permissions.ts.
export type PermissionMatchKind = "bash_prefix" | "bash_exact" | "mcp_server";

// One watched setting file as this task last ran under it
// (task_settings_snapshots, see lib/settingsDrift.ts). `file` is
// worktree-relative; `hash` covers the whole file even when `content` is ''
// because the file was too big to keep a copy of.
export interface SettingsSnapshot {
  task_id: string;
  file: string;
  hash: string;
  content: string;
  updated_at: number;
}

// A remembered "always allow" (permission_rules table), scoped to one project.
export interface PermissionRule {
  id: string;
  project_id: string;
  tool: string;
  match_kind: PermissionMatchKind;
  value: string;
  created_at: number;
}

// What "always allow" would remember, rendered on the card so the user
// approves the exact rule being created. "project" stores a permission_rules
// row; "session" only hands the CLI its own don't-ask-again payload, which
// dies with the session and is never persisted.
export interface PermissionScopeOffer {
  scope: "project" | "session";
  match_kind?: PermissionMatchKind;
  value: string;
  label: string;
}

// One parked permission prompt. `id` is the SDK's toolUseID, and it doubles
// as the ask-registry key: the decision travels back through the same
// waitForAnswer/submitAnswer machinery an AskUserQuestion uses.
export interface PermissionRequest {
  id: string;
  tool: string;
  /**
   * What this card is asking about. Absent means the ordinary canUseTool gate
   * on a tool call.
   *
   * "settings" is the pre-turn gate (lib/settingsDrift.ts, issue #43): the
   * agent hasn't started, and what needs approving is the configuration the
   * whole turn would run under, not a call. It rides the same
   * request/outcome/answer machinery, one card shape, one answer route, one
   * transcript row, with only the wording differing. Declining ends the turn
   * before it runs, instead of refusing one call inside it, so the UI must
   * not tell the user the session keeps running either way.
   */
  kind?: "settings";
  /** Headline: the CLI's own prompt sentence when it supplies one, else a derived title. */
  title: string;
  /** The input worth judging: the full command for Bash, the path for a write. */
  detail: string;
  /** Optional one-line subtitle from the CLI ("Claude will have write access to…"). */
  description?: string;
  diff?: DiffLine[];
  /** Absent when the call can't be generalized into a rule. */
  scope?: PermissionScopeOffer;
  /** ms epoch after which the prompt auto-denies itself; 0 = parks indefinitely. */
  expiresAt: number;
}

// How a permission prompt settled. `auto` marks a decision nobody made: an
// unattended or expired prompt that failed closed, or a call the CLI refused
// on its own before a card ever existed ("blocked").
export interface PermissionOutcome {
  decision: PermissionDecision;
  /** True for a decision nobody made: the gate failed closed on its own. */
  auto?: boolean;
  /**
   * Why the gate decided without the user. "unattended" is the one the runner
   * acts on: it means nobody was there, so queued follow-ups are parked
   * instead of drained straight into the same wall, mirroring a dead-login
   * turn. "blocked" means the app's own gate never decided at all: the CLI
   * refused before canUseTool was consulted (see the permission_denied
   * StreamEvent), so the card it settles was never answerable.
   */
  reason?: "unattended" | "timeout" | "interrupted" | "blocked";
  /**
   * On `reason: "blocked"` only: the SDK's `decision_reason_type`
   * discriminator verbatim, e.g. 'classifier', 'mode', 'rule',
   * 'subcommandResults'. Stored raw and phrased at render time, since the CLI
   * mints values the SDK's own docs don't list, and a sentence baked into a
   * persisted transcript can never be re-worded.
   */
  blockedBy?: string;
  /** The rule label recorded on "always allow". */
  remembered?: string;
  /** The user's typed reason, or why the gate decided on its own. */
  note?: string;
}

// Token usage and dollar cost for one Claude turn, parsed from the SDK result
// message. Persisted per turn (task_usage table) and summed for cumulative
// spend.
export interface TurnUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  // Tokens burned inside subagent sidechains, which the four counts above do
  // not include: the Claude result message's usage covers only the main
  // session's own API requests, while its cost covers everything. Undefined
  // means not measured (Codex, the mock driver, or a task predating this
  // field) and is stored as NULL, distinct from a measured zero.
  subagent_tokens?: number;
}

// Cumulative usage totals across one task (or project): summed turn usage
// plus `total_tokens` (the four token counts combined) and the turn count.
// `total_tokens` stays main-session-only, matching the four buckets it sums;
// `subagent_tokens` is additional, and the two are combined for display.
export interface UsageTotals extends TurnUsage {
  total_tokens: number;
  subagent_tokens: number;
  turns: number;
  /** How many of those `turns` had no price to record, e.g. a custom base URL
   *  whose cost nobody has stated (see LedgerUsage). `cost_usd` sums only the
   *  other turns, so a non-zero count here means the dollar figure beside it
   *  is a floor, not the whole total, and the UI must say so. */
  unpriced_turns: number;
}

/**
 * A turn's usage as the ledger stores it, which differs from what a driver
 * reports in exactly one place: `cost_usd` may be null, meaning nobody knows
 * what this turn cost. Only the runner produces that null, from the
 * provider's `pricing` (lib/agentEnv.ts), since a driver has no way to know
 * its endpoint is a third party. Distinct from 0, which asserts the turn was
 * free.
 */
export interface LedgerUsage extends Omit<TurnUsage, "cost_usd"> {
  cost_usd: number | null;
}

// One rolling rate-limit window of a subscription plan (Claude Pro/Max's
// 5-hour session and 7-day week), as the usage display renders it. `id` is
// the provider's window key ("five_hour", "seven_day", "seven_day_sonnet",
// etc.); `utilization` is percent spent (0-100); `resetsAt` is epoch ms, null
// when the provider didn't say.
export interface PlanUsageWindow {
  id: string;
  label: string;
  utilization: number;
  resetsAt: number | null;
  /**
   * Which of the two windows every metered plan has this is, when the driver
   * can say. The ids are the provider's ("five_hour", "gemini-5h"), and this
   * is what the pill and lib/usageReset.ts use to pick the session/week rows.
   * Absent on a window that is neither (Claude's per-model weeks) and on
   * older rows.
   *
   * `gateway_budget` is not a subscription window: it's the LiteLLM instance
   * key's own budget (GET /key/info), synthesized by GET /api/plan-usage
   * under the `"gateway"` map key rather than reported by an agent driver. A
   * gateway task's turns don't draw on any agent's session/week window
   * (lib/agentEnv.ts planWindowApplies), so the session header reads this one
   * instead, where a vendor window would otherwise be shown but doesn't
   * apply.
   */
  kind?: "session" | "week" | "gateway_budget" | null;
}

/** Not a real agent id. The key the LiteLLM gateway's own budget snapshot
 *  rides under in GET /api/plan-usage's map (app/api/plan-usage/route.ts),
 *  since the budget belongs to one instance key, not any agent. Shared
 *  between that route, app/shell/PlanUsage.tsx and app/shell/SessionView.tsx
 *  so the writer and both readers use the same string. */
export const GATEWAY_PLAN_ID = "gateway";

// Instance-wide snapshot of one agent's subscription-plan usage, what the
// titlebar meter renders. Two sources merged server-side (see
// lib/agents/claude/planUsage.ts): `windows` come from the provider's usage
// API (cached, conservatively refetched), while the `status*` trio is the
// passive signal, the latest rate-limit telemetry carried by a turn already
// running, which is fresher than any poll and costs nothing extra.
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

// An always-visible "peek" at a tool's effect, mirroring Claude Code's `⎿`
// line. `count`: a one-liner (Read N lines / Found N matches) with no content
// shown. `diff`: a -/+ hunk for Edits/Writes. `lines`: a short snippet (Bash
// output) with a +N-more affordance. `todos`: a rendered checklist. `fail`:
// an error result shown tail-first, the exit status when the agent reported
// one, then the last lines of output, since a shell puts the message
// explaining a non-zero exit at the end (stderr after stdout), and the head
// of a failed `cat a b` is just the contents of `a`. `omitted` counts the
// earlier lines the full body holds.
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
  // `file` is the path a file-writing call touched (Write/Edit, a Codex
  // single-file patch), as the agent spelled it, absolute in practice. The
  // runner resolves it against the task's worktree before persisting, so the
  // transcript card can open the file in collaboration mode without asking
  // git whether it's tracked (an ignored scratch doc never reaches the diff).
  // `name` is the agent's own name for the tool ("Bash",
  // "mcp__calandria__suggest_task", "calandria__suggest_task" for the stdio
  // bridge). The title is written for a human and can change wording; `name`
  // is what code matches on, which is how the runner knows a call was a
  // suggest_task and settles the created suggestion onto that row (see
  // lib/suggestionCard.ts). Optional: older persisted rows and any driver
  // that doesn't set it simply grow no card.
  | { type: "tool"; id: string; name?: string; title: string; detail: string; peek?: ToolPeek; diff?: DiffLine[]; file?: string }
  // `cutOff`: the agent CLI answered this call itself and it never reached
  // Calandria (lib/agentToolGuard.mjs); `content` is the driver's rewrite.
  | { type: "tool_result"; id: string; content: string; isError: boolean; peek?: ToolPeek; cutOff?: boolean }
  | { type: "ask"; id: string; questions: AskQuestion[] }
  | { type: "ask_answered"; id: string; answers: AskAnswers }
  | { type: "ask_dismissed"; id: string; dismissal: AskDismissal }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission_decided"; id: string; outcome: PermissionOutcome }
  // A tool call the CLI refused on its own, without ever consulting
  // canUseTool: the "auto" classifier vetoing it, or a deny rule in the
  // loaded settings. There was no card, so there is nothing to answer and
  // nothing parked on the user. `id` is the tool_use id, which lets the
  // transcript settle this onto the call it killed instead of floating a
  // loose notice beside it. A denial from the app's own canUseTool does not
  // also emit this event, so the two paths never double-render the same
  // refusal.
  | { type: "permission_denied"; id: string; tool: string; reasonType?: string; reason?: string; agentId?: string }
  // A suggested task was filed. `projectId` is the project it landed in,
  // which is not necessarily the one the turn is running in (suggest_task can
  // target any project), so it names the tray that needs to refresh.
  // `taskId` is the row that was created; the runner settles it onto the
  // suggest_task tool row so the transcript can render a live card that
  // re-reads the task (started? accepted? deleted?) instead of freezing a
  // snapshot.
  | { type: "suggested"; title: string; projectId: string; taskId?: string }
  // `usage.cost_usd` is 0 when `unpriced` is set, since the client adds this
  // to the task's running total and an unknown price must not inflate it. The
  // flag stops the client from reading that 0 as "this turn was free": it
  // bumps the row's `unpriced_turns` instead, so the chip marks the total as
  // a floor immediately rather than only after the next refetch. See
  // LedgerUsage.
  // `partial` marks a report the next full one supersedes: one API request's
  // own tokens, emitted as the turn goes, where a full report is the whole
  // segment's totals arriving at the end. The runner accumulates partials
  // separately and drops them when a full report lands, then writes whatever
  // is left over in its finally block, the only record produced for a turn
  // stopped before its result message. A partial carries no price, since its
  // source has none, so it is never written as a priced turn.
  | { type: "usage"; usage: TurnUsage; unpriced?: boolean; partial?: boolean }
  // How full the context window is right now: the input-side token count
  // (input + cache_read + cache_creation) of the latest model request in the
  // main session, as reported by the agent's own stream. Emitted whenever the
  // figure changes, so the gauge moves mid-turn. Distinct from `usage`, which
  // is the turn's spend: one turn is many API requests (every tool round-trip
  // re-reads the whole context) plus any subagents, and a usage report sums
  // all of them, so deriving occupancy from it would read far higher than the
  // window size on a tool-heavy turn. Subagent sidechains are excluded, since
  // they have their own windows.
  | { type: "context"; tokens: number }
  | { type: "notice"; content: string } // a non-error system note (e.g. "caught up to main")
  // The model's turn ended but run_in_background work is still running, or a
  // session-scoped wakeup (ScheduleWakeup / CronCreate / /loop) is pending,
  // and the driver holds the session open for it (optionally bounded by
  // BACKGROUND_LINGER_MS). The runner sets tasks.background_pending and
  // persists `note` as tasks.background_note so the UI can say "working in
  // background" or "waiting to wake at 12:00" instead of a generic spinner,
  // and instead of ending the turn with the work still in flight and the row
  // wrongly reading "needs your input". `kind` is the CLI's task type for
  // background work, "wakeup" for a one-shot cron and "cron" for a recurring
  // one; `wakeAt` (ms epoch) is a cron's next fire.
  | { type: "background_pending"; tasks: { id: string; kind: string; description: string; wakeAt?: number }[]; note: string }
  // A lingered-on background task settled and its notification triggered the
  // next turn (status completed/failed/stopped), or a pending wakeup fired
  // (status "woke"): a fresh turn streams with no user message behind it.
  // `summary` is the CLI's own account of what settled, or, for a wake, the
  // driver's account of which schedule fired and the prompt it submitted,
  // persisted so the transcript explains the unprompted continuation.
  | { type: "background_resumed"; status: "completed" | "failed" | "stopped" | "woke"; summary: string }
  | { type: "error"; content: string }
  | { type: "done"; sessionId: string | null };

// Events as delivered over the task event bus and the GET /messages SSE tail.
// Turn events carry the persisted DB message id (and generation) so
// reconnecting clients can upsert idempotently instead of blindly appending:
// `msgId` is the row the event created (assistant/tool/ask/notice/error/user)
// or updated in place (tool_result/ask_answered). `snapshot` opens every
// stream with the full persisted transcript plus whether a turn is live.
// `turn_end` marks the runner's finally block (running flag off, task row
// settled), letting clients refresh without owning the turn's lifetime.
// `queued` is a follow-up parked while a turn runs; `dequeued` removes a
// parked follow-up from the transcript, either because the runner is now
// running it as the next turn or because it was cancelled. `snapshot` carries
// the parked queue too, so a reload mid-run re-renders the queued bubbles.
// `ts` mirrors the persisted row's created_at (ms epoch) so a live-tail
// bubble carries the same clock a reconnect's snapshot row would.
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
// channel, but it's really an instance-wide fact (one login per agent, shared
// by every task), so GET /api/events relays it verbatim to every tab, where
// it drives the titlebar reconnect banner. See lib/authFailure.ts.
export type AgentAuthEvent = {
  type: "agent_auth";
  agent: string;
  broken: boolean;
  reason: string | null;
};

// Coarse cross-task lifecycle events on the always-open GET /api/events
// stream (the wildcard channel of lib/events.ts). One event per turn
// boundary: turn launched, parked on a question, question answered,
// suggestion created, turn ended. Each carries the task row's settled
// running/awaiting_input/status (the runner persists before it publishes, so
// these are authoritative) plus the project's fresh awaiting count. This
// keeps spinners, project badges, and the "N need you" pill live for tasks
// whose transcript stream isn't open.
export type GlobalTaskEvent = {
  type: "task";
  event: "turn_started" | "awaiting_input" | "ask_answered" | "suggested" | "turn_end" | "background" | "turn_idle";
  taskId: string;
  projectId: string;
  running: boolean;
  awaiting_input: boolean;
  /** Turn lingering on run_in_background work (running stays true): the "working in background" indicator. */
  background_pending: boolean;
  /** What the linger is waiting on ("waiting to wake at 12:00"); "" when not lingering. */
  background_note: string;
  status: Status;
  /**
   * A clean unattended run nobody has acknowledged yet (ms epoch; 0 = none):
   * the resting state of a scheduled success. Carried alongside the flags
   * above because it settles at the same instant they do, and a client that
   * only read running/awaiting_input would draw the row as still working.
   */
  unread_run_at: number;
  /**
   * When this task's live turn last produced anything, once it has been quiet
   * long enough to be worth reporting (ms epoch; 0 = not idle, or not
   * running). A mark, not a deadline; see lib/turnActivity.ts. It is an
   * instant rather than an age so the client can grow the label against its
   * own clock without the server re-publishing every minute.
   */
  idle_since: number;
  /** In-progress tasks awaiting the user across this task's project. */
  awaiting_count: number;
  /**
   * On a "suggested" event only: the project the new task was filed into.
   * Usually the same as `projectId`, but suggest_task can target any project;
   * when it differs, this is the only field naming the tray that gained a
   * row. Every other field on this payload describes the task that did the
   * suggesting.
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
  // The agent's own tool name, persisted so a card can be matched to a call
  // by what it was rather than by the wording of its title. Absent on rows
  // written before this field existed, and on drivers that don't report it.
  name?: string;
  detail?: string;
  result?: string;
  isError?: boolean;
  // Always-visible summary/snippet of the call's effect (see ToolPeek).
  // Input-derived peeks (diff/todos/write) are set with the tool event;
  // result-derived peeks (read count, bash output) are filled in when the
  // tool_result arrives.
  peek?: ToolPeek;
  // Full colored diff for Edit/Write, rendered in the expanded body (the peek
  // shows a capped slice of the same lines). Absent on older persisted
  // messages, which fall back to the plaintext `detail`.
  diff?: DiffLine[];
  // Worktree-relative path of the file this call wrote or edited. Set only
  // when the runner could place the agent's path inside the task's worktree,
  // so the transcript's Collaborate button never points the file route at
  // something it would refuse. Absent on older rows and on non-file tools.
  file?: string;
  // Present when this "tool" message is an AskUserQuestion prompt. `id` is
  // the tool_use id, stored here so it survives a reload since there's no DB
  // column for it. `answers` is absent while awaiting the user, set once
  // answered; `dismissed` is set instead when the question died unanswered
  // (Stop, driver error, restart), which keeps a dead card from rendering
  // live buttons. `outcome` plays the same role on `permission` below: both
  // cards park the user the same way and must un-park the same way.
  ask?: { id: string; questions: AskQuestion[]; answers?: AskAnswers; dismissed?: AskDismissal };
  // Present when this "tool" message is a permission prompt (the canUseTool
  // gate under acceptEdits / plan). Handled like `ask`: the request is
  // persisted so a reload re-renders an answerable card, and `outcome` is
  // absent while the turn is parked, set once it settles.
  permission?: { request: PermissionRequest; outcome?: PermissionOutcome };
  // Present when this "tool" message is a suggest_task call that actually
  // filed a task. Only the two ids are persisted: the card re-reads the task
  // row (GET /api/tasks/[id]/suggestion) every time it renders, so what it
  // offers (Start, "added to the board", "withdrawn", "no longer exists") is
  // derived from the row's current state instead of frozen at the moment the
  // tool ran. `projectId` is where it was filed, which suggest_task can point
  // at any project, so it is not necessarily the session's own.
  suggestion?: { taskId: string; projectId: string };
}

/**
 * What GET /api/tasks/[id]/suggestion serves: the live state of a task a
 * `suggest_task` call filed, read by the suggestion card the transcript
 * settles onto that call. Re-read rather than persisted into the transcript,
 * since the card's job is to say what the row is now.
 */
export interface SuggestionCard {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number;
  started: number;
  withdrawn_reason: string;
  /** The project the task was filed into, which need not be the session's own. */
  project_id: string;
  project_name: string;
  blocked_by: { id: string; title: string; status: Status }[];
}

/** A recurring prompt. */
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
  /**
   * 'YYYY-MM-DD' for a one-time schedule, '' for the ordinary weekly one.
   * When set, `days_mask` is ignored and the schedule fires exactly once, then
   * spends itself (enabled = 0, next_fire_at = 0) instead of being deleted, so
   * the run ledger keeps a record of a "check on it at 04:00" job.
   */
  once_date: string;
  next_fire_at: number; // cached from lib/schedule/time.ts
  /**
   * The runbook this schedule fires, if any. When set, fireSchedule() reads
   * the prompt and dispatch config from that row instead of the columns
   * above, which stay populated as the fallback and are refreshed from the
   * runbook if it is ever deleted (see deleteRunbook).
   */
  runbook_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A saved task-launch preset. */
export interface Runbook {
  id: string;
  project_id: string;
  name: string;
  description: string;
  /** The first user message of every task this dispatches, so a /slash command expands. */
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
 * A named, project-scoped label a task can carry: "the auth migration", "the
 * mobile PWA", "flaky-tests". Not a task: no session, no worktree, no status
 * of its own. Many-to-many with tasks (`task_tags`), so a task can be a step
 * of the auth migration and a piece of the mobile push at once, getting both
 * tags' context.
 */
export interface Tag {
  id: string;
  project_id: string;
  name: string;
  description: string;
  /** Badge tint (hex from TAG_COLORS), or null for the neutral badge. */
  color: string | null;
  /** The session that filed this tag, when an agent did; null when the user made it. */
  origin_task_id: string | null;
  /**
   * The base branch tasks carrying this tag are cut from: the whole plan's
   * base, configured once instead of on every task. `""` means no opinion,
   * follow the project's default. It applies to a task only until its
   * worktree is cut, after which `tasks.base_branch` holds the pinned answer;
   * a task carrying several tags takes the first non-empty one in tag order.
   * See lib/baseBranch.ts.
   */
  base_branch: string;
  position: number;
  created_at: number;
  updated_at: number;
  /**
   * "Refresh tag with AI" job state (lib/tagRefresh.ts). Persisted on the row
   * rather than held in memory because the job outlives the click: a user who
   * fires it and then switches to a different chip, switches project, or
   * reloads the tab must come back to the same bar, and a server that dies
   * mid-run must leave something a later poll can unstick.
   *
   * Unlike the project context draft, this has no draft field: the outcome is
   * applied, not reviewed. The tag description is written directly, and the
   * task edits land in `task_agent_edits`, where the "Changed by agent" chip
   * and its per-edit Revert serve as the review surface.
   */
  refresh_status: "idle" | "running" | "done" | "error";
  /** Which phase a running job is in, for the bar's label. "" when idle. */
  refresh_stage: string;
  /** What the last finished run actually changed, in the server's words, not the model's. */
  refresh_summary: string;
  refresh_error: string; // failure message (when status="error")
  refresh_started_at: number; // when the current/last job started (ms epoch, 0 = never)
  /**
   * Derived per read, never stored. `done`/`cancelled` are terminal the way
   * lib/autoStart's blocks() counts them (a withdrawn suggestion is
   * cancelled); `awaiting` uses the same NEEDS_YOU predicate as the project
   * badge.
   */
  counts: { total: number; done: number; cancelled: number; running: number; awaiting: number };
}

/** The badge tints a tag may carry: the project palette, so the two read as one system. */
export const TAG_COLORS = ["#C2603C", "#3E7CA8", "#6B6F8C", "#5C8C5A", "#9A6E14", "#9E5BA0"] as const;

/**
 * Validate a badge tint off the wire: undefined/null/"" clear it, anything
 * else must be a palette entry. Shared by the create and edit routes so the
 * two can't accept different colors.
 */
export function parseTagColor(v: unknown): { ok: true; color: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, color: null };
  if (typeof v !== "string" || !(TAG_COLORS as readonly string[]).includes(v)) {
    return { ok: false, error: `color must be one of: ${TAG_COLORS.join(", ")}` };
  }
  return { ok: true, color: v };
}

/** Every member terminal, and at least one member: the tag's derived "done". */
export function tagIsDone(t: Pick<Tag, "counts">): boolean {
  return t.counts.total > 0 && t.counts.done + t.counts.cancelled === t.counts.total;
}

export type ScheduleRunStatus =
  | "claimed" | "running" | "succeeded" | "failed" | "stopped" | "interrupted"
  | "missed" | "skipped_overlap";

export type ScheduleTrigger = "scheduled" | "catch_up" | "manual";

/** One occurrence of a schedule, including occurrences that never ran. */
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
