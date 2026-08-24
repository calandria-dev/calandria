import { nanoid } from "nanoid";
import { getDb } from "./db";
// Capability data comes from the SDK-free lib/agents/capabilities.ts, NOT the
// driver registry — importing the registry here would drag the agent SDKs
// (async Turbopack externals) into every module that touches the store and
// break sync route entries at runtime (see the note in that file).
import { modelContextWindow } from "./agents/capabilities";
import { SERVICE_PORT_BASE } from "./config";
import type { Project, Task, Message, PendingMessage, TaskComment, TaskDocComment, Summary, Session, Priority, Status, MsgRole, TurnUsage, UsageTotals, PermissionRule, PermissionMatchKind } from "./types";
export { addInternalUsage, type InternalJob } from "./internalUsage";

// ---------- projects ----------

// The single "needs you" predicate (over tasks aliased `t`): a real task,
// in progress, flagged awaiting_input. Deliberately NO running condition — a
// turn parked mid-stream on an AskUserQuestion has running=1 AND
// awaiting_input=1 and needs the user exactly as much as a settled one (the
// client-side isAwaiting in app/orchestrator/format.ts makes the same call).
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
// (app/orchestrator/snooze.ts nextWake) — the same refetch a task_edited does.
const NOT_SNOOZED = "(t.snoozed_until = 0 OR t.snoozed_until <= CAST(strftime('%s','now') AS INTEGER) * 1000)";
const NEEDS_YOU = `t.suggested = 0 AND t.status = 'in_progress' AND t.awaiting_input = 1 AND ${NOT_SNOOZED}`;

export function listProjects(): (Project & { task_count: number; last_activity: number; awaiting_count: number; cost_usd: number })[] {
  return getDb()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.suggested = 0) AS task_count,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${NEEDS_YOU}) AS awaiting_count,
         COALESCE((SELECT SUM(u.cost_usd) FROM task_usage u WHERE u.project_id = p.id), 0) AS cost_usd,
         (SELECT MAX(ts) FROM (
            SELECT MAX(updated_at) AS ts FROM tasks WHERE project_id = p.id
            UNION ALL SELECT MAX(started_at) FROM sessions WHERE project_id = p.id
            UNION ALL SELECT MAX(ended_at) FROM sessions WHERE project_id = p.id
            UNION ALL SELECT MAX(m.created_at) FROM messages m
              JOIN tasks t ON t.id = m.task_id WHERE t.project_id = p.id
          )) AS last_activity
       FROM projects p ORDER BY p.position ASC, p.created_at ASC`
    )
    .all() as (Project & { task_count: number; last_activity: number; awaiting_count: number; cost_usd: number })[];
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
// NEEDS_YOU predicate: in_progress with awaiting_input set — including a turn
// still live but parked on an AskUserQuestion) — the rows behind the titlebar
// "N need you" dropdown. `waiting_since` is when Claude last spoke (its final
// message of the paused turn), falling back to the task's updated_at when a task
// is awaiting with no messages yet; the UI renders it as "waiting for <duration>".
// Longest-waiting first, so the most-stale task sits at the top of the list.
export function listNeedsYou(): {
  id: string;
  project_id: string;
  title: string;
  project_name: string;
  project_color: string;
  project_icon: string;
  waiting_since: number;
}[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.title,
         p.name AS project_name, p.color AS project_color, p.icon AS project_icon,
         COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.task_id = t.id), t.updated_at) AS waiting_since
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

// Does this ONE task need the user right now? The same predicate the pill
// count and the dropdown use, asked of a single row — including the
// deprecated-project join listNeedsYou applies, since a project the user has
// archived should not buzz their phone.
//
// The notification emitter screens through this rather than trusting the event
// that woke it: a snoozed task, an unreviewed suggestion, and an ask that
// auto-denied on an unattended turn all publish the same "your turn" event,
// and none of them is a reason to interrupt anybody.
export function taskNeedsYou(id: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS ok FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? AND p.deprecated = 0 AND ${NEEDS_YOU}`
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
}[] {
  return getDb()
    .prepare(
      `SELECT t.id, t.project_id, t.title, t.status, t.running, t.awaiting_input, t.updated_at,
         p.name AS project_name, p.color AS project_color, p.icon AS project_icon
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE t.suggested = 0 AND p.deprecated = 0
       ORDER BY t.updated_at DESC`
    )
    .all() as ReturnType<typeof listAllTasksLite>;
}

