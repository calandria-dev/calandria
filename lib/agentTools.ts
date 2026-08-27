// Shared implementations of Calandria's agent-facing tools
// (suggest_task / list_tasks / get_task / update_task / withdraw_suggestion /
//  list_groups / expose_service / ask_user).
// One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. Both are deliberately split so the
// plain-Node bridge (scripts/calandria-mcp.mjs) can import the defs without pulling in
// the TS/SQLite graph.

import { nanoid } from "nanoid";
import { PRIORITIES, groupIsDone } from "./types";
import type { Project, Task, TaskGroup, ServiceInfo, Priority, Status, AskQuestion, PermissionOutcome, PermissionRequest, ToolData, AgentEditChange } from "./types";
import {
  createTask,
  setTaskDeps,
  addMessage,
  updateMessage,
  updateTask,
  getGroup,
  getProject,
  getTask,
  getTaskDeps,
  listGroups,
  listProjectsPlain,
  listTasks,
  recordAgentEdit,
  resolveGroup,
  sameDepSet,
} from "./store";
import { exposeService } from "./services";
import { publish, publishGlobal } from "./events";
import { waitForAnswer, settleAsk } from "./asks";
import { interactionDenied, recordUnattendedDenial, UNATTENDED_ASK_DENIAL, UNATTENDED_ASK_NOTE } from "./runContext";
import { turnSignal } from "./abort";
import { formatAnswers } from "./agents/shared";
import { resolveConnectedAgent } from "./agents/connections";

/** What `list_projects` hands the agent: enough to name a target, nothing more. */
export interface AgentProjectInfo {
  id: string;
  name: string;
  repo_path: string;
  /** True for the project the calling session is running in. */
  current: boolean;
}

/**
 * The `list_projects` tool. Discovery has to exist before `suggest_task`'s
 * `project` param is usable at all: resolution is strict, so without the exact
 * names and ids an agent could only guess, and a guess is a refusal.
 */
export function listProjectsForAgent(currentId: string): AgentProjectInfo[] {
  return listProjectsPlain().map((p) => ({ id: p.id, name: p.name, repo_path: p.repo_path, current: p.id === currentId }));
}

/**
 * Pick the project a `suggest_task` call is filing into: an exact id, else an
 * exact name compared case-insensitively, else a refusal that lists the names
 * it could have meant. Omitted (or blank) means the calling session's project.
 *
 * Deliberately strict in both directions. There is NO fallback to the calling
 * project on an unrecognized value — a task quietly misfiled into the repo the
 * session happens to be running in is worse than an error the agent can retry —
 * and a name matching two projects is refused rather than resolved by luck.
 * Ids beat names so an id is never shadowed by a project named after it.
 *
 * `current` may be a snapshot captured at turn start (the Claude driver's MCP
 * server closes over it), so even the no-ref path re-reads the row: the project
 * can be deleted while a turn runs.
 */
export function resolveTargetProject(current: Project, ref?: string): { project: Project } | { error: string } {
  const wanted = ref?.trim() ?? "";
  const projects = listProjectsPlain();
  const names = () => projects.map((p) => `"${p.name}"`).join(", ") || "(none)";

  if (!wanted) {
    const fresh = getProject(current.id);
    return fresh ? { project: fresh } : { error: `The project this session belongs to no longer exists.` };
  }
  const byId = projects.find((p) => p.id === wanted);
  if (byId) return { project: byId };

  const lower = wanted.toLowerCase();
  const byName = projects.filter((p) => p.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { project: byName[0] };
  if (byName.length > 1) {
    // Ids, not names: the name is precisely what failed to identify one, so
    // repeating it back would leave the agent no way to retry successfully.
    return {
      error:
        `"${wanted}" is ambiguous — ${byName.length} projects share that name. ` +
        `Pass one of these ids instead: ${byName.map((p) => p.id).join(", ")}. Nothing was created.`,
    };
  }
  return {
    error:
      `No project matches "${wanted}". Pass an exact project id, or a project name (case-insensitive) from: ${names()}. ` +
      `Call list_projects for the ids. Nothing was created.`,
  };
}

/**
 * Resolve a `group` parameter INSIDE one project — the group half of
 * resolveTargetProject, with the same posture: the container the model named is
 * checked before anything is written, and a miss is an error the agent can act
 * on rather than a quiet default.
 *
 * Two policies behind `create`, and the split is the whole design (store's
 * resolveGroup owns the mechanics; this owns the wording and the project the
 * lookup happens in):
 *   - `create: true` for suggest_task, the planning verb. The common case IS
 *     "this group doesn't exist yet", and demanding a create_group round trip
 *     first would repeat the two-phase dance blocked_by already forces on
 *     ordering. A near-miss minting a second group is bounded by
 *     UNIQUE(project_id, name) plus the tool result naming what happened.
 *   - strict for update_task, where the task already exists and a typo would
 *     mint a near-duplicate of a group the user is actively filtering by.
 *
 * The `project` is the TARGET (already resolved), never the calling session's —
 * a cross-project suggestion groups within the project it lands in, because a
 * group may not span repositories.
 *
 * The error is a FRAGMENT, not a sentence: the three callers frame a refusal
 * differently ("could not update…, nothing was changed" vs a read that changed
 * nothing by definition), and only they know which tail is true.
 */
export function resolveGroupRef(
  project: Project,
  ref: string,
  opts: { create?: boolean; originTaskId?: string | null } = {}
): { group: TaskGroup | null; created: boolean } | { error: string } {
  const wanted = ref.trim();
  // "" is not a miss: on update_task it is the documented way to UNGROUP, and
  // on the other two it means the parameter was left out.
  if (!wanted) return { group: null, created: false };
  try {
    const hit = resolveGroup(project.id, wanted, opts);
    if (hit) return hit;
  } catch (e) {
    // resolveGroup looked the name up before creating, so the only throw left
    // is the UNIQUE constraint losing a race with another session's create.
    return { error: `could not use group "${wanted}" in ${project.name}: ${(e as Error).message}` };
  }
  const names = listGroups(project.id).map((g) => `"${g.name}"`).join(", ") || "(none yet)";
  return {
    error:
      `no group in ${project.name} matches "${wanted}" — pass an existing group id or its exact name, from: ${names}. ` +
      `Call list_groups for them, or file the task with suggest_task's \`group\`, which creates a group that doesn't exist yet`,
  };
}

/** One row of `list_groups`: the feature, how far along it is, and what's in it. */
export interface AgentGroupInfo {
  id: string;
  name: string;
  description: string;
  /** Derived, never stored: every member terminal (and at least one member). */
  done: boolean;
  counts: TaskGroup["counts"];
  /** The session that planned this group, when an agent filed it. */
  origin_task_id: string | null;
  /** Its members. Titles ride along so "how's the migration going" needs no second call. */
  tasks: { id: string; title: string; status: Status }[];
}

/**
 * The `list_groups` tool. `project` is the TARGET board (already resolved), so
 * an agent can read another project's plans the way list_tasks reads its board.
 *
 * Members are listed with their titles rather than as bare ids: the question
 * this tool exists to answer in ONE call is "how is the auth migration going",
 * and a list of ids answers it only after N get_task calls — which is exactly
 * the paging the group noun was meant to end. Descriptions stay out, for the
 * same context reason lib/groupContext.ts leaves sibling briefs out.
 */
export function listGroupsForAgent(project: Project): AgentGroupInfo[] {
  const tasks = listTasks(project.id);
  return listGroups(project.id).map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    done: groupIsDone(g),
    counts: g.counts,
    origin_task_id: g.origin_task_id,
    tasks: tasks.filter((t) => t.group_id === g.id).map((t) => ({ id: t.id, title: t.title, status: t.status })),
  }));
}

