// Work Center wire types, contract work-center/1 (calandria-notes, specs/
// 2026-09-22-work-center-contract-v1.md). Type-only and SDK-free: JSON
// camelCase, UTC epoch milliseconds, explicit null for unavailable data,
// opaque string ids. Nothing here may import a runtime module.

export type Id = string;
export type Ms = number;
export type Outcome = "ok" | "failed" | "stopped" | "interrupted" | "unknown";
export type ReviewApplicability = "current" | "landed" | "retired" | "changed" | "unavailable";

export type Freshness = {
  state: "fresh" | "stale" | "unknown";
  observedAt: Ms | null;
  lastAttemptAt: Ms | null;
  errorCode: string | null;
};

export type Count = { value: number | null; known: number };

export type Summary = {
  workingTaskCount: Count;
  needsYouTaskCount: Count;
  attentionItemCount: Count;
  snoozedNeedsYouTaskCount: Count;
  // Amendment 1: needs-you minus snoozed. Every displayed needs-you number
  // uses these; the unsubtracted fields above are for tests and diagnostics.
  visibleNeedsYouTaskCount: Count;
  visibleAttentionItemCount: Count;
  suggestedTaskCount: number;
};

export type Coverage = {
  source: "execution" | "question" | "permission" | "ci" | "agent_edit"
    | "settings_proposal" | "base_rewrite" | "turn_failure" | "review";
  taskId: Id | null;
  state: "complete" | "partial" | "unavailable" | "not_applicable";
  reason: string | null;
};

export type Destination = {
  projectId: Id; taskId: Id; sessionId: Id | null;
  messageId: Id | null; requestId: Id | null;
  reviewRequestId: Id | null; submissionId: Id | null;
  surface: "transcript" | "checks" | "agent_edits" | "base_sync" | "review";
};

export type Attention = {
  id: Id; sourceRevision: string;
  kind: "question" | "permission" | "ci" | "agent_edit"
    | "settings_proposal" | "base_rewrite" | "turn_failure" | "review";
  firstOccurredAt: Ms; actionable: true;
  title: string; action: "answer" | "decide_permission" | "fix_ci"
    | "acknowledge_or_revert" | "decide_proposal" | "repair_base"
    | "recover_turn" | "decide_review" | "recover_review_action";
  destination: Destination;
  freshness: Freshness;
  snoozedUntil: Ms | null;
  recoveryActionId: Id | null;
  // Amendment 1: "allow_once_or_deny" only for a live, scope-free,
  // non-settings-drift Claude permission request; null for every other item.
  inlineDecision: "allow_once_or_deny" | null;
};

export type WaitingReason =
  | "input" | "wakeup" | "external" | "queued"
  | "dependency" | "on_hold" | "no_live_turn" | "detail_unavailable" | "review_required";

export type Execution = {
  turnId: Id | null;
  sessionId: Id | null;
  foreground: "executing" | "parked" | "finished" | "none" | "unknown";
  background: Array<{ id: Id; kind: "command" | "agent"; startedAt: Ms | null }>;
  backgroundCoverage: "complete" | "unavailable";
  wakeups: Array<{ id: Id; at: Ms }>;
  externalWait: { kind: "provider" | "capacity"; since: Ms | null } | null;
  queuedStart: { at: Ms | null; reason: "scheduled" | "usage_reset" | "capacity" } | null;
  queuedFollowupCount: number;
  blockerTaskIds: Id[];
  lastActivityAt: Ms | null;
  isWorking: boolean;
  waitingReasons: WaitingReason[];
};

export type LatestResult = {
  turnId: Id | null; sessionId: Id | null; generation: number;
  scheduleRunId: Id | null;
  startedAt: Ms | null; endedAt: Ms;
  outcome: Outcome; terminalMessageId: Id | null;
  taskCompletedAt: Ms | null;
};

export type Lifecycle = "not_started" | "in_progress" | "on_hold" | "done" | "cancelled";

export type WorkRow = {
  taskId: Id; projectId: Id; title: string; projectName: string;
  lifecycle: Lifecycle;
  execution: Execution; attention: Attention[];
  latestResult: LatestResult | null;
  snoozedUntil: Ms | null;
};

export type Snapshot = {
  version: 1; instanceId: Id; instanceEpoch: Id; sequence: number; generatedAt: Ms;
  scope: { projectId: Id | null; includeDeprecated: boolean };
  freshness: Freshness; coverage: Coverage[];
  summary: Summary;
  projects: Array<{ projectId: Id; summary: Summary }>;
  tasks: WorkRow[];
  recentlyFinished: { rows: WorkRow[]; nextCursor: string | null };
};

/**
 * What a driver reports about the live session. The runner attaches the task,
 * generation and server turn id; a provider never chooses them. `background`
 * and `wakeups` are the full current sets (each observation replaces the
 * last), and `backgroundCoverage: "unavailable"` says the provider cannot
 * tell, which is never the same as an empty list.
 */
export type ExecutionObservation = {
  type: "execution_observation";
  foreground: "executing" | "parked" | "finished" | "unknown";
  background: Array<{ id: string; kind: "command" | "agent"; startedAt: number | null }>;
  backgroundCoverage: "complete" | "unavailable";
  wakeups: Array<{ id: string; at: number }>;
  externalWait: { kind: "provider" | "capacity"; since: number | null } | null;
};

/** The failure classes a finalized turn can carry (tasks.latest_turn_failure_code). */
export type TurnFailureCode = "context_limit" | "auth" | "approval" | "execution";