export function createProject(input: {
  name: string;
  icon?: string;
  sub?: string;
  color?: string;
  context?: string;
  repo_path?: string;
  branch?: string;
}): Project {
  const now = Date.now();
  const id = nanoid();
  const icon = (input.icon || input.name.charAt(0) || "?").toUpperCase().slice(0, 1);
  // New projects sort to the bottom of the sidebar.
  const position = (getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM projects").get() as { n: number }).n;
  // New projects inherit the app-level default agent (Settings → Run defaults);
  // per-project it can then be changed in the Context editor.
  const defaultAgent = getSetting("default_agent") || "claude";
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, default_agent, port, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.name, icon, input.sub ?? "", input.color ?? "#C2603C", input.context ?? "", input.repo_path ?? "", input.branch ?? "main", defaultAgent, nextServicePort(), position, now);
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
  getDb()
    .prepare(
      `UPDATE projects SET name = ?, icon = ?, sub = ?, color = ?, context = ?, repo_path = ?, branch = ?,
        dev_command = ?, setup_command = ?, test_command = ?, default_agent = ?, send_context = ?, deprecated = ? WHERE id = ?`
    )
    .run(n.name, (n.icon || "?").toUpperCase().slice(0, 1), n.sub, n.color, n.context, n.repo_path, n.branch, n.dev_command ?? "", n.setup_command ?? "", n.test_command ?? "", n.default_agent || "claude", n.send_context ? 1 : 0, n.deprecated ? 1 : 0, id);
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
// `depends_on` lists the task ids this task is blocked by (see task_dependencies).
export type TaskWithUsage = Task & {
  cost_usd: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  context_tokens: number;
  context_pct: number;
  context_estimated: boolean;
  depends_on: string[];
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

export function listTasks(projectId: string): TaskWithUsage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.*,
         COALESCE((SELECT SUM(u.cost_usd) FROM task_usage u WHERE u.task_id = t.id), 0) AS cost_usd,
         COALESCE((SELECT SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens)
                   FROM task_usage u WHERE u.task_id = t.id), 0) AS total_tokens,
         COALESCE((SELECT SUM(u.cache_read_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS cache_read_tokens,
         COALESCE((SELECT SUM(u.cache_creation_tokens) FROM task_usage u WHERE u.task_id = t.id), 0) AS cache_creation_tokens,
         ${CONTEXT_TOKENS_SQL("t")} AS context_tokens,
         ${CONTEXT_ESTIMATED_SQL("t")} AS context_estimated
       FROM tasks t WHERE t.project_id = ?
       ORDER BY t.suggested ASC, t.position ASC, t.created_at ASC`
    )
    .all(projectId) as (Task & {
    cost_usd: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
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
  return rows.map((r) => ({
    ...r,
    context_pct: contextPct(r.context_tokens, r.agent, r.model),
    context_estimated: r.context_estimated === 1,
    depends_on: byTask.get(r.id) ?? [],
  }));
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

export function getTask(id: string): Task | undefined {
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
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
  /** The schedule that minted this task (lib/scheduler.ts). null for hand-made tasks. */
  schedule_id?: string | null;
  /** The runbook that dispatched this task (lib/dispatch.ts). null for hand-made tasks. */
  runbook_id?: string | null;
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
  // New tasks land at the end of the project's manual order.
  const position = (
    getDb().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tasks WHERE project_id = ?").get(input.project_id) as { n: number }
  ).n;
  getDb()
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, priority, status, suggested, agent, send_context, permission_mode, schedule_id, runbook_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, input.project_id, input.title, input.description ?? "", input.priority ?? "med", input.suggested ? 1 : 0,
      agent, sendContext ? 1 : 0, input.permission_mode || null, input.schedule_id ?? null, input.runbook_id ?? null,
      position, now, now
    );
  return getTask(id)!;
}

// The fields listTasks sorts by — everything needed to tell whether a reorder
// actually moves a card, read before the write rewrites the positions.
type OrderRow = { id: string; project_id: string; suggested: number; position: number; created_at: number };

// listTasks' `suggested ASC, position ASC, created_at ASC`, with the id as a
// final tiebreak so the comparison below is total (two rows CAN share a
// position — reorderTasks only renumbers the ids it's given).
function byRenderedOrder(a: OrderRow, b: OrderRow): number {
  return a.suggested - b.suggested || a.position - b.position || a.created_at - b.created_at || (a.id < b.id ? -1 : 1);
}

/** The listed ids per project, in the order given. */
function idsByProject(rows: OrderRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const seq = out.get(r.project_id);
    if (seq) seq.push(r.id);
    else out.set(r.project_id, [r.id]);
  }
  return out;
}

// Persist a manual task ordering (board drag / drop). `ids` is the desired
// order — each task's position is set to its index. The client sends the
// project's full task list flattened in column order; only relative order
// within a status group is ever rendered, so cross-group interleaving is fine.
//
// Returns the project ids whose RENDERED order actually changed — what POST
// /api/tasks/reorder announces on the bus. Rendered order, not raw position
// values, because the two come apart in both directions and only the first is
// something another tab could be drawing wrong:
//   - Positions go non-contiguous when a task is deleted (0, 1, 3), so the next
//     drop renumbers a row to 2 without moving a single card.
//   - The board submits ONE flat list with the Suggested column at the front,
//     while the tray renders suggestions last — so the submitted sequence is
//     compared per `suggested` group, the way the read sorts it.
// A drag that drops a card back where it started (or that only tidies the
// numbering) is therefore silent, instead of costing every open tab a refetch.
export function reorderTasks(ids: string[]): string[] {
  const db = getDb();
  // Read first: the write below is what we're comparing against.
  const sel = db.prepare("SELECT id, project_id, suggested, position, created_at FROM tasks WHERE id = ?");
  const rows = ids.map((id) => sel.get(id) as OrderRow | undefined).filter((r): r is OrderRow => !!r);
  const stmt = db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
  db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id));
  })();

  const submitted = new Map(ids.map((id, i) => [id, i]));
  const before = idsByProject([...rows].sort(byRenderedOrder));
  // After the write every listed row holds a distinct position (its index), so
  // `suggested` then submitted index is the whole sort key.
  const after = idsByProject([...rows].sort((a, b) => a.suggested - b.suggested || submitted.get(a.id)! - submitted.get(b.id)!));
  return [...after].filter(([pid, seq]) => before.get(pid)!.join() !== seq.join()).map(([pid]) => pid);
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
    return "a started task can't be moved — its git worktree belongs to the current project's repo";
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
  if (movers.length === 0) return { moved: [], from_project_ids: [], unchanged, skipped, dropped: [], kept: [] };

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
  const now = Date.now();

  db.transaction(() => {
    const unlink = db.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?");
    for (const e of dropped) unlink.run(e.task_id, e.depends_on_id);
    const reparent = db.prepare(
      `UPDATE tasks SET project_id = ?, position = ?, agent = ?, send_context = ?, model = ?, resolved_model = ?,
        reasoning = ?, permission_mode = ?, session_id = ?, updated_at = ? WHERE id = ?`
    );
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
        session_id = NULL, context_measured = NULL WHERE id = ?`
    );
    // Project-keyed child rows follow their task. These are the tables that
    // denormalize project ownership for per-project rollups (spend, session
    // counts, the merged-per-day charts) — left behind, they'd keep billing the
    // source project for a task it no longer owns.
    const repoint = ["sessions", "task_usage", "task_merges"].map((t) =>
      db.prepare(`UPDATE ${t} SET project_id = ? WHERE task_id = ?`)
    );
    for (const r of rows) {
      reparent.run(projectId, r.position, r.agent, r.send_context, r.model, r.resolved_model, r.reasoning, r.permission_mode, r.session_id, now, r.id);
      if (opts.resetCheckout?.has(r.id)) clearCheckout.run(r.id);
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
        session_id=?, worktree_path=?, work_branch=?, base_sha=?, merged_at=?, pr_url=?, generation=?, started=?, auto_start=?, withdrawn_reason=?, running=?, awaiting_input=?, background_pending=?, background_note=?, schedule_id=?, snoozed_until=?, start_at=?, context_measured=?, updated_at=? WHERE id=?`
    )
    .run(n.title, n.description, n.priority, n.status, n.suggested, n.agent, n.send_context ? 1 : 0, n.model ?? null, n.resolved_model ?? null, n.reasoning ?? null, n.permission_mode ?? null, n.session_id, n.worktree_path, n.work_branch, n.base_sha, n.merged_at, n.pr_url, n.generation, n.started, n.auto_start, n.withdrawn_reason ?? "", n.running, n.awaiting_input, n.background_pending ?? 0, n.background_note ?? "", n.schedule_id ?? null, n.snoozed_until ?? 0, n.start_at ?? 0, n.context_measured ?? null, n.updated_at, id);
  return getTask(id);
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
      `SELECT t.id, t.title, t.project_id, p.name AS project_name, p.repo_path, p.branch AS base_branch,
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
  usage: TurnUsage;
}): void {
  const u = input.usage;
  getDb()
    .prepare(
      `INSERT INTO task_usage
         (id, project_id, task_id, generation, agent, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nanoid(), input.project_id, input.task_id, input.generation, input.agent || "claude",
      u.cost_usd, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens,
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
  cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, turns: 0,
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

// Percent (0–100, one decimal) of the model's window that `tokens` occupies.
// The window itself comes from lib/agents/capabilities.ts (modelContextWindow).
function contextPct(tokens: number, agent: string | null | undefined, model: string | null | undefined): number {
  const window = modelContextWindow(agent, model);
  return window > 0 ? Math.round((tokens / window) * 1000) / 10 : 0;
}

export interface TaskContext {
  context_tokens: number; // input-side tokens of the latest main-session request ≈ context sent to the model
  context_window: number; // the model's window (tokens)
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
  return {
    context_tokens,
    context_window: modelContextWindow(task?.agent, task?.model),
    context_pct: contextPct(context_tokens, task?.agent, task?.model),
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
  /** Per-day token/cost usage. */
  usage: { d: string; p: string; a: string; cost: number; inp: number; out: number; cr: number; cw: number }[];
  /** Calandria's own one-shot work, kept separate from task usage. */
  internal: { d: string; p: string; a: string; job: string; n: number; cost: number; inp: number; out: number; cr: number; cw: number }[];
  /** Tasks whose (latest) merge landed that day. */
  shipped: { d: string; p: string; a: string; n: number }[];
  /** Lines landed on the base branch that day (from task_merges). */
  merges: { d: string; p: string; a: string; add: number; del: number }[];
  /** Distinct resolved models seen per agent (for the provider panel). */
  models: { a: string; m: string }[];
}

export function getInsightsData(sinceMs: number): InsightsData {
  const db = getDb();
  const projects = db
    .prepare("SELECT id, name, color, deprecated FROM projects ORDER BY position ASC, created_at ASC")
    .all() as InsightsData["projects"];
  const usage = db
    .prepare(
      `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d, project_id AS p,
              CASE WHEN agent = '' THEN 'claude' ELSE agent END AS a,
              SUM(cost_usd) AS cost, SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
              SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cw
       FROM task_usage WHERE created_at >= ? GROUP BY d, p, a`
    )
    .all(sinceMs) as InsightsData["usage"];
  const internal = db
    .prepare(
      `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d,
              COALESCE(project_id, '') AS p, agent AS a, job, COUNT(*) AS n,
              SUM(cost_usd) AS cost, SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
              SUM(cache_read_tokens) AS cr, SUM(cache_creation_tokens) AS cw
       FROM internal_usage WHERE created_at >= ? GROUP BY d, p, a, job`
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
  return { projects, usage, internal, shipped, merges, models };
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
