// Client-side shapes + UI constants shared across the shell modules.
// Pure data only (no React / no Icon) so any module can import freely.
import { PRIORITIES, TAG_COLORS, tagIsDone } from "@/lib/types";
import type { LandingMode, Priority, Status, Tag } from "@/lib/types";
export { PRIORITIES, TAG_COLORS, tagIsDone };
export type { LandingMode };
/** A tag as the project GET embeds it — lib/types' row plus its derived counts. */
export type TagRow = Tag;
import type { InternalUsageEstimate } from "@/lib/internalUsage";
export type { InternalUsageEstimate };

// ---------- client shapes ----------
export interface ProjectRow {
  id: string;
  name: string;
  icon: string;
  sub: string;
  color: string;
  context: string;
  repo_path: string;
  branch: string;
  landing_mode: LandingMode; // how work lands on `branch`: "merge" (local merge) or "pr" (protected — finish by opening a PR)
  auto_reclaim: number; // 1 = once a task's work lands, reclaim its checkout and delete its local branch without being asked (lib/reclaim.ts)
  dev_command: string;
  setup_command: string;
  test_command: string;
  default_agent: string; // agent driver new tasks in this project default to (lib/agents/registry.ts)
  send_context: number; // 1 = new tasks default to sending the saved project context to the agent
  port: number;
  deprecated: number;
  seeded: number; // 1 = built-in "Welcome" tutorial project (coach marks + post-merge nudge)
  task_count: number;
  last_activity: number;
  awaiting_count: number; // in-progress tasks waiting on the user (across this project)
  cost_usd: number; // cumulative dollar spend across all this project's tasks
}
export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: Status;
  suggested: number;
  agent: string; // agent driver this task's sessions run under (lib/agents/); fixed for the task's life
  send_context: number; // 1 = sessions get the saved project context (seeded from the project setting)
  model: string | null;
  resolved_model: string | null;
  reasoning: string | null; // thinking preset; null = inherit default
  permission_mode: string | null; // run permission; null = bypassPermissions (default)
  session_id: string | null;
  worktree_path: string; // isolated git worktree this task runs in ("" = not created yet — appears on the first turn)
  merged_at: number; // when this task's branch was merged into the base branch LOCALLY (0 = never); pairs with pr_state for "has this landed?"
  pr_url: string; // GitHub PR opened from this task's branch ("" = none yet)
  // Live PR state, refreshed from GitHub in the background (lib/prState.ts) and
  // arriving here on task_edited. All five are "" / 0 until the first refresh
  // answers, which is what the chip draws as "checking…" rather than guessing.
  pr_number: number; // parsed from pr_url when the PR was created — never re-derived per render
  pr_state: string; // "open" | "merged" | "closed"
  pr_checks: string; // "pending" | "passing" | "failing" | "none" (no CI configured)
  pr_review: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED ("" = review not required)
  pr_merged_at: number; // when GITHUB merged it (0 = not merged there); not merged_at, which is our local merge
  pr_synced_at: number; // when the server last heard from GitHub (0 = never)
  generation: number;
  started: number;
  running: number;
  awaiting_input: number;
  background_pending: number; // 1 while a live turn lingers on run_in_background work — "working in background", never "needs you"
  background_note: string; // what the linger is waiting on ("waiting to wake at 12:00"); '' when not lingering
  idle_since?: number; // a live turn that has produced nothing since this instant (ms epoch; absent/0 = fine) — see ./idleTurn.ts
  position: number; // the project's filing sequence (MAX+1 on create) — not a render order; the tag strip numbers its steps by it
  updated_at: number;
  cost_usd: number; // cumulative dollar spend across all turns of this task
  total_tokens: number; // cumulative tokens (input+output+cache) across all turns
  cache_read_tokens: number; // of that total, context re-read from the prompt cache (~10% of input price)
  cache_creation_tokens: number; // of that total, context written INTO the cache (fresh work)
  depends_on: string[]; // task ids this task is blocked by until they're done
  tag_ids: string[]; // the tags this task carries, in tag order (see TagChips.tsx); [] = untagged
  auto_start: number; // 1 = start automatically when the last unfinished blocker is marked done
  withdrawn_reason: string; // an agent retracted this suggestion and said why ("" = live); pairs with status "cancelled" + suggested 1
  agent_edited_at: number; // ms epoch of the most recent agent edit the user hasn't reviewed yet (0 = nothing outstanding) — see AgentEdits.tsx
  context_tokens: number; // current context-window occupancy: the latest main-session request's input-side tokens
  context_pct: number; // context_tokens as a percent (0–100) of the model's window
  context_estimated: boolean; // true when context_tokens is derived from a usage report, not reported by the agent (see lib/store.ts getTaskContext)
  snoozed_until: number; // when a snooze ends (ms epoch; 0 = never snoozed / indicator cleared) — see ./snooze.ts
  unread_run_at: number; // an unattended run finished cleanly and nobody has acknowledged it (ms epoch; 0 = nothing outstanding) — see isUnreadRun in ./format.ts
  start_at: number; // queued to start/resume on its own at this instant (ms epoch; 0 = not queued) — see ./queuedStart.ts
  base_branch: string; // the branch this task is based on ("" = inherit the project's default) — see lib/baseBranch.ts
  work_branch?: string; // the worktree's branch — board footer only; present once a worktree exists
  diff_add?: number; // uncommitted+committed additions vs. base, running tasks only (see /api/projects/[id])
  diff_del?: number; // same, deletions
}
// ---------- agent edits on an already-accepted task (AgentEdits.tsx) ----------
// Mirrors lib/types.ts's server-side shapes for GET/POST /api/tasks/[id]/agent-edits.