/**
 * Key for the per-session title→id map. Scoped by project because dependencies
 * are: the same title suggested into two different projects is two unrelated
 * tasks, and only one of them can ever be a legal `blocked_by` ref for a given
 * suggestion. Scoping by construction beats detecting ambiguity after the fact.
 */
export function titleKey(projectId: string, title: string): string {
  return `${projectId}\u0000${title}`;
}

/**
 * Marks a title that two suggestions in one project now share. Stored in place
 * of an id so the ref resolves to nothing at all: choosing either task would be
 * a coin flip, and a wrong dependency is invisible where an unresolved ref is
 * reported straight back to the agent.
 */
const AMBIGUOUS = "\u0000ambiguous";

/** Record a suggestion's title -> id for later `blocked_by` refs, per target project. */
export function rememberSuggestedTitle(createdByTitle: Map<string, string>, projectId: string, title: string, taskId: string): void {
  const key = titleKey(projectId, title);
  createdByTitle.set(key, createdByTitle.has(key) ? AMBIGUOUS : taskId);
}

/**
 * Resolve `blocked_by` refs against a per-session title→id map: an id passes
 * through; a title of a task suggested earlier this session INTO THE SAME
 * TARGET PROJECT maps to its id; anything else is left as-is (createSuggestedTask
 * then reports it as unusable rather than dropping it silently).
 * Callers own the map because it is inherently session-scoped — the Claude
 * driver keeps one per turn, the stdio bridge keeps one per (per-turn) process.
 */
export function resolveTitleRefs(refs: string[] | undefined, createdByTitle: Map<string, string>, projectId: string): string[] {
  return (refs ?? []).map((ref) => {
    const hit = createdByTitle.get(titleKey(projectId, ref));
    return hit && hit !== AMBIGUOUS ? hit : ref;
  });
}

export interface SuggestTaskInput {
  title: string;
  description: string;
  priority?: Priority;
  /** Already resolved to task ids (see resolveTitleRefs) — id passes through to setTaskDeps. */
  blocked_by?: string[];
  /** Group ref (id or exact name) as the MODEL typed it — resolved in the target project, created on a miss. */
  group?: string;
  /** The CALLING session's task, recorded as the new group's origin. Never the model's word for it. */
  origin_task_id?: string | null;
}

/**
 * Create a suggested task in `project` and (optionally) set its dependencies.
 * `project` is the TARGET — already resolved by resolveTargetProject, which may
 * have picked a project other than the one the calling session runs in. Every
 * default the task is born with (its agent, send_context, board position) is
 * derived from this project by createTask, so handing in the wrong one mints a
 * task that can't run.
 *
 * Returns the created task plus the human-readable confirmation text both the
 * MCP server and the HTTP endpoint hand back to the agent verbatim. A null task
 * means the project vanished and nothing was made.
 */
export function createSuggestedTask(project: Project, input: SuggestTaskInput): { task: Task | null; text: string } {
  // `project` can be the snapshot captured at turn START (the Claude driver's
  // MCP server closes over it) — the row may have been deleted while the turn
  // ran, and inserting its id would hit tasks' project_id FOREIGN KEY. Re-read
  // at insert time and hand the agent a refusal instead of throwing.
  if (!getProject(project.id)) {
    return { task: null, text: `Could not add "${input.title}": the project no longer exists.` };
  }
  // The group is resolved in the TARGET project, before the insert — so a
  // cross-project suggestion groups within the project it lands in, and a task
  // is never created against a group that turned out to be unusable. Missing
  // names are created here (`create: true`); see resolveGroupRef for why this
  // verb creates where update_task refuses to.
  let group: TaskGroup | null = null;
  let groupCreated = false;
  if (input.group?.trim()) {
    const hit = resolveGroupRef(project, input.group, { create: true, originTaskId: input.origin_task_id ?? null });
    if ("error" in hit) return { task: null, text: `Could not add "${input.title}": ${hit.error}. Nothing was created.` };
    group = hit.group;
    groupCreated = hit.created;
  }
  const task = createTask({
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
    // Connected-first, matching the New-task dialog (defaultAgentFor). A task's
    // agent is fixed for its whole life, so inheriting an unconnected project
    // default would mint tasks that can never run — the exact way a Codex-only
    // instance would silently accumulate dead Claude tasks in the tray. Null
    // (nothing connected) leaves createTask's own default in place. The default
    // read here is the TARGET project's, not the calling session's.
    agent: resolveConnectedAgent([project.default_agent]) ?? undefined,
    group_id: group?.id ?? null,
  });
  // Say which of the two things happened to the group, always. "Created" is the
  // half that matters most — exact-match-or-create is only safe if a near-miss
  // that minted a SECOND group says so in the same breath, while the agent can
  // still reuse the right spelling for the rest of the batch.
  const groupNote = group ? (groupCreated ? ` Created group "${group.name}" in ${project.name}.` : ` Filed under group "${group.name}".`) : "";
  return {
    task,
    text: `Suggested task "${input.title}" added to ${project.name}'s tray (id: ${task.id}).${depNote(task, project, input.blocked_by)}${groupNote}`,
  };
}

