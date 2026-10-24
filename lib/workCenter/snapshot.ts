// Work Center snapshot assembly (contract work-center/1 with amendment 1).
//
// Every surface reads this one projection. Each attention item is derived from
// the source that owns it (the live ask registries and their persisted cards,
// the PR snapshot, the agent-edit audit trail, the base-rewrite stamp, the
// latest-turn columns), and no copy of an item is stored: a source that
// settles simply stops producing its item on the next read.
//
// Assembly is synchronous and does no network I/O. It captures ONE `now` and
// uses it for every snooze comparison, so a deadline passing between two reads
// cannot put a task on both sides of the visible count. The sequence is read
// before and after; a change retries (three attempts), and a still-unstable
// read throws SnapshotBusy so the route can answer 503 instead of returning
// partial totals.

import { hasTurn, activeTurnIds } from "@/lib/abort";
import { openAskIds, tasksWithOpenAsks } from "@/lib/asks";
import { hasMandatoryDecision, mandatoryDecisionIds, tasksWithMandatoryDecisions } from "@/lib/advanced-env/capabilities";
import { PR_POLL_MS } from "@/lib/config";
import {
  findCardMessage,
  listOutstandingAgentEdits,
  listPendingMessages,
  listProjectsForWorkCenter,
  listWorkCenterTaskRows,
  sessionRowId,
  suggestedCountsByProject,
  workCenterInstanceId,
  type WorkCenterTaskRow,
} from "@/lib/store";
import type { PermissionRequest, ToolData } from "@/lib/types";
import { inlineDecisionOf, summarize, type TaskTally } from "./counts";
import { executionOf, recentResults, workCenterEpoch, workCenterSequence, RecentCursorError } from "./execution";
import { resultNeedsAttention } from "./classify";
import { ensureWorkCenterBridge } from "./bridge";
import { legacyEpisodeId, sourceId } from "./ids";
import { getProposal } from "./proposals";
import { reviewAttention } from "./reviewAdapter";
import type { Attention, Coverage, Destination, Execution, Freshness, Id, Ms, Snapshot, Summary, WorkRow } from "./types";

export class SnapshotBusy extends Error {
  constructor() {
    super("snapshot_busy");
  }
}
export class ScopeError extends Error {
  constructor(public code: "unknown_project" | "invalid_scope" | "invalid_cursor") {
    super(code);
  }
}

export type SnapshotOptions = {
  projectId?: Id | null;
  includeDeprecated?: boolean;
  recentCursor?: string | null;
  recentLimit?: number;
  now?: Ms;
  /** Test seam: runs between the two sequence reads so a mutation can be injected. */
  onRead?: (attempt: number) => void;
};

const FRESH = (now: Ms): Freshness => ({ state: "fresh", observedAt: now, lastAttemptAt: now, errorCode: null });

type ItemSource = { attention: Attention[]; coverage: Coverage[] };

// ---- adapters ------------------------------------------------------------

function snoozeOf(row: WorkCenterTaskRow, now: Ms): Ms | null {
  return row.snoozed_until && row.snoozed_until > now ? row.snoozed_until : null;
}

function dest(row: WorkCenterTaskRow, d: Partial<Destination> & Pick<Destination, "surface">): Destination {
  return { projectId: row.project_id, taskId: row.id, sessionId: null, messageId: null, requestId: null, reviewRequestId: null, submissionId: null, ...d };
}

function askTitle(card: ToolData): string {
  const q = card.ask?.questions?.[0] as { question?: string; header?: string } | undefined;
  return (q?.question || q?.header || "Question for you").slice(0, 200);
}