/** The task field an agent tool changed — `update_task`'s, plus the base branch
 *  `set_base_branch` retargets (whose Revert re-runs the retarget, not a write). */
export type AgentEditField = "title" | "description" | "priority" | "status" | "tags" | "blocked_by" | "base_branch";

/** One field's before/after within an edit — `before`/`after` are already the
 *  readable rendering ("(none)", "3 tasks", a title, a priority); `before_value`
 *  is what a revert writes back and is never sent by the client. */
export interface AgentEditChange {
  field: AgentEditField;
  before: string;
  after: string;
  before_value: string | string[] | null;
}

/** One recorded agent edit to a task the user had already accepted. */
export interface TaskAgentEdit {
  id: string;
  task_id: string;
  project_id: string;
  /** The task whose session made the change; "" if that row is gone. */
  actor_task_id: string;
  actor_title: string;
  /** An agent id, e.g. "claude" / "codex". */
  actor_agent: string;
  changes: AgentEditChange[];
  created_at: number;
  /** 0 = still applied; non-zero = the user already reverted it. */
  reverted_at: number;
  acknowledged_at: number;
}

// A single row in the titlebar "need you" dropdown: an awaiting task plus enough
// of its project to label and color it. Mirrors lib/store.ts listNeedsYou().
export interface NeedsYouRow {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
}
// A row in the ⌘K palette's session search: any real task across the active
// projects plus enough of its project to label it. Mirrors lib/store.ts
// listAllTasksLite().
export interface PaletteTaskRow {
  id: string;
  project_id: string;
  title: string;
  status: Status;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  project_color: string;
  project_icon: string;
  /** The tags it carries — the palette's badges; [] when untagged. */
  tags: { name: string; color: string | null }[];
}
// A tag in the ⌘K palette: a jump target of its own ("Tag · Auth migration
// · 4/7"), so a feature is reachable by name from anywhere. Mirrors
// lib/store.ts listAllTagsLite().
export type PaletteTagRow = TagRow & {
  project_name: string;
  project_color: string;
  project_icon: string;
};
export interface Msg {
  id: string;
  // "queued" is a client-only role: a follow-up the user typed mid-turn that's
  // parked (in pending_messages) until the current turn ends. Not a persisted
  // message role — it never lands in the `messages` table.
  role: "user" | "assistant" | "tool" | "system" | "session_break" | "queued";
  content: string;
  generation: number;
  toolId?: string; // tool_use id, for merging the tool_result that arrives later
  ts?: number; // created_at of the persisted row (ms epoch); absent on synthetic ids
}
export interface ProjectSession {
  id: string;
  task_id: string;
  task_title: string;
  task_status: Status;
  generation: number;
  claude_session_id: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
}
export interface RecapInfo {
  recap: string | null;
  recap_at: number;
  hasHistory: boolean;
  stale: boolean;
  needsRecap: boolean;
  generating: boolean;
  lastActivity: number;
  // Client-side only: set when the fetch/generate failed, so the landing pane
  // can offer a retry instead of silently showing nothing.
  error?: string;
}