/**
 * Wire a new suggestion's dependencies and describe what actually stuck.
 *
 * setTaskDeps only keeps refs pointing at tasks in the SAME project, and used
 * to drop the rest in silence — tolerable when every suggestion landed in the
 * session's own project, misleading now that a task can be filed anywhere: a
 * blocker id copied from the calling project would vanish while the tool still
 * reported success. So partition first and name the refs we couldn't use.
 */
function depNote(task: Task, project: Project, refs: string[] | undefined): string {
  if (!refs?.length) return "";
  const unique = [...new Set(refs)].filter((r) => r && r !== task.id);
  const usable = unique.filter((r) => getTask(r)?.project_id === project.id);
  const unusable = unique.filter((r) => !usable.includes(r));

  let note = "";
  if (usable.length) {
    try {
      setTaskDeps(task.id, usable);
      note = ` Blocked by ${usable.length} task(s).`;
    } catch (e) {
      // Only a cycle reaches here — setTaskDeps' other rejections were filtered above.
      note = ` (Could not set dependencies: ${(e as Error).message}.)`;
    }
  }
  if (unusable.length) {
    note +=
      ` Ignored ${unusable.length} blocked_by ref(s) that aren't tasks in ${project.name}: ` +
      `${unusable.map((r) => `"${r}"`).join(", ")}. Dependencies only work within one project.`;
  }
  return note;
}

/* ── Reading and updating tasks ──────────────────────────────────────────────
 *
 * Reads are inert, so they range over the board the same way suggest_task can
 * file into any project. Writes used to be bounded by ownership — the CALLING
 * task's own row, or an INERT TRAY SUGGESTION (isInertSuggestion below) nobody
 * had touched yet — and everything else, including a task the user had already
 * accepted and started, was refused outright.
 *
 * That gate is gone. An agent may now update ANY task in ANY project. The old
 * restriction's real cost was a long chain of accepted tasks going stale the
 * moment one fact changed — a planning session that learns something on task 3
 * had no way to correct task 1 except narrating the fix and making the user
 * apply it by hand. What replaces the gate is not a narrower permission but
 * VISIBILITY: a write to a row the old policy would have refused is RECORDED
 * (recordAgentEdit, below) so the board can show a "changed since you accepted
 * it" chip, a field-by-field diff, and a per-edit Revert — the user finds out
 * what changed and can undo it, rather than the write being silently blocked
 * or silently invisible.
 *
 * The one thing still refused is a row with a LIVE TURN in it that isn't the
 * caller's own — that session may be mid-way through reading the very fields
 * this call would rewrite, and there is no way to warn it. Nothing else is
 * off-limits: a suggestion, an accepted backlog item, a task on hold, even one
 * the user is actively viewing.
 */

/** One row of `list_tasks`: enough to reason about the board, no prose. */
export interface AgentTaskInfo {
  id: string;
  title: string;
  status: Status;
  priority: Priority;
  /** Still sitting unreviewed in the Suggested tray. */
  suggested: boolean;
  agent: string;
  /** A turn is streaming right now. */
  running: boolean;
  /** Ids this task is blocked by (edges never leave the project). */
  blocked_by: string[];
  /** The feature this is a step of, or null when ungrouped. Carried on every row, filtered or not. */
  group: { id: string; name: string } | null;
  /** True for the task the calling session is running in. */
  current: boolean;
}

/** A blocker, resolved to something readable — an id alone says nothing useful. */
export interface AgentTaskBlocker {
  id: string;
  title: string;
  status: Status;
  /** Terminal, i.e. no longer holding the dependent back (mirrors lib/autoStart.ts). */
  cleared: boolean;
}

/** What `get_task` hands back: the whole brief, plus its blockers spelled out. */
export interface AgentTaskDetail extends Omit<AgentTaskInfo, "blocked_by"> {
  description: string;
  project_id: string;
  project_name: string;
  started: boolean;
  awaiting_input: boolean;
  /** Starts by itself once its last blocker is marked done (lib/autoStart.ts). */
  auto_start: boolean;
  work_branch: string;
  worktree_path: string;
  merged: boolean;
  created_at: number;
  updated_at: number;
  blocked_by: AgentTaskBlocker[];
}

// done and cancelled are the terminal statuses — the same pair lib/autoStart.ts
// treats as "no longer blocking". Hidden from list_tasks by default so a long-
// lived board doesn't bury the open work under everything ever finished.
const TERMINAL: Status[] = ["done", "cancelled"];

function taskInfo(t: Task, deps: string[], currentTaskId: string, groups: Map<string, string>): AgentTaskInfo {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    suggested: t.suggested === 1,
    agent: t.agent,
    running: t.running === 1,
    blocked_by: deps,
    // Name as well as id: an id alone would force a list_groups call to make
    // sense of any row, and the name is what the user calls the feature.
    group: t.group_id && groups.has(t.group_id) ? { id: t.group_id, name: groups.get(t.group_id)! } : null,
    current: t.id === currentTaskId,
  };
}

/** id → name for one project's groups, so a board listing costs one extra query. */
function groupNames(projectId: string): Map<string, string> {
  return new Map(listGroups(projectId).map((g) => [g.id, g.name]));
}

