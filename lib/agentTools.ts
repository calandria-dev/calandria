// Shared implementations of Calandria's agent-facing tools
// (suggest_task / list_tasks / get_task / update_task / move_task /
//  withdraw_suggestion / list_tags / expose_service / ask_user).
// One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. The split lets the plain-Node bridge
// (scripts/calandria-mcp.mjs) import the defs without pulling in the TS/SQLite
// graph.

import { nanoid } from "nanoid";
import { PRIORITIES, parseTagColor, tagIsDone } from "./types";
import type { Project, Task, Tag, ServiceInfo, Priority, Status, AskQuestion, PermissionOutcome, PermissionRequest, ToolData, AgentEditChange } from "./types";
import {
  createTask,
  setTaskDeps,
  addMessage,
  updateMessage,
  updateTask,
  getProject,
  getTask,
  getTaskDeps,
  getTaskTagIds,
  getTaskTags,
  listTags,
  listProjectsPlain,
  listTasks,
  recordAgentEdit,
  resolveTag,
  sameDepSet,
  setTaskTags,
  TagNameConflictError,
  updateTag,
} from "./store";
import { topoMembers } from "./tagContext";
// SDK-free, and already pinned that way. `resolveBaseBranch` is what puts the
// EFFECTIVE base on every task row an agent reads (never the raw column, so it
// never reimplements the fallback chain); `setTaskBaseBranch` is the whole
// retarget policy behind `set_base_branch`, shared with the route.
import { resolveBaseBranch, setTaskBaseBranch } from "./baseBranch";
// One name check, shared with PATCH /api/tags/[id]: a tag's base branch is a
// string that reaches a `git` argv later, and `--upload-pack=evil` is a
// perfectly ordinary-looking one.
import { refNameSafe } from "./git";
import { withTaskLock } from "./taskLock";
// The re-parenting operation itself, shared with POST /api/tasks/[id]/move and
// POST /api/tasks/move. SDK-free and pinned that way, like this module.
import { moveTasksToProject } from "./taskMove";
import { exposeService } from "./services";
import { publish, publishGlobal } from "./events";
import { waitForAnswer, settleAsk, ASK_DISMISSED_REPLY, ASK_INTERRUPTED_NOTE } from "./asks";
import { interactionDenied, recordUnattendedDenial, UNATTENDED_ASK_DENIAL, UNATTENDED_ASK_NOTE } from "./runContext";
import { turnSignal } from "./abort";
import { formatAnswers } from "./agents/shared";
import { resolveConnectedAgent } from "./agents/connections";
import { cloudOverrideEnv, describeProvider, providerPresetEnv, taskProvider, type AgentEnv } from "./agentEnv";
import { LOCAL_MODEL_BASE_URL } from "./config";

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
 * Strict in both directions: an unrecognized value never falls back to the
 * calling project, and a name matching two projects is refused, never
 * resolved by luck. Ids beat names so an id is never shadowed by a project
 * named after it.
 *
 * `current` may be a snapshot captured at turn start (the Claude driver's MCP
 * server closes over it), so even the no-ref path re-reads the row: the project
 * can be deleted while a turn runs.
 */
export function resolveTargetProject(
  current: Project,
  ref?: string,
  /**
   * How the refusal ends. Every caller has to say that nothing happened, and
   * what "nothing" was differs per tool (`suggest_task` created no task,
   * `move_task` moved none), so the sentence is the caller's own, not a
   * generic one that would be wrong for one of them.
   */
  nothingHappened = "Nothing was created."
): { project: Project } | { error: string } {
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
        `Pass one of these ids instead: ${byName.map((p) => p.id).join(", ")}. ${nothingHappened}`,
    };
  }
  return {
    error:
      `No project matches "${wanted}". Pass an exact project id, or a project name (case-insensitive) from: ${names()}. ` +
      `Call list_projects for the ids. ${nothingHappened}`,
  };
}

/**
 * Resolve the `tags` parameter INSIDE one project, the tag half of
 * resolveTargetProject: every label the model named is checked before
 * anything is written, and a miss is an error the agent can act on rather
 * than a default.
 *
 * `create` splits into two policies (store's resolveTag owns the mechanics;
 * this owns the wording and the project the lookup happens in): `create:
 * true` for suggest_task, since a planning turn's common case is "this tag
 * doesn't exist yet" and demanding a create_tag round trip first would repeat
 * the two-phase dance blocked_by already forces on ordering; strict for
 * update_task, where the task already exists and a typo would mint a
 * near-duplicate of a tag the user is actively filtering by.
 *
 * `project` is the TARGET (already resolved), never the calling session's: a
 * cross-project suggestion tags within the project it lands in, because a tag
 * may not span repositories.
 *
 * ALL-OR-NOTHING across the list: one unusable ref refuses the whole call, so
 * nothing is written for the refs that did resolve, matching the reasoning
 * `blocked_by` on update_task uses. With `create` on, a tag minted for an
 * earlier ref survives the refusal; an empty tag nobody used is a smaller
 * wrong than unwinding creates another session may already be reading.
 *
 * The error is a FRAGMENT, not a sentence: the three callers frame a refusal
 * differently ("could not update..., nothing was changed" vs a read that
 * changed nothing by definition), and only they know which tail is true.
 */
export function resolveTagRefs(
  project: Project,
  refs: string[],
  opts: { create?: boolean; originTaskId?: string | null } = {}
): { tags: Tag[]; created: Tag[] } | { error: string } {
  const wanted = refs.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean);
  // An empty list is not a miss: on update_task it is the documented way to
  // clear every tag, and on the other two it means the parameter was left out.
  if (!wanted.length) return { tags: [], created: [] };
  const tags: Tag[] = [];
  const created: Tag[] = [];
  for (const ref of wanted) {
    let hit: { tag: Tag; created: boolean } | null;
    try {
      hit = resolveTag(project.id, ref, opts);
    } catch (e) {
      // resolveTag looks the name up before creating, so the only throw left
      // is the UNIQUE constraint losing a race with another session's create.
      return { error: `could not use tag "${ref}" in ${project.name}: ${(e as Error).message}` };
    }
    if (!hit) {
      const names = listTags(project.id).map((t) => `"${t.name}"`).join(", ") || "(none yet)";
      return {
        error:
          `no tag in ${project.name} matches "${ref}" — pass an existing tag id or its exact name, from: ${names}. ` +
          `Call list_tags for them, or file the task with suggest_task's \`tags\`, which creates a tag that doesn't exist yet`,
      };
    }
    // A list naming the same tag twice is the model being emphatic, not two
    // memberships: task_tags' primary key would refuse the second anyway.
    if (tags.some((t) => t.id === hit!.tag.id)) continue;
    tags.push(hit.tag);
    if (hit.created) created.push(hit.tag);
  }
  return { tags, created };
}