// What POST /api/tasks/move did with a selection. Ids rather than rows: the
// trays get refetched either way (the move changes both projects' counts and
// the moved tasks' neighbours), so what the client needs back is the account.
// `skipped` is the whole reason the endpoint reports instead of refusing —
// a started task in the selection is named, not silently left behind.
export interface BulkMoveResult {
  moved: string[];
  unchanged: string[];
  skipped: { id: string; reason: string }[];
  /** Blocked-by edges severed because only one end moved. */
  dropped: { task_id: string; depends_on_id: string }[];
  /** Edges that survived because both ends moved together. */
  kept: { task_id: string; depends_on_id: string }[];
  /** One per worktree torn down to let a started task move — the part of the
   *  account nobody can get back, so the report names it. */
  discarded: { id: string; branch: string; dirty: boolean; ahead: number }[];
  /** Moved rows that left a tag behind, because the rest of its members stayed. */
  untagged: { id: string; tag_id: string; tag_name: string }[];
  /** Tags that came along whole — `renamed_from` when the destination had that name. */
  carried: { id: string; name: string; renamed_from: string | null }[];
}

// What discarding a task's checkout would cost — GET /api/tasks/[id]/move for
// one, GET /api/tasks/move?ids=… for a selection. Mirrors lib/taskMove.ts
// DiscardPreview.
export interface DiscardPreview {
  has_worktree: boolean;
  safe: boolean;
  dirty: boolean;
  ahead: number;
  reason: string | null;
  branch: string;
}

// Divergence status for the reopened-task sync banner (GET /api/tasks/:id/sync).
export interface SyncStatusResp {
  isolated: boolean;
  baseBranch?: string;
  behind?: number;
  ahead?: number;
  isDirty?: boolean;
  canFastForward?: boolean;
  clean?: boolean;
  conflicts?: string[];
  mergeInProgress?: boolean; // a base→work merge is paused in the worktree, awaiting accept/discard in Changes
  unresolved?: string[]; // while paused: files still conflicted (markers or unstaged binaries)
}

// How the project's LOCAL base branch stands against its remote — the thing
// nothing in the app used to look at, so a PR merged on GitHub left every new
// task branching off a dead tip while the sync panel said "up to date".
export interface BaseBranchResp {
  hasRemote: boolean;
  label?: string; // "origin/main"
  baseBranch?: string;
  tracked?: boolean;
  behind?: number;
  ahead?: number;
  diverged?: boolean;
  unknown?: boolean; // ancestry couldn't be established (shallow clone)
  canFastForward?: boolean;
  remoteTip?: string;
  fetchedAt?: number;
  fetchError?: string;
}

export type FsListing = { path: string; parent: string | null; home: string; entries: { name: string; path: string }[] };

// ---------- GitHub onboarding shapes ----------
export type GhStatusT = { installed: boolean; authenticated: boolean; login: string | null };
export type GhLoginT = { status: "idle" | "starting" | "awaiting" | "success" | "error"; code: string | null; url: string | null; user: string | null; error: string | null };
export type GhRepoT = { nameWithOwner: string; description: string; isPrivate: boolean; updatedAt: string };

