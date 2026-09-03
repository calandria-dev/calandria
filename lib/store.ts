import { serializeAgentEnv, taskProvider, type ProviderKind } from "./agentEnv";
import { gatewayContextWindow } from "./gatewayModels";
import { nanoid } from "nanoid";
import { getDb } from "./db";
// Capability data comes from the SDK-free lib/agents/capabilities.ts, NOT the
// driver registry — importing the registry here would drag the agent SDKs
// (async Turbopack externals) into every module that touches the store and
// break sync route entries at runtime (see the note in that file).
import { modelContextWindow } from "./agents/capabilities";
import { SERVICE_PORT_BASE } from "./config";
import type { Project, Task, Tag, Message, PendingMessage, TaskComment, TaskDocComment, Summary, Session, Priority, Status, MsgRole, LedgerUsage, UsageTotals, PermissionRule, PermissionMatchKind, AgentEditChange, TaskAgentEdit, SettingsSnapshot } from "./types";
import { isLandingMode, type LandingMode } from "./types";
export { addInternalUsage, type InternalJob } from "./internalUsage";

// ---------- projects ----------

// The single "needs you" predicate (over tasks aliased `t`), which a real task
// satisfies two ways.
//
// PARKED: in progress, flagged awaiting_input. Deliberately NO running
// condition — a turn parked mid-stream on an AskUserQuestion has running=1 AND
// awaiting_input=1 and needs the user exactly as much as a settled one (the
// client-side isAwaiting in app/shell/format.ts makes the same call).
//
// RED PR: an open PR whose check rollup is failing. Nothing is parked here —
// the turn ended, often successfully, and the task may already be marked done —
// but a broken PR is work only a human can route, and .github/CLAUDE.md's "a
// push isn't done until its CI runs conclude" was pure policy until this line:
// it asked every session to remember to watch Actions, and main once sat red
// for nine hours because they all verified locally instead. Riding THIS
// predicate rather than inventing a second notifier is the point — one pill,
// one dropdown, one project badge, one snooze.
//
// `done` counts, `on_hold` and `cancelled` don't. A finished task with a red PR
// is the exact case that went unnoticed, so excluding it would leave the hole
// this closes; a held or cancelled one has already been answered by a human
// deciding not to pursue it.
//
// Shared by listProjects' awaiting_count subquery, listNeedsYou, and
// countAwaiting so the project badges, the titlebar "N need you" pill, and its
// dropdown can never disagree.
// A snooze deadline still ahead of us hides the task from every attention
// surface — a task you parked until Tuesday must stop asking until Tuesday, or
// snoozing the thing that keeps nagging you achieves nothing. Evaluated against
// SQLITE'S OWN CLOCK rather than a bound Date.now(), so all three callers share
// one `now` no matter how their parameters are ordered; second precision is
// ample for a feature whose shortest offered deadline is an hour.
//
// The consequence to know about: a deadline passing writes nothing, so a count
// taken before it and not recomputed will under-report until the next event on
// the bus. The client closes that by refetching when its own wake timer fires
// (app/shell/snooze.ts nextWake) — the same refetch a task_edited does.
const NOT_SNOOZED = "(t.snoozed_until = 0 OR t.snoozed_until <= CAST(strftime('%s','now') AS INTEGER) * 1000)";
const AWAITING_ARM = "(t.status = 'in_progress' AND t.awaiting_input = 1)";
// pr_state = 'open' is load-bearing, not decoration: a merged or closed PR is
// never re-polled (stalePrTasks), so its last-seen 'failing' would otherwise sit
// in the pill forever with nothing left that could ever clear it.
const PR_RED_ARM = "(t.pr_state = 'open' AND t.pr_checks = 'failing' AND t.status IN ('in_progress', 'done'))";
const NEEDS_YOU = `t.suggested = 0 AND (${AWAITING_ARM} OR ${PR_RED_ARM}) AND ${NOT_SNOOZED}`;

export function listProjects(): (Project & { task_count: number; last_activity: number; awaiting_count: number; cost_usd: number; unpriced_turns: number })[] {
  return getDb()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.suggested = 0) AS task_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${NEEDS_YOU}) AS awaiting_count,
         COALESCE((SELECT SUM(u.cost_usd) FROM task_usage u WHERE u.project_id = p.id), 0) AS cost_usd,
         COALESCE((SELECT SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) FROM task_usage u WHERE u.project_id = p.id), 0) AS unpriced_turns,
         (SELECT MAX(ts) FROM (
            SELECT MAX(updated_at) AS ts FROM tasks WHERE project_id = p.id
            UNION ALL SELECT MAX(started_at) FROM sessions WHERE project_id = p.id
            UNION ALL SELECT MAX(ended_at) FROM sessions WHERE project_id = p.id
            UNION ALL SELECT MAX(m.created_at) FROM messages m
              JOIN tasks t ON t.id = m.task_id WHERE t.project_id = p.id
          )) AS last_activity
       FROM projects p ORDER BY p.position ASC, p.created_at ASC`
    )
    .all() as (Project & { task_count: number; last_activity: number; awaiting_count: number; cost_usd: number; unpriced_turns: number })[];
}

// Every project row in sidebar order, WITHOUT listProjects' per-project
// aggregate subqueries. The agent-facing project tools (lib/agentTools.ts) only
// need id/name/repo_path to let a session name a target project, and they run
// on the turn's hot path — counting tasks and summing usage for each project to
// answer "which project is called X" is pure waste.
export function listProjectsPlain(): Project[] {
  return getDb().prepare("SELECT * FROM projects ORDER BY position ASC, created_at ASC").all() as Project[];
}

export function getProject(id: string): Project | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}

// The ids of every task with a live turn streaming right now, fleet-wide. The
// client only holds the selected project's tasks, so a turn finishing in a
// project the user has navigated away from is never learned through that
// project's event stream (none is open) nor its task fetch (never refetched) —
// its spinner would stick forever, pinning the client's 10s running-poll on. The
// running-set poller reconciles against this authoritative list so stale
// spinners clear and the poll backs off once nothing is actually running.
export function listRunningTaskIds(): string[] {
  return (
    getDb().prepare("SELECT id FROM tasks WHERE suggested = 0 AND running = 1").all() as { id: string }[]
  ).map((r) => r.id);
}

// Every task across all active projects that's waiting on the user (the shared
// NEEDS_YOU predicate, both arms) — the rows behind the titlebar "N need you"
// dropdown. `waiting_since` is when Claude last spoke (its final message of the
// paused turn), falling back to the task's updated_at when a task is awaiting
// with no messages yet. Longest-waiting first, so the most-stale task sits at
// the top of the list.
//
// `reason` says WHICH arm put the row here, because the two need different
// sublines: "waiting for 3 hours" is true of a parked turn and a lie about a
// red PR, whose age we don't store (only when we last ASKED GitHub). A CI row
// names its PR instead. Derived from the same expression the predicate uses, so
// a row can't claim an arm it didn't match.
export function listNeedsYou(): {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
  reason: "input" | "ci";
  pr_number: number;
  pr_url: string;
}[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.title,
         p.name AS project_name, p.color AS project_color, p.icon AS project_icon,
         COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.task_id = t.id), t.updated_at) AS waiting_since,
         CASE WHEN ${AWAITING_ARM} THEN 'input' ELSE 'ci' END AS reason,
         t.pr_number, t.pr_url
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE ${NEEDS_YOU} AND p.deprecated = 0
       ORDER BY waiting_since ASC`
    )
    .all() as ReturnType<typeof listNeedsYou>;
}

// One project's awaiting count (the shared NEEDS_YOU predicate, same as
// listProjects' awaiting_count subquery and listNeedsYou's rows) — recomputed
// per lifecycle event for the global /api/events stream so clients can patch
// the project badge without refetching the project list.
export function countAwaiting(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND ${NEEDS_YOU}`)
    .get(projectId) as { n: number };
  return row.n;
}

// Is this ONE task parked on the user's input right now? The AWAITING arm of
// the pill's predicate asked of a single row, plus the deprecated-project join
// listNeedsYou applies, since a project the user has archived should not buzz
// their phone.
//
// The notification emitter screens through this rather than trusting the event
// that woke it: a snoozed task, an unreviewed suggestion, and an ask that
// auto-denied on an unattended turn all publish the same "your turn" event,
// and none of them is a reason to interrupt anybody.
//
// Deliberately the ARM, not the whole NEEDS_YOU predicate. The emitter behind
// it delivers a toast that says "Waiting for input", and the dispatcher calls
// it on EVERY turn end and lets this row-read decide — so under the full
// predicate a turn that ended cleanly on a task whose PR happens to be red
// would announce a question nobody asked. A red PR belongs in the pill, the
// dropdown and the board (which all use NEEDS_YOU); whether it should also
// push a notification is a separate decision with its own wording, and this is
// not the place to make it by accident.
export function taskAwaitingInput(id: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND p.deprecated = 0 AND t.suggested = 0 AND ${AWAITING_ARM} AND ${NOT_SNOOZED}`
    )
    .get(id);
  return !!row;
}