/**
 * The `list_tasks` tool. `project` is the TARGET board (already resolved by
 * resolveTargetProject, so it may not be the session's own) and `currentTaskId`
 * only flags which row is the caller's — it can perfectly well be a task in
 * another project, in which case nothing is flagged.
 *
 * The caller's own row is exempt from the terminal-status filter: a session that
 * has just marked itself done should still see itself in the list it gets back.
 *
 * `groupId` is an already-resolved filter (resolveGroupRef, so an unknown ref is
 * the caller's refusal rather than a silently unfiltered board). null lists
 * everything — every row carries its own group either way, filtered or not.
 * The caller's own row is NOT exempt from this one: a filter that always
 * included a task from another feature would misreport the group.
 */
export function listTasksForAgent(project: Project, currentTaskId: string, includeDone = false, groupId: string | null = null): AgentTaskInfo[] {
  const groups = groupNames(project.id);
  return listTasks(project.id)
    .filter((t) => includeDone || !TERMINAL.includes(t.status) || t.id === currentTaskId)
    .filter((t) => !groupId || t.group_id === groupId)
    .map((t) => taskInfo(t, t.depends_on, currentTaskId, groups));
}

/**
 * The `get_task` tool. Reads by id across projects (reads are inert), so the
 * project name travels with the row — otherwise an agent reading a task it found
 * via list_projects has no idea which board it's looking at.
 */