// ---------- first-run onboarding wizard shapes ----------
export type OnbStep = "connect" | "verify";
export type OnboardingT = {
  complete: boolean;
  step: OnbStep;
  method: "subscription" | "api_key" | null;
  account: { email: string | null; plan: string | null } | null;
};
export type ClaudeLoginT = {
  status: "idle" | "starting" | "awaiting" | "submitting" | "success" | "error";
  url: string | null;
  email: string | null;
  plan: string | null;
  error: string | null;
  log: string;
};
export type ClaudeVerifyT = {
  connected: boolean;
  email: string | null;
  plan: string | null;
  method: string | null;
  error: string | null;
};

// ---------- multi-agent connect (GET /api/agents + /api/agents/[id]/*) ----------
// Mirrors the server's AgentCapabilities + per-agent connection state. Used by
// the Settings "Agents" surface to render connect cards and gray out agents that
// aren't wired up. Only the fields the client reads are typed here.
export type AgentCapabilitiesT = {
  apiKeyHint: string | null;
  loginStyle: "paste_code" | "device_code";
  // Whether a task on this agent also gets the MCP servers the user configured
  // for its CLI, plus the driver's one-line why. A real difference between the
  // agents when picking one for a task, so the Agents section states it.
  inheritsUserMcpServers: boolean;
  userMcpServersNote: string | null;
};
export type AgentInfoT = {
  id: string;
  label: string;
  capabilities: AgentCapabilitiesT;
  connected: boolean;
  account: { email: string | null; plan: string | null; method: "subscription" | "api_key" } | null;
  authBroken?: AgentAuthBrokenT | null;
};
// Connected, but its login stopped working mid-flight (see lib/authFailure.ts).
// `reason` is the provider's own error text; `at` is when it was first seen.
export type AgentAuthBrokenT = { at: number; reason: string };
export type AgentsResponseT = { default: string; agents: AgentInfoT[]; utility?: UtilityAgentT };
// Which agent actually runs the app's project-scoped internal jobs (recaps,
// context drafts), resolved connected-first on the server (lib/agents/oneshots).
// `id: null` = nothing connected; `fallback` = the configured agent isn't
// connected, so a different one is standing in.
export type UtilityAgentT = { id: string | null; configured: string; fallback: boolean };
export type AgentLoginT = ClaudeLoginT & { code?: string | null };