// Lightweight rows for the ⌘K command palette's session search: every real task
// across all active projects, plus just enough of its project to label it. The
// client only holds the selected project's tasks, so the palette fetches this
// fresh each open. Recency order so the empty-query state surfaces what you
// touched last.
export function listAllTasksLite(): {
  id: string;
  project_id: string;
  title: string;
  status: string;
  running: number;
  awaiting_input: number;
  updated_at: number;
  project_name: string;
  project_color: string;
  project_icon: string;
  /** The tags it carries, for the palette's badges — name + tint, in tag order. */
  tags: { name: string; color: string | null }[];
}[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.id, t.project_id, t.title, t.status, t.running, t.awaiting_input, t.updated_at,
         p.name AS project_name, p.color AS project_color, p.icon AS project_icon
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.suggested = 0 AND p.deprecated = 0
       ORDER BY t.updated_at DESC`
    )
    .all() as Omit<ReturnType<typeof listAllTasksLite>[number], "tags">[];
  // The badges in one more query rather than a correlated one per row — the
  // same shape listTasks attaches `depends_on` with, and for the same reason:
  // GROUP_CONCAT would have to guess at ordering, and this keeps tag order
  // (task_tags.position) exactly as the task carries it.
  const pairs = db
    .prepare(
      `SELECT tt.task_id, g.name, g.color FROM task_tags tt
         JOIN tags g ON g.id = tt.tag_id
         JOIN tasks t ON t.id = tt.task_id
        WHERE t.suggested = 0
        ORDER BY tt.position ASC, tt.created_at ASC`
    )
    .all() as { task_id: string; name: string; color: string | null }[];
  const byTask = new Map<string, { name: string; color: string | null }[]>();
  for (const p of pairs) {
    const list = byTask.get(p.task_id);
    if (list) list.push({ name: p.name, color: p.color });
    else byTask.set(p.task_id, [{ name: p.name, color: p.color }]);
  }
  return rows.map((r) => ({ ...r, tags: byTask.get(r.id) ?? [] }));
}

export function createProject(input: {
  name: string;
  icon?: string;
  sub?: string;
  color?: string;
  context?: string;
  repo_path?: string;
  branch?: string;
  landing_mode?: LandingMode;
}): Project {
  const now = Date.now();
  const id = nanoid();
  const icon = (input.icon || input.name.charAt(0) || "?").toUpperCase().slice(0, 1);
  // New projects sort to the bottom of the sidebar.
  const position = (getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM projects").get() as { n: number }).n;
  // New projects inherit the app-level default agent (Settings → Run defaults);
  // per-project it can then be changed in the Context editor.
  const defaultAgent = getSetting("default_agent") || "claude";
  // The branch default is `|| "main"` rather than `?? "main"` for updateProject's
  // reason: a blank projects.branch is where resolveBaseBranch's last leg lands,
  // and branchExists answers false for it before running any git, so every task
  // in the project shows the sync banner naming no branch at all. `??` defaults
  // null and undefined and nothing else, so a create body that spells the field
  // out as "" wrote exactly the blank the update path now refuses.
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, landing_mode, default_agent, port, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.name, icon, input.sub ?? "", input.color ?? "#C2603C", input.context ?? "", input.repo_path ?? "", input.branch?.trim() || "main", isLandingMode(input.landing_mode) ? input.landing_mode : "merge", defaultAgent, nextServicePort(), position, now);
  return getProject(id)!;
}

// The next deterministic per-project port: one past the current max (never
// reusing a freed slot, so a project's port is stable for its lifetime), floored
// at SERVICE_PORT_BASE. Injected as PORT into the project's services + PTY.
export function nextServicePort(): number {
  const maxRow = getDb().prepare("SELECT COALESCE(MAX(port), 0) AS n FROM projects").get() as { n: number };
  return Math.max(maxRow.n, SERVICE_PORT_BASE - 1) + 1;
}

// Persist a new sidebar order. `ids` is the full list of project ids in the
// desired order; each project's position is set to its index.
export function reorderProjects(ids: string[]) {
  const db = getDb();
  const stmt = db.prepare("UPDATE projects SET position = ? WHERE id = ?");
  db.transaction((list: string[]) => list.forEach((id, i) => stmt.run(i, id)))(ids);
}

export function deleteProject(id: string) {
  // Cascades to the project's tasks, messages and summaries (FK ON DELETE CASCADE).
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function updateProject(id: string, patch: Partial<Omit<Project, "id" | "created_at">>): Project | undefined {
  const cur = getProject(id);
  if (!cur) return undefined;
  const n = { ...cur, ...patch };
  // branch is normalized like landing_mode below: a blank patch (missing base
  // branch field, or one cleared to "" / whitespace in Settings) keeps the
  // CURRENT branch rather than saving emptiness. An empty projects.branch
  // makes resolveBaseBranch fall through to "", and every task then shows
  // "isn't a branch in this repository" with a blank name.
  const branch = n.branch.trim() || cur.branch;
  getDb()
    .prepare(
      `UPDATE projects SET name = ?, icon = ?, sub = ?, color = ?, context = ?, repo_path = ?, branch = ?, landing_mode = ?,
        auto_reclaim = ?, dev_command = ?, setup_command = ?, test_command = ?, default_agent = ?, send_context = ?, deprecated = ?, agent_env = ?,
        gateway_max_budget = ?, gateway_key_duration = ? WHERE id = ?`
    )
    // landing_mode is normalized rather than trusted: the column has no CHECK
    // behind it and this is reached straight from PATCH /api/projects/[id].
    .run(n.name, (n.icon || "?").toUpperCase().slice(0, 1), n.sub, n.color, n.context, n.repo_path, branch, isLandingMode(n.landing_mode) ? n.landing_mode : "merge", n.auto_reclaim ? 1 : 0, n.dev_command ?? "", n.setup_command ?? "", n.test_command ?? "", n.default_agent || "claude", n.send_context ? 1 : 0, n.deprecated ? 1 : 0,
      // agent_env is normalized, not trusted, for the same reason: the allowlist
      // in lib/agentEnv.ts is enforced HERE, so nothing unlisted reaches the DB
      // whatever a PATCH body (object or JSON text) carried.
      serializeAgentEnv(n.agent_env),
      // A budget of 0 is a legitimate (if pointless) cap, so only null/undefined
      // clear it — matching gateway_max_budget's own null-is-unlimited contract.
      n.gateway_max_budget ?? null, n.gateway_key_duration?.trim() ?? "", id);
  return getProject(id);
}

// Persist "Refresh with AI" job state in isolation. Deliberately separate from
// updateProject (whose fixed column list must NOT touch refresh_* state) so a
// background draft and a concurrent project edit can't clobber each other.
export function setProjectRefresh(
  id: string,
  fields: Partial<Pick<Project, "refresh_status" | "refresh_draft" | "refresh_error" | "refresh_started_at">>,
): Project | undefined {
  const cur = getProject(id);
  if (!cur) return undefined;
  const n = { ...cur, ...fields };
  getDb()
    .prepare(
      `UPDATE projects SET refresh_status = ?, refresh_draft = ?, refresh_error = ?, refresh_started_at = ? WHERE id = ?`
    )
    .run(n.refresh_status, n.refresh_draft, n.refresh_error, n.refresh_started_at, id);
  return getProject(id);
}

// ---------- tasks ----------

// Tasks carry their cumulative spend (cost_usd + total_tokens, summed across all
// turns of every generation) so the chat header can show it without an extra
// call. The two cache buckets ride along because `total_tokens` on its own is
// misleading: in real sessions most of it is prompt-cache READS (context re-sent
// every turn, billed at ~10% of the input rate), so the UI splits the total into
// fresh work vs cached re-reads rather than showing one scary number.
// `context_tokens`/`context_pct` are the LIVE context-window gauge — the
// agent's own report of the latest request's context size, NOT a cumulative
// sum, with `context_estimated` flagging the rows where it's only derived from
// a usage report (see getTaskContext for both).
// `depends_on` lists the task ids this task is blocked by (see task_dependencies);
// `tag_ids` the tags it carries, in tag order (see task_tags).
export type TaskWithUsage = Task & {
  cost_usd: number;
  /** Turns whose endpoint had no price to record, so `cost_usd` is the sum over
   *  the others — a floor, not the whole figure. See LedgerUsage. */
  unpriced_turns: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  subagent_tokens: number;
  context_tokens: number;
  context_window: number;
  context_pct: number;
  context_estimated: boolean;
  depends_on: string[];
  tag_ids: string[];
};

// The two halves of the context gauge as SQL, shared by listTasks (aliased on
// `t`) and getTaskContext. The measured column wins; the fallback is the
// CURRENT generation's latest usage row, input side only — a row from a
// previous generation describes a window /clear already threw away, which is
// why the gauge reads 0 right after a clear rather than the old figure.
// `context_estimated` is 1 only when that fallback actually produced a number:
// a task that has never run has an exact 0, nothing to hedge.
const CONTEXT_FALLBACK_SQL = (t: string) =>
  `(SELECT u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens
      FROM task_usage u WHERE u.task_id = ${t}.id AND u.generation = ${t}.generation
     ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1)`;
const CONTEXT_TOKENS_SQL = (t: string) => `COALESCE(${t}.context_measured, ${CONTEXT_FALLBACK_SQL(t)}, 0)`;
const CONTEXT_ESTIMATED_SQL = (t: string) =>
  `CASE WHEN ${t}.context_measured IS NULL AND ${CONTEXT_FALLBACK_SQL(t)} IS NOT NULL THEN 1 ELSE 0 END`;

/**
 * One project's tasks, MOST RECENTLY ACTIVE FIRST — `updated_at DESC`, with
 * `created_at` then `rowid` breaking the ties two writes in the same
 * millisecond produce (so a fresh task still lands above its same-tick
 * siblings). Every bucket the UI partitions this into inherits that order, the
 * Suggested tray included: the top card is always the newest thing that
 * happened, which is what makes a long backlog readable without scrolling.
 *
 * Deliberately NOT `position` — the manual board order that used to lead this
 * sort. The two can't both be the default, and recency won: a task you just
 * worked on has to come back to the top on its own, without being dragged
 * there. `tasks.position` survives as a stable creation sequence (moveTasks
 * renumbers it per destination) but nothing renders it any more.
 */
export function listTasks(projectId: string): TaskWithUsage[] {
  const db = getDb();
  // One read for the whole list: the provider override a row inherits is the
  // project's, with only the task's own agent_env laid over it per row. Rows
  // where NEITHER carries one skip the describe entirely — that is almost every
  // row on almost every instance, and this runs on every task-list load.
  const project = getProject(projectId);
  const anyOverride = !!project?.agent_env;
  const rows = db
    .prepare(
      `SELECT t.*,
         COALESCE((SELECT SUM(u.cost_usd) FROM task_usage u WHERE u.task_id = t.id), 0) AS cost_usd,
         COALESCE((SELECT SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) FROM task_usage u WHERE u.task_id = t.id), 0) AS unpriced_turns,
         COALESCE((SELECT SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens)
                   FROM task_usage u WHERE u.task_id = t.id), 0) AS total_tokens,
         COALESCE((SELECT SUM(u.cache_read_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS cache_read_tokens,
         COALESCE((SELECT SUM(u.cache_creation_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS cache_creation_tokens,
         COALESCE((SELECT SUM(u.subagent_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS subagent_tokens,
         ${CONTEXT_TOKENS_SQL("t")} AS context_tokens,
         ${CONTEXT_ESTIMATED_SQL("t")} AS context_estimated
       FROM tasks t WHERE t.project_id = ?
       ORDER BY t.suggested ASC, t.updated_at DESC, t.created_at DESC, t.rowid DESC`
    )
    .all(projectId) as (Task & {
    cost_usd: number;
    unpriced_turns: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    subagent_tokens: number;
    context_tokens: number;
    context_estimated: number;
  })[];
  // Attach each task's dependency edges in one query (project-scoped via join).
  const edges = db
    .prepare(
      `SELECT td.task_id, td.depends_on_id FROM task_dependencies td
       JOIN tasks t ON t.id = td.task_id WHERE t.project_id = ?`
    )
    .all(projectId) as { task_id: string; depends_on_id: string }[];
  const byTask = new Map<string, string[]>();
  for (const e of edges) {
    const list = byTask.get(e.task_id);
    if (list) list.push(e.depends_on_id);
    else byTask.set(e.task_id, [e.depends_on_id]);
  }
  // Tag membership the same way, in tag order — one query for the project, not
  // one per row. This is what the chips filter on and what every badge renders.
  const memberships = db
    .prepare(
      `SELECT tt.task_id, tt.tag_id FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id WHERE t.project_id = ?
        ORDER BY tt.position ASC, tt.created_at ASC`
    )
    .all(projectId) as { task_id: string; tag_id: string }[];
  const tagsByTask = new Map<string, string[]>();
  for (const m of memberships) {
    const list = tagsByTask.get(m.task_id);
    if (list) list.push(m.tag_id);
    else tagsByTask.set(m.task_id, [m.tag_id]);
  }
  return rows.map((r) => {
    redactGatewayKey(r);
    const kind = (anyOverride || !!r.agent_env) ? taskProvider(project, r).kind : "cloud";
    const window = taskContextWindow(r.agent, r.model, kind);
    return {
      ...r,
      context_window: window,
      context_pct: contextPct(r.context_tokens, window),
      context_estimated: r.context_estimated === 1,
      depends_on: byTask.get(r.id) ?? [],
      tag_ids: tagsByTask.get(r.id) ?? [],
    };
  });
}

// The task ids a given task is blocked by.
export function getTaskDeps(taskId: string): string[] {
  return (
    getDb().prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?").all(taskId) as {
      depends_on_id: string;
    }[]
  ).map((r) => r.depends_on_id);
}

// Tasks that opted into auto-start and are blocked by the given task: the
// candidates to launch when it's marked done (lib/autoStart.ts re-checks each
// one's OTHER blockers before starting it). Deliberately narrow — only a
// never-started, non-suggested, plain not_started task may auto-start; on_hold
// means the user parked it, and a suggestion hasn't been reviewed yet.
export function listAutoStartCandidates(dependsOnId: string): Task[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM tasks t JOIN task_dependencies td ON td.task_id = t.id
       WHERE td.depends_on_id = ? AND t.auto_start = 1 AND t.started = 0
         AND t.suggested = 0 AND t.status = 'not_started'`
    )
    .all(dependsOnId) as Task[];
}

// Tasks whose queued start has come due (lib/deferredStart.ts sweeps this on a
// timer). Oldest deadline first, so tasks queued for the same reset launch in
// the order they were queued. Deliberately does NOT read `running`: turn
// liveness belongs to the abort registry (the row's flag can be stale after a
// crash), so the sweep asks hasTurn() itself. Terminal and tray rows are out —
// a done or cancelled task has nothing to start, and a suggestion hasn't been
// accepted yet — while every other status is in: the user queued it, so
// on_hold (which auto-start refuses) is theirs to override here.
export function listDueDeferredStarts(now: number): Task[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM tasks t
       WHERE t.start_at > 0 AND t.start_at <= ? AND t.suggested = 0
         AND t.status NOT IN ('done', 'cancelled')
       ORDER BY t.start_at ASC, t.rowid ASC`
    )
    .all(now) as Task[];
}

/**
 * Same dependency set, order-insensitively — edges have no order, so a caller
 * that resubmits the stored list in a different order hasn't changed anything.
 * Shared by the two writers that have to tell a real edit from a resubmission:
 * PATCH /api/tasks/[id] (the edit dialog posts every field, touched or not) and
 * update_task (which must not report a change it didn't make).
 */
export function sameDepSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

// Replace a task's dependency set. Drops self-references and ids outside the
// task's project, then guards against cycles before persisting. Throws on a cycle.
export function setTaskDeps(taskId: string, dependsOn: string[]): void {
  const db = getDb();
  const task = getTask(taskId);
  if (!task) throw new Error("task not found");
  const wanted = [...new Set(dependsOn)].filter((id) => id && id !== taskId);
  const valid = wanted.filter((id) => {
    const t = getTask(id);
    return !!t && t.project_id === task.project_id;
  });
  // Cycle guard: build the would-be graph (taskId's edges replaced by `valid`)
  // and confirm taskId can't reach itself by following depends_on edges.
  const edges = db.prepare("SELECT task_id, depends_on_id FROM task_dependencies").all() as {
    task_id: string;
    depends_on_id: string;
  }[];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.task_id === taskId) continue; // replacing taskId's edges with `valid`
    const list = adj.get(e.task_id);
    if (list) list.push(e.depends_on_id);
    else adj.set(e.task_id, [e.depends_on_id]);
  }
  adj.set(taskId, valid);
  const seen = new Set<string>();
  const stack = [...valid];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) throw new Error("dependency cycle");
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) stack.push(n);
  }
  const now = Date.now();
  db.transaction(() => {
    db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const ins = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)");
    for (const id of valid) ins.run(taskId, id, now);
  })();
}

// ---------- agent-edit audit trail (task_agent_edits) ----------
//
// The record behind the "changed since you accepted it" chip: one row per
// update_task write that used to be refused by the old ownership gate and now
// goes through instead (lib/agentTools.ts updateTaskForAgent). The chip is
// `tasks.agent_edited_at` — reverting the LAST outstanding edit clears it,
// acknowledging (POST .../agent-edits { action: "ack" }) clears it WITHOUT
// touching history, so the audit trail always outlives the chip.

/** Record one agent edit and (re-)raise the target task's chip. One transaction. */
export function recordAgentEdit(input: {
  task_id: string;
  project_id: string;
  actor_task_id: string;
  actor_title: string;
  actor_agent: string;
  changes: AgentEditChange[];
}): TaskAgentEdit {
  const db = getDb();
  const id = nanoid();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO task_agent_edits (id, task_id, project_id, actor_task_id, actor_title, actor_agent, changes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.task_id, input.project_id, input.actor_task_id, input.actor_title, input.actor_agent, JSON.stringify(input.changes), now);
    db.prepare("UPDATE tasks SET agent_edited_at = ? WHERE id = ?").run(now, input.task_id);
  })();
  return getAgentEdit(id)!;
}

function parseAgentEdit(r: Omit<TaskAgentEdit, "changes"> & { changes: string }): TaskAgentEdit {
  let changes: AgentEditChange[] = [];
  try {
    changes = JSON.parse(r.changes);
  } catch {
    // Tolerate a corrupt row rather than throwing the whole list/panel away —
    // an edit with no readable diff is still worth flagging as having happened.
  }
  return { ...r, changes };
}

/** An edit's history, newest first — what the diff panel renders. */
export function listAgentEdits(taskId: string): TaskAgentEdit[] {
  return (
    getDb().prepare("SELECT * FROM task_agent_edits WHERE task_id = ? ORDER BY created_at DESC, rowid DESC").all(taskId) as (Omit<
      TaskAgentEdit,
      "changes"
    > & { changes: string })[]
  ).map(parseAgentEdit);
}

export function getAgentEdit(id: string): TaskAgentEdit | undefined {
  const r = getDb().prepare("SELECT * FROM task_agent_edits WHERE id = ?").get(id) as (Omit<TaskAgentEdit, "changes"> & { changes: string }) | undefined;
  return r ? parseAgentEdit(r) : undefined;
}

export function markAgentEditReverted(id: string): void {
  getDb().prepare("UPDATE task_agent_edits SET reverted_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Any edit on this task still applied (not reverted) — what Revert re-checks before clearing the chip. */
/** True while some edit is neither reverted nor acknowledged — what keeps the chip up. */
export function hasOutstandingAgentEdits(taskId: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM task_agent_edits WHERE task_id = ? AND reverted_at = 0 AND acknowledged_at = 0 LIMIT 1").get(taskId);
}

/** Clear the chip without touching history — Ack, or the last outstanding edit reverted. */
export function clearAgentEditFlag(taskId: string): void {
  getDb().prepare("UPDATE tasks SET agent_edited_at = 0 WHERE id = ?").run(taskId);
}

/**
 * "Keep changes": stamp every outstanding edit acknowledged and drop the chip,
 * in one transaction. Stamping the ROWS is what lets a later Revert decide
 * whether anything is still outstanding — clearing only the task flag left
 * acked rows counting as outstanding forever.
 */
export function acknowledgeAgentEdits(taskId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE task_agent_edits SET acknowledged_at = ? WHERE task_id = ? AND reverted_at = 0 AND acknowledged_at = 0").run(Date.now(), taskId);
    db.prepare("UPDATE tasks SET agent_edited_at = 0 WHERE id = ?").run(taskId);
  })();
}

export function getTask(id: string): Task | undefined {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | (Task & { gateway_key_spend?: number })
    | undefined;
  return row && redactGatewayKey(row);
}

// Never let a task's minted LiteLLM key (or its spend baseline, an internal
// bookkeeping field with no reader outside lib/gatewayKeys.ts) leave this
// module through the general read path — every route that spreads a Task or
// TaskWithUsage into JSON goes through getTask() or listTasks(). The real
// value lives only where taskGatewayKeyState()/setTaskGatewayKey() read and
// write it (lib/runner.ts, lib/gatewayKeys.ts).
function redactGatewayKey<T extends { gateway_key: string; gateway_key_spend?: number }>(row: T): T {
  row.gateway_key = "";
  delete row.gateway_key_spend;
  return row;
}

/** Internal-only: a task's minted LiteLLM virtual key and the cumulative spend
 *  last reconciled against it (docs/design/litellm.md, "Per-task virtual
 *  keys"). `key` is "" when no key has been minted (per-task keys off, not a
 *  gateway task, or the mint failed and the turn fell back to the instance
 *  key). Never call this from a route that returns its result to the client —
 *  use getTask()/listTasks(), which always redact it. */
export function taskGatewayKeyState(id: string): { key: string; spend: number } | undefined {
  return getDb().prepare("SELECT gateway_key AS key, gateway_key_spend AS spend FROM tasks WHERE id = ?").get(id) as
    | { key: string; spend: number }
    | undefined;
}

/** Store a newly minted key (or "" to clear one on delete), resetting the
 *  spend baseline — a fresh key has spent nothing yet. No `updated_at` stamp,
 *  same reason as clearTaskWorktreePath: internal bookkeeping, not a
 *  user-visible edit that should reorder the board. */
export function setTaskGatewayKey(id: string, key: string): void {
  getDb().prepare("UPDATE tasks SET gateway_key = ?, gateway_key_spend = 0 WHERE id = ?").run(key, id);
}

/** Advance the spend baseline after a reconciliation (lib/gatewayKeys.ts) —
 *  the next one diffs against this. No `updated_at` stamp, same reason as
 *  setTaskGatewayKey. */
export function setTaskGatewayKeySpend(id: string, spend: number): void {
  getDb().prepare("UPDATE tasks SET gateway_key_spend = ? WHERE id = ?").run(spend, id);
}

export function createTask(input: {
  project_id: string;
  title: string;
  description?: string;
  priority?: Priority;
  suggested?: boolean;
  agent?: string;
  send_context?: boolean;
  /**
   * The task's run permission, settable at creation so a task that will run
   * UNATTENDED (auto-start, and later a schedule) can be pinned to a mode that
   * won't stop to ask. null/undefined keeps the inherit-the-default behavior
   * every other creation path relies on.
   */
  permission_mode?: string | null;
  /**
   * The model the task's sessions run on, settable at creation for the same
   * reason as permission_mode: the New-task dialog can start the first turn in
   * the same gesture, so a later PATCH would be too late. null/undefined keeps
   * the inherit-the-default behavior (agent's Settings default, then the CLI's).
   */
  model?: string | null;
  /** The schedule that minted this task (lib/scheduler.ts). null for hand-made tasks. */
  schedule_id?: string | null;
  /** The runbook that dispatched this task (lib/dispatch.ts). null for hand-made tasks. */
  runbook_id?: string | null;
  /** The tags it carries at birth (validated against the project by the caller). */
  tag_ids?: string[];
  /**
   * A provider override laid over the project's (lib/agentEnv.ts), settable at
   * creation because `suggest_task` is the path a frontier-model session uses
   * to delegate work to a local model, and the task's first turn may be an
   * auto-start with no PATCH in between. Object or JSON text; normalized here.
   */
  agent_env?: string | Record<string, string> | null;
}): Task {
  const now = Date.now();
  const id = nanoid();
  const project = getProject(input.project_id);
  // Which agent driver the task runs under: explicit choice, else the owning
  // project's default (see lib/agents/registry.ts for resolution).
  const agent = input.agent || project?.default_agent || "claude";
  // Whether sessions get the saved project context: explicit choice, else the
  // project's send_context setting (missing project ⇒ 1, the historic behavior).
  const sendContext = input.send_context ?? (project ? project.send_context !== 0 : true);
  // Next in the project's creation sequence. Not a render order any more —
  // listTasks sorts by recency — but a monotonic per-project counter the move
  // paths still renumber, and the only durable record of the order rows were
  // added in beyond `created_at`'s millisecond resolution.
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  getDb()
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, priority, status, suggested, agent, send_context, model, permission_mode, schedule_id, runbook_id, agent_env, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.title, input.description ?? "", input.priority ?? "med", input.suggested ? 1 : 0,
      agent, sendContext ? 1 : 0, input.model || null, input.permission_mode || null, input.schedule_id ?? null, input.runbook_id ?? null,
      serializeAgentEnv(input.agent_env), position, now, now
    );
  // Tags are a second write because they are a second table. setTaskTags does
  // the project check for us, so a caller that got the tags wrong fails here
  // with the row already created — deliberate: every creation path validates
  // its tags first (the routes and lib/agentTools.ts resolve them before the
  // insert), and a tag that vanished in between must not lose the task.
  if (input.tag_ids?.length) setTaskTags([id], input.tag_ids);
  return getTask(id)!;
}

// Why a task may not change projects right now — null when it may. A task with
// a worktree holds a checkout cut from its CURRENT project's repo: re-parenting
// the row would leave it diffing against one repository and merging into
// another. So a plain move is refused for started work.
// (`started`, `running` and the worktree columns are checked together — a task
// can be flagged started before its worktree exists, and a merged task keeps
// `started` after its worktree is reclaimed.)
//
// `resetCheckout` is the caller saying that checkout is being thrown away —
// lib/taskMove.ts tears the worktree down and this write clears the columns, so
// the next turn cuts a fresh one from the DESTINATION repo. The started-task
// reason then no longer applies; a LIVE turn still refuses either way, because
// nothing may delete a worktree an agent is writing into.
export function moveTaskBlockedReason(task: Task, opts: { resetCheckout?: boolean } = {}): string | null {
  if (task.running === 1) return "a task with a running turn can't be moved";
  if (opts.resetCheckout) return null;
  if (task.started === 1 || task.worktree_path || task.work_branch || task.base_sha)
    return "a started task can't be moved. Its git worktree belongs to the current project's repo";
  return null;
}

// What a move left behind, so the caller can tell the user (an edge whose other
// end stayed behind would span projects — see setTaskDeps — so it goes).
export interface TaskMove {
  task: Task;
  /** Tasks this one was blocked by. */
  dropped_blockers: string[];
  /** Tasks that were blocked by this one. */
  dropped_dependents: string[];
}

/** A blocked-by edge: `task_id` is blocked until `depends_on_id` is done. */
export interface TaskEdge {
  task_id: string;
  depends_on_id: string;
}

/** The outcome of moving a selection of tasks — see moveTasks. */
export interface TaskMoveBatch {
  /** Rows that changed project, in the order they were appended. */
  moved: Task[];
  /**
   * The distinct projects that LOST rows. Captured before the write — the moved
   * rows themselves only remember where they landed, and a tray that lost a task
   * has to hear about it too.
   */
  from_project_ids: string[];
  /** Ids already filed in the destination: nothing to do, and nothing to refuse. */
  unchanged: string[];
  /** Ids that couldn't move, each with the reason to show the user. */
  skipped: { id: string; reason: string }[];
  /** Edges severed because only one of their ends moved. */
  dropped: TaskEdge[];
  /** Edges that survived because both of their ends moved together. */
  kept: TaskEdge[];
  /**
   * Tags a moved row LOST, because some of that tag's members weren't coming.
   * One entry per (task, tag): a task carrying three tags can leave one behind
   * and keep two. The name travels with the report so the caller can say WHICH
   * label the task just lost rather than "a tag".
   */
  untagged: { id: string; tag_id: string; tag_name: string }[];
  /** Tags whose every member was in the selection, so the tag row moved too. */
  carried: MovedTag[];
}

/** A tag re-keyed to the destination project along with its whole membership. */
export interface MovedTag {
  id: string;
  /** Its name in the destination — suffixed when a tag there already had that name. */
  name: string;
  /** The name it arrived with, when the collision above renamed it; null otherwise. */
  renamed_from: string | null;
}

/**
 * Re-parent unstarted tasks to another project — the one path that changes
 * `project_id` after creation (a misfiled task used to mean delete + recreate,
 * losing its transcript). One transaction for the whole selection, so eleven
 * misfiled tasks are one write and one event rather than eleven of each.
 *
 * Throws only on the caller's own mistake (an unknown destination). A task that
 * can't move — missing, or past the point of no return per moveTaskBlockedReason
 * — is REPORTED in `skipped` rather than failing its eleven innocent neighbours;
 * one already in the destination is `unchanged`, which is not a refusal either.
 *
 * Dependency edges: an edge survives iff BOTH its ends are in the moving set.
 * Those land in the destination together, so they stay intra-project and the
 * invariant setTaskDeps enforces still holds — a whole chain moving together
 * keeps its shape. Every other edge touching a mover would end up spanning
 * projects, and nothing else revalidates them, so it goes. Locally decided per
 * edge on purpose: one skipped task mid-chain costs its own two edges, not the
 * whole component's.
 *
 * The tasks' own child rows (messages, summaries, uploads) are task-keyed, so
 * they simply come along. The project-keyed ones — sessions, task_usage,
 * task_merges — are re-pointed at the destination, unconditionally: a task's
 * sessions and its spend are the task's, and leaving them behind would bill the
 * old project for work its new owner did. (For an unstarted task there are no
 * such rows at all, which is why this used to be skipped — a started task
 * couldn't move. `resetCheckout` is what ended that.)
 *
 * `resetCheckout` moves a STARTED task by throwing its checkout away: the
 * caller (lib/taskMove.ts) has already removed the worktree and branch from the
 * old repo, and this clears every column that described them so the next turn
 * cuts a fresh worktree from the destination — see the `clearCheckout` statement
 * below for exactly what that covers and why.
 *
 * It's a SET of ids rather than a flag on the batch, because a checkout is
 * thrown away one at a time: each is a separate irreversible answer the user
 * gave about that task's worktree, and the two things the option does — waive
 * the started-task refusal, and clear the columns — must apply to exactly the
 * tasks that were answered for. As one flag over the batch, an unanswered
 * started task would move with its columns cleared and its worktree left
 * orphaned in the repo it came from, with nothing pointing at it.
 *
 * Liveness is NOT checked here: a turn can be in flight with the row still
 * reading running=0 (POST /messages claims the abort slot before it locks), so
 * the caller screens for that under the task locks — see lib/taskMove.ts.
 */
export function moveTasks(
  ids: string[],
  projectId: string,
  opts: { resetCheckout?: ReadonlySet<string> } = {}
): TaskMoveBatch {
  const db = getDb();
  const dest = getProject(projectId);
  if (!dest) throw new Error("project not found");

  const unchanged: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const movers: (Task & { picked: number })[] = [];
  // Input order is the click order; classify in it so the skip report reads the
  // way the user's selection did.
  [...new Set(ids)].forEach((id, picked) => {
    const task = getTask(id);
    if (!task) skipped.push({ id, reason: "task not found" });
    else if (task.project_id === projectId) unchanged.push(id);
    else {
      const blocked = moveTaskBlockedReason(task, { resetCheckout: opts.resetCheckout?.has(id) });
      if (blocked) skipped.push({ id, reason: blocked });
      else movers.push({ ...task, picked });
    }
  });
  if (movers.length === 0) return { moved: [], from_project_ids: [], unchanged, skipped, dropped: [], kept: [], untagged: [], carried: [] };

  // Append in SOURCE order, not click order, so a selection keeps the shape it
  // had in the tray it left. Positions only mean something WITHIN a project — a
  // task at 2 in one tray is not "after" a task at 0 in another — so a selection
  // spanning several sources keeps each source's run whole, ordered by when the
  // caller first named that source. Arbitrary across trays, but deterministic,
  // which sorting two unrelated orderings together isn't.
  const sourceRank = new Map<string, number>();
  for (const t of movers) if (!sourceRank.has(t.project_id)) sourceRank.set(t.project_id, sourceRank.size);
  movers.sort((a, b) =>
    sourceRank.get(a.project_id)! - sourceRank.get(b.project_id)! || a.position - b.position || a.picked - b.picked);
  const moving = new Set(movers.map((t) => t.id));

  // Whole-table read, as setTaskDeps' cycle guard already does: task_dependencies
  // is small, and partitioning in JS is clearer than an IN-list built twice.
  const edges = db.prepare("SELECT task_id, depends_on_id FROM task_dependencies").all() as TaskEdge[];
  const touching = edges.filter((e) => moving.has(e.task_id) || moving.has(e.depends_on_id));
  const kept = touching.filter((e) => moving.has(e.task_id) && moving.has(e.depends_on_id));
  const dropped = touching.filter((e) => !(moving.has(e.task_id) && moving.has(e.depends_on_id)));

  // Tags get the same both-ends-moving rule the edges above do. A tag is
  // project-scoped, so a moved row can't keep carrying one from the project it
  // left — UNLESS the whole tag is leaving with it, which is what "both ends
  // are moving" means for a label: it follows its members. A feature selected
  // whole therefore arrives whole, badges intact; a feature selected in part
  // leaves that tag (and its remaining members) behind. Decided PER TAG, not
  // per task: a task in the auth migration and in "flaky-tests" can carry one
  // across and drop the other, and telling it which is the whole point of
  // making these many-to-many.
  const carried: MovedTag[] = [];
  const untagged: { id: string; tag_id: string; tag_name: string }[] = [];
  const carriedTags: Tag[] = [];
  const tagsOfMovers = new Map<string, string[]>();
  for (const t of movers) tagsOfMovers.set(t.id, getTaskTagIds(t.id));
  const membersOf = db.prepare("SELECT task_id FROM task_tags WHERE tag_id = ?");
  for (const tagId of new Set([...tagsOfMovers.values()].flat())) {
    const tag = getTag(tagId);
    // The FK says a membership's tag exists; a missing one just means nothing to carry.
    if (!tag) continue;
    const members = (membersOf.all(tagId) as { task_id: string }[]).map((m) => m.task_id);
    if (members.every((id) => moving.has(id))) carriedTags.push(tag);
    else for (const t of movers) if (tagsOfMovers.get(t.id)!.includes(tagId)) untagged.push({ id: t.id, tag_id: tagId, tag_name: tag.name });
  }

  // Position is per-project (createTask appends at MAX+1 within the project), so
  // the movers need fresh ones or they collide with the destination's order.
  let position = (
    db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE project_id = ?").get(projectId) as { n: number }
  ).n;
  const rows = movers.map((task) => ({ ...deriveMoved(task, dest), id: task.id, position: position++ }));
  // Whose blocker list just got shorter: the movers, and the DEPENDENT end of
  // every severed edge. Not the blocker end — a task that something else was
  // waiting on lost nothing when that edge went, and reaping its (already dead)
  // auto_start would bump an updated_at on a row this move never touched.
  const touched = new Set([...moving, ...dropped.map((e) => e.task_id)]);
  // Which memberships to sever, keyed by task: only the tags that stayed.
  const leftBehind = new Map<string, string[]>();
  for (const u of untagged) leftBehind.set(u.id, [...(leftBehind.get(u.id) ?? []), u.tag_id]);
  const now = Date.now();

  db.transaction(() => {
    const unlink = db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?");
    for (const e of dropped) unlink.run(e.task_id, e.depends_on_id);
    // Re-key the carried tags FIRST, so nothing in between ever reads a
    // member in one project and its tag in another.
    let tagPos = (
      db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tags WHERE project_id = ?").get(projectId) as { n: number }
    ).n;
    const nameTaken = db.prepare("SELECT 1 AS x FROM tags WHERE project_id = ? AND name = ?");
    // base_branch is cleared on the way across for exactly the reason it is
    // cleared on every mover below: a branch name means nothing in another
    // repository, and a carried tag still naming `feature/auth` would hand that
    // default to every task filed under it in a repo that has no such branch.
    const rekey = db.prepare(
      "UPDATE tags SET project_id = ?, name = ?, position = ?, origin_task_id = ?, base_branch = '', updated_at = ? WHERE id = ?"
    );
    for (const g of carriedTags) {
      // UNIQUE(project_id, name), and a same-named tag in the destination is
      // NOT this feature: suffix rather than merge, because merging two plans
      // is a decision and this is a move. The report names what happened.
      let name = g.name;
      for (let n = 1; nameTaken.get(projectId, name); n++) name = n === 1 ? `${g.name} (moved)` : `${g.name} (moved ${n})`;
      // Provenance can't span projects either — the planning session stays put
      // unless it was selected too, in which case the link survives intact.
      const origin = g.origin_task_id && moving.has(g.origin_task_id) ? g.origin_task_id : null;
      rekey.run(projectId, name, tagPos++, origin, now, g.id);
      carried.push({ id: g.id, name, renamed_from: name === g.name ? null : g.name });
    }
    // base_branch is cleared for EVERY mover, started or not, and unlike the
    // checkout columns below it isn't an exception: a branch name means nothing
    // in a different repository, and a task carrying `feature/auth` into a repo
    // that has no such branch would silently fall back to HEAD at its next cut.
    // Empty is the honest answer — inherit the destination project's default.
    const reparent = db.prepare(
      `UPDATE tasks SET project_id = ?, position = ?, agent = ?, send_context = ?, model = ?, resolved_model = ?,
        reasoning = ?, permission_mode = ?, session_id = ?, base_branch = '', updated_at = ? WHERE id = ?`
    );
    // The tags a row leaves behind, when the rest of their members stayed. Not
    // folded into the reparent above: a whole selection now KEEPS its tags, so
    // severing one is the exception — the way the checkout reset below is.
    const untag = db.prepare("DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?");
    // Everything that described the checkout being thrown away. Its own
    // statement, run AFTER the reparent: it's the exception rather than part of
    // every move, so the ordinary unstarted move still writes exactly the
    // columns it always has.
    //
    // The worktree/branch/base triple is the obvious part — they name a
    // directory and a branch in the OLD repo, both gone by the time this runs,
    // and emptying them is what makes the next turn cut a fresh worktree from
    // the destination (POST /messages and lib/autoStart both read a missing
    // worktree_path as "create one").
    //
    // The other three are current-state fields about that same checkout, and
    // only clearing them keeps the row honest in its new home:
    //   - session_id resumes an agent thread whose entire context — files read,
    //     commands run, the repo it believes it's in — is the old project's.
    //     Worse, worktrees are keyed by TASK id, so the fresh one lands at the
    //     very path that session remembers, with different contents. The next
    //     turn opens a new session instead. (deriveMoved already nulls this on
    //     an agent switch, for the same "what it was attached to is gone"
    //     reason.) The transcript, summaries and usage are task-keyed and all
    //     survive — losing them is what the move exists to avoid.
    //   - merged_at / pr_url claim this task's work sits in the base branch,
    //     and under review, of a repo it has just left. The merge itself isn't
    //     forgotten: task_merges keeps the event, its line counts and its date,
    //     and is re-pointed at the destination below.
    // `started` and `generation` are deliberately untouched — the task really
    // did start and its transcript is still here, so it stays a resume.
    // context_measured goes with session_id: it described the session being
    // thrown away, and the next turn opens a fresh one that reports its own.
    const clearCheckout = db.prepare(
      `UPDATE tasks SET worktree_path = '', work_branch = '', base_sha = '', merged_at = 0, pr_url = '',
        pr_number = 0, pr_state = '', pr_checks = '', pr_review = '', pr_merged_at = 0, pr_synced_at = 0,
        session_id = NULL, context_measured = NULL WHERE id = ?`
    );
    // Project-keyed child rows follow their task. These are the tables that
    // denormalize project ownership for per-project rollups (spend, session
    // counts, the merged-per-day charts) — left behind, they'd keep billing the
    // source project for a task it no longer owns.
    const repoint = ["sessions", "task_usage", "task_merges"].map((t) =>
      db.prepare(`UPDATE ${t} SET project_id = ? WHERE task_id = ?`)
    );
    // The acknowledged copy of a watched setting file (lib/settingsDrift.ts) is
    // about a file in the repo this task has just LEFT. The next turn cuts a
    // fresh worktree from the destination's base, so keeping the old baseline
    // would raise a settings card on the first turn after every move — a
    // warning that the file "changed in this task's worktree" when what changed
    // is the repo. Dropped instead, so the destination's settings are taken as
    // the baseline the same way a brand-new task takes its repo's.
    const dropSettings = db.prepare("DELETE FROM task_settings_snapshots WHERE task_id = ?");
    for (const r of rows) {
      reparent.run(projectId, r.position, r.agent, r.send_context, r.model, r.resolved_model, r.reasoning, r.permission_mode, r.session_id, now, r.id);
      dropSettings.run(r.id);
      if (opts.resetCheckout?.has(r.id)) clearCheckout.run(r.id);
      for (const tagId of leftBehind.get(r.id) ?? []) untag.run(r.id, tagId);
      for (const stmt of repoint) stmt.run(projectId, r.id);
    }
    // A blocker-less task can never auto-start (lib/autoStart.ts selects through
    // task_dependencies), so the opt-in would be a dead flag — clear it. Read
    // off the FINAL graph, which is what makes the batch worth having: a task
    // whose blocker came along still has an edge here, so its opt-in survives.
    const clearAutoStart = db.prepare(
      `UPDATE tasks SET auto_start = 0, updated_at = ? WHERE id = ? AND auto_start = 1
         AND NOT EXISTS (SELECT 1 FROM task_dependencies WHERE task_id = ?)`
    );
    for (const id of touched) clearAutoStart.run(now, id, id);
  })();

  return {
    moved: rows.map((r) => getTask(r.id)!),
    from_project_ids: [...new Set(movers.map((t) => t.project_id))],
    unchanged,
    skipped,
    dropped,
    kept,
    untagged,
    carried,
  };
}

/**
 * The columns a task carries INTO `dest`. `agent` and `send_context` are both
 * DERIVED from the owning project at creation (see createTask) but stored as
 * plain columns, so nothing records whether a value was the user's explicit pick
 * or the project's default. A value that still matches the SOURCE project's
 * default is treated as inherited and re-derived from the destination; anything
 * else is an explicit choice and travels with the task.
 */
function deriveMoved(task: Task, dest: Project) {
  const src = getProject(task.project_id);
  const srcAgent = src?.default_agent || "claude";
  const agent = task.agent === srcAgent ? dest.default_agent || "claude" : task.agent;
  const srcSend = src ? (src.send_context !== 0 ? 1 : 0) : 1;
  const send_context = task.send_context === srcSend ? (dest.send_context !== 0 ? 1 : 0) : task.send_context;
  // Re-deriving the agent switches drivers, so the same rule the PATCH route
  // applies to a manual switch holds here: run controls are provider-specific,
  // and only an inherited/default choice is safe for the new driver.
  const switched = agent !== task.agent;
  return {
    agent,
    send_context,
    model: switched ? null : task.model,
    resolved_model: switched ? null : task.resolved_model,
    reasoning: switched ? null : task.reasoning,
    permission_mode: switched ? null : task.permission_mode,
    session_id: switched ? null : task.session_id,
  };
}

/**
 * Move one task, the strict way: what the single-task route needs. Throws the
 * reason instead of reporting it, and reports the severed edges as the two id
 * lists that route has always returned. A task moving alone can never have both
 * ends of an edge in its set, so every edge touching it still drops.
 */
export function moveTask(taskId: string, projectId: string): TaskMove {
  const result = moveTasks([taskId], projectId);
  const refused = result.skipped[0];
  if (refused) throw new Error(refused.reason);
  // Already in the destination — a no-op, not a move.
  if (result.unchanged.length) return { task: getTask(taskId)!, dropped_blockers: [], dropped_dependents: [] };
  return {
    task: result.moved[0],
    dropped_blockers: result.dropped.filter((e) => e.task_id === taskId).map((e) => e.depends_on_id),
    dropped_dependents: result.dropped.filter((e) => e.depends_on_id === taskId).map((e) => e.task_id),
  };
}

export function updateTask(id: string, patch: Partial<Task>): Task | undefined {
  const cur = getTask(id);
  if (!cur) return undefined;
  const n = { ...cur, ...patch, updated_at: Date.now() };
  getDb()
    .prepare(
      `UPDATE tasks SET title=?, description=?, priority=?, status=?, suggested=?, agent=?, send_context=?, model=?, resolved_model=?, reasoning=?, permission_mode=?,
        session_id=?, worktree_path=?, work_branch=?, base_sha=?, base_branch=?, merged_at=?, pr_url=?, pr_number=?, pr_state=?, pr_checks=?, pr_review=?, pr_merged_at=?, pr_synced_at=?, generation=?, started=?, auto_start=?, withdrawn_reason=?, agent_edited_at=?, running=?, awaiting_input=?, background_pending=?, background_note=?, schedule_id=?, snoozed_until=?, unread_run_at=?, start_at=?, context_measured=?, agent_env=?, updated_at=? WHERE id=?`
    )
    .run(n.title, n.description, n.priority, n.status, n.suggested, n.agent, n.send_context ? 1 : 0, n.model ?? null, n.resolved_model ?? null, n.reasoning ?? null, n.permission_mode ?? null, n.session_id, n.worktree_path, n.work_branch, n.base_sha, n.base_branch ?? "", n.merged_at, n.pr_url, n.pr_number ?? 0, n.pr_state ?? "", n.pr_checks ?? "", n.pr_review ?? "", n.pr_merged_at ?? 0, n.pr_synced_at ?? 0, n.generation, n.started, n.auto_start, n.withdrawn_reason ?? "", n.agent_edited_at ?? 0, n.running, n.awaiting_input, n.background_pending ?? 0, n.background_note ?? "", n.schedule_id ?? null, n.snoozed_until ?? 0, n.unread_run_at ?? 0, n.start_at ?? 0, n.context_measured ?? null, serializeAgentEnv(n.agent_env), n.updated_at, id);
  return getTask(id);
}

/**
 * Drop a task's worktree column, and NOTHING else — not even `updated_at`.
 *
 * updateTask() stamps `updated_at = Date.now()` on every write, which is right
 * for a change somebody made and wrong for a reclaim nobody asked for. That
 * column is the board's sort key (listTasks orders by it, so the top card in
 * each bucket is the most recently active task) AND retention's clock, so
 * stamping it here would float a six-month-old finished task to the top of
 * Done and push its transcript prune out by the width of the worktree window.
 * Used by the scheduled worktree sweep (lib/worktreeSweep.ts) and by
 * lib/reclaim.ts; the interactive paths go through updateTask, where the stamp
 * is the truth.
 *
 * `branch: true` clears the branch columns in the same statement, for the
 * caller that deleted the local branch as well as the checkout (a landed task,
 * whose diff now lives in the base branch rather than on a branch of its own).
 * Leaving `work_branch` pointing at a ref that no longer exists would make the
 * DIFF tab, the reclaim list and worktreePruneSafety all reason about a branch
 * git cannot resolve.
 */
export function clearTaskWorktreePath(id: string, opts: { branch?: boolean } = {}): void {
  getDb()
    .prepare(
      opts.branch
        ? "UPDATE tasks SET worktree_path = '', work_branch = '', base_sha = '' WHERE id = ?"
        : "UPDATE tasks SET worktree_path = '' WHERE id = ?"
    )
    .run(id);
}

/**
 * Write back what GitHub just said about a task's PR — and NOTHING else, not
 * even `updated_at`, for exactly the reason clearTaskWorktreePath gives.
 *
 * A refresh is a poll nobody asked for: it runs on a timer, on opening a task,
 * and after a PR is created. updateTask() would stamp `updated_at`, which is
 * the board's sort key AND retention's clock, so a five-minute CI poll would
 * float every open-PR task to the top of its column and push its transcript
 * prune out indefinitely. The chip's freshness must not reorder the board.
 *
 * Returns the fresh row so the caller can publish an authoritative snapshot.
 */
export function setTaskPrState(
  id: string,
  pr: {
    state: string;
    checks: string;
    review: string;
    merged_at: number;
    synced_at: number;
    number?: number;
    draft?: number;
    merge_state?: string;
    failing?: string;
  }
): Task | undefined {
  getDb()
    .prepare(
      `UPDATE tasks SET pr_state = ?, pr_checks = ?, pr_review = ?, pr_merged_at = ?, pr_synced_at = ?,
        pr_number = COALESCE(?, pr_number),
        pr_draft = COALESCE(?, pr_draft), pr_merge_state = COALESCE(?, pr_merge_state),
        pr_failing = COALESCE(?, pr_failing) WHERE id = ?`
    )
    .run(
      pr.state, pr.checks, pr.review, pr.merged_at, pr.synced_at,
      pr.number ?? null, pr.draft ?? null, pr.merge_state ?? null, pr.failing ?? null, id
    );
  return getTask(id);
}

/**
 * Tasks whose PR is worth asking GitHub about again: one exists, and the last
 * answer wasn't terminal. A merged or closed PR is never polled again — its
 * state cannot change back — which is what keeps the ticker's cost bounded by
 * open work rather than by how many PRs the instance has ever opened.
 *
 * `staleBefore` is the pr_synced_at cutoff, so a task refreshed by a click a
 * moment ago isn't re-fetched by the tick that follows. Oldest sync first, so a
 * capped batch always makes progress rather than re-serving the same rows.
 */
export function stalePrTasks(staleBefore: number, limit: number): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE pr_url != '' AND pr_number > 0 AND pr_state NOT IN ('merged', 'closed')
         AND pr_synced_at < ?
       ORDER BY pr_synced_at ASC LIMIT ?`
    )
    .all(staleBefore, limit) as Task[];
}

/** How many tasks still have a PR that could change — the ticker's stop condition. */
export function openPrTaskCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE pr_url != '' AND pr_number > 0 AND pr_state NOT IN ('merged', 'closed')`
    )
    .get() as { n: number };
  return row.n;
}

export function deleteTask(id: string) {
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function setTaskStatus(id: string, status: Status) {
  return updateTask(id, { status });
}

// Merged tasks and completed tasks that still hold an on-record worktree — the
// candidates for Settings → Storage cleanup. A completed task is included even
// when its work was never merged, because the user may explicitly discard it.
// Joined with the owning project so the API can resolve each worktree's repo
// (for git ops) and label it for the user.
// Whether the directory actually exists on disk is checked by the caller.
export interface ReclaimableWorktree {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  repo_path: string;
  // The task's RESOLVED base — its own when it has one, else the first of its
  // tags that sets one (in tag order), else the project's default. Expressed as
  // SQL because this sweep has no Task in hand; the order must stay the twin of
  // resolveBaseBranch() in lib/baseBranch.ts, and tests/baseBranch.test.ts
  // asserts that all three legs agree.
  base_branch: string;
  worktree_path: string;
  work_branch: string;
  merged_at: number;
  status: Status;
  updated_at: number;
}
export function listReclaimableWorktrees(): ReclaimableWorktree[] {
  return getDb()
    .prepare(
      // The tag leg is no longer a plain COALESCE column: it is a lookup
      // through task_tags, ordered by the same position getTaskTags() reads in,
      // taking the FIRST tag that actually sets a base. A task carrying three
      // tags where two name a branch resolves to the one its badges lead with.
      `SELECT t.id, t.title, t.project_id, p.name AS project_name, p.repo_path,
              COALESCE(
                NULLIF(t.base_branch, ''),
                (SELECT g.base_branch FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
                  WHERE tt.task_id = t.id AND g.base_branch != ''
                  ORDER BY tt.position ASC, tt.created_at ASC LIMIT 1),
                p.branch
              ) AS base_branch,
              t.worktree_path, t.work_branch, t.merged_at, t.status, t.updated_at
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.worktree_path != '' AND (t.merged_at > 0 OR t.status = 'done')
        ORDER BY CASE WHEN t.merged_at > 0 THEN t.merged_at ELSE t.updated_at END ASC`
    )
    .all() as ReclaimableWorktree[];
}

// ---------- permission rules (remembered "always allow" answers) ----------
//
// The durable half of the tool-permission gate (lib/permissions.ts): what the
// user chose to stop being asked about, scoped to one project. Matching logic
// lives in lib/permissions.ts; this is storage only.

// ---------- tags ----------
// A named, project-scoped label a task can carry (lib/types Tag; design in
// docs/superpowers/specs/2026-08-27-tags-design.md). Membership is a row in
// task_tags, not a column on tasks: a task belongs to as many tags as it has
// reasons to, and takes context from every one of them. Everything about a
// tag's PROGRESS is derived here at read time from its members — no cached
// column, nothing to go stale when a task is deleted or moved.

/** The derived member counts, as correlated subqueries over the join table. */
const TAG_COUNTS_SQL = `
  (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE tt.tag_id = g.id) AS c_total,
  (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE tt.tag_id = g.id AND t.status = 'done') AS c_done,
  (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE tt.tag_id = g.id AND t.status = 'cancelled') AS c_cancelled,
  (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE tt.tag_id = g.id AND t.running = 1) AS c_running,
  (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE tt.tag_id = g.id AND ${NEEDS_YOU}) AS c_awaiting`;

type TagRow = Omit<Tag, "counts"> & { c_total: number; c_done: number; c_cancelled: number; c_running: number; c_awaiting: number };

function tagFromRow(r: TagRow): Tag {
  const { c_total, c_done, c_cancelled, c_running, c_awaiting, ...rest } = r;
  return { ...rest, counts: { total: c_total, done: c_done, cancelled: c_cancelled, running: c_running, awaiting: c_awaiting } };
}

const SELECT_TAG = `SELECT g.*, ${TAG_COUNTS_SQL} FROM tags g`;

/** UNIQUE(project_id, name) lost. Its own class so the routes can answer 409. */
export class TagNameConflictError extends Error {
  readonly code = "tag_name_taken" as const;
  constructor(readonly tagName: string) {
    super(`A tag named "${tagName}" already exists in this project`);
    this.name = "TagNameConflictError";
  }
}

export function listTags(projectId: string): Tag[] {
  return (getDb().prepare(`${SELECT_TAG} WHERE g.project_id = ? ORDER BY g.position ASC, g.created_at ASC`).all(projectId) as TagRow[]).map(tagFromRow);
}

/**
 * Every tag in every active project, with its project's identity — the ⌘K
 * palette's jump targets.
 */
export function listAllTagsLite(): (Tag & { project_name: string; project_color: string; project_icon: string })[] {
  const rows = getDb()
    .prepare(
      `SELECT g.*, ${TAG_COUNTS_SQL}, p.name AS project_name, p.color AS project_color, p.icon AS project_icon
       FROM tags g JOIN projects p ON p.id = g.project_id
       WHERE p.deprecated = 0
       ORDER BY p.position ASC, g.position ASC, g.created_at ASC`
    )
    .all() as (TagRow & { project_name: string; project_color: string; project_icon: string })[];
  return rows.map((r) => ({ ...tagFromRow(r), project_name: r.project_name, project_color: r.project_color, project_icon: r.project_icon }));
}

export function getTag(id: string): Tag | undefined {
  const r = getDb().prepare(`${SELECT_TAG} WHERE g.id = ?`).get(id) as TagRow | undefined;
  return r ? tagFromRow(r) : undefined;
}

/**
 * The tags one task carries, in the order it carries them — `position`, which
 * is the order the badges render and the order lib/tagContext.ts injects their
 * blocks in, so the first tag on a card is the first thing its session reads.
 */
export function getTaskTags(taskId: string): Tag[] {
  return (
    getDb()
      .prepare(
        `${SELECT_TAG} JOIN task_tags tt ON tt.tag_id = g.id WHERE tt.task_id = ?
         ORDER BY tt.position ASC, tt.created_at ASC`
      )
      .all(taskId) as TagRow[]
  ).map(tagFromRow);
}

/** Just the ids, in the same order — what the client rows carry. */
export function getTaskTagIds(taskId: string): string[] {
  return (
    getDb()
      .prepare("SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY position ASC, created_at ASC").all(taskId) as { tag_id: string }[]
  ).map((r) => r.tag_id);
}

// Exact match, case-sensitive, like the UNIQUE constraint it mirrors. A near
// miss creating a second tag is bounded by that constraint plus the tool
// result naming what happened (resolveTag's `created`).
function tagByName(projectId: string, name: string): Tag | undefined {
  const r = getDb().prepare(`${SELECT_TAG} WHERE g.project_id = ? AND g.name = ?`).get(projectId, name) as TagRow | undefined;
  return r ? tagFromRow(r) : undefined;
}

export function createTag(input: {
  project_id: string;
  name: string;
  description?: string;
  color?: string | null;
  /** The whole plan's base branch; "" = no opinion, members follow the project. */
  base_branch?: string;
  /** The session that filed it, when an agent did. */
  origin_task_id?: string | null;
}): Tag {
  const name = input.name.trim();
  if (!name) throw new Error("tag name required");
  // Checked rather than left to the constraint so the error names the tag,
  // and so the throw is the same class whether it came from create or rename.
  if (tagByName(input.project_id, name)) throw new TagNameConflictError(name);
  const now = Date.now();
  const id = nanoid();
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tags WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  getDb()
    .prepare(
      `INSERT INTO tags (id, project_id, name, description, color, base_branch, origin_task_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, name, input.description ?? "", input.color ?? null,
      input.base_branch?.trim() ?? "", input.origin_task_id ?? null, position, now, now
    );
  return getTag(id)!;
}

export function updateTag(
  id: string,
  fields: Partial<Pick<Tag, "name" | "description" | "color" | "base_branch" | "position">>
): Tag | undefined {
  const cur = getTag(id);
  if (!cur) return undefined;
  const patch: Record<string, string | number | null> = {};
  if (fields.name !== undefined) {
    const name = fields.name.trim();
    if (!name) throw new Error("tag name required");
    const other = tagByName(cur.project_id, name);
    if (other && other.id !== id) throw new TagNameConflictError(name);
    patch.name = name;
  }
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.color !== undefined) patch.color = fields.color;
  // "" clears the default back to "follow the project". Only members that
  // haven't been cut yet ever see the change — tasks.base_branch is pinned at
  // the worktree cut, which is what makes editing this mid-plan safe.
  if (fields.base_branch !== undefined) patch.base_branch = fields.base_branch.trim();
  if (fields.position !== undefined) patch.position = fields.position;
  const keys = Object.keys(patch);
  if (!keys.length) return cur;
  getDb()
    .prepare(`UPDATE tags SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), Date.now(), id);
  return getTag(id);
}

/**
 * Persist "Refresh tag with AI" job state in isolation — the tag analogue of
 * setProjectRefresh, and separate from updateTag for the same reason: a
 * background run and a concurrent rename must not clobber each other, and
 * updateTag's fixed column list must never carry refresh_* state.
 *
 * It deliberately does NOT stamp `updated_at`. That column is the tag's own
 * edit clock; a job ticking through three stages would otherwise report the
 * tag as freshly edited three times for work the user didn't do.
 */
export function setTagRefresh(
  id: string,
  fields: Partial<Pick<Tag, "refresh_status" | "refresh_stage" | "refresh_summary" | "refresh_error" | "refresh_started_at">>,
): Tag | undefined {
  const cur = getTag(id);
  if (!cur) return undefined;
  const n = { ...cur, ...fields };
  getDb()
    .prepare(
      `UPDATE tags SET refresh_status = ?, refresh_stage = ?, refresh_summary = ?, refresh_error = ?, refresh_started_at = ?
       WHERE id = ?`
    )
    .run(n.refresh_status, n.refresh_stage, n.refresh_summary, n.refresh_error, n.refresh_started_at, id);
  return getTag(id);
}

/**
 * Hard delete, like everything else. Members are UNTAGGED, never deleted —
 * task_tags is ON DELETE CASCADE from this side, and that is the whole policy:
 * a tag is a label over work, not the work. A member carrying other tags keeps
 * them. Returns whether a row was removed.
 */
export function deleteTag(id: string): boolean {
  return getDb().prepare("DELETE FROM tags WHERE id = ?").run(id).changes > 0;
}

/**
 * Resolve an agent's or a form's reference — an id or an exact name — inside
 * ONE project. Two policies behind one flag, because the two callers mean
 * different things by a miss:
 *   - `create: true` is the planning verb (suggest_task): the common case IS
 *     "this tag doesn't exist yet", so a miss creates it, tagged with the
 *     session that filed it, and `created` says so in the tool result.
 *   - strict (the default) is for update_task and the PATCH routes, where a
 *     typo must fail the call rather than mint a near-duplicate.
 * Returns null on a strict miss or an empty ref.
 */
export function resolveTag(
  projectId: string,
  ref: string,
  opts: { create?: boolean; originTaskId?: string | null } = {}
): { tag: Tag; created: boolean } | null {
  const key = ref.trim();
  if (!key) return null;
  const byId = getTag(key);
  if (byId && byId.project_id === projectId) return { tag: byId, created: false };
  const byName = tagByName(projectId, key);
  if (byName) return { tag: byName, created: false };
  if (!opts.create) return null;
  return { tag: createTag({ project_id: projectId, name: key, origin_task_id: opts.originTaskId ?? null }), created: true };
}

/**
 * Replace the tag set on a batch of tasks, in one transaction — the write
 * behind the edit dialog's field, the selection bar's Tag…, and update_task.
 * Refuses the WHOLE batch when any tag lives outside a task's project: a tag
 * never spans repositories, and a batch that silently skipped the strays would
 * report success for a half-applied selection.
 *
 * Returns the ids actually rewritten (a task already carrying exactly these
 * tags is skipped), so callers can tell "nothing changed" from "changed".
 */
export function setTaskTags(ids: string[], tagIds: string[]): string[] {
  const wanted = dedupe(tagIds);
  return writeTaskTags(ids, () => wanted);
}

/** Dedupe preserving order — the tag order a caller passes is the order it means. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * The one write every membership change goes through: `next` names the tag set
 * each task should end up with, given the set it has now. Bulk add and bulk
 * remove are that function, which is why they are not three near-copies of one
 * transaction with three chances to skip the project check.
 */
function writeTaskTags(ids: string[], next: (current: string[]) => string[]): string[] {
  const db = getDb();
  const unique = dedupe(ids);
  if (!unique.length) return [];
  const rows = unique.map((id) => getTask(id)).filter((t): t is Task => !!t);
  const now = Date.now();
  const changed: string[] = [];
  const plans = rows.map((t) => {
    const current = getTaskTagIds(t.id);
    const wanted = dedupe(next(current));
    for (const tagId of wanted) {
      const tag = getTag(tagId);
      if (!tag) throw new Error("no such tag");
      // A tag never spans repositories, so this is checked per task rather
      // than once per batch: a selection may legitimately span trays.
      if (tag.project_id !== t.project_id) throw new Error(`task "${t.title}" is in another project. A tag can't span projects`);
    }
    return { task: t, current, wanted };
  });
  db.transaction(() => {
    const del = db.prepare("DELETE FROM task_tags WHERE task_id = ?");
    const ins = db.prepare("INSERT INTO task_tags (task_id, tag_id, position, created_at) VALUES (?, ?, ?, ?)");
    const touch = db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?");
    for (const { task, current, wanted } of plans) {
      if (current.length === wanted.length && current.every((id, i) => id === wanted[i])) continue;
      // Rewritten wholesale rather than diffed: `position` is the order the
      // caller passed, so a reorder with the same membership is still a real
      // change, and a diff would have to renumber the survivors anyway.
      del.run(task.id);
      wanted.forEach((tagId, i) => ins.run(task.id, tagId, i, now));
      touch.run(now, task.id);
      changed.push(task.id);
    }
  })();
  return changed;
}

/** Add tags to a selection, keeping whatever each task already carried. */
export function addTaskTags(ids: string[], tagIds: string[]): string[] {
  const add = dedupe(tagIds);
  return writeTaskTags(ids, (current) => [...current, ...add.filter((id) => !current.includes(id))]);
}

/** Take tags off a selection, leaving the rest of each task's set alone. */
export function removeTaskTags(ids: string[], tagIds: string[]): string[] {
  const drop = new Set(tagIds);
  return writeTaskTags(ids, (current) => current.filter((id) => !drop.has(id)));
}

export function listPermissionRules(projectId: string): PermissionRule[] {
  return getDb()
    .prepare("SELECT * FROM permission_rules WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as PermissionRule[];
}

/** Every rule across every project, newest first — the Settings revoke list. */
export function listAllPermissionRules(): PermissionRule[] {
  return getDb().prepare("SELECT * FROM permission_rules ORDER BY created_at DESC").all() as PermissionRule[];
}

/**
 * Remember an "always allow" answer. Idempotent: re-approving the same rule
 * keeps the original row (and its created_at) rather than stacking duplicates.
 */
export function addPermissionRule(input: {
  project_id: string;
  tool: string;
  match_kind: PermissionMatchKind;
  value: string;
}): PermissionRule {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO permission_rules (id, project_id, tool, match_kind, value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(nanoid(), input.project_id, input.tool, input.match_kind, input.value, Date.now());
  return db
    .prepare("SELECT * FROM permission_rules WHERE project_id = ? AND tool = ? AND match_kind = ? AND value = ?")
    .get(input.project_id, input.tool, input.match_kind, input.value) as PermissionRule;
}

export function deletePermissionRule(id: string): void {
  getDb().prepare("DELETE FROM permission_rules WHERE id = ?").run(id);
}

// ---------- watched setting files (lib/settingsDrift.ts, issue #43) ----------

/**
 * What this task's watched setting file looked like the last time a turn was
 * allowed to run under it. null = never recorded, which the gate reads as "no
 * turn has run under any version of this file yet" and takes as its baseline
 * rather than as a change.
 */
export function getSettingsSnapshot(taskId: string, file: string): SettingsSnapshot | null {
  return (getDb()
    .prepare("SELECT * FROM task_settings_snapshots WHERE task_id = ? AND file = ?")
    .get(taskId, file) as SettingsSnapshot | undefined) ?? null;
}

/**
 * Adopt what is on disk now as what this task runs under. Called for a file
 * nobody has seen before (silently, at the first turn) and when the user
 * approves a change — the two moments a new version becomes the baseline the
 * NEXT turn is compared against.
 */
export function recordSettingsSnapshot(taskId: string, file: string, hash: string, content: string): void {
  getDb()
    .prepare(
      `INSERT INTO task_settings_snapshots (task_id, file, hash, content, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id, file) DO UPDATE SET hash = excluded.hash, content = excluded.content, updated_at = excluded.updated_at`
    )
    .run(taskId, file, hash, content, Date.now());
}

// ---------- settings (app-level key/value, readable server-side) ----------

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// A null/empty value clears the key, so it falls back to the built-in default.
export function setSetting(key: string, value: string | null) {
  if (value == null || value === "") {
    getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

/**
 * Point the seeded Welcome tutorial at a different agent. The tutorial is
 * created at first boot — before onboarding — so its project/tasks carry the
 * 'claude' column defaults; when setup finishes with a different agent connected
 * (a Codex-only first run), the not-yet-started tutorial tasks must follow the
 * agent that actually works. Started tasks keep their agent: a session lineage
 * can't switch CLIs mid-flight.
 */
export function retargetSeededAgent(agent: string): void {
  const db = getDb();
  db.prepare("UPDATE projects SET default_agent = ? WHERE seeded = 1").run(agent);
  db.prepare("UPDATE tasks SET agent = ? WHERE started = 0 AND project_id IN (SELECT id FROM projects WHERE seeded = 1)").run(agent);
}

// ---------- messages ----------

export function listMessages(taskId: string): Message[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(taskId) as Message[];
}

export function addMessage(taskId: string, generation: number, role: MsgRole, content: string): Message {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO messages (id, task_id, generation, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, taskId, generation, role, content, now);
  return { id, task_id: taskId, generation, role, content, created_at: now };
}

/**
 * The task's most recent `tool` messages, NEWEST FIRST.
 *
 * The seam for a card that has to settle onto the call that produced it without
 * holding that call's tool_use id. The runner never needs this — it keeps the
 * live turn's tool rows in memory — but the stdio bridge's suggest_task
 * endpoint does: it is invoked out-of-band by a Codex session's MCP client, so
 * the only thing it knows about the call in flight is which task it belongs to.
 * Capped because only the tail can be that call; a full transcript read to find
 * the last few rows would grow with the session.
 */
export function recentToolMessages(taskId: string, limit = 10): Message[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE task_id = ? AND role = 'tool' ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(taskId, limit) as Message[];
}

export function getMessage(id: string): Message | undefined {
  return getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as Message | undefined;
}

export function updateMessage(id: string, content: string) {
  getDb().prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
}

// ---------- pending (queued) messages ----------

// The follow-ups parked behind a running turn for a task, oldest first.
export function listPendingMessages(taskId: string): PendingMessage[] {
  return getDb()
    .prepare("SELECT * FROM pending_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(taskId) as PendingMessage[];
}

// Park a follow-up to run after the current turn ends.
export function addPendingMessage(taskId: string, generation: number, content: string): PendingMessage {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO pending_messages (id, task_id, generation, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, taskId, generation, content, now);
  return { id, task_id: taskId, generation, content, created_at: now };
}

// Atomically claim + remove the oldest parked follow-up for a task (FIFO).
// Returns undefined if the queue is empty. The select+delete run in one
// transaction so two concurrent drains can't pop the same row.
export function popPendingMessage(taskId: string): PendingMessage | undefined {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM pending_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get(taskId) as PendingMessage | undefined;
    if (row) db.prepare("DELETE FROM pending_messages WHERE id = ?").run(row.id);
    return row;
  })();
}

// Remove one parked follow-up by id (the user cancelled it). Scoped by task_id
// so a request against one task can't drop another task's queued message.
// Returns the removed row (so the caller can publish a dequeued event), or
// undefined — including when the id exists but belongs to a different task.
export function deletePendingMessage(id: string, taskId: string): PendingMessage | undefined {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM pending_messages WHERE id = ? AND task_id = ?")
      .get(id, taskId) as PendingMessage | undefined;
    if (row) db.prepare("DELETE FROM pending_messages WHERE id = ?").run(row.id);
    return row;
  })();
}

// Drop the whole parked queue for a task (e.g. the turn was Stopped). Returns
// the removed rows so the caller can clear their bubbles from the transcript.
export function clearPendingMessages(taskId: string): PendingMessage[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = listPendingMessages(taskId);
    if (rows.length) db.prepare("DELETE FROM pending_messages WHERE task_id = ?").run(taskId);
    return rows;
  })();
}

// ---------- task comments (Changes tab review comments) ----------

export function listTaskComments(taskId: string): TaskComment[] {
  return getDb()
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(taskId) as TaskComment[];
}

export function addTaskComment(
  taskId: string,
  file: string,
  side: "old" | "new",
  lineStart: number,
  lineEnd: number,
  body: string,
  sentToAgent: boolean,
  anchorSha: string | null
): TaskComment {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO task_comments (id, task_id, file, side, line_start, line_end, body, sent_to_agent, anchor_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, taskId, file, side, lineStart, lineEnd, body, sentToAgent ? 1 : 0, anchorSha, now);
  return {
    id, task_id: taskId, file, side, line_start: lineStart, line_end: lineEnd, body,
    sent_to_agent: sentToAgent ? 1 : 0, anchor_sha: anchorSha, created_at: now,
  };
}

// ---------- document comments (collaboration modal passage comments) ----------

export function listTaskDocComments(taskId: string, file?: string): TaskDocComment[] {
  const db = getDb();
  return (
    file === undefined
      ? db.prepare("SELECT * FROM task_doc_comments WHERE task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId)
      : db.prepare("SELECT * FROM task_doc_comments WHERE task_id = ? AND file = ? ORDER BY created_at ASC, rowid ASC").all(taskId, file)
  ) as TaskDocComment[];
}

export function addTaskDocComment(
  taskId: string,
  file: string,
  quote: string,
  heading: string | null,
  body: string,
  anchorSha: string | null
): TaskDocComment {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO task_doc_comments (id, task_id, file, quote, heading, body, sent_to_agent, anchor_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(id, taskId, file, quote, heading, body, anchorSha, now);
  return { id, task_id: taskId, file, quote, heading, body, sent_to_agent: 0, anchor_sha: anchorSha, created_at: now };
}

// Flip the given comments to sent, in one transaction — Send is one action
// over the whole draft list, so it lands whole or not at all. Scoped to the
// task and to unsent rows: returns how many actually changed, so a caller
// naming another task's comment (or one already sent) sees fewer than it
// asked for rather than a silent success.
export function markTaskDocCommentsSent(taskId: string, ids: string[]): number {
  if (!ids.length) return 0;
  const db = getDb();
  const stmt = db.prepare("UPDATE task_doc_comments SET sent_to_agent = 1 WHERE task_id = ? AND id = ? AND sent_to_agent = 0");
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(taskId, id).changes, 0))();
}

// Delete an UNSENT comment. A sent one is part of the record of what the agent
// was told and is refused rather than removed — the caller reports "sent".
export function deleteTaskDocComment(taskId: string, id: string): "deleted" | "sent" | "missing" {
  const db = getDb();
  const row = db.prepare("SELECT sent_to_agent FROM task_doc_comments WHERE task_id = ? AND id = ?").get(taskId, id) as
    | { sent_to_agent: number }
    | undefined;
  if (!row) return "missing";
  if (row.sent_to_agent) return "sent";
  db.prepare("DELETE FROM task_doc_comments WHERE task_id = ? AND id = ?").run(taskId, id);
  return "deleted";
}

// ---------- summaries ----------

export function listSummaries(taskId: string): Summary[] {
  return getDb()
    .prepare("SELECT * FROM summaries WHERE task_id = ? ORDER BY generation ASC")
    .all(taskId) as Summary[];
}

export function addSummary(taskId: string, generation: number, summary: string): Summary {
  const id = nanoid();
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO summaries (id, task_id, generation, summary, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, taskId, generation, summary, now);
  return { id, task_id: taskId, generation, summary, created_at: now };
}

// ---------- sessions ----------

export type ProjectSession = Session & { task_title: string; task_status: Status; message_count: number };

// Upsert the session row for a task generation, stamping the live Claude
// session id. Called when a turn opens a session; safe to call on every turn
// of the same generation (resume) — started_at is preserved.
export function recordSession(input: {
  project_id: string;
  task_id: string;
  generation: number;
  claude_session_id: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, project_id, task_id, generation, claude_session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, generation) DO UPDATE SET
         claude_session_id = COALESCE(excluded.claude_session_id, sessions.claude_session_id)`
    )
    .run(nanoid(), input.project_id, input.task_id, input.generation, input.claude_session_id, Date.now());
}

// Mark a generation's session as ended (turn finished). No-op if absent.
export function endSession(taskId: string, generation: number): void {
  getDb()
    .prepare("UPDATE sessions SET ended_at = ? WHERE task_id = ? AND generation = ?")
    .run(Date.now(), taskId, generation);
}

// The agent thread's last reported CUMULATIVE token counters (sessions.usage_cum,
// stored as JSON, keyed by the driver's opaque thread/session id). Codex reports
// the WHOLE thread's totals on every turn.completed, so a turn's own usage is the
// delta against this baseline — which has to survive a server restart, hence the
// DB rather than a process-local map. Claude reports per-turn usage and never
// touches this. Returns null when the thread has no baseline yet (fresh thread,
// or a session row that predates the column).
export function getThreadUsageCum<T>(threadId: string): T | null {
  if (!threadId) return null;
  const row = getDb()
    .prepare("SELECT usage_cum FROM sessions WHERE claude_session_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(threadId) as { usage_cum: string | null } | undefined;
  if (!row?.usage_cum) return null;
  try {
    return JSON.parse(row.usage_cum) as T;
  } catch {
    return null;
  }
}

// Store the new cumulative baseline for a thread. Written mid-turn (as soon as
// the driver maps the turn's usage) so a crash before turn end can't make the
// NEXT turn re-count the whole thread. No-op if no session row carries the id.
export function setThreadUsageCum(threadId: string, cum: unknown): void {
  if (!threadId) return;
  getDb()
    .prepare("UPDATE sessions SET usage_cum = ? WHERE claude_session_id = ?")
    .run(JSON.stringify(cum), threadId);
}

export function listProjectSessions(projectId: string): ProjectSession[] {
  return getDb()
    .prepare(
      `SELECT s.*, t.title AS task_title, t.status AS task_status,
        (SELECT COUNT(*) FROM messages m
           WHERE m.task_id = s.task_id AND m.generation = s.generation
             AND m.role IN ('user', 'assistant', 'tool')) AS message_count
       FROM sessions s JOIN tasks t ON t.id = s.task_id
       WHERE s.project_id = ?
       ORDER BY s.started_at DESC`
    )
    .all(projectId) as ProjectSession[];
}

// ---------- usage ----------

// Persist one turn's token usage + cost. Called once per completed Claude turn
// from the result message. One row per turn keyed (implicitly) by task+generation.
export function addUsage(input: {
  project_id: string;
  task_id: string;
  generation: number;
  agent?: string;
  /** The endpoint host the turn ran against, "" (default) for the agent's own
   *  cloud — `AgentProvider.host` from lib/agentEnv.ts. The runner decides what
   *  the turn is worth from that provider's `pricing` before calling this: the
   *  driver's figure for cloud, 0 for a local model server, null for a custom
   *  base URL nobody has priced. */
  provider?: string;
  usage: LedgerUsage;
}): void {
  const u = input.usage;
  getDb()
    .prepare(
      `INSERT INTO task_usage
         (id, project_id, task_id, generation, agent, provider, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, subagent_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(), input.project_id, input.task_id, input.generation, input.agent || "claude", input.provider || "",
      u.cost_usd, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
      // NULL, not 0, for a driver that doesn't report it — see TurnUsage.
      u.subagent_tokens ?? null,
      Date.now()
    );
}

// One row per merge that landed commits — see the task_merges schema comment.
export function recordTaskMerge(input: {
  project_id: string;
  task_id: string;
  agent: string;
  additions: number;
  deletions: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO task_merges (id, project_id, task_id, agent, additions, deletions, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nanoid(), input.project_id, input.task_id, input.agent || "claude", input.additions, input.deletions, Date.now());
}

const ZERO_USAGE: UsageTotals = {
  cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, subagent_tokens: 0, total_tokens: 0, turns: 0, unpriced_turns: 0,
};

// Sum a usage query into cumulative totals (NULLs → 0 when no rows exist yet).
function sumUsage(where: string, param: string): UsageTotals {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(subagent_tokens), 0) AS subagent_tokens,
         COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_turns,
         COUNT(*) AS turns
       FROM task_usage WHERE ${where}`
    )
    .get(param) as Omit<UsageTotals, "total_tokens"> | undefined;
  if (!row) return { ...ZERO_USAGE };
  return {
    ...row,
    total_tokens: row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens,
  };
}

export function getTaskUsage(taskId: string): UsageTotals {
  return sumUsage("task_id = ?", taskId);
}

// ---------- context-window occupancy ----------

// The window this task's turns actually run in, or 0 for "we don't know".
//
// The catalog is the agent VENDOR's line-up, so it can only size a model the
// vendor ships. Point a project at a local server (lib/agentEnv.ts) and every
// id becomes one the catalog has never heard of — and worse, the override
// rewrites ANTHROPIC_MODEL and the opus/sonnet/haiku aliases, so a task whose
// picker still reads `sonnet` is not running Sonnet and must not be sized like
// it. contextWindowFor's narrowest-on-miss guess is the right answer for an
// unrecognised CLOUD id (see lib/contextWindow.ts) and the wrong one here: it
// would report a 32K local model as 200K and draw a 4% gauge on a window about
// to overflow. So an override reports nothing and the gauge says so.
//
// The gateway is the one override kind that gets an answer anyway: unlike a
// local server or a custom URL, it STATES its models' windows (GET
// <gateway>/model/info, lib/gatewayModels.ts), so a task pointed there is
// sized from that catalog instead of reported unknown. A model missing from
// the catalog (a stale pick, or nothing probed yet) still falls back to 0.
function taskContextWindow(agent: string | null | undefined, model: string | null | undefined, kind: ProviderKind): number {
  if (kind === "cloud") return modelContextWindow(agent, model);
  if (kind === "gateway") {
    const window = gatewayContextWindow(model);
    if (window > 0) return window;
  }
  return 0;
}

// Percent (0–100, one decimal) of that window `tokens` occupies. 0 when the
// window is unknown — the UI reads context_window === 0 and shows the token
// count without a percentage rather than an authoritative-looking 0%.
function contextPct(tokens: number, window: number): number {
  return window > 0 ? Math.round((tokens / window) * 1000) / 10 : 0;
}

export interface TaskContext {
  context_tokens: number; // input-side tokens of the latest main-session request ≈ context sent to the model
  context_window: number; // the model's window (tokens); 0 = unknown (see taskContextWindow)
  context_pct: number; // context_tokens as a percent (0–100) of the window
  context_estimated: boolean; // true when derived from a usage report rather than measured (see below)
}

// The live "how full is the context window" gauge for a task. Two sources, in
// order:
//
//   1. tasks.context_measured — what the agent's own stream reported for the
//      latest main-session model request (input + cache_read + cache_creation).
//      The Claude driver emits it from each assistant message's usage, skipping
//      subagent sidechains; the runner persists it as `context` events arrive,
//      so it moves mid-turn and survives a Stop.
//   2. The current generation's latest task_usage row, same three buckets. This
//      was the whole gauge before context_measured existed and is kept for
//      rows that predate it and for drivers that don't report occupancy (Codex:
//      its exec stream carries only the thread's running totals, though the
//      binary does compute a `last_token_usage` for its app-server protocol).
//      It is an ESTIMATE, and an inflated one on tool-heavy turns: a turn is
//      one query spanning many API requests plus any subagents, and a usage
//      report SUMS them — every tool round-trip re-reads the whole context, so
//      a long turn's sum is a multiple of the real window ("7.6M tokens" on a
//      200k model). `context_estimated` tells the UI to say so.
//
// Distinct from cumulative spend either way — it reflects CURRENT occupancy and
// drops back to 0 after a /clear (the measurement is reset, and the fallback
// only reads the new generation). 0 when the task has never run a turn.
export function getTaskContext(taskId: string): TaskContext {
  const task = getTask(taskId);
  const row = getDb()
    .prepare(
      `SELECT ${CONTEXT_TOKENS_SQL("t")} AS context_tokens, ${CONTEXT_ESTIMATED_SQL("t")} AS context_estimated
       FROM tasks t WHERE t.id = ?`
    )
    .get(taskId) as { context_tokens: number; context_estimated: number } | undefined;
  const context_tokens = row?.context_tokens ?? 0;
  const kind = taskProvider(task ? getProject(task.project_id) : null, task).kind;
  const context_window = taskContextWindow(task?.agent, task?.model, kind);
  return {
    context_tokens,
    context_window,
    context_pct: contextPct(context_tokens, context_window),
    context_estimated: row?.context_estimated === 1,
  };
}

export function getProjectUsage(projectId: string): UsageTotals {
  return sumUsage("project_id = ?", projectId);
}

// ---------- instance-wide rollup (for fleet-polling dashboards) ----------

export interface InstanceUsage extends UsageTotals {
  internal_cost_usd: number;
  internal_tokens: number;
  internal_jobs: number;
  projects: number;
  tasks: number; // real tasks (suggested excluded), like listProjects' task_count
  running_tasks: number;
  awaiting_tasks: number;
  last_activity: number; // max(task.updated_at); 0 when the instance is empty
}

/**
 * A single-row summary of everything this instance has done, for a fleet
 * dashboard to poll and roll up (no per-project fan-out). Cost/tokens are the
 * cumulative sum over task_usage; counts exclude suggested-tray tasks so they
 * match what the user actually sees. Cheap: three aggregate queries, no joins.
 */
export function getInstanceUsage(): InstanceUsage {
  const db = getDb();
  const usage = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(subagent_tokens), 0) AS subagent_tokens,
         COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_turns,
         COUNT(*) AS turns
       FROM task_usage`
    )
    .get() as Omit<UsageTotals, "total_tokens">;
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM projects) AS projects,
         (SELECT COUNT(*) FROM tasks WHERE suggested = 0) AS tasks,
         (SELECT COALESCE(SUM(running), 0) FROM tasks WHERE suggested = 0) AS running_tasks,
         (SELECT COALESCE(SUM(awaiting_input), 0) FROM tasks WHERE suggested = 0) AS awaiting_tasks,
         (SELECT COALESCE(MAX(updated_at), 0) FROM tasks WHERE suggested = 0) AS last_activity`
    )
    .get() as {
    projects: number;
    tasks: number;
    running_tasks: number;
    awaiting_tasks: number;
    last_activity: number;
  };
  const internal = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS internal_cost_usd,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS internal_tokens,
         COUNT(*) AS internal_jobs
       FROM internal_usage`
    )
    .get() as Pick<InstanceUsage, "internal_cost_usd" | "internal_tokens" | "internal_jobs">;
  return {
    ...usage,
    total_tokens:
      usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens,
    ...internal,
    ...counts,
  };
}