/** Live questions, permissions and Advanced Settings proposals, joined to their persisted cards. */
function liveRequests(rows: Map<string, WorkCenterTaskRow>, now: Ms): ItemSource {
  const attention: Attention[] = [];
  const taskIds = new Set([...tasksWithOpenAsks(), ...tasksWithMandatoryDecisions()]);
  for (const taskId of taskIds) {
    const row = rows.get(taskId);
    if (!row) continue;
    const askIds = new Set(openAskIds(taskId));
    const ids = [...askIds, ...mandatoryDecisionIds(taskId).filter((id) => hasMandatoryDecision(taskId, id))];
    for (const id of ids) {
      const msg = findCardMessage(taskId, id);
      if (!msg) continue;
      let card: ToolData;
      try {
        card = JSON.parse(msg.content) as ToolData;
      } catch {
        continue;
      }
      const sessionId = sessionRowId(taskId, msg.generation);
      const base = { firstOccurredAt: msg.created_at, actionable: true as const, freshness: FRESH(now), snoozedUntil: snoozeOf(row, now), recoveryActionId: null };
      if (card.ask && !card.ask.answers && !card.ask.dismissed && card.ask.id === id) {
        attention.push({
          ...base,
          id: sourceId("question", [taskId, sessionId ?? "", msg.id, id]),
          sourceRevision: id,
          kind: "question",
          title: askTitle(card),
          action: "answer",
          destination: dest(row, { sessionId, messageId: msg.id, requestId: id, surface: "transcript" }),
          inlineDecision: null,
        });
      } else if (card.permission && !card.permission.outcome && card.permission.request.id === id) {
        const req: PermissionRequest = card.permission.request;
        if (req.kind === "environment") {
          // The proposal is the permission card; its duplicate permission item is excluded.
          const meta = getProposal(id);
          attention.push({
            ...base,
            id: sourceId("settings_proposal", [taskId, sessionId ?? "", msg.id, id]),
            sourceRevision: id,
            kind: "settings_proposal",
            title: meta?.label ?? "Environment setting change",
            action: "decide_proposal",
            destination: dest(row, { sessionId, messageId: msg.id, requestId: id, surface: "transcript" }),
            inlineDecision: null,
          });
        } else {
          attention.push({
            ...base,
            id: sourceId("permission", [taskId, sessionId ?? "", msg.id, id]),
            sourceRevision: id,
            kind: "permission",
            // The card's own headline; never the raw command or its detail.
            title: (req.title || "Permission needed").slice(0, 200),
            action: "decide_permission",
            destination: dest(row, { sessionId, messageId: msg.id, requestId: id, surface: "transcript" }),
            inlineDecision: inlineDecisionOf({ kind: "permission", live: true, agent: row.agent, requestKind: req.kind, offersScope: !!req.scope }),
          });
        }
      }
    }
  }
  return { attention, coverage: [] };
}

function prFreshness(row: WorkCenterTaskRow, now: Ms): Freshness {
  const synced = row.pr_synced_at || null;
  const attempted = row.pr_refresh_attempted_at || null;
  if (row.pr_refresh_error) return { state: "stale", observedAt: synced, lastAttemptAt: attempted, errorCode: "refresh_failed" };
  if (!synced) return { state: "unknown", observedAt: null, lastAttemptAt: attempted, errorCode: null };
  if (PR_POLL_MS > 0 && now - synced > 2 * PR_POLL_MS) return { state: "stale", observedAt: synced, lastAttemptAt: attempted, errorCode: "stale" };
  return { state: "fresh", observedAt: synced, lastAttemptAt: attempted, errorCode: null };
}