/** One row of `list_tags`: the label, how far along its work is, and what carries it. */
export interface AgentTagInfo {
  id: string;
  name: string;
  description: string;
  /** Derived, never stored: every member terminal (and at least one member). */
  done: boolean;
  counts: Tag["counts"];
  /**
   * The branch tasks carrying this tag are cut from; "" = they follow the
   * project's default. It applies until a task's worktree is cut, after which
   * that task's own base is pinned, so this is the plan's default, not a
   * statement about every member (`get_task` carries each member's resolved
   * answer).
   */
  base_branch: string;
  /** The session that planned this tag, when an agent filed it. */
  origin_task_id: string | null;
  /** Its members. Titles ride along so "how's the migration going" needs no second call. */
  tasks: { id: string; title: string; status: Status }[];
}

/**
 * The `list_tags` tool. `project` is the TARGET board (already resolved), so
 * an agent can read another project's plans the way list_tasks reads its board.
 *
 * Members are listed with their titles, not as bare ids: the question
 * this tool exists to answer in ONE call is "how is the auth migration going",
 * and a list of ids answers it only after N get_task calls. Descriptions stay
 * out, for the same context reason lib/tagContext.ts leaves sibling briefs out.
 */
export function listTagsForAgent(project: Project): AgentTagInfo[] {
  const tasks = listTasks(project.id);
  return listTags(project.id).map((tag) => ({
    id: tag.id,
    name: tag.name,
    description: tag.description,
    done: tagIsDone(tag),
    counts: tag.counts,
    base_branch: tag.base_branch,
    origin_task_id: tag.origin_task_id,
    // Plan order, not the tray's recency order: topoMembers is what numbers
    // the steps on screen and in a session's tag context block, and an agent
    // asking "how is it going" is asking about the same sequence.
    tasks: topoMembers(tasks.filter((t) => t.tag_ids.includes(tag.id))).map((t) => ({ id: t.id, title: t.title, status: t.status })),
  }));
}

/**
 * Key for the per-session title-to-id map. Scoped by project because
 * dependencies are: the same title suggested into two different projects is
 * two unrelated tasks, and only one of them can ever be a legal `blocked_by`
 * ref for a given suggestion. Scoping by construction beats detecting
 * ambiguity after the fact.
 */
export function titleKey(projectId: string, title: string): string {
  return `${projectId}\u0000${title}`;
}

/**
 * Marks a title that two suggestions in one project now share. Stored in place
 * of an id so the ref resolves to nothing: choosing either task would be a
 * coin flip, and a wrong dependency is invisible where an unresolved ref is
 * reported straight back to the agent.
 */
const AMBIGUOUS = "\u0000ambiguous";

/** Record a suggestion's title -> id for later `blocked_by` refs, per target project. */
export function rememberSuggestedTitle(createdByTitle: Map<string, string>, projectId: string, title: string, taskId: string): void {
  const key = titleKey(projectId, title);
  createdByTitle.set(key, createdByTitle.has(key) ? AMBIGUOUS : taskId);
}

/**
 * Resolve `blocked_by` refs against a per-session title-to-id map: an id
 * passes through; a title of a task suggested earlier this session INTO THE
 * SAME TARGET PROJECT maps to its id; anything else is left as-is
 * (createSuggestedTask reports such a ref as unusable and does not drop it).
 * Callers own the map because it is session-scoped: the Claude driver keeps
 * one per turn, the stdio bridge keeps one per (per-turn) process.
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
  /** Already resolved to task ids (see resolveTitleRefs); id passes through to setTaskDeps. */
  blocked_by?: string[];
  /** Tag refs (ids or exact names) as the MODEL typed them, resolved in the target project, created on a miss. */
  tags?: string[];
  /** The CALLING session's task, recorded as a new tag's origin. Never the model's word for it. */
  origin_task_id?: string | null;
  /**
   * Where the new task's turns run (lib/agentEnv.ts). "local" pins it to the
   * local model server, the delegation case where a frontier-model session
   * hands routine work to a model that costs no quota. "cloud" pins it to the
   * agent's own login inside a project whose default is local. Omitted = inherit.
   */
  provider?: "local" | "cloud";
  /** The model to run on: an Ollama tag for local, a catalog id for cloud. */
  model?: string;
}