// ---------- insights ----------

/**
 * Everything the Insights dashboard charts, as per-day facts grouped by
 * (day, project, agent), with Calandria jobs additionally grouped by job — the client slices/filters/aggregates locally so
 * switching range/project/agent filters never refetches. Days are local-time
 * `YYYY-MM-DD` strings (this is a single-user, local-first surface; the server's
 * clock IS the user's clock). One fetch covers the widest range plus the same
 * width again for prior-period deltas.
 */
export interface InsightsData {
  projects: { id: string; name: string; color: string; deprecated: number }[];
  /** Per-day token/cost usage, one row per (day, project, agent). `unp` counts
   *  the turns in the bucket that had no price to record — a custom base URL,
   *  whose cost nobody has stated (see LedgerUsage). `cost` sums the OTHERS, so
   *  a bucket with `unp > 0` is showing a floor, and the dashboard has to say
   *  so rather than present it as the period's spend. */
  usage: { d: string; p: string; a: string; cost: number; unp: number; inp: number; out: number; cr: number; cw: number }[];
  /**
   * The same spend attributed to TAGS — `g` is the tag id, "" for usage by a
   * task carrying none (or by a task since deleted). A task with three tags
   * appears under all three, so these rows deliberately do NOT sum to `usage`:
   * "what did the auth migration cost" is a question about a label, and a task
   * that is part of two features really did cost both of them its time. The
   * leaderboard says so rather than dividing spend it has no basis to divide.
   */
  tagUsage: { d: string; p: string; a: string; g: string; cost: number; unp: number; inp: number; out: number; cr: number; cw: number }[];
  /** The tags those `g` keys name, for the leaderboard's labels. */
  tags: { id: string; name: string; color: string | null; project_id: string }[];
  /** Calandria's own one-shot work, kept separate from task usage. */
  internal: { d: string; p: string; a: string; job: string; m: string; n: number; cost: number; inp: number; out: number; cr: number; cw: number }[];
  /** Tasks whose (latest) merge landed that day. */
  shipped: { d: string; p: string; a: string; n: number }[];
  /** Lines landed on the base branch that day (from task_merges). */
  merges: { d: string; p: string; a: string; add: number; del: number }[];
  /** Distinct resolved models seen per agent (for the provider panel). */
  models: { a: string; m: string }[];
  /**
   * Cache-read vs. input tokens per agent, for turns run against the LiteLLM
   * gateway specifically (`u.provider` matching the gateway's own host) — the
   * only signal Calandria has that prompt caching survived translation
   * through the gateway (docs/design/litellm.md, "What Calandria cannot
   * fix"): `cache_read_tokens` stuck at zero across a task's turns despite
   * real `inp` is the failure. A separate query rather than a finer GROUP BY
   * on `usage` above, same reason `models` is: it isn't a per-day series, and
   * folding a provider dimension into the one every other chart draws from
   * would change what every other chart on the page means. Empty when no
   * gateway is configured (the route passes an empty host and this matches
   * nothing, `task_usage.provider` never being "").
   */
  gatewayCache: { a: string; inp: number; cr: number }[];
}