/** Failing open PRs, on any lifecycle, as CI episodes. */
function ciItems(row: WorkCenterTaskRow, now: Ms, queuedRecovery: boolean): ItemSource {
  const coverage: Coverage[] = [];
  if (!row.pr_url || row.pr_state !== "open") return { attention: [], coverage };
  if (!row.pr_synced_at) {
    // An applicable source nobody has observed: the totals are unknown, never zero.
    coverage.push({ source: "ci", taskId: row.id, state: "unavailable", reason: "never_observed" });
    return { attention: [], coverage };
  }
  if (row.pr_checks !== "failing") return { attention: [], coverage };
  const structured = !!row.pr_ci_episode_id;
  const episodeId = row.pr_ci_episode_id ?? legacyEpisodeId(row.id, row.pr_number);
  if (!structured) coverage.push({ source: "ci", taskId: row.id, state: "partial", reason: "episode_unavailable" });
  // Recovery suppresses only the episode it owns, and only while that recovery
  // is executing or durably queued. A different head or episode stays actionable.
  if (structured && row.ci_recovery_episode_id === episodeId && (hasTurn(row.id) || queuedRecovery)) return { attention: [], coverage };
  const sessionId = sessionRowId(row.id, row.generation);
  return {
    coverage,
    attention: [
      {
        id: sourceId("ci", [row.id, row.pr_repository_id ?? "", row.pr_number, row.pr_head_sha ?? "", episodeId]),
        sourceRevision: episodeId,
        kind: "ci",
        firstOccurredAt: row.pr_ci_episode_started_at ?? row.pr_synced_at,
        actionable: true,
        title: `CI failing on PR #${row.pr_number}`,
        action: "fix_ci",
        destination: dest(row, { sessionId, surface: "checks" }),
        freshness: prFreshness(row, now),
        snoozedUntil: snoozeOf(row, now),
        recoveryActionId: null,
        inlineDecision: null,
      },
    ],
  };
}

function baseRewriteItem(row: WorkCenterTaskRow, now: Ms): ItemSource {
  if (!row.base_rewritten_at) return { attention: [], coverage: [] };
  const structured = !!row.base_rewrite_episode_id;
  const episodeId = row.base_rewrite_episode_id ?? legacyEpisodeId(row.id, row.base_rewritten_at);
  return {
    coverage: structured ? [] : [{ source: "base_rewrite", taskId: row.id, state: "partial", reason: "legacy_provenance" }],
    attention: [
      {
        id: sourceId("base_rewrite", [row.id, episodeId]),
        sourceRevision: episodeId,
        kind: "base_rewrite",
        firstOccurredAt: row.base_rewritten_at,
        actionable: true,
        title: "Base branch was rewritten",
        action: "repair_base",
        destination: dest(row, { sessionId: sessionRowId(row.id, row.generation), messageId: row.base_rewrite_message_id, surface: "base_sync" }),
        freshness: FRESH(now),
        snoozedUntil: snoozeOf(row, now),
        recoveryActionId: null,
        inlineDecision: null,
      },
    ],
  };
}

function turnFailureItem(row: WorkCenterTaskRow, now: Ms): Attention[] {
  if (!row.latest_turn_id || !resultNeedsAttention(row)) return [];
  const code = row.latest_turn_failure_code;
  const title =
    code === "context_limit" ? "Context limit reached" : code === "auth" ? "Agent login needs reconnecting" : code === "approval" ? "Approval policy blocked the turn" : "Turn failed";
  return [
    {
      id: sourceId("turn_failure", [row.id, row.latest_turn_id]),
      sourceRevision: row.latest_turn_id,
      kind: "turn_failure",
      firstOccurredAt: row.latest_turn_ended_at ?? now,
      actionable: true,
      title,
      action: "recover_turn",
      destination: dest(row, { sessionId: row.latest_turn_session_id, messageId: row.latest_turn_terminal_message_id, surface: "transcript" }),
      freshness: FRESH(now),
      snoozedUntil: snoozeOf(row, now),
      recoveryActionId: null,
      inlineDecision: null,
    },
  ];
}

// ---- assembly ------------------------------------------------------------

function workRow(row: WorkCenterTaskRow, execution: Execution, attention: Attention[], now: Ms): WorkRow {
  return {
    taskId: row.id,
    projectId: row.project_id,
    title: row.title,
    projectName: row.project_name,
    lifecycle: row.status,
    execution,
    attention: attention.sort((a, b) => a.firstOccurredAt - b.firstOccurredAt || (a.id < b.id ? -1 : 1)),
    latestResult: null,
    snoozedUntil: snoozeOf(row, now),
  };
}