/**
 * Create a suggested task in `project` and (optionally) set its dependencies.
 * `project` is the TARGET, already resolved by resolveTargetProject, which may
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
  // MCP server closes over it), and the row may have been deleted while the
  // turn ran, so inserting its id would hit tasks' project_id FOREIGN KEY.
  // Re-read at insert time and hand the agent a refusal instead of throwing.
  if (!getProject(project.id)) {
    return { task: null, text: `Could not add "${input.title}": the project no longer exists.` };
  }
  // Tags are resolved in the TARGET project, before the insert, so a
  // cross-project suggestion tags within the project it lands in, and a task is
  // never created against a tag that turned out to be unusable. Missing names
  // are created here (`create: true`); see resolveTagRefs for why this verb
  // creates where update_task refuses to.
  let tags: Tag[] = [];
  let createdTags: Tag[] = [];
  if (input.tags?.length) {
    const hit = resolveTagRefs(project, input.tags, { create: true, originTaskId: input.origin_task_id ?? null });
    if ("error" in hit) return { task: null, text: `Could not add "${input.title}": ${hit.error}. Nothing was created.` };
    tags = hit.tags;
    createdTags = hit.created;
  }
  // The provider override, resolved BEFORE the insert so a task is never
  // created pointing at nothing. "local" reuses the target project's own
  // endpoint when it already has one (a project on a LAN box must not be
  // redirected to the instance default) and falls back to the instance knob;
  // the model is the caller's, else the project's, and with neither the call
  // is refused, since a local task with no model would ask Ollama for a Claude id.
  const model = input.model?.trim() || null;
  let agentEnv: AgentEnv | undefined;
  if (input.provider === "local") {
    const current = taskProvider(project);
    const localModel = model ?? current.model;
    if (!localModel) {
      return {
        task: null,
        text: `Could not add "${input.title}": provider "local" needs a model — pass one (an Ollama tag such as qwen3-coder), or set a local model on ${project.name} in its settings. Nothing was created.`,
      };
    }
    agentEnv = providerPresetEnv({
      baseUrl: current.kind === "cloud" ? LOCAL_MODEL_BASE_URL : (current.anthropic_base_url ?? current.openai_base_url ?? LOCAL_MODEL_BASE_URL),
      model: localModel,
      token: current.auth_token ?? undefined,
    });
  } else if (input.provider === "cloud") {
    agentEnv = cloudOverrideEnv();
  }
  const task = createTask({
    model,
    agent_env: agentEnv,
    project_id: project.id,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "med",
    suggested: true,
    // Connected-first, matching the New-task dialog (defaultAgentFor). A task's
    // agent is fixed for its whole life, so inheriting an unconnected project
    // default would mint tasks that can never run: the way a Codex-only
    // instance would accumulate dead Claude tasks in the tray. Null (nothing
    // connected) leaves createTask's own default in place. The default read
    // here is the TARGET project's, not the calling session's.
    agent: resolveConnectedAgent([project.default_agent]) ?? undefined,
    tag_ids: tags.map((t) => t.id),
  });
  // Say which of the two things happened to each tag, always. "Created" is the
  // half that matters most: exact-match-or-create is only safe if a near-miss
  // that minted a SECOND tag says so in the same breath, while the agent can
  // still reuse the right spelling for the rest of the batch. Named separately
  // from the reused ones for that reason: "tagged X, Y" would bury the one
  // word that tells a planning turn its second call spelled it differently.
  const reused = tags.filter((t) => !createdTags.some((c) => c.id === t.id));
  const tagNote =
    (reused.length ? ` Tagged ${reused.map((t) => `"${t.name}"`).join(", ")}.` : "") +
    (createdTags.length ? ` Created tag${createdTags.length === 1 ? "" : "s"} ${createdTags.map((t) => `"${t.name}"`).join(", ")} in ${project.name}.` : "");
  const providerNote = agentEnv
    ? ` Runs against ${input.provider === "cloud" ? "the agent's own cloud login" : `the local model server (${describeProvider(agentEnv).host}, model ${describeProvider(agentEnv).model})`}.`
    : "";
  return {
    task,
    text: `Suggested task "${input.title}" added to ${project.name}'s tray (id: ${task.id}).${depNote(task, project, input.blocked_by)}${tagNote}${providerNote}`,
  };
}

/**
 * Wire a new suggestion's dependencies and describe what actually stuck.
 *
 * setTaskDeps only keeps refs pointing at tasks in the SAME project and drops
 * the rest without saying so, which would be misleading now that a task can
 * be filed anywhere: a blocker id copied from the calling project would
 * vanish while the tool still reported success. So partition first and name
 * the refs that couldn't be used.
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
      // Only a cycle reaches here: setTaskDeps' other rejections were filtered above.
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
 * file into any project. An agent may update ANY task in ANY project.
 *
 * A write to a row the caller doesn't own (not its own row, not an unreviewed
 * tray suggestion, i.e. not isInertSuggestion below) is RECORDED
 * (recordAgentEdit, below), so the board shows a "changed since you accepted
 * it" chip, a field-by-field diff and a per-edit Revert: the user finds out
 * what changed and can undo it.
 *
 * The one thing refused is a row with a LIVE TURN in it that isn't the
 * caller's own: that session may be mid-way through reading the very fields
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
  /** The tags it carries, in tag order; [] when untagged. Carried on every row, filtered or not. */
  tags: { id: string; name: string }[];
  /**
   * The RESOLVED base branch: what this task was cut from, what Sync catches it
   * up to and what Merge lands it into. The effective answer, never the raw
   * column: the chain is the task's own base -> the first of its tags that sets
   * one -> the project's default (lib/baseBranch.ts), and an agent asking "what
   * am I based on" reads this field instead of reimplementing the chain. "" only
   * when the project has no base branch configured at all.
   */
  base_branch: string;
  /** True for the task the calling session is running in. */
  current: boolean;
}

/** A blocker, resolved to something readable: an id alone says nothing useful. */
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

// done and cancelled are the terminal statuses, the same pair lib/autoStart.ts
// treats as "no longer blocking". Hidden from list_tasks by default so a long-
// lived board doesn't bury the open work under everything ever finished.
const TERMINAL: Status[] = ["done", "cancelled"];

function taskInfo(
  t: Task & { tag_ids?: string[] },
  deps: string[],
  currentTaskId: string,
  tagNamesById: Map<string, string>,
  projectBranch: string
): AgentTaskInfo {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    suggested: t.suggested === 1,
    agent: t.agent,
    running: t.running === 1,
    blocked_by: deps,
    // Names as well as ids: an id alone would force a list_tags call to make
    // sense of any row, and the name is what the user calls the feature.
    // `tag_ids` rides listTasks; get_task reads a bare row, so it passes its own.
    tags: (t.tag_ids ?? getTaskTagIds(t.id))
      .filter((id) => tagNamesById.has(id))
      .map((id) => ({ id, name: tagNamesById.get(id)! })),
    base_branch: resolveBaseBranch(t, { branch: projectBranch }),
    current: t.id === currentTaskId,
  };
}

/** id -> name for one project's tags, so a board listing costs one extra query. */
function tagNames(projectId: string): Map<string, string> {
  return new Map(listTags(projectId).map((t) => [t.id, t.name]));
}

/**
 * The `list_tasks` tool. `project` is the TARGET board (already resolved by
 * resolveTargetProject, so it may not be the session's own) and `currentTaskId`
 * only flags which row is the caller's; it can perfectly well be a task in
 * another project, in which case nothing is flagged.
 *
 * The caller's own row is exempt from the terminal-status filter: a session that
 * has just marked itself done should still see itself in the list it gets back.
 *
 * `tagId` is an already-resolved filter (resolveTagRefs, so an unknown ref is
 * the caller's own refusal, not an unfiltered board). null lists everything;
 * every row carries its own tags either way, filtered or not. The caller's own
 * row is NOT exempt from this one: a filter that always included a task from
 * another feature would misreport the tag.
 */
export function listTasksForAgent(project: Project, currentTaskId: string, includeDone = false, tagId: string | null = null): AgentTaskInfo[] {
  const names = tagNames(project.id);
  return listTasks(project.id)
    .filter((t) => includeDone || !TERMINAL.includes(t.status) || t.id === currentTaskId)
    .filter((t) => !tagId || t.tag_ids.includes(tagId))
    .map((t) => taskInfo(t, t.depends_on, currentTaskId, names, project.branch));
}

/**
 * The `get_task` tool. Reads by id across projects (reads are inert), so the
 * project name travels with the row: otherwise an agent reading a task it found
 * via list_projects has no idea which board it's looking at.
 */