export function getInsightsData(sinceMs: number, gatewayHost = ""): InsightsData {
  const db = getDb();
  const projects = db
    .prepare("SELECT id, name, color, deprecated FROM projects ORDER BY position ASC, created_at ASC")
    .all() as InsightsData["projects"];
  const usage = db
    .prepare(
      `SELECT date(u.created_at/1000, 'unixepoch', 'localtime') AS d, u.project_id AS p,
              CASE WHEN u.agent = '' THEN 'claude' ELSE u.agent END AS a,
              SUM(u.cost_usd) AS cost,
              SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS unp,
              SUM(u.input_tokens) AS inp, SUM(u.output_tokens) AS out,
              SUM(u.cache_read_tokens) AS cr, SUM(u.cache_creation_tokens) AS cw
       FROM task_usage u
       WHERE u.created_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["usage"];
  // The tag attribution is its OWN read rather than a finer GROUP BY on the one
  // above, because tags are many-to-many: a task with three of them joins to
  // three rows, and folding that into `usage` would triple its spend on every
  // chart in the dashboard. Kept apart, the charts stay exact and the tag
  // leaderboard gets the overlapping answer it wants.
  // LEFT JOIN twice, so usage whose task has since been deleted (or which
  // carries no tag) still lands somewhere — the "" bucket the leaderboard shows
  // as untagged.
  const tagUsage = db
    .prepare(
      `SELECT date(u.created_at/1000, 'unixepoch', 'localtime') AS d, u.project_id AS p,
              CASE WHEN u.agent = '' THEN 'claude' ELSE u.agent END AS a,
              COALESCE(tt.tag_id, '') AS g,
              SUM(u.cost_usd) AS cost,
              SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS unp,
              SUM(u.input_tokens) AS inp, SUM(u.output_tokens) AS out,
              SUM(u.cache_read_tokens) AS cr, SUM(u.cache_creation_tokens) AS cw
       FROM task_usage u
         LEFT JOIN tasks t ON t.id = u.task_id
         LEFT JOIN task_tags tt ON tt.task_id = t.id
       WHERE u.created_at >= ? GROUP BY d, p, a, g`
    )
    .all(sinceMs) as InsightsData["tagUsage"];
  // Every tag, not just the ones with spend: the leaderboard says "no spend
  // yet" for a feature that's been planned and not run, which is a different
  // fact from a feature that isn't there.
  const tags = db
    .prepare("SELECT id, name, color, project_id FROM tags ORDER BY position ASC, created_at ASC")
    .all() as InsightsData["tags"];
  const internal = db
    .prepare(
      `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d,
              COALESCE(project_id, '') AS p, agent AS a, job,
              COALESCE(model, '') AS m, COUNT(*) AS n,
              SUM(cost_usd) AS cost, SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
              SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cw
       FROM internal_usage WHERE created_at >= ? GROUP BY d, p, a, job, m`
    )
    .all(sinceMs) as InsightsData["internal"];
  const shipped = db
    .prepare(
      `SELECT date(merged_at/1000, 'unixepoch', 'localtime') AS d, project_id AS p, agent AS a, COUNT(*) AS n
       FROM tasks WHERE merged_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["shipped"];
  const merges = db
    .prepare(
      `SELECT date(merged_at/1000, 'unixepoch', 'localtime') AS d, project_id AS p, agent AS a,
              SUM(additions) AS "add", SUM(deletions) AS del
       FROM task_merges WHERE merged_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["merges"];
  const models = db
    .prepare(
      `SELECT DISTINCT agent AS a, resolved_model AS m FROM tasks
       WHERE resolved_model IS NOT NULL AND resolved_model != '' AND updated_at >= ?`
    )
    .all(sinceMs) as InsightsData["models"];
  // `gatewayHost` is "" when no gateway is configured. `provider` is ALSO ""
  // for a row billed to the agent's own cloud (see addUsage), so an empty host
  // has to short-circuit here rather than reach the query — `provider = ''`
  // would otherwise match every ordinary cloud turn on the instance.
  const gatewayCache = gatewayHost
    ? (db
        .prepare(
          `SELECT CASE WHEN agent = '' THEN 'claude' ELSE agent END AS a,
                  SUM(input_tokens) AS inp, SUM(cache_read_tokens) AS cr
           FROM task_usage WHERE created_at >= ? AND provider = ? GROUP BY a`
        )
        .all(sinceMs, gatewayHost) as InsightsData["gatewayCache"])
    : [];
  return { projects, tags, usage, tagUsage, internal, shipped, merges, models, gatewayCache };
}

// ---------- recaps ----------

// The most recent moment anything happened in a project: task edits, session
// boundaries, or messages. Drives "it's been a while" staleness. 0 = no activity.
export function projectLastActivity(projectId: string): number {
  const row = getDb()
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT MAX(updated_at) AS ts FROM tasks WHERE project_id = @p
         UNION ALL SELECT MAX(started_at) FROM sessions WHERE project_id = @p
         UNION ALL SELECT MAX(ended_at) FROM sessions WHERE project_id = @p
         UNION ALL SELECT MAX(m.created_at) FROM messages m
           JOIN tasks t ON t.id = m.task_id WHERE t.project_id = @p
       )`
    )
    .get({ p: projectId }) as { ts: number | null };
  return row.ts ?? 0;
}

// Whether the project has ever opened a session — i.e. there is anything to recap.
export function projectHasHistory(projectId: string): boolean {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?").get(projectId) as { n: number };
  return row.n > 0;
}

export function setProjectRecap(id: string, recap: string, coversAt: number): void {
  getDb()
    .prepare("UPDATE projects SET recap = ?, recap_at = ?, recap_covers_at = ? WHERE id = ?")
    .run(recap, Date.now(), coversAt, id);
}
