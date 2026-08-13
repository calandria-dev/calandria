/* Shared definitions for the orchestrator's agent-facing MCP tools.
 *
 * The SAME tool names, descriptions and parameter docs feed two places that
 * expose these tools to a coding agent:
 *   - lib/agents/claude/driver.ts   the in-process SDK MCP server (createSdkMcpServer)
 *   - scripts/orch-mcp.mjs          the portable stdio MCP bridge (Codex + future CLIs)
 * Keeping the strings here means the two can never drift.
 *
 * Plain .mjs on purpose: it's imported both through Next's bundler (the Claude
 * driver, TS) AND by raw Node ESM (the bridge script, plain JS) — same shape as
 * lib/cf-access.mjs. Only literal data lives here (no zod, no SDK types) so both
 * consumers can build their own schema objects from it. Every such .mjs the
 * bridge needs must also be COPY'd into the runtime image (see Dockerfile).
 */

export const LIST_PROJECTS = {
  name: "list_projects",
  description:
    "List every project in the orchestrator (id, name, repo path, and which one this session is running in). " +
    "Call this before using `suggest_task`'s `project` parameter — it is the only way to learn the exact names and ids, " +
    "and suggest_task refuses a value it doesn't recognize rather than guessing.",
  params: {},
};

export const SUGGEST_TASK = {
  name: "suggest_task",
  description:
    "Create a task in the orchestrator — it lands in the user's Suggested tray to review and start later as its own session. " +
    "Defaults to THIS project; pass `project` to file it into a different one (useful when work you've spotted belongs to another repo). " +
    "Use when the user asks you to plan/break down/roadmap work (call once per task), or to capture out-of-scope follow-ups. " +
    "To suggest ORDERED work, create the blocker tasks first, then set `blocked_by` on the dependent task using the ids returned by this tool " +
    "(titles of tasks suggested earlier this session also work). A blocked task can't be started until everything it's blocked by is done. " +
    "Dependencies are project-scoped: a task can only be blocked by tasks in the SAME project it is filed into.",
  params: {
    title: "Short task title",
    description: "What the task should do — becomes the task's initial prompt",
    priority: "Task priority: hi, med (default) or lo",
    project:
      "Which project to file this task into — its id, or its exact name (case-insensitive), as returned by `list_projects`. " +
      "Omit to use the project this session is running in. An unrecognized value is an error, never a fallback.",
    blocked_by:
      "Ids (or titles, for tasks suggested earlier this session) of tasks that must be done before this one can start. " +
      "They must live in the same project this task is filed into.",
  },
  priorities: ["hi", "med", "lo"],
  defaultPriority: "med",
};

export const LIST_TASKS = {
  name: "list_tasks",
  description:
    "List the tasks on the orchestrator board — id, title, status, priority, agent, whether it's still an unreviewed suggestion, " +
    "and the ids it's blocked by. Defaults to THIS project; pass `project` to look at another one (ids and names come from `list_projects`). " +
    "The task this session is running in is flagged `current: true`. Read-only. Use it to see what's already planned before suggesting " +
    "more work, or to find the id of a task to read with `get_task`. Descriptions are omitted to keep the list small — `get_task` has the full text.",
  params: {
    project:
      "Which project's board to list — its id, or its exact name (case-insensitive), as returned by `list_projects`. " +
      "Omit for the project this session is running in. An unrecognized value is an error, never a fallback.",
    include_done:
      "Include tasks that are already done or cancelled. Default false — open work only. " +
      "This session's own task is always listed, whatever its status.",
  },
};

export const GET_TASK = {
  name: "get_task",
  description:
    "Read one task in full: its description (the brief it runs on), status, priority, agent, git branch and worktree, and each of its " +
    "blockers with their titles and statuses. Call it with no arguments to re-read THIS session's own task — the way to recall the brief " +
    "you were started with, or to check whether the user has edited it since. Read-only.",
  params: {
    task: "The task's id, from `list_tasks` or `suggest_task`. Omit to read the task this session is running in.",
  },
};

export const UPDATE_TASK = {
  name: "update_task",
  description:
    "Update THIS session's own task — retitle it, rewrite its description, change its priority, or set its status (e.g. mark it done once " +
    "the work is finished). Pass only the fields you want to change; anything omitted is left exactly as it is. " +
    "Only the calling task can be changed: editing other rows on the board is the user's call, so use `suggest_task` to propose new work " +
    "instead. Marking this task done can auto-start tasks that were blocked on it, so do it when the work really is complete.",
  params: {
    title: "New short task title.",
    description: "New description — the task's brief. Replaces the existing text rather than appending to it.",
    priority: "New priority: hi, med or lo.",
    status:
      "New status: not_started, in_progress, on_hold or done. Cancelling is deliberately not offered — it's the user's call, " +
      "and it would abort this very turn.",
  },
  priorities: ["hi", "med", "lo"],
  statuses: ["not_started", "in_progress", "on_hold", "done"],
};

export const EXPOSE_SERVICE = {
  name: "expose_service",
  description:
    "Register a long-running server you just started (e.g. a dev server, API, or preview) with the orchestrator so it appears in the " +
    "project's Services panel and the user gets a working URL. Call this right after the server is up and listening. Returns the URL to " +
    "reach it. Use the PORT environment variable the orchestrator injected when one is set; otherwise pass the actual port your server bound.",
  params: {
    name: 'Short label for the service, e.g. "dev", "api", "storybook".',
    port: "The TCP port the server is listening on.",
  },
};

export const ASK_USER = {
  name: "ask_user",
  description:
    "Ask the user one or more multiple-choice questions and wait for their answer before continuing. Use this when you're blocked on a " +
    "decision only the user can make (which approach to take, a missing requirement, a destructive action to confirm). The question is " +
    "surfaced in the orchestrator UI as an interactive card; this tool blocks until the user answers, then returns their selections.",
  params: {
    questions:
      "The questions to ask. Each has a `question` (the full prompt), a short `header` label, and 2–4 `options` (each an object with a `label`).",
  },
};
