// Shared implementations of the orchestrator's agent-facing tools
// (suggest_task / expose_service). One home for the LOGIC so both callers agree:
//   - the Claude driver's in-process SDK MCP server (lib/agents/claude/driver.ts)
//   - the internal HTTP endpoints the stdio bridge proxies to
//     (app/api/internal/agent-tools/*), which serve Codex and any future CLI
//
// The tool *definitions* (names/descriptions/params) live in lib/agentToolDefs.mjs;
// this file is the behaviour behind them. Both are deliberately split so the
// plain-Node bridge (scripts/orch-mcp.mjs) can import the defs without pulling in
// the TS/SQLite graph.

import { nanoid } from "nanoid";
import type { Project, Task, ServiceInfo, Priority, AskQuestion, ToolData } from "./types";
import { createTask, setTaskDeps, addMessage, updateMessage, updateTask, getProject, getTask, listProjectsPlain } from "./store";
import { exposeService } from "./services";
import { publish } from "./events";
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

/**
 * Register a service the agent just started (the expose_service tool). Records
 * the port/url so it shows in the Services panel and returns the URL to hand the
 * user, plus the confirmation text. We don't own the process — this entry is
 * informational (see lib/services.ts exposeService).
 */
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