export function getTaskForAgent(taskId: string, currentTaskId: string): AgentTaskDetail | null {
  const t = getTask(taskId);
  if (!t) return null;
  const project = getProject(t.project_id);
  const blocked_by: AgentTaskBlocker[] = getTaskDeps(t.id).flatMap((id) => {
    const dep = getTask(id);
    // A deleted blocker's edge cascades away with it, so this is belt-and-braces
    // — but reporting a bare id with no title would be worse than omitting it.
    return dep ? [{ id: dep.id, title: dep.title, status: dep.status, cleared: TERMINAL.includes(dep.status) }] : [];
  });
  return {
    ...taskInfo(t, [], currentTaskId, groupNames(t.project_id)),
    blocked_by,
    description: t.description,
    project_id: t.project_id,
    project_name: project?.name ?? "(deleted project)",
    started: t.started === 1,
    awaiting_input: t.awaiting_input === 1,
    auto_start: t.auto_start === 1,
    work_branch: t.work_branch,
    worktree_path: t.worktree_path,
    merged: t.merged_at > 0,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

/** The subset of a task row `update_task` will write. Every field is optional. */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: Priority;
  status?: Status;
  /**
   * The COMPLETE set of task ids this task is blocked by — it replaces whatever
   * was there, the way the edit dialog's DepPicker does, and `[]` clears it.
   * Omitted leaves the edges alone. Ids only: unlike suggest_task's version of
   * this parameter there is no per-session title map to resolve against here,
   * and inventing one would make the same string mean different things in the
   * two tools depending on what the process happened to have created.
   */
  blocked_by?: string[];
  /**
   * The group this task belongs to: an existing id or exact name in the task's
   * OWN project, or "" to ungroup. Omitted leaves it alone. STRICT, unlike
   * suggest_task's version — see the block in the body for why this one won't
   * create.
   */
  group?: string;
}

// "cancelled" is deliberately absent, for a reason that holds whichever row is
// being written. On the caller's OWN row it's self-destruction: PATCH
// /api/tasks/[id] calls abortTurn() on cancel, which would tear down the very
// turn making the tool call — the agent would kill itself mid-sentence and never
// see the result. On anyone else's, abandoning a task the user hasn't reviewed
// yet is a decision that needs a stated reason attached to it, which a bare
// status write has nowhere to put — that's withdraw_suggestion below.
const STATUSES: Status[] = ["not_started", "in_progress", "on_hold", "done"];

/**
 * Is this a row an agent other than its owner may write?
 *
 * Exactly one thing makes a task safe to edit from outside: nobody has started
 * it. `suggested` is that signal and it's a single flag, not a heuristic —
 * suggest_task is what sets it, and every path that puts a task to work clears
 * it in the SAME write that starts it (POST /api/tasks/[id]/messages sets
 * `suggested: 0, running: 1` together; the tray's Add does it without starting).
 * So `suggested === 1` already implies no session, no worktree and no turn.
 *
 * `started`/`running` are checked anyway rather than trusted as implications.
 * The user-facing PATCH route lets `suggested` be written directly, so the pair
 * can in principle be reconstructed on a live row — and this is the one place
 * where being wrong hands an agent somebody else's work.
 */
export function isInertSuggestion(t: Task): boolean {
  return t.suggested === 1 && t.started === 0 && t.running === 0;
}

/**
 * The `update_task` tool. Mirrors the user-facing PATCH /api/tasks/[id] over the
 * fields it accepts, minus the run-control plumbing that belongs to the UI.
 * `blocked_by` is here rather than there-only because it is the ONLY way an
 * agent can express order at all: suggest_task takes blockers in the same call
 * that invents the task, so a planning turn — which files its tasks in one
 * parallel batch and therefore has no ids yet — could never use it. See the
 * dependency block below for the two rules that differ from suggest_task's.
 *
 * `caller` is the session's own task and is TRUSTED — it never comes from the
 * model. The Claude driver closes over it; the bridge's endpoint reads it from
 * the env-injected CALANDRIA_TASK_ID. `targetRef` is the opposite: the id the MODEL
 * named, or undefined for "my own row". Everything that decides whether that id
 * may be written lives here, so the in-process server and the HTTP endpoint
 * behind the stdio bridge cannot drift into two different policies.
 *
 * Both rows are re-read before anything is written. `caller` may be the snapshot
 * captured at turn START, and a target read a moment ago may have been started
 * since — same defence createSuggestedTask takes against a project deleted
 * mid-turn. A null task back means nothing was written; `text` says why.
 *
 * The eligibility check and the write sit in one synchronous block with no
 * `await` between them. better-sqlite3 is synchronous and the app is a single
 * Node process, so nothing can interleave — the check-then-write is atomic
 * without a WHERE-guarded UPDATE.
 *
 * `autoStartDependents` is returned rather than acted on: firing it needs
 * lib/autoStart.ts, which reaches the runner and the agent SDKs, and this module
 * is pinned SDK-free (tests/importGraph.test.ts) because the internal HTTP
 * routes behind the stdio bridge import it. Callers that can, do — against the
 * returned task's id, which is the TARGET's, not the caller's.
 *
 * `wasAccepted` — captured on the PRE-PATCH row, before anything about it can
 * change — is true exactly when this write is one the old ownership gate would
 * have refused: not the caller's own row, and not an unreviewed tray
 * suggestion. That, and only that, is what gets recorded via recordAgentEdit
 * (see the block comment above this section for why) — an edit to the caller's
 * own row or to a suggestion nobody has looked at yet was always allowed and
 * isn't a surprise to anyone.
 */
export function updateTaskForAgent(
  caller: Task,
  targetRef: string | undefined,
  input: UpdateTaskInput
): { task: Task | null; text: string; autoStartDependents: boolean } {
  const wanted = targetRef?.trim() ?? "";
  const own = !wanted || wanted === caller.id;

  const cur = getTask(own ? caller.id : wanted);
  if (!cur) {
    return own
      ? { task: null, text: "Could not update this task: its row no longer exists.", autoStartDependents: false }
      : {
          task: null,
          text: `No task with id "${wanted}". Call list_tasks for the ids. Nothing was changed.`,
          autoStartDependents: false,
        };
  }
  // The one remaining cross-task refusal: a live turn is streaming in the
  // target and it isn't the caller's own. That session may be mid-way through
  // reading the very fields this call would rewrite, and there is no way to
  // warn it — everything else (an accepted task, one on hold, one the user is
  // actively viewing) is now writable, on the record (see wasAccepted below).
  if (!own && cur.running === 1) {
    return {
      task: null,
      text:
        `Could not update "${cur.title}": a turn is streaming in it right now, so another session is actively working from ` +
        `these fields. Try again once it finishes, or ask the user. Nothing was changed.`,
      autoStartDependents: false,
    };
  }
  // Captured on the PRE-PATCH row, before any field below can move `suggested`
  // out from under it: true exactly for the class of write the OLD gate used
  // to refuse outright. That, and only that, gets recorded as a visible edit.
  const wasAccepted = !own && !isInertSuggestion(cur);
  // Past this point the target is writable and the field rules are identical
  // either way — only the noun in the refusals changes, so the agent can tell
  // which row it just failed to write.
  const what = own ? "this task" : `"${cur.title}"`;
  const patch: Partial<Task> = {};
  const changed: string[] = [];
  // One AgentEditChange per field actually moving, in parallel with `changed`
  // above — `changed` is prose for the tool's own confirmation text, this is
  // structured data for the diff panel. Only populated when `wasAccepted`
  // matters, but built unconditionally: cheap, and keeping one code path per
  // field (rather than duplicating each push under an `if (wasAccepted)`)
  // is what keeps the two lists from drifting apart.
  const changes: AgentEditChange[] = [];
  const fail = (text: string) => ({ task: null, text, autoStartDependents: false });

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return fail(`Could not update ${what}: \`title\` was empty. Nothing was changed.`);
    if (title !== cur.title) {
      patch.title = title;
      changed.push(`title → "${title}"`);
      changes.push({ field: "title", before: cur.title, after: title, before_value: cur.title });
    }
  }
  if (input.description !== undefined && input.description !== cur.description) {
    patch.description = input.description;
    changed.push("description rewritten");
    // Full text, not a preview — the diff panel is what truncates, not the store.
    changes.push({ field: "description", before: cur.description, after: input.description, before_value: cur.description });
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority))
      return fail(`Could not update ${what}: "${input.priority}" isn't a priority. Use one of: ${PRIORITIES.join(", ")}. Nothing was changed.`);
    if (input.priority !== cur.priority) {
      patch.priority = input.priority;
      changed.push(`priority → ${input.priority}`);
      changes.push({ field: "priority", before: cur.priority, after: input.priority, before_value: cur.priority });
    }
  }
  if (input.status !== undefined) {
    if (input.status === "cancelled")
      return fail(
        `Could not update ${what}: cancelling a task is the user's call` +
          (own
            ? ", and it would abort this turn mid-flight. Use one of: " + STATUSES.join(", ") + ", or ask the user."
            : ". Use one of: " + STATUSES.join(", ") + ", or withdraw_suggestion if this suggestion is redundant and you can say why.") +
          ` Nothing was changed.`
      );
    if (!STATUSES.includes(input.status))
      return fail(`Could not update ${what}: "${input.status}" isn't a status. Use one of: ${STATUSES.join(", ")}. Nothing was changed.`);
    if (input.status !== cur.status) {
      patch.status = input.status;
      // Same reasoning as the PATCH route: a deliberate status change settles
      // the "needs you" flag. In practice it's already 0 — a turn parked on an
      // ask can't be calling this — but leaving a stale 1 behind a "done" would
      // keep the task in the project's awaiting count forever.
      patch.awaiting_input = 0;
      changed.push(`status → ${input.status}`);
      changes.push({ field: "status", before: cur.status, after: input.status, before_value: cur.status });
    }
  }

  // Group membership. Resolved STRICTLY, where suggest_task's version of this
  // parameter creates on a miss, and the asymmetry is the point: there, a group
  // that doesn't exist yet is the normal case (a plan being born, named once);
  // here the task already exists, the group probably does too, and a typo would
  // mint a near-duplicate of the very group the user is filtering their board
  // by — silently splitting a feature in two. So an unknown ref fails the WHOLE
  // call with the reason, exactly like an unusable `blocked_by` ref, and the
  // rename that shared the call doesn't land under a refusal saying nothing did.
  let nextGroupName = "";
  if (input.group !== undefined) {
    // "" is the documented way to take a task OUT of its group — the only
    // "clear it" spelling on this tool, since a JSON null can't reach the enum-
    // free string param the same way [] clears blocked_by.
    const wanted = typeof input.group === "string" ? input.group.trim() : "";
    let nextGroupId: string | null = null;
    if (wanted) {
      // The task's OWN project, never the caller's: this tool writes tray
      // suggestions in any project, and a group may not span repositories.
      const owner = getProject(cur.project_id);
      if (!owner) return fail(`Could not update ${what}: its project no longer exists.`);
      const hit = resolveGroupRef(owner, wanted);
      if ("error" in hit) return fail(`Could not update ${what}: ${hit.error}. Nothing was changed.`);
      nextGroupId = hit.group?.id ?? null;
      nextGroupName = hit.group?.name ?? "";
    }
    if (nextGroupId !== (cur.group_id ?? null)) {
      patch.group_id = nextGroupId;
      changed.push(nextGroupId ? `group → "${nextGroupName}"` : "no longer in a group");
      changes.push({
        field: "group",
        before: cur.group_id ? getGroup(cur.group_id)?.name ?? cur.group_id : "(none)",
        after: nextGroupId ? nextGroupName : "(none)",
        // Not the name — a group NAME can't be written back on revert, only the id.
        before_value: cur.group_id ?? null,
        after_value: nextGroupId ?? null,
      });
    }
  }

  // Dependencies. This is the parameter that makes an ordered plan expressible
  // at all: suggest_task can only take blockers in the call that invents the
  // task, i.e. before any of them has an id, so a planning turn that files its
  // tasks in one batch and works out the order afterwards had nowhere to put it.
  //
  // Two rules that differ from suggest_task's version, both because this one
  // REPLACES an existing set rather than filling in a blank one:
  //   - never on the caller's own row (below): blockers gate whether a task may
  //     START, and a session calling this has already started, so the edge would
  //     be inert on the scheduler and a lie on the board;
  //   - fail-closed on a ref it can't use. suggest_task partitions and reports,
  //     which is safe when the task is new and has no blockers to lose; here,
  //     wiring the refs we recognized and dropping the rest would quietly delete
  //     edges the agent never mentioned and still report success.
  let nextDeps: string[] | null = null;
  if (input.blocked_by !== undefined) {
    if (own)
      return fail(
        "Could not update this task: `blocked_by` can't be set on the task this session is running in. Dependencies gate " +
          "whether a task may START and this one already has, so the edge would do nothing but show the board a blocked task " +
          'that is running. Use status "on_hold" to park this task, or set the dependency on the suggestion that has to wait. ' +
          "Nothing was changed."
      );
    const here = getProject(cur.project_id)?.name ?? "this project";
    // The element type is only a promise on the HTTP path — the bridge's array
    // arrives from JSON, so a stray number would reach .trim() as a TypeError
    // and surface as a 500 instead of the refusal the agent can act on.
    const wanted = [...new Set(input.blocked_by.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean))];
    // Named one by one with the reason each failed — "ignored 2 refs" tells an
    // agent nothing it can act on, and the fix differs per reason (re-read the
    // id, file the blocker into the same project, drop the self-reference).
    const problems = wanted.flatMap((ref) => {
      if (ref === cur.id) return [`"${ref}" is this task itself`];
      const blocker = getTask(ref);
      if (!blocker) return [`"${ref}" isn't a task id`];
      if (blocker.project_id !== cur.project_id)
        return [`"${ref}" is in ${getProject(blocker.project_id)?.name ?? "another project"}, not ${here}`];
      return [];
    });
    if (problems.length)
      return fail(
        `Could not update ${what}: ${problems.join("; ")}. \`blocked_by\` takes task ids (from suggest_task or list_tasks) ` +
          `in the same project, and it replaces the whole set — so nothing was changed rather than wiring the refs that did ` +
          `work and silently dropping the rest. Pass the complete list of blockers.`
      );
    const depsBefore = getTaskDeps(cur.id);
    if (!sameDepSet(depsBefore, wanted)) {
      nextDeps = wanted;
      changed.push(wanted.length ? `blocked by ${wanted.length} task(s)` : "no longer blocked by anything");
      // The complete id list, not a rendered count — Revert has to be able to
      // wire the exact same set back, and a readable "3 tasks" names no ids.
      changes.push({
        field: "blocked_by",
        before: depsBefore.length ? `${depsBefore.length} task(s)` : "nothing",
        after: wanted.length ? `${wanted.length} task(s)` : "nothing",
        before_value: depsBefore,
        after_value: wanted,
      });
    }
  }

  if (!changed.length) {
    return {
      task: cur,
      // The dep count and the group ride along only when they were part of the
      // call. Edges have no order, so resubmitting the same set in a different
      // order lands here; re-stating the group a task is already in lands here
      // too — and "status not_started, priority med" alone would read as if the
      // tool had ignored the half the agent actually cared about.
      text:
        `No change: "${cur.title}" already matches what you passed (status ${cur.status}, priority ${cur.priority}` +
        `${input.blocked_by !== undefined ? `, blocked by ${getTaskDeps(cur.id).length} task(s)` : ""}` +
        `${input.group !== undefined ? (cur.group_id ? `, in group "${getGroup(cur.group_id)?.name ?? cur.group_id}"` : ", not in a group") : ""}).`,
      autoStartDependents: false,
    };
  }

  // Edges before fields, so the two writes can't half-land. setTaskDeps runs its
  // cycle guard BEFORE it opens its transaction, so a rejection here has touched
  // nothing at all — whereas patching the row first and then throwing would
  // leave a rename applied under a refusal that says nothing changed.
  if (nextDeps) {
    try {
      setTaskDeps(cur.id, nextDeps);
    } catch (e) {
      return fail(
        `Could not update ${what}: ${(e as Error).message} — those blockers would make a loop, so the task could never ` +
          `start. Nothing was changed. Check what each task is already blocked by with list_tasks.`
      );
    }
  }
  const updated = updateTask(cur.id, patch);
  if (!updated) return fail(`Could not update ${what}: its row no longer exists.`);

  // Record the edit when it's the class of write the old ownership gate used
  // to refuse outright (wasAccepted, captured on the pre-patch row above) —
  // this is what raises the "changed since you accepted it" chip. Before the
  // publish below, so a listener that refetches on task_edited sees the chip
  // already set rather than racing it. recordAgentEdit writes
  // tasks.agent_edited_at directly, so the `updated` row above is already
  // stale the moment this runs — re-read so the task this function RETURNS
  // carries the fresh chip instead of reporting 0 for a beat.
  let task = updated;
  if (wasAccepted && changes.length) {
    recordAgentEdit({
      task_id: cur.id,
      project_id: cur.project_id,
      actor_task_id: caller.id,
      actor_title: caller.title,
      actor_agent: caller.agent,
      changes,
    });
    task = getTask(cur.id) ?? updated;
  }

  // Announce it: the board is live and nothing else will publish for this write.
  // "task_edited" rather than "task_updated" because title/description/priority
  // moved too, and the coarse snapshot on the wire only carries status —
  // listeners have to refetch the row to see the rest (app/api/events/route.ts).
  // A deps-only change needs it most: the edges live in their own table, so the
  // refetch is the only thing that redraws the blocked badge — on the NEIGHBOUR
  // rows as well, which is why PATCH /api/tasks/[id] counts deps as an edit too.
  publishGlobal(task.id, { type: "task_edited" });

  // No auto-start sweep for a dependency change: clearing a task's last blocker
  // could only launch the task ITSELF, and neither this tool nor the edit
  // dialog's PATCH (app/api/tasks/[id]/route.ts) launches a task on its own
  // dependency edit — both fire the sweep only on the task's own transition to
  // terminal. The sweep below is for the OTHER direction: tasks blocked by
  // this one.
  const done = task.status === "done" && cur.status !== "done";
  return {
    task,
    text:
      `Updated "${task.title}": ${changed.join(", ")}.` +
      (done ? " Any task set to start when unblocked by this one will now launch." : "") +
      // An agent should know the edit is visible, not silent — it landed on a
      // row the user already reviewed and accepted as their own backlog item.
      (wasAccepted && changes.length
        ? " The user already accepted this task, so it's now flagged as changed on their board with a diff and a revert button."
        : ""),
    autoStartDependents: done,
  };
}