// ---------- status maps (DB status -> design's r/a/g classes + labels) ----------
export const SCLS: Record<Status, "r" | "a" | "g" | "h" | "x"> = { not_started: "r", in_progress: "a", on_hold: "h", done: "g", cancelled: "x" };
export const SLABEL: Record<Status, string> = { not_started: "Not started", in_progress: "In progress", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
export const AWAIT_LABEL = "Needs your input";
// The derived category a snoozed task is drawn in — one constant so the list
// group, the board column and any copy referring to it can't drift apart. NOT
// a Status: a snooze leaves the status alone, which is what the task goes back
// to when it wakes (see ./snooze.ts).
export const SNOOZE_LABEL = "Snoozed";
// The ran-clean group/column: a scheduled run that finished on its own with
// nothing to answer. Named for what HAPPENED rather than for a status, because
// it isn't one — the task is still `in_progress` underneath (see ./format.ts).
export const RAN_LABEL = "Ran clean";
export const SSUB: Record<Status, string> = { not_started: "no session yet", in_progress: "session active or paused", on_hold: "paused, pick up later", done: "work complete / merged", cancelled: "abandoned, won't be finished" };
export const STATUSES: Status[] = ["not_started", "in_progress", "on_hold", "done", "cancelled"];
export const PLABEL: Record<Priority, string> = { hi: "High", med: "Medium", lo: "Low" };

// ---------- agent capability descriptors (mirrors lib/agents/types.ts) ----------
// The run controls are no longer hardcoded per agent: each driver ships a
// capability descriptor (models / reasoning / permission modes it supports, plus
// feature flags) served by GET /api/agents. The client renders every picker from
// this data, so a task's controls always match the agent it runs under.
export interface AgentModelOption { value: string; label: string; sub: string; contextWindow: number; group?: string }
export interface AgentPickerOption { value: string; label: string; sub: string }
export interface AgentCapabilities {
  models: AgentModelOption[];
  reasoningOptions: AgentPickerOption[];
  permissionModes: AgentPickerOption[];
  supportsAsks: boolean;      // can surface interactive ask cards mid-turn
  supportsMcpTools: boolean;  // can mount the Calandria MCP tools
  reportsCostUsd: boolean;    // usage carries a real dollar cost (not just tokens)
  costIsEstimated: boolean;   // cost is estimated from tokens × API prices — show with ~
  reportsContext?: boolean;   // the stream reports real context occupancy; false = the gauge is a usage-derived estimate (absent on a stale bundle = assume true)
  supportsResume: boolean;    // turns can resume a prior session/thread id
}
// How this agent is signed in. "subscription" (a Max/Pro or ChatGPT login) means
// turns draw on plan quota and cost no marginal money, so a dollar figure is an
// API-PRICE EQUIVALENT rather than a charge; "api_key" means it really is billed.
// Mirrors lib/agents/connections.ts AgentConnection; null when not connected.
export interface AgentAccount { email: string | null; plan: string | null; method: "subscription" | "api_key" }
export interface AgentInfo { id: string; label: string; capabilities: AgentCapabilities; authenticated: boolean; account?: AgentAccount | null; authBroken?: AgentAuthBrokenT | null }
export interface AgentsBundle { default: string; agents: AgentInfo[]; utility?: UtilityAgentT }
export const EMPTY_AGENTS: AgentsBundle = { default: "claude", agents: [] };

// A picker option list. `value: null` is the synthetic inherit head — it
// persists as null in tasks.model/reasoning/permission_mode, inheriting the
// app-level (agent-scoped) default, then the driver's built-in.
export type PickerOption = { value: string | null; label: string; sub: string; group?: string };
// The head is deliberately NOT called "Default": the labels below it are
// provider-native (Anthropic's own `--permission-mode` strings), and one of
// those modes is literally spelled "default", so a capital-D head read as a
// duplicate of it and made picking the wrong one easy. "Inherit" is the one
// word every picker built from withInherit() uses for "no choice of my own",
// and anywhere the resolved value is rendered as a label (the session rail's
// model/reasoning chips) must show the same word.
export const INHERIT_LABEL = "Inherit";
const INHERIT_HEAD: PickerOption = { value: null, label: INHERIT_LABEL, sub: "use the app-level default" };
// `sub` overrides what the head claims to inherit — Settings → Run defaults IS
// the app-level default, so there the head hands the choice to the driver.
const withInherit = (opts: PickerOption[], sub?: string): PickerOption[] =>
  [sub ? { ...INHERIT_HEAD, sub } : INHERIT_HEAD, ...opts];
// Build each picker's option list from a driver's capabilities. Undefined caps
// (agent metadata not loaded yet) yields just the inherit head.
export const modelOptions = (caps?: AgentCapabilities, sub?: string): PickerOption[] => withInherit(caps?.models ?? [], sub);
export const reasoningOptions = (caps?: AgentCapabilities, sub?: string): PickerOption[] => withInherit(caps?.reasoningOptions ?? [], sub);
export const permissionOptions = (caps?: AgentCapabilities, sub?: string): PickerOption[] => withInherit(caps?.permissionModes ?? [], sub);

// Lightweight filter box for the project & task lists — only worth showing once a
// list grows past SEARCH_MIN, so small workspaces stay clutter-free.
export const SEARCH_MIN = 6;

// How a project's tasks render: the grouped list (middle column + chat), or
// the full-workspace kanban board. Persisted alongside the other prefs.
export type TaskView = "list" | "board";

// What a save from the Edit-task dialog does BEYOND writing the fields:
// "add" also accepts a suggestion out of the tray, "start" does that and
// launches the first session. Both ride along on the one PATCH the save
// already sends — see saveTask in useShell.ts.
export type SaveAction = "add" | "start";

// Which surface fills the work area (the right two columns). "workspace" is the
// normal tasks+session view; "settings" replaces it with the app settings shell;
// "insights" with the usage/analytics dashboard. Mirrored into the URL
// (?view=settings / ?view=insights) so it's deep-linkable + refresh-stable,
// consistent with how project/task selection is persisted.
export type View = "workspace" | "settings" | "insights";
// Purely cosmetic, client-only look-and-feel prefs (the "Appearance" panel).
// `wide` is a string ("0"/"1") rather than a boolean so every field goes through
// the same `setAppearance(key, value: string)` setter that palette/mode/density use.
//
// `palette` picks one of the four design-system themes (docs/design/handoff/styles.css);
// `mode` is "system" (follow the OS) or a pinned light/dark. usePrefs.ts resolves
// the pair to a `data-theme="<palette>-<mode>"` attribute on <html>, plus a bare
// `data-mode="<mode>"` for the handful of component rules that key off resolved
// mode regardless of palette.
export type Palette = "cherenkov" | "heavywater" | "denoche" | "basic";
export type ThemeMode = "system" | "light" | "dark";

// User-selectable code/terminal font (Settings → Appearance, full picker lands in
// a later wave — see AppearancePanel.tsx). Default: JetBrains Mono.
export type MonoFontId = "jetbrains-mono" | "fira-code" | "cascadia-code" | "red-hat-mono" | "atkinson-mono";
// User-selectable prompt-input font. Default: Source Sans 3.
export type PromptFontId = "source-sans" | "literata" | "spectral" | "atkinson-next";

export interface Appearance {
  palette: Palette;
  mode: ThemeMode;
  monoFont: MonoFontId;
  promptFont: PromptFontId;
  density: string;
  wide: string;
}
export const DEFAULT_APPEARANCE: Appearance = {
  palette: "cherenkov",
  mode: "system",
  monoFont: "jetbrains-mono",
  promptFont: "source-sans",
  density: "1",
  wide: "0",
};

// Font metadata: id → display label + a full CSS font-family stack. `cssFamily`
// points at the next/font CSS variable (app/fonts.ts) plus a generic fallback,
// so it's usable directly in globals.css tokens; xterm needs a literal family
// name instead of a var(), so Terminal.tsx resolves these via getComputedStyle
// at mount rather than reading cssFamily verbatim.
export const MONO_FONTS: Record<MonoFontId, { label: string; cssFamily: string }> = {
  "jetbrains-mono": { label: "JetBrains Mono", cssFamily: "var(--nf-jetbrains-mono), ui-monospace, monospace" },
  "fira-code": { label: "Fira Code", cssFamily: "var(--nf-fira-code), ui-monospace, monospace" },
  "cascadia-code": { label: "Cascadia Code", cssFamily: "var(--nf-cascadia-code), ui-monospace, monospace" },
  "red-hat-mono": { label: "Red Hat Mono", cssFamily: "var(--nf-red-hat-mono), ui-monospace, monospace" },
  "atkinson-mono": { label: "Atkinson Hyperlegible Mono", cssFamily: "var(--nf-atkinson-mono), ui-monospace, monospace" },
};
export const PROMPT_FONTS: Record<PromptFontId, { label: string; cssFamily: string }> = {
  "source-sans": { label: "Source Sans 3", cssFamily: "var(--nf-source-sans), system-ui, sans-serif" },
  literata: { label: "Literata", cssFamily: "var(--nf-literata), Georgia, serif" },
  spectral: { label: "Spectral", cssFamily: "var(--nf-spectral), Georgia, serif" },
  "atkinson-next": { label: "Atkinson Hyperlegible Next", cssFamily: "var(--nf-atkinson-next), system-ui, sans-serif" },
};
// What `.tw` / `.composer-inner` cap their column at, applied as --text-width on
// <html>. "Reading" is the 760px measure the design was drawn at; "full" lets the
// transcript and composer use the whole session pane (the 28px gutter stays).
export const TEXT_WIDTH = { reading: "760px", full: "none" };

// App-level preferences (distinct from Appearance, which is purely cosmetic). These
// are personal/client-only so they live in the same localStorage store as Appearance;
// if shared/server config is ever needed, a `settings` table in lib/db.ts keyed by
// name would be the place. Keep this a flat object with sensible defaults so new
// settings are a one-line addition here + a field in SettingsView.
export interface Settings {
  // The app nudges you to /clear when a session's context window crosses EITHER
  // of these — a percentage of the window, or an absolute token count. The paired
  // "Recommend /clear when context is high" feature reads these.
  clearThresholdPct: number;    // 0–100, % of the context window
  clearThresholdTokens: number; // absolute token count
}
export const DEFAULT_SETTINGS: Settings = { clearThresholdPct: 75, clearThresholdTokens: 150_000 };

// Persisted sidebar layout — column widths and collapsed (hidden) state, so the
// user can carve out more room for the chat and have it stick across reloads.
export interface Layout { projW: number; taskW: number; railW: number; projCollapsed: boolean; taskCollapsed: boolean; railCollapsed: boolean; }
export const DEFAULT_LAYOUT: Layout = { projW: 236, taskW: 352, railW: 430, projCollapsed: false, taskCollapsed: false, railCollapsed: false };
export const PROJ_W = { min: 170, max: 460 };
export const TASK_W = { min: 240, max: 620 };
export const RAIL_W = { min: 320, max: 760 };

// ---------- scheduled tasks (project landing "Schedules" card) ----------
// Mirrors lib/store.ts's schedule + schedule_run rows as served by
// GET /api/projects/[id]/schedules (Task 10). `last_run`/`runs` are joined in
// server-side so the card never needs a second round trip to show an outcome.
export interface ScheduleRunRow {
  id: string;
  scheduled_for: number;
  fired_at: number;
  finished_at: number;
  task_id: string | null;
  status: "claimed" | "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "missed" | "skipped_overlap";
  trigger: "scheduled" | "catch_up" | "manual";
  detail: string;
  dst_adjusted: string;
}

export interface ScheduleRow {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  days_mask: number;
  time_of_day: string;
  timezone: string;
  enabled: number;
  agent: string;
  permission_mode: string | null;
  next_fire_at: number;
  /** The runbook this schedule fires, if any — it supplies the prompt and config. */
  runbook_id: string | null;
  last_run: ScheduleRunRow | null;
  runs: ScheduleRunRow[];
  // The row still `claimed`/`running` for this schedule, if any — served
  // explicitly rather than left for the client to find inside `runs`, which is
  // a 5-row history window a long-wedged run can fall out of entirely.
  active_run: ScheduleRunRow | null;
}

/** lib/scheduler.ts's schedulerHealth(), as served by the schedules endpoints. */
export interface SchedulerHealth {
  started: boolean;
  /** When the ticker was started; the baseline before any sweep has finished. */
  startedAt: number;
  /** When the last sweep FINISHED. A stale value is the only symptom a wedged sweep has. */
  lastTickAt: number;
  /** The last per-schedule failure. Cleared by the next clean sweep. */
  lastError: string;
  /** The configured tick interval, so the client can age lastTickAt honestly. */
  tickMs: number;
}

export interface SchedulesResponse {
  schedules: ScheduleRow[];
  scheduler: SchedulerHealth;
}

/** A saved task-launch preset, as served by the runbooks endpoints. */
export interface RunbookRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  prompt: string;
  agent: string;
  permission_mode: string | null;
  send_context: number;
  priority: Priority;
  /** '' = the user wrote it; otherwise the agent id that filed it. */
  created_by: string;
  /** The most recent task this dispatched — null until it has run once. */
  last_run: { id: string; title: string; status: string; created_at: number } | null;
  /**
   * The schedules that fire this runbook, by name. Editing it changes what they
   * run, unattended, so the card says so rather than leaving it implicit.
   */
  used_by: { id: string; name: string }[];
}

export interface RunbooksResponse {
  runbooks: RunbookRow[];
}
