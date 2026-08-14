// Shared implementations of the orchestrator's agent-facing tools
// (suggest_task / list_tasks / get_task / update_task / expose_service / ask_user).
// One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. Both are deliberately split so the
// plain-Node bridge (scripts/orch-mcp.mjs) can import the defs without pulling in
// the TS/SQLite graph.

import { nanoid } from "nanoid";
import type { Project, Task, ServiceInfo, Priority, Status, AskQuestion, ToolData } from "./types";
import {
  createTask,
  setTaskDeps,
  addMessage,
  updateMessage,
  updateTask,
  getProject,
  getTask,
  getTaskDeps,
  listProjectsPlain,
  listTasks,
} from "./store";
import { exposeService } from "./services";
import { publish, publishGlobal } from "./events";
import { waitForAnswer, settleAsk } from "./asks";
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
  });
  return { task, text: `Suggested task "${input.title}" added to ${project.name}'s tray (id: ${task.id}).${depNote(task, project, input.blocked_by)}` };
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
 * file into any project. WRITES are bounded by what nobody else is holding: a
 * turn runs detached for as long as it likes, and letting one retitle or close a
 * row another session is mid-flight on would let an agent rearrange live work.
 *
 * So update_task writes exactly two kinds of row: the CALLING task's own (the
 * one thing the session unambiguously owns), and any INERT TRAY SUGGESTION
 * (isInertSuggestion below) in any project. The second is what makes a planning
 * turn honest — an agent that files eight suggestions and then learns something
 * can go back and sharpen them instead of narrating a correction the user has to
 * apply by hand. It ranges across projects because suggest_task already files
 * across projects; a task you can create in project B but not fix there is a
 * seam, not a boundary.
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

function taskInfo(t: Task, deps: string[], currentTaskId: string): AgentTaskInfo {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    suggested: t.suggested === 1,
    agent: t.agent,
    running: t.running === 1,
    blocked_by: deps,
    current: t.id === currentTaskId,
  };
}

/**
 * The `list_tasks` tool. `project` is the TARGET board (already resolved by
 * resolveTargetProject, so it may not be the session's own) and `currentTaskId`
 * only flags which row is the caller's — it can perfectly well be a task in
 * another project, in which case nothing is flagged.
 *
 * The caller's own row is exempt from the terminal-status filter: a session that
 * has just marked itself done should still see itself in the list it gets back.
 */
export function listTasksForAgent(project: Project, currentTaskId: string, includeDone = false): AgentTaskInfo[] {
  return listTasks(project.id)
    .filter((t) => includeDone || !TERMINAL.includes(t.status) || t.id === currentTaskId)
    .map((t) => taskInfo(t, t.depends_on, currentTaskId));
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
    ...taskInfo(t, [], currentTaskId),
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
}

const PRIORITIES: Priority[] = ["hi", "med", "lo"];
// "cancelled" is deliberately absent, for a reason that holds whichever row is
// being written. On the caller's OWN row it's self-destruction: PATCH
// /api/tasks/[id] calls abortTurn() on cancel, which would tear down the very
// turn making the tool call — the agent would kill itself mid-sentence and never
// see the result. On anyone else's, abortTurn is a no-op (only inert rows are
// eligible) but abandoning a task the user hasn't reviewed yet is still their
// call. An agent that thinks a task should be dropped can say so and ask_user.
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
function isInertSuggestion(t: Task): boolean {
  return t.suggested === 1 && t.started === 0 && t.running === 0;
}

/**
 * The `update_task` tool. Mirrors the user-facing PATCH /api/tasks/[id] over the
 * fields it accepts, minus the run-control and dependency plumbing that belongs
 * to the UI.
 *
 * `caller` is the session's own task and is TRUSTED — it never comes from the
 * model. The Claude driver closes over it; the bridge's endpoint reads it from
 * the env-injected ORCH_TASK_ID. `targetRef` is the opposite: the id the MODEL
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
  // The whole cross-task boundary, in one place. Refuse with the reason the
  // agent needs to pick a different move — a bare "not allowed" invites a retry
  // with the same id.
  if (!own && !isInertSuggestion(cur)) {
    return {
      task: null,
      text:
        `Could not update "${cur.title}": it isn't an unreviewed suggestion, so it belongs to the user or to another session ` +
        `that may be working in it right now. Only tasks still sitting in the Suggested tray can be edited from outside. ` +
        `Use suggest_task to propose new work, or ask the user. Nothing was changed.`,
      autoStartDependents: false,
    };
  }
  // Past this point the target is writable and the field rules are identical
  // either way — only the noun in the refusals changes, so the agent can tell
  // which row it just failed to write.
  const what = own ? "this task" : `"${cur.title}"`;
  const patch: Partial<Task> = {};
  const changed: string[] = [];
  const fail = (text: string) => ({ task: null, text, autoStartDependents: false });

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return fail(`Could not update ${what}: \`title\` was empty. Nothing was changed.`);
    if (title !== cur.title) {
      patch.title = title;
      changed.push(`title → "${title}"`);
    }
  }
  if (input.description !== undefined && input.description !== cur.description) {
    patch.description = input.description;
    changed.push("description rewritten");
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority))
      return fail(`Could not update ${what}: "${input.priority}" isn't a priority. Use one of: ${PRIORITIES.join(", ")}. Nothing was changed.`);
    if (input.priority !== cur.priority) {
      patch.priority = input.priority;
      changed.push(`priority → ${input.priority}`);
    }
  }
  if (input.status !== undefined) {
    if (input.status === "cancelled")
      return fail(
        `Could not update ${what}: cancelling a task is the user's call` +
          (own ? ", and it would abort this turn mid-flight" : "") +
          `. Use one of: ${STATUSES.join(", ")}, or ask the user. Nothing was changed.`
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
    }
  }

  if (!changed.length) {
    return {
      task: cur,
      text: `No change: "${cur.title}" already matches what you passed (status ${cur.status}, priority ${cur.priority}).`,
      autoStartDependents: false,
    };
  }

  const updated = updateTask(cur.id, patch);
  if (!updated) return fail(`Could not update ${what}: its row no longer exists.`);

  // Announce it: the board is live and nothing else will publish for this write.
  // "task_edited" rather than "task_updated" because title/description/priority
  // moved too, and the coarse snapshot on the wire only carries status —
  // listeners have to refetch the row to see the rest (app/api/events/route.ts).
  publishGlobal(updated.id, { type: "task_edited" });

  const done = updated.status === "done" && cur.status !== "done";
  return {
    task: updated,
    text: `Updated "${updated.title}": ${changed.join(", ")}.${done ? " Any task set to start when unblocked by this one will now launch." : ""}`,
    autoStartDependents: done,
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