/**
 * The `withdraw_suggestion` tool: retract a tray suggestion that turned out to
 * be redundant, recording WHY on the row.
 *
 * The verb exists because the nearest alternative was wrong twice over. An agent
 * that wanted "get this off the board" had only `status: "done"`, which claims a
 * task nobody started is finished — and, worse, is the exact transition that
 * fires maybeAutoStartDependents(), so a tidy-up would silently launch real
 * sessions for anything auto-starting behind it.
 *
 * Not a delete, deliberately. The tray's Dismiss button already hard-deletes
 * (DELETE /api/tasks/[id]) and this app has no undo for that anywhere; an agent
 * quietly destroying a proposal the user hasn't read yet is not a call it gets
 * to make. So the row is cancelled but LEFT `suggested = 1`: it stays in the
 * tray, struck through with the reason beside it, and the user can revive it or
 * dismiss it for real. `cancelled` is already terminal and non-blocking in
 * lib/autoStart.ts, so nothing downstream waits on it forever.
 *
 * Eligibility is isInertSuggestion — the SAME helper update_task uses, shared so
 * the two policies cannot drift into "editable but not withdrawable" or worse.
 * `caller`/`targetRef` carry the same trust split as updateTaskForAgent: the
 * caller is the server's word, the target is the model's. There's no "my own
 * row" default here, and no need for one — a task with a live turn calling this
 * has running = 1, so it could never be eligible anyway.
 *
 * `autoStartDependents` rides back for the same reason it does on the done path,
 * and for the same caller to fire (this module is pinned SDK-free): a suggestion
 * can be another task's blocker, and cancelling it clears that edge. Firing the
 * sweep on THIS transition is what stops a withdrawal from stranding an
 * auto_start dependent unblocked-but-never-launched.
 */