export function getTaskForAgent(taskId: string, currentTaskId: string): AgentTaskDetail | null {
  const t = getTask(taskId);
  if (!t) return null;
  const project = getProject(t.project_id);
  const blocked_by: AgentTaskBlocker[] = getTaskDeps(t.id).flatMap((id) => {
    const dep = getTask(id);
    // A deleted blocker's edge cascades away with it, so this check is
    // belt-and-braces, but reporting a bare id with no title would be worse
    // than omitting it.
    return dep ? [{ id: dep.id, title: dep.title, status: dep.status, cleared: TERMINAL.includes(dep.status) }] : [];
  });
  return {
    ...taskInfo(t, [], currentTaskId, tagNames(t.project_id), project?.branch ?? ""),
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
   * The COMPLETE set of task ids this task is blocked by. It replaces whatever
   * was there, the way the edit dialog's DepPicker does, and `[]` clears it.
   * Omitted leaves the edges alone. Ids only: unlike suggest_task's version of
   * this parameter there is no per-session title map to resolve against here,
   * and inventing one would make the same string mean different things in the
   * two tools depending on what the process happened to have created.
   */
  blocked_by?: string[];
  /**
   * The COMPLETE set of tags this task carries: existing ids or exact names in
   * the task's OWN project, replacing whatever it had, and `[]` clears them
   * all. Omitted leaves them alone. STRICT, unlike suggest_task's version; see
   * the block in the body for why this one won't create.
   */
  tags?: string[];
}

/** ", tagged \"a\", \"b\"" / ", untagged": the tail the no-change reply reads back. */
function tagsPhrase(tags: Tag[]): string {
  return tags.length ? `, tagged ${tags.map((t) => `"${t.name}"`).join(", ")}` : ", untagged";
}

// "cancelled" is absent, for a reason that holds whichever row is being
// written. On the caller's OWN row it's self-destruction: PATCH
// /api/tasks/[id] calls abortTurn() on cancel, which would tear down the very
// turn making the tool call, so the agent would kill itself mid-sentence and
// never see the result. On anyone else's, abandoning a task the user hasn't
// reviewed yet is a decision that needs a stated reason attached to it, which
// a bare status write has nowhere to put; that's withdraw_suggestion below.
const STATUSES: Status[] = ["not_started", "in_progress", "on_hold", "done"];

/**
 * Is this a row an agent other than its owner may write?
 *
 * Exactly one thing makes a task safe to edit from outside: nobody has started
 * it. `suggested` is that signal and it's a single flag, not a heuristic:
 * suggest_task is what sets it, and every path that puts a task to work clears
 * it in the SAME write that starts it (POST /api/tasks/[id]/messages sets
 * `suggested: 0, running: 1` together; the tray's Add does it without starting).
 * So `suggested === 1` already implies no session, no worktree and no turn.
 *
 * `started`/`running` are checked anyway, not merely trusted as implications,
 * since the user-facing PATCH route lets `suggested` be written directly, so
 * the pair can in principle be reconstructed on a live row, and being wrong
 * here hands an agent somebody else's work.
 */
export function isInertSuggestion(t: Task): boolean {
  return t.suggested === 1 && t.started === 0 && t.running === 0;
}

/**
 * The `update_task` tool. Mirrors the user-facing PATCH /api/tasks/[id] over the
 * fields it accepts, minus the run-control plumbing that belongs to the UI.
 * `blocked_by` lives here, not on suggest_task, only because it is the ONLY way an
 * agent can express order at all: suggest_task takes blockers in the same call
 * that invents the task, so a planning turn, which files its tasks in one
 * parallel batch and therefore has no ids yet, could never use it. See the
 * dependency block below for the two rules that differ from suggest_task's.
 *
 * `caller` is the session's own task and is TRUSTED: it never comes from the
 * model. The Claude driver closes over it; the bridge's endpoint reads it from
 * the env-injected CALANDRIA_TASK_ID. `targetRef` is the opposite: the id the MODEL
 * named, or undefined for "my own row". Everything that decides whether that id
 * may be written lives here, so the in-process server and the HTTP endpoint
 * behind the stdio bridge cannot drift into two different policies.
 *
 * Both rows are re-read before anything is written. `caller` may be the snapshot
 * captured at turn START, and a target read a moment ago may have been started
 * since, the same defence createSuggestedTask takes against a project deleted
 * mid-turn. A null task back means nothing was written; `text` says why.
 *
 * The eligibility check and the write sit in one synchronous block with no
 * `await` between them. better-sqlite3 is synchronous and the app is a single
 * Node process, so nothing can interleave: the check-then-write is atomic
 * without a WHERE-guarded UPDATE.
 *
 * `autoStartDependents` is returned, not acted on here: firing it needs
 * lib/autoStart.ts, which reaches the runner and the agent SDKs, and this module
 * is pinned SDK-free (tests/importGraph.test.ts) because the internal HTTP
 * routes behind the stdio bridge import it. Callers that can, do, against the
 * returned task's id, which is the TARGET's, not the caller's.
 *
 * `wasAccepted`, captured on the PRE-PATCH row before anything about it can
 * change, is true exactly when the write is not the caller's own row and not
 * an unreviewed tray suggestion. That, and only that, is what gets recorded
 * via recordAgentEdit (see the block comment above this section): an edit to
 * the caller's own row or to a suggestion nobody has looked at yet isn't a
 * surprise to anyone.
 */
/**
 * Who is making the write, for the refusals and the audit row. A structural
 * pick, not a whole `Task`, because not every caller IS a task: the tag
 * refresh job (lib/tagRefresh.ts) is a background job the user pressed a
 * button to start, and it has no session of its own to name. It passes a
 * synthetic actor whose `id` matches no row: `task_agent_edits.actor_task_id`
 * has no foreign key precisely so the actor can outlive (or never have been)
 * a task, and the chip renders `actor_title` as prose instead of a link.
 * The three fields below are all any of this ever reads off the caller;
 * widening the type is what keeps the job from having to fake the other thirty.
 */
export type AgentEditActor = Pick<Task, "id" | "title" | "agent">;

export function updateTaskForAgent(
  caller: AgentEditActor,
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
  // warn it. Everything else (an accepted task, one on hold, one the user is
  // actively viewing) is writable, on the record (see wasAccepted below).
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
  // out from under it: true exactly when the write is not the caller's own
  // row and not an unreviewed suggestion. That, and only that, gets recorded
  // as a visible edit.
  const wasAccepted = !own && !isInertSuggestion(cur);
  // Past this point the target is writable and the field rules are identical
  // either way; only the noun in the refusals changes, so the agent can tell
  // which row it just failed to write.
  const what = own ? "this task" : `"${cur.title}"`;
  const patch: Partial<Task> = {};
  const changed: string[] = [];
  // One AgentEditChange per field actually moving, in parallel with `changed`
  // above: `changed` is prose for the tool's own confirmation text, this is
  // structured data for the diff panel. Only populated when `wasAccepted`
  // matters, but built unconditionally, since keeping one code path per field
  // (not duplicated per field under an `if (wasAccepted)`) is what
  // keeps the two lists from drifting apart.
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
    // Full text, not a preview: the diff panel is what truncates, not the store.
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
      // Same reasoning as the PATCH route: a status change settles the "needs
      // you" flag. In practice it's already 0, since a turn parked on an ask
      // can't be calling this, but leaving a stale 1 behind a "done" would
      // keep the task in the project's awaiting count forever.
      patch.awaiting_input = 0;
      changed.push(`status → ${input.status}`);
      changes.push({ field: "status", before: cur.status, after: input.status, before_value: cur.status });
    }
  }

  // Tags. Resolved STRICTLY, unlike suggest_task's version of this parameter,
  // which creates on a miss: there, a tag that doesn't exist yet is the normal
  // case (a plan being born, named once); here the task already exists, the
  // tag probably does too, and a typo would mint a near-duplicate of the tag
  // the user is filtering their board by, splitting a feature in two. So an
  // unknown ref fails the WHOLE call with the reason, exactly like an unusable
  // `blocked_by` ref, so a rename that shared the call doesn't land under a
  // refusal saying nothing did.
  //
  // It REPLACES the set, like blocked_by: `[]` clears every tag. A tool that
  // only added would have no way to say "this isn't part of the mobile PWA
  // after all", and one that guessed between add and replace would do the
  // wrong one with no way to tell. The description says so, and the
  // confirmation names the resulting set, not the delta.
  let nextTags: Tag[] | null = null;
  if (input.tags !== undefined) {
    // The task's OWN project, never the caller's: this tool writes tasks in any
    // project, and a tag may not span repositories.
    const owner = getProject(cur.project_id);
    if (!owner) return fail(`Could not update ${what}: its project no longer exists.`);
    const hit = resolveTagRefs(owner, Array.isArray(input.tags) ? input.tags : []);
    if ("error" in hit) return fail(`Could not update ${what}: ${hit.error}. Nothing was changed.`);
    const before = getTaskTags(cur.id);
    const same = before.length === hit.tags.length && before.every((t, i) => t.id === hit.tags[i].id);
    if (!same) {
      nextTags = hit.tags;
      changed.push(hit.tags.length ? `tags → ${hit.tags.map((t) => `"${t.name}"`).join(", ")}` : "no longer tagged");
      changes.push({
        field: "tags",
        before: before.length ? before.map((t) => t.name).join(", ") : "(none)",
        after: hit.tags.length ? hit.tags.map((t) => t.name).join(", ") : "(none)",
        // Not the names: a tag NAME can't be written back on revert, only ids.
        before_value: before.map((t) => t.id),
        after_value: hit.tags.map((t) => t.id),
      });
    }
  }

  // Dependencies. This is the parameter that makes an ordered plan expressible
  // at all: suggest_task can only take blockers in the call that invents the
  // task, i.e. before any of them has an id, so a planning turn that files its
  // tasks in one batch and works out the order afterwards had nowhere to put it.
  //
  // Two rules that differ from suggest_task's version, both because this one
  // REPLACES an existing set instead of filling in a blank one:
  //   - never on the caller's own row (below): blockers gate whether a task may
  //     START, and a session calling this has already started, so the edge would
  //     be inert on the scheduler and a lie on the board;
  //   - fail-closed on a ref it can't use. suggest_task partitions and reports,
  //     which is safe when the task is new and has no blockers to lose; here,
  //     wiring the refs we recognized and dropping the rest would delete edges
  //     the agent never mentioned and still report success.
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
    // The element type is only a promise on the HTTP path: the bridge's array
    // arrives from JSON, so a stray number would reach .trim() as a TypeError
    // and surface as a 500 instead of the refusal the agent can act on.
    const wanted = [...new Set(input.blocked_by.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean))];
    // Named one by one with the reason each failed: "ignored 2 refs" tells an
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
      // The complete id list, not a rendered count: Revert has to be able to
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
      // The dep count and the tags ride along only when they were part of the
      // call. Edges have no order, so resubmitting the same set in a different
      // order lands here; re-stating the tags a task already carries lands here
      // too, and "status not_started, priority med" alone would read as if the
      // tool had ignored the half the agent actually cared about.
      text:
        `No change: "${cur.title}" already matches what you passed (status ${cur.status}, priority ${cur.priority}` +
        `${input.blocked_by !== undefined ? `, blocked by ${getTaskDeps(cur.id).length} task(s)` : ""}` +
        `${input.tags !== undefined ? tagsPhrase(getTaskTags(cur.id)) : ""}).`,
      autoStartDependents: false,
    };
  }

  // Edges before fields, so the two writes can't half-land. setTaskDeps runs its
  // cycle guard BEFORE it opens its transaction, so a rejection here has touched
  // nothing at all, whereas patching the row first and then throwing would
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
  // Same before-the-row-patch placement as the edges above, and for the same
  // reason: setTaskTags does its own project check and throws, so a refusal
  // must not leave a rename applied behind it.
  if (nextTags) {
    try {
      setTaskTags([cur.id], nextTags.map((t) => t.id));
    } catch (e) {
      return fail(`Could not update ${what}: ${(e as Error).message}. Nothing was changed.`);
    }
  }
  const updated = updateTask(cur.id, patch);
  if (!updated) return fail(`Could not update ${what}: its row no longer exists.`);

  // Record the edit when it's not the caller's own row and not an unreviewed
  // suggestion (wasAccepted, captured on the pre-patch row above): this is
  // what raises the "changed since you accepted it" chip. Before the publish
  // below, so a listener that refetches on task_edited sees the chip already
  // set instead of racing it. recordAgentEdit writes tasks.agent_edited_at
  // directly, so the `updated` row above is already stale the moment this
  // runs; re-read so the task this function RETURNS carries the fresh chip
  // instead of reporting 0 for a beat.
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
  // "task_edited", not "task_updated", because title/description/priority
  // moved too, and the coarse snapshot on the wire only carries status, so
  // listeners have to refetch the row to see the rest (app/api/events/route.ts).
  // A deps-only change needs it most: the edges live in their own table, so the
  // refetch is the only thing that redraws the blocked badge, on the NEIGHBOUR
  // rows as well, which is why PATCH /api/tasks/[id] counts deps as an edit too.
  publishGlobal(task.id, { type: "task_edited" });

  // No auto-start sweep for a dependency change: clearing a task's last blocker
  // could only launch the task ITSELF, and neither this tool nor the edit
  // dialog's PATCH (app/api/tasks/[id]/route.ts) launches a task on its own
  // dependency edit; both fire the sweep only on the task's own transition to
  // terminal. The sweep below is for the OTHER direction: tasks blocked by
  // this one.
  const done = task.status === "done" && cur.status !== "done";
  return {
    task,
    text:
      `Updated "${task.title}": ${changed.join(", ")}.` +
      (done ? " Any task set to start when unblocked by this one will now launch." : "") +
      // An agent should know the edit is visible, not silent: it landed on a
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
 * task nobody started is finished, and, worse, is the exact transition that
 * fires maybeAutoStartDependents(), so a tidy-up would launch real sessions for
 * anything auto-starting behind it.
 *
 * Not a delete. The tray's Dismiss button already hard-deletes
 * (DELETE /api/tasks/[id]) and this app has no undo for that anywhere, and an
 * agent destroying a proposal the user hasn't read yet is not a call it gets
 * to make. So the row is cancelled but LEFT `suggested = 1`: it stays in the
 * tray, struck through with the reason beside it, and the user can revive it or
 * dismiss it for real. `cancelled` is already terminal and non-blocking in
 * lib/autoStart.ts, so nothing downstream waits on it forever.
 *
 * Eligibility is isInertSuggestion, the SAME helper update_task uses, shared so
 * the two policies cannot drift into "editable but not withdrawable" or worse.
 * `caller`/`targetRef` carry the same trust split as updateTaskForAgent: the
 * caller is the server's word, the target is the model's. There's no "my own
 * row" default here, and no need for one: a task with a live turn calling this
 * has running = 1, so it could never be eligible anyway.
 *
 * `autoStartDependents` rides back for the same reason it does on the done path,
 * and for the same caller to fire (this module is pinned SDK-free): a suggestion
 * can be another task's blocker, and cancelling it clears that edge. Firing the
 * sweep on THIS transition is what stops a withdrawal from stranding an
 * auto_start dependent unblocked-but-never-launched.
 */
export function withdrawSuggestionForAgent(
  caller: AgentEditActor,
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

  // Read at WRITE time, never trusting what the model saw, since the target
  // may have been started since it read the board. The check and the write
  // share one synchronous block (better-sqlite3, single process), so nothing
  // interleaves.
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

  // suggested stays 1: that flag is what keeps the row in the tray.
  // awaiting_input for the same reason update_task settles it on a status write:
  // a terminal row must not keep counting toward the project's "needs you" pill.
  const updated = updateTask(cur.id, { status: "cancelled", withdrawn_reason: why, awaiting_input: 0 });
  if (!updated) return fail(`Could not withdraw "${cur.title}": its row no longer exists.`);

  // task_edited, not task_updated: withdrawn_reason is a field the coarse
  // /api/events payload can't carry, so listeners have to refetch the row to
  // draw the struck-through card.
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
 * The `move_task` tool: re-parent tasks into another project, keeping the rows.
 *
 * A dedicated verb, not a `project` field on `update_task`, for
 * `set_base_branch`'s reason and one more. `updateTaskForAgent` is a
 * synchronous, atomic better-sqlite3 write; this is asynchronous, since it
 * takes the per-task locks and can run git, so folding it in would make the
 * field-writer non-atomic for every other field. And it is a SET operation:
 * whether a `blocked_by` edge survives depends on which OTHER tasks are moving
 * in the same call, which a per-row field has nowhere to express.
 *
 * The whole operation is lib/taskMove.ts's, shared with the two move routes, so
 * an agent's move and a user's cannot mean two different things. What this adds
 * is the trust split every agent tool makes (`caller` is the server's word,
 * `refs` and `projectRef` are the model's), the destination resolution
 * `suggest_task` uses, the audit row, and the report.
 *
 * **No discard acknowledgement is offered.** A started task's checkout was cut
 * from the OLD repo, so it can only move by being destroyed; the bulk route
 * takes that answer as a LIST OF IDS, not a flag, since one switch over
 * eleven irreversible answers isn't consent. An agent-facing verb must not
 * become the shortcut past that question, so it passes no acknowledgements at
 * all: every started task is refused with its checkout untouched, and the user
 * gives the answer from the board's Move dialog. Same for a live turn,
 * including the caller's own row: a session cannot move itself, because its
 * worktree is open in front of it.
 *
 * Refusals are per task, matching the bulk route: three started tasks don't
 * refuse the eight that can move. Only a missing destination fails the call.
 *
 * Dependency edges are answered the way `moveTasks` already answers it for the
 * UI: an edge survives iff both ends move together, and every edge that
 * doesn't is REPORTED. Dropping them without saying so is the one outcome to
 * avoid, since it produces a task that looks ready and isn't, so the text
 * names each one and the model can redraw it with `update_task`.
 *
 * Recorded in `task_agent_edits` for every moved task the user had already
 * accepted, on `updateTaskForAgent`'s rule: an unreviewed tray suggestion the
 * agent filed itself is nobody's surprise. Its Revert re-runs this same move
 * backwards (app/api/tasks/[id]/agent-edits/route.ts), never a `project_id`
 * column write, which would leave the sessions, usage and merge rows billing
 * the project the task no longer belongs to.
 */
export async function moveTasksForAgent(
  caller: Task,
  refs: string[],
  projectRef: string
): Promise<{ ok: boolean; moved: Task[]; text: string }> {
  // `ok: false` is the WHOLE CALL failing: no ids, no destination, a
  // destination that doesn't resolve. It is not "nothing moved": a selection
  // that was entirely started tasks moved nothing and is still a well-formed
  // answer the model has to read, so the two can't be told apart by counting
  // rows. The callers turn this into isError / a 400.
  const fail = (text: string) => ({ ok: false, moved: [] as Task[], text });
  const ids = [...new Set(refs.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean))];
  if (ids.length === 0)
    return fail(`move_task needs at least one task id in \`tasks\`. Call list_tasks for them. Nothing was moved.`);

  const current = getProject(caller.project_id);
  if (!current) return fail(`Could not move: the project this session belongs to no longer exists.`);
  const wanted = projectRef?.trim() ?? "";
  if (!wanted)
    return fail(
      `move_task needs a destination: pass \`project\` as the id or exact name of the project to move into. ` +
        `Call list_projects for them. Nothing was moved.`
    );
  const target = resolveTargetProject(current, wanted, "Nothing was moved.");
  if ("error" in target) return fail(target.error);

  // Read every row BEFORE the move: afterwards they all name the destination,
  // and the report has to say where each one came from, what it was called if
  // it turned out not to exist, and whether it was a row the user had accepted.
  const before = new Map(ids.map((id) => [id, getTask(id)] as const));
  // Falls through to a live read because a DROPPED edge names the task at its
  // OTHER end, which by definition is one that didn't move and so was never
  // captured above. A bare id there would be the least readable half of the
  // one line in this report the model has to act on.
  const name = (id: string) => `"${before.get(id)?.title ?? getTask(id)?.title ?? id}"`;

  const result = await moveTasksToProject(ids, target.project.id, {
    // Empty: see the block comment above. A started task is refused here,
    // not acknowledged away.
  });
  if (!result) return fail(`Project "${target.project.name}" no longer exists. Nothing was moved.`);

  // One audit row per moved task the user had already accepted, attributed to
  // this session. isInertSuggestion is the same screen update_task uses, read
  // off the PRE-move row so a move can't be judged by the state it produced.
  let recorded = false;
  for (const task of result.moved) {
    const was = before.get(task.id);
    if (!was || isInertSuggestion(was)) continue;
    recorded = true;
    recordAgentEdit({
      task_id: task.id,
      project_id: target.project.id,
      actor_task_id: caller.id,
      actor_title: caller.title,
      actor_agent: caller.agent,
      changes: [
        {
          field: "project",
          before: getProject(was.project_id)?.name ?? was.project_id,
          after: target.project.name,
          // The ids are what Revert moves back to. The names are only readable.
          before_value: was.project_id,
          after_value: target.project.id,
        },
      ],
    });
  }
  const lines: string[] = [];
  if (result.moved.length === 0) lines.push(`Nothing moved into "${target.project.name}".`);
  else
    lines.push(
      `Moved ${result.moved.length} task${result.moved.length === 1 ? "" : "s"} into "${target.project.name}": ` +
        `${result.moved.map((t) => `"${t.title}"`).join(", ")}.`
    );
  if (result.unchanged.length)
    lines.push(`Already there, so left alone: ${result.unchanged.map(name).join(", ")}.`);
  if (result.skipped.length) {
    lines.push(`Not moved: ${result.skipped.map((s) => `${name(s.id)} — ${s.reason}`).join("; ")}.`);
    // Said once, not per row, since the answer it asks for is the same
    // one, and it is not one this tool can give on the user's behalf.
    if (result.skipped.some((s) => s.reason.startsWith("a started task can't be moved")))
      lines.push(
        `Moving a started task means destroying the worktree it was cut from, which only the user can approve — ` +
          `from the task's Move dialog on the board. Say which tasks are waiting on that rather than re-filing them.`
      );
  }
  if (result.dropped.length)
    lines.push(
      `Dependency edges dropped, because only one end moved: ` +
        `${result.dropped.map((e) => `${name(e.task_id)} was blocked by ${name(e.depends_on_id)}`).join("; ")}. ` +
        `Redraw any that still apply with update_task's blocked_by, or move the other end too.`
    );
  if (result.untagged.length)
    lines.push(
      `Tags left behind, because some of their members stayed: ` +
        `${result.untagged.map((u) => `${name(u.id)} lost "${u.tag_name}"`).join("; ")}.`
    );
  if (recorded)
    lines.push(
      `The tasks the user had already accepted show on their board as moved by an agent, with a one-click revert.`
    );

  return { ok: true, moved: result.moved, text: lines.join("\n") };
}

/**
 * The `set_base_branch` tool: point a task at the git branch its worktree is
 * cut from, catches up to, and merges into.
 *
 * A dedicated verb, not a field on `update_task`: `updateTaskForAgent`
 * is a synchronous, atomic better-sqlite3 write with an audit trail, while
 * this is asynchronous, touches git, can create a local ref, can
 * `reset --hard` a worktree and can fail halfway. Folding it in would either
 * make the field-writer async and non-atomic for every other field, or open a
 * second policy path for the same verb. `update_task` says so in its own
 * description and names this tool.
 *
 * The trust split is `updateTaskForAgent`'s exactly: `caller` is the server's
 * word (the driver closes over it; the bridge's endpoint reads the env-injected
 * CALANDRIA_TASK_ID) and `targetRef` is the model's, undefined meaning "my own
 * row". Two rules on the target:
 *   - it must be in the CALLER'S OWN PROJECT, unlike update_task's any-project
 *     reach. A branch name means nothing in another repository, so a
 *     cross-project retarget could only ever be a mistake.
 *   - a live turn in it that isn't the caller's own is refused, mirroring
 *     update_task, enforced inside `retargetTaskBase`, which re-reads the row
 *     instead of trusting this one, because a retarget can reset a worktree
 *     out from under a running session.
 * A task retargeting ITSELF mid-turn is the tool's main use and is allowed.
 *
 * Recorded in `task_agent_edits` whenever the target ISN'T the caller's own
 * row, so the "Changed by agent" chip covers a retarget the way it covers a
 * rewritten description. Its Revert goes back through this same reconciliation
 * (app/api/tasks/[id]/agent-edits/route.ts), never a raw column write, since
 * undoing a retarget with an UPDATE would leave `base_sha` describing a branch
 * the task is no longer on.
 */
export async function setBaseBranchForAgent(
  caller: Task,
  targetRef: string | undefined,
  branch: string
): Promise<{ task: Task | null; text: string }> {
  const wanted = targetRef?.trim() ?? "";
  const own = !wanted || wanted === caller.id;
  const fail = (text: string) => ({ task: null, text });

  const cur = getTask(own ? caller.id : wanted);
  if (!cur)
    return own
      ? fail("Could not change the base branch: this task's row no longer exists.")
      : fail(`No task with id "${wanted}". Call list_tasks for the ids. Nothing was changed.`);
  // Same project only. update_task reaches any board because a title is a title
  // anywhere; a branch is a name in ONE repository, so a task in another project
  // could not be based on it even in principle.
  if (!own && cur.project_id !== caller.project_id)
    return fail(
      `Could not change the base branch of "${cur.title}": it's in a different project, and a branch name means nothing in ` +
        `another repository. Base branches are set from a session in the same project. Nothing was changed.`
    );
  const project = getProject(cur.project_id);
  if (!project) return fail(`Could not change the base branch of "${cur.title}": its project no longer exists.`);

  const what = own ? "this task" : `"${cur.title}"`;
  const before = cur.base_branch;
  const beforeResolved = resolveBaseBranch(cur, project);

  // The whole policy (name check, self, liveness, paused merge, existence,
  // occupancy, and the three reconciliation cases) lives in lib/baseBranch.ts,
  // shared with POST /api/tasks/[id]/base-branch. `callerTaskId` is what lets
  // this session retarget ITSELF while its own turn is running.
  //
  // Under the TARGET's task lock, exactly as that route runs it: the
  // reconciliation can `reset --hard` a worktree, and the liveness check inside
  // has to stay true for the whole operation, not only at the instant it
  // was read. Taken HERE, not in the two endpoints, so the in-process
  // Claude server and the bridge's route can't differ on it. Safe on the
  // caller's own row, since a streaming turn does not hold this lock (lib/taskLock.ts).
  const result = await withTaskLock(cur.id, () => setTaskBaseBranch(cur, project, branch, { callerTaskId: caller.id }));
  if (!result.ok) return fail(`Could not change the base branch of ${what}: ${result.error} Nothing was changed.`);

  const after = getTask(cur.id);
  if (!after) return fail(`Could not change the base branch of ${what}: its row no longer exists.`);
  // Nothing moved: the task was already on this branch and the reconciliation
  // found nothing to do. Not an edit, so nothing is recorded either.
  if (after.base_branch === before)
    return { task: after, text: own ? result.message! : `"${after.title}": ${result.message}` };

  let task = after;
  if (!own) {
    recordAgentEdit({
      task_id: cur.id,
      project_id: cur.project_id,
      actor_task_id: caller.id,
      actor_title: caller.title,
      actor_agent: caller.agent,
      // The RESOLVED names are what's readable ("main", not ""); the raw
      // column is what Revert has to put back, since clearing the pin and
      // pinning it to the value it was inheriting are different rows with the
      // same label.
      changes: [
        {
          field: "base_branch",
          before: beforeResolved || "(none)",
          after: resolveBaseBranch(after, project) || "(none)",
          before_value: before,
          after_value: after.base_branch,
        },
      ],
    });
    task = getTask(cur.id) ?? after;
  }

  return {
    task,
    text:
      (own ? result.message! : `"${task.title}": ${result.message}`) +
      (own
        ? ""
        : " The user can see this on their board as a change made by an agent, with a one-click revert that retargets it back."),
  };
}

/**
 * The `update_tag` tool: edit the TAG ITSELF: its name, its brief, its badge
 * colour, and the git branch the tasks carrying it are based on.
 *
 * The editing verb tags never had. `update_task`'s `tags` parameter sets
 * MEMBERSHIP (which tags a task carries); this is the other axis, and without it
 * an agent that files a plan under a tag can never correct the plan's own brief
 * as it learns what the work actually is.
 *
 * Project-scoped and resolved exactly like every other tag reference: an id or
 * an EXACT name, strict, because this tool cannot create one and a miss that
 * fell back to creating would mint a near-duplicate of the tag the user filters
 * their board by. A rename onto a name another tag already holds is refused BY
 * NAME (TagNameConflictError) instead of merging the two.
 *
 * `base_branch: ""` clears the default back to "members follow the project".
 * No git runs here, unlike `set_base_branch`: a tag has no worktree, and its
 * value is a default for cuts that HAVEN'T HAPPENED YET, so the integration
 * branch a plan is about to create must be settable before it exists. The name
 * check is what stops a `--upload-pack=evil` string reaching a `git` argv later.
 *
 * There is no delete verb, the same line runbooks draw: hard delete with no undo
 * stays the user's call.
 */
export function updateTagForAgent(
  project: Project,
  tagRef: string,
  input: { name?: string; description?: string; color?: string; base_branch?: string }
): { tag: Tag | null; text: string } {
  const fail = (text: string) => ({ tag: null, text });
  const ref = tagRef?.trim() ?? "";
  if (!ref) return fail("Could not update the tag: `tag` is required — pass a tag id or its exact name from `list_tags`. Nothing was changed.");

  const hit = resolveTagRefs(project, [ref]);
  if ("error" in hit) return fail(`Could not update the tag: ${hit.error}. Nothing was changed.`);
  const cur = hit.tags[0];
  if (!cur) return fail("Could not update the tag: `tag` is required — pass a tag id or its exact name from `list_tags`. Nothing was changed.");

  const fields: { name?: string; description?: string; color?: string | null; base_branch?: string } = {};
  const changed: string[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return fail(`Could not update "${cur.name}": \`name\` was empty. Nothing was changed.`);
    if (name !== cur.name) {
      fields.name = name;
      changed.push(`renamed to "${name}"`);
    }
  }
  if (input.description !== undefined && input.description !== cur.description) {
    fields.description = input.description;
    changed.push("description rewritten");
  }
  if (input.color !== undefined) {
    const parsed = parseTagColor(input.color);
    // The palette is closed, and the refusal carries it, since there's no
    // list_tags field to read the accepted values off, so naming them here is
    // the only way a retry can succeed.
    if (!parsed.ok) return fail(`Could not update "${cur.name}": ${parsed.error}. Nothing was changed.`);
    if (parsed.color !== cur.color) {
      fields.color = parsed.color;
      changed.push(parsed.color ? `colour → ${parsed.color}` : "colour cleared");
    }
  }
  if (input.base_branch !== undefined) {
    const want = input.base_branch.trim();
    if (want && !refNameSafe(want)) return fail(`Could not update "${cur.name}": "${want}" isn't a usable git branch name. Nothing was changed.`);
    if (want !== cur.base_branch) {
      fields.base_branch = want;
      changed.push(want ? `tasks are based on ${want}` : "tasks follow the project's default branch again");
    }
  }

  if (!changed.length)
    return {
      tag: cur,
      text: `No change: "${cur.name}" already matches what you passed${cur.base_branch ? ` (based on ${cur.base_branch})` : ""}.`,
    };

  let updated: Tag | undefined;
  try {
    updated = updateTag(cur.id, fields);
  } catch (e) {
    if (e instanceof TagNameConflictError)
      return fail(
        `Could not update "${cur.name}": ${e.message}. Two tags can't share a name — pick a different one, or tag the tasks ` +
          `with the existing "${e.tagName}" via update_task instead of renaming this one onto it. Nothing was changed.`
      );
    return fail(`Could not update "${cur.name}": ${(e as Error).message}. Nothing was changed.`);
  }
  if (!updated) return fail(`Could not update "${cur.name}": it no longer exists. Nothing was changed.`);

  // Project-keyed, like every other tag write: no single task row changed, so
  // the per-task re-read on /api/events has nothing to read, and the client
  // refetches the project's tags instead.
  publishGlobal("", { type: "tags_changed", projectId: updated.project_id });

  return {
    tag: updated,
    text:
      `Updated tag "${updated.name}": ${changed.join(", ")}.` +
      (fields.base_branch
        ? ` Tasks tagged with it are cut from ${fields.base_branch} from now on; members whose worktree already exists keep the ` +
          `branch their work is built on — retarget those with set_base_branch.`
        : ""),
  };
}

/**
 * Surface an ask_user question card and wait for the answer: the bridge-served
 * counterpart of the Claude driver's AskUserQuestion hook. Unlike suggest_task /
 * expose_service this is asynchronous by nature: we persist + publish the ask
 * card here (the same tool-row shape the runner writes, so the UI and the
 * /answer route treat it identically), then park a DETACHED waiter on
 * lib/asks.ts. The bridge polls takeAskOutcome() via the wait endpoint, with no
 * long-held HTTP request, per the house rule. The waiter is tied to the live
 * turn's abort signal, so a Stop settles it as a dismissal.
 */
export function startAskUser(task: Task, questions: AskQuestion[]): { askId: string } {
  const askId = `ask-${nanoid()}`;
  // A turn that declared itself unattended (a scheduled firing) has nobody to
  // answer, and parking here is worse than useless: the bridge would poll for
  // an answer that never comes, holding the turn slot for as long as the
  // process lives, which makes every later occurrence of that schedule
  // `skipped_overlap`. Settle it at once, the same contract lib/permissions.ts
  // honors for the permission gate, on the other interactive path.
  if (interactionDenied(task.id)) return denyAskUnattended(task, askId, questions);
  const data: ToolData = { title: "Question for you", ask: { id: askId, questions } };
  const m = addMessage(task.id, task.generation, "tool", JSON.stringify(data));
  // The turn is live but parked on the user, same flag the runner sets for
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
      // Turn torn down (Stop) before an answer arrived. Mark the card dismissed,
      // not blank: this is the bridge's OWN settle path (the
      // runner's turn-end backstop never sees an out-of-band ask, since the row
      // was written here and not through its event queue), so without it the
      // card would render live option buttons that resolve nothing; /answer
      // would return resolved:false and the pick would land as an ordinary message.
      const dismissal = { reason: "interrupted" as const, note: ASK_INTERRUPTED_NOTE };
      data.ask = { id: askId, questions, dismissed: dismissal };
      updateMessage(m.id, JSON.stringify(data));
      updateTask(task.id, { awaiting_input: 0 });
      publish(task.id, { type: "ask_dismissed", id: askId, dismissal, msgId: m.id, generation: task.generation });
      settleAsk(task.id, askId, ASK_DISMISSED_REPLY);
    });

  return { askId };
}

/**
 * Refuse an ask_user for a declared-unattended turn, on the record.
 *
 * Written as a SETTLED permission card, not an ask card, for the same
 * reason the Claude driver's hook does it that way: an ask card in the
 * transcript promises an answer is coming, and this one never was. A decided
 * card says what was asked, that it was refused, and why, and it leaves
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
 * user, plus the confirmation text. This process doesn't own the service; the
 * entry is informational (see lib/services.ts exposeService).
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