function assembleOnce(opts: SnapshotOptions, now: Ms): Snapshot {
  const projectId = opts.projectId ?? null;
  const includeDeprecated = !!opts.includeDeprecated;
  const projects = listProjectsForWorkCenter();
  if (projectId) {
    const p = projects.find((x) => x.id === projectId);
    if (!p) throw new ScopeError("unknown_project");
    if (p.deprecated && !includeDeprecated) throw new ScopeError("invalid_scope");
  }
  const inScopeProject = (id: string, deprecated: number) => (projectId ? id === projectId : includeDeprecated || !deprecated);

  const all = listWorkCenterTaskRows();
  const rows = new Map(all.map((r) => [r.id, r]));
  const scoped = all.filter((r) => inScopeProject(r.project_id, r.project_deprecated));

  // ---- attention, by source
  const items = new Map<string, Attention[]>();
  const coverage: Coverage[] = [];
  const add = (taskId: string, list: Attention[]) => {
    if (!list.length) return;
    const cur = items.get(taskId) ?? [];
    cur.push(...list);
    items.set(taskId, cur);
  };

  const live = liveRequests(rows, now);
  for (const a of live.attention) add(a.destination.taskId, [a]);

  const edits = listOutstandingAgentEdits();
  for (const e of edits) {
    const row = rows.get(e.task_id);
    if (!row) continue;
    add(row.id, [
      {
        id: sourceId("agent_edit", [row.id, e.id]),
        sourceRevision: e.id,
        kind: "agent_edit",
        firstOccurredAt: e.created_at,
        actionable: true,
        title: `Changed by ${e.actor_title || "another task"}`.slice(0, 200),
        action: "acknowledge_or_revert",
        destination: dest(row, { surface: "agent_edits" }),
        freshness: FRESH(now),
        snoozedUntil: snoozeOf(row, now),
        recoveryActionId: null,
        inlineDecision: null,
      },
    ]);
  }

  const pending = new Map<string, number>();
  const pendingCount = (id: string) => {
    if (!pending.has(id)) pending.set(id, listPendingMessages(id).length);
    return pending.get(id)!;
  };
  for (const row of scoped) {
    const ci = ciItems(row, now, row.ci_recovery_episode_id ? pendingCount(row.id) > 0 : false);
    add(row.id, ci.attention);
    coverage.push(...ci.coverage);
    const br = baseRewriteItem(row, now);
    add(row.id, br.attention);
    coverage.push(...br.coverage);
    add(row.id, turnFailureItem(row, now));
  }

  // The local adapters are always readable; their coverage is complete.
  for (const source of ["question", "permission", "settings_proposal", "agent_edit", "turn_failure"] as const) {
    coverage.push({ source, taskId: null, state: "complete", reason: null });
  }
  for (const a of reviewAttention(rows, now)) add(a.destination.taskId, [a]);
  coverage.push({ source: "review", taskId: null, state: "complete", reason: null });

  // ---- execution and rows
  const liveIds = new Set(activeTurnIds());
  const executions = new Map<string, Execution>();
  const candidates: WorkCenterTaskRow[] = [];
  for (const row of scoped) {
    const operational =
      row.status === "in_progress" ||
      row.status === "on_hold" ||
      liveIds.has(row.id) ||
      items.has(row.id) ||
      (row.status === "not_started" && (row.start_at > 0 || pendingCount(row.id) > 0));
    if (!operational && row.status !== "not_started") continue;
    const ex = executionOf(row.id);
    if (!ex) continue;
    executions.set(row.id, ex);
    const blocked = ex.blockerTaskIds.length > 0 && row.status === "not_started";
    if (operational || blocked) candidates.push(row);
  }
  coverage.push({
    source: "execution",
    taskId: null,
    state: [...executions.values()].some((e) => e.waitingReasons.includes("detail_unavailable")) ? "partial" : "complete",
    reason: null,
  });

  // ---- summaries
  const unavailable = coverage.filter((c) => c.state === "unavailable" && c.source !== "execution");
  const suggested = suggestedCountsByProject();
  const tally = (r: WorkCenterTaskRow): TaskTally => {
    const ex = executions.get(r.id);
    const live = liveIds.has(r.id);
    return {
      taskId: r.id,
      items: items.get(r.id)?.length ?? 0,
      snoozed: !!snoozeOf(r, now),
      working: !!ex?.isWorking,
      // A live session that might be doing work nobody can observe.
      workUnknown: live && !!ex && !ex.isWorking && ex.backgroundCoverage === "unavailable" && ex.foreground !== "executing",
    };
  };
  const tallies = scoped.map((r) => ({ row: r, t: tally(r) }));
  const globalSummary: Summary = summarize(
    tallies.map((x) => x.t),
    { attentionComplete: unavailable.length === 0 },
    projects.filter((p) => inScopeProject(p.id, p.deprecated)).reduce((n, p) => n + (suggested.get(p.id) ?? 0), 0)
  );
  const projectSummaries = projects
    .filter((p) => inScopeProject(p.id, p.deprecated))
    .map((p) => ({
      projectId: p.id,
      summary: summarize(
        tallies.filter((x) => x.row.project_id === p.id).map((x) => x.t),
        { attentionComplete: !unavailable.some((c) => c.taskId === null || rows.get(c.taskId)?.project_id === p.id) },
        suggested.get(p.id) ?? 0
      ),
    }));

  // Snoozed tasks leave the lists; their unresolved items stay in the unsubtracted counts.
  const visible = candidates.filter((r) => !snoozeOf(r, now));
  const taskRows = visible.map((r) => workRow(r, executions.get(r.id)!, items.get(r.id) ?? [], now));

  let recent;
  try {
    recent = recentResults({ now, projectId, cursor: opts.recentCursor ?? null, limit: opts.recentLimit });
  } catch (e) {
    if (e instanceof RecentCursorError) throw new ScopeError("invalid_cursor");
    throw e;
  }
  const recentRows: WorkRow[] = [];
  for (const r of recent.rows) {
    const row = rows.get(r.taskId);
    if (!row || !inScopeProject(row.project_id, row.project_deprecated) || snoozeOf(row, now)) continue;
    const ex = executions.get(row.id) ?? executionOf(row.id);
    if (!ex) continue;
    const w = workRow(row, ex, items.get(row.id) ?? [], now);
    w.latestResult = r.result;
    recentRows.push(w);
  }
  // A row on both lists carries its result on the operational one too.
  for (const w of taskRows) {
    const r = recent.rows.find((x) => x.taskId === w.taskId);
    if (r) w.latestResult = r.result;
  }

  return {
    version: 1,
    instanceId: workCenterInstanceId(),
    instanceEpoch: workCenterEpoch(),
    sequence: workCenterSequence(),
    generatedAt: now,
    scope: { projectId, includeDeprecated },
    freshness: FRESH(now),
    coverage,
    summary: globalSummary,
    projects: projectSummaries,
    tasks: taskRows,
    recentlyFinished: { rows: recentRows, nextCursor: recent.nextCursor },
  };
}

/** The Work Center snapshot, read at a stable sequence or not at all. */
export function assembleSnapshot(opts: SnapshotOptions = {}): Snapshot {
  ensureWorkCenterBridge();
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = workCenterSequence();
    const now = opts.now ?? Date.now();
    const snap = assembleOnce(opts, now);
    opts.onRead?.(attempt);
    if (workCenterSequence() === before) return { ...snap, sequence: before };
  }
  throw new SnapshotBusy();
}