export function withdrawSuggestionForAgent(
  caller: Task,
  targetRef: string | undefined,
  reason: string
): { task: Task | null; text: string; autoStartDependents: boolean } {
  const wanted = targetRef?.trim() ?? "";
  const fail = (text: string) => ({ task: null, text, autoStartDependents: false });

  if (!wanted) return fail("Could not withdraw: `task` is required — pass the id of the suggestion to retract. Nothing was changed.");
  // Required, and required to say something. An unexplained retraction leaves
  // the user a struck-through card and no way to judge whether to revive it.
  const why = reason?.trim() ?? "";
  if (!why) return fail("Could not withdraw: `reason` is required — say why the suggestion should be dropped. Nothing was changed.");

  if (wanted === caller.id)
    return fail("Could not withdraw this task: it's the one this session is running in, not an unreviewed suggestion. Nothing was changed.");

  // Read at WRITE time, never trusting what the model saw: the target may have
  // been started since it read the board. The check and the write share one
  // synchronous block (better-sqlite3, single process), so nothing interleaves.
  const cur = getTask(wanted);
  if (!cur) return fail(`No task with id "${wanted}". Call list_tasks for the ids. Nothing was changed.`);
  if (!isInertSuggestion(cur))
    return fail(
      `Could not withdraw "${cur.title}": it isn't an unreviewed suggestion, so it belongs to the user or to another session ` +
        `that may be working in it right now. Only tasks still sitting in the Suggested tray can be withdrawn. ` +
        `Say what you think should happen and let the user decide. Nothing was changed.`
    );
  if (cur.status === "cancelled")
    return { task: cur, text: `No change: "${cur.title}" is already withdrawn (${cur.withdrawn_reason || "no reason recorded"}).`, autoStartDependents: false };

  // suggested stays 1 on purpose — that flag is what keeps the row in the tray.
  // awaiting_input for the same reason update_task settles it on a status write:
  // a terminal row must not keep counting toward the project's "needs you" pill.
  const updated = updateTask(cur.id, { status: "cancelled", withdrawn_reason: why, awaiting_input: 0 });
  if (!updated) return fail(`Could not withdraw "${cur.title}": its row no longer exists.`);

  // task_edited, not task_updated: withdrawn_reason is a field the coarse
  // /api/events payload can't carry, so listeners have to refetch the row to
  // draw the struck-through card at all.
  publishGlobal(updated.id, { type: "task_edited" });

  return {
    task: updated,
    text:
      `Withdrew "${updated.title}" — it stays in the user's Suggested tray, struck through, with your reason on it, ` +
      `so they can revive it or dismiss it for good.`,
    // Cancelling is a blocker clearing. Anything auto-starting behind this
    // suggestion is now unblocked and must actually launch, or it waits forever.
    autoStartDependents: true,
  };
}

/**
 * Surface an ask_user question card and wait for the answer — the bridge-served
 * counterpart of the Claude driver's AskUserQuestion hook. Unlike suggest_task /
 * expose_service this is asynchronous by nature: we persist + publish the ask
 * card here (the same tool-row shape the runner writes, so the UI and the
 * /answer route treat it identically), then park a DETACHED waiter on
 * lib/asks.ts. The bridge polls takeAskOutcome() via the wait endpoint — no
 * long-held HTTP request, per the house rule. The waiter is tied to the live
 * turn's abort signal, so a Stop settles it as a dismissal.
 */
export function startAskUser(task: Task, questions: AskQuestion[]): { askId: string } {
  const askId = `ask-${nanoid()}`;
  // A turn that declared itself unattended (a scheduled firing) has nobody to
  // answer, and parking here is worse than useless: the bridge would poll for
  // an answer that never comes, holding the turn slot for as long as the
  // process lives, which makes every later occurrence of that schedule
  // `skipped_overlap`. Settle it at once — the same contract lib/permissions.ts
  // honors for the permission gate, on the other interactive path.
  if (interactionDenied(task.id)) return denyAskUnattended(task, askId, questions);
  const data: ToolData = { title: "Question for you", ask: { id: askId, questions } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  // The turn is live but parked on the user — same flag the runner sets for
  // Claude asks, driving the "Needs your input" badges. Cleared on answer below;
  // the runner's turn-end finally re-settles it either way.
  updateTask(task.id, { awaiting_input: 1 });
  publish(task.id, { type: "ask", id: askId, questions, msgId: m.id, generation: task.generation, ts: m.created_at });

  void waitForAnswer(task.id, askId, questions, turnSignal(task.id))
    .then((answers) => {
      data.ask = { id: askId, questions, answers };
      updateMessage(m.id, JSON.stringify(data));
      updateTask(task.id, { awaiting_input: 0 });
      publish(task.id, { type: "ask_answered", id: askId, answers, msgId: m.id, generation: task.generation });
      settleAsk(task.id, askId, formatAnswers(questions, answers));
    })
    .catch(() => {
      // Turn torn down (Stop) before an answer arrived. The card stays in the
      // transcript unanswered — answering it later falls back to the /answer
      // route's resolved:false path (a normal reply into a fresh turn).
      settleAsk(task.id, askId, "The user dismissed the question without answering.");
    });

  return { askId };
}

/**
 * Refuse an ask_user for a declared-unattended turn, on the record.
 *
 * Written as a SETTLED permission card rather than an ask card, for the same
 * reason the Claude driver's hook does it that way: an ask card in the
 * transcript promises an answer is coming, and this one never was. A decided
 * card says what was asked, that it was refused, and why — and it leaves
 * `awaiting_input` alone, because there is nothing for the user to do.
 * `recordUnattendedDenial` is what stops the schedule run from settling green
 * on a turn that stopped short of the job.
 */
function denyAskUnattended(task: Task, askId: string, questions: AskQuestion[]): { askId: string } {
  const asked = questions.map((q) => q.header?.trim() || q.question?.trim()).filter(Boolean).join(" · ");
  const request: PermissionRequest = {
    id: askId,
    tool: "ask_user",
    title: asked ? `Question for you: ${asked.slice(0, 200)}` : "The agent asked a question",
    detail: questions.map((q) => q.question).filter(Boolean).join("\n\n"),
    expiresAt: Date.now(),
  };
  const outcome: PermissionOutcome = { decision: "deny", auto: true, reason: "unattended", note: UNATTENDED_ASK_NOTE };
  const data: ToolData = { title: "Permission needed", permission: { request, outcome } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  recordUnattendedDenial(task.id);
  // Create-then-settle, exactly as the runner publishes a decided card, so a
  // live viewer and a reloaded snapshot render the identical row.
  publish(task.id, { type: "permission", request, msgId: m.id, generation: task.generation, ts: m.created_at });
  publish(task.id, { type: "permission_decided", id: askId, outcome, msgId: m.id, generation: task.generation });
  // The bridge polls for this; handing it the model-facing text now means the
  // very next poll returns instead of looping until the process dies.
  settleAsk(task.id, askId, UNATTENDED_ASK_DENIAL);
  return { askId };
}

/**
 * Register a service the agent just started (the expose_service tool). Records
 * the port/url so it shows in the Services panel and returns the URL to hand the
 * user, plus the confirmation text. We don't own the process — this entry is
 * informational (see lib/services.ts exposeService).
 */
export function registerExposedService(project: Project, name: string, port: number): { info: ServiceInfo; url: string; text: string } {
  const info = exposeService(project, name.trim() || "dev", port);
  const url = info.url ?? `http://localhost:${port}`;
  const text =
    `Registered "${info.name}" on port ${port}. It's reachable at ${url} — ` +
    `give the user this exact URL. It now shows in the project's Services panel` +
    (info.visibility === "private"
      ? ` (visibility: private — only the signed-in owner can open it; they can share it from the panel).`
      : ` (visibility: ${info.visibility}).`);
  return { info, url, text };
}
