/* Shared definitions for Calandria's agent-facing MCP tools.
 *
 * The SAME tool names, descriptions and parameter docs feed two places that
 * expose these tools to a coding agent:
 *   - lib/agents/claude/driver.ts   the in-process SDK MCP server (createSdkMcpServer)
 *   - scripts/calandria-mcp.mjs     the portable stdio MCP bridge (Codex + future CLIs)
 * Keeping the strings here means the two can never drift.
 *
 * Plain .mjs on purpose: it's imported both through Next's bundler (the Claude
 * driver, TS) AND by raw Node ESM (the bridge script, plain JS), the same shape as
 * lib/cf-access.mjs. Only literal data lives here (no zod, no SDK types) so both
 * consumers can build their own schema objects from it. Every such .mjs the
 * bridge needs must also be COPY'd into the runtime image (see Dockerfile).
 */

// Shared by every tool with a "which project" parameter that defaults to the
// caller's own project. `move_task`'s destination param writes its own text,
// since there omitting it is not a valid choice.
const PROJECT_PARAM =
  "Project id, or its exact name (case-insensitive), from `list_projects`. Omit for this session's " +
  "project. An unrecognized value is refused, never a fallback.";

export const LIST_PROJECTS = {
  name: "list_projects",
  description:
    "List every project: id, name, repo path, and which one this session runs in. Call it before " +
    "passing `project` to another tool. A project reference must match an id or exact name from " +
    "this list; an unrecognized value is refused, never guessed.",
  params: {},
};

export const SUGGEST_TASK = {
  name: "suggest_task",
  description:
    "Create a task. It lands in the user's Suggested tray to review and start later as its own " +
    "session. Files into this project by default; pass `project` to target another. Use it to " +
    "plan, break down or roadmap work (once per task), or to capture out-of-scope follow-ups. " +
    "Set `blocked_by` only for blockers that already exist; to order a batch filed together, file " +
    "them first and wire `blocked_by` afterward with `update_task`. Give every task of one plan " +
    "the same `tags`. Refuses an unrecognized `project`.",
  params: {
    title: "Short task title.",
    description: "The task's brief. Becomes its opening prompt.",
    priority: "hi, med (default) or lo.",
    project: PROJECT_PARAM,
    blocked_by:
      "Ids (or titles, for tasks suggested earlier this session) of already-existing blockers, in " +
      "the same project as this task. To order tasks filed together, leave this out and set it " +
      "with `update_task` once every one of them has an id.",
    tags:
      "Tag ids or names. A name that doesn't exist yet is created in this task's project. Give " +
      "every task of one plan the same tags, so the user sees one chip for it and each session " +
      "knows its place in the plan.",
    provider:
      "\"local\" pins the task to the instance's local model server (Ollama / LM Studio), for " +
      "delegating mechanical, well-specified work at no cloud cost; write the brief for a smaller " +
      "model, naming the files and the expected result. \"cloud\" pins it to the agent's own login " +
      "even in a project that defaults to local. Omit to inherit the project's setting.",
    model:
      "Model id to run the task on: a local server tag under provider \"local\" (required unless " +
      "the project already names one), or a catalog id under \"cloud\". Omit to inherit.",
  },
  priorities: ["hi", "med", "lo"],
  defaultPriority: "med",
  providers: ["local", "cloud"],
};

export const LIST_TASKS = {
  name: "list_tasks",
  description:
    "List the board: id, title, status, priority, agent, whether it's an unreviewed suggestion, " +
    "its blockers, and its resolved base branch. Defaults to this project; pass `project` for " +
    "another. This session's own task is flagged `current: true`. Read-only. Descriptions are " +
    "omitted; read one in full with `get_task`.",
  params: {
    project: PROJECT_PARAM,
    include_done: "Include done or cancelled tasks. Default false. This session's own task is always listed.",
    tag:
      "Only tasks carrying this tag, by id or exact name from `list_tags`. Omit for the whole " +
      "board. An unrecognized value is refused.",
  },
};

export const LIST_TAGS = {
  name: "list_tags",
  description:
    "List a project's tags: named plans a set of tasks belongs to. Each carries its description, " +
    "base branch, done/running/waiting counts, and its member tasks (id, title, status). " +
    "Read-only. Use it to check a plan's progress, or to look up a tag's exact name before " +
    "passing it to another tool.",
  params: {
    project: PROJECT_PARAM,
  },
};

export const GET_TASK = {
  name: "get_task",
  description:
    "Read one task in full: description, status, priority, agent, work branch and worktree, " +
    "resolved base branch, and each blocker with its title and status. Read-only.",
  params: {
    task: "Task id, from `list_tasks` or `suggest_task`. Omit to read this session's own task.",
  },
};

export const UPDATE_TASK = {
  name: "update_task",
  description:
    "Update a task: title, description, priority, status, or `blocked_by`. Only the fields you " +
    "pass change. Defaults to this session's own task; `task` can name any task on the board, in " +
    "any project, including one already accepted or started. Such an edit shows on the user's " +
    "board as a reviewable \"changed by agent\" diff, not a silent change. Refuses only a task " +
    "with a turn running right now. Base branch is not a field here; use `set_base_branch`.",
  params: {
    task:
      "Task id, from `list_tasks` or `suggest_task`. Omit for this session's own task; any other " +
      "id is fair game except one with a turn running right now.",
    title: "New title.",
    description: "New description. Replaces the existing brief.",
    priority: "hi, med or lo.",
    status:
      "not_started, in_progress, on_hold or done. Marking done can auto-start tasks blocked on " +
      "this one; to retract a suggestion instead, use `withdraw_suggestion`. Cancelling is not " +
      "offered here; that's the user's call.",
    blocked_by:
      "The complete list of blocker task ids, replacing whatever is set; pass [] to clear. All " +
      "must already exist, in the same project as this task (file new ones with `suggest_task`, " +
      "wait for their ids, then set this). Not settable on the caller's own task. An unusable id " +
      "refuses the whole call.",
    tags:
      "The complete set of tag ids or exact names this task should carry, replacing whatever is " +
      "set; pass [] to clear. Unlike `suggest_task`, an unknown name is refused, never created. " +
      "To edit a tag itself, use `update_tag`.",
  },
  priorities: ["hi", "med", "lo"],
  statuses: ["not_started", "in_progress", "on_hold", "done"],
};

export const MOVE_TASK = {
  name: "move_task",
  description:
    "Move tasks into another project, keeping their ids, history, sessions, and spend. Use it " +
    "when work was planned in the wrong project. Move a dependency chain in one call: a " +
    "`blocked_by` edge survives only when both ends move together; one left behind is dropped and " +
    "named. Refuses a task the user has started (moving it destroys its git worktree; that is the " +
    "user's call, from the board's Move dialog) and any task with a turn running now, including " +
    "the caller. Refusals are per task: the rest still move.",
  params: {
    tasks:
      "Ids to move, from `list_tasks`. Pass a dependency chain whole; an edge survives only if " +
      "both ends are in this list.",
    project:
      "Destination project id, or its exact name (case-insensitive), from `list_projects`. An " +
      "unrecognized value is refused, never a fallback to this session's project.",
  },
};

export const WITHDRAW_SUGGESTION = {
  name: "withdraw_suggestion",
  description:
    "Retract a task suggestion that turned out redundant, wrong, or already covered. The " +
    "suggestion is marked cancelled but stays in the user's Suggested tray, struck through with " +
    "your reason, so they can revive or dismiss it. Use this instead of `update_task` with status " +
    "\"done\": a suggestion nobody started isn't finished, and done can auto-start tasks waiting " +
    "on it. Refuses anything the user has already accepted or started, and anything not still " +
    "sitting unreviewed in the Suggested tray.",
  params: {
    task:
      "Id, from `list_tasks` or `suggest_task`. Must still be in the Suggested tray " +
      "(`suggested: true`); anything accepted or started is refused.",
    reason: "Why this suggestion should be dropped, in one sentence. Shown on the withdrawn card. Required.",
  },
};

export const EXPOSE_SERVICE = {
  name: "expose_service",
  description:
    "Register a long-running server you just started (dev server, API, preview) so it appears in " +
    "the project's Services panel and the user gets a working URL. Call it once the server is " +
    "listening; it returns the URL. Use the injected PORT environment variable when one is set, " +
    "otherwise the actual port your server bound.",
  params: {
    name: 'Short label, e.g. "dev", "api", "storybook". Slugified to lowercase [a-z0-9-].',
    port: "TCP port the server is listening on.",
  },
};

export const ASK_USER = {
  name: "ask_user",
  description:
    "Ask the user one or more multiple-choice questions and wait for the answer before " +
    "continuing. Use it when blocked on a decision only the user can make: which approach to " +
    "take, a missing requirement, a destructive action to confirm. Surfaced in the Calandria UI as " +
    "an interactive card; blocks until answered, then returns the selections.",
  params: {
    questions:
      "Questions to ask. Each has a `question` (the full prompt), a short `header` label, and " +
      "2-4 `options` (each an object with a `label`).",
  },
};

export const CREATE_RUNBOOK = {
  name: "create_runbook",
  description:
    "Save a task the user runs often as a reusable runbook: a named recipe the user can dispatch " +
    "later in one click from the project's Runbooks card. Use it when asked to save one, or after " +
    "working out a procedure worth repeating. Files into this project by default; pass `project` " +
    "for another. A runbook runs nothing on its own until dispatched, so creating one is safe; for " +
    "work that should happen now, use `suggest_task` instead.",
  params: {
    name: 'Short name, e.g. "Push & babysit CI".',
    description: "One line on what it does. Becomes the brief on every task it dispatches.",
    prompt:
      "The message the dispatched task's first turn sends. Prefer a slash command when one " +
      "exists; otherwise write the instructions out in full.",
    priority: "hi, med (default) or lo.",
    permission_mode:
      "Permission mode for dispatched tasks. Omit to inherit the user's default. " +
      "\"bypassPermissions\" is refused here: only a human can turn it on, from the UI.",
    project: PROJECT_PARAM,
  },
  priorities: ["hi", "med", "lo"],
  defaultPriority: "med",
};

export const LIST_RUNBOOKS = {
  name: "list_runbooks",
  description:
    "List a project's saved runbooks: id, name, description, prompt, and any schedules that fire " +
    "them. Read-only. Call it before `create_runbook` to avoid a near-duplicate, and to find an id " +
    "to edit. A runbook with a non-empty `used_by` cannot be edited by you; `update_runbook` " +
    "refuses it.",
  params: {
    project: PROJECT_PARAM,
  },
};

export const UPDATE_RUNBOOK = {
  name: "update_runbook",
  description:
    "Edit a saved runbook: name, description, prompt, priority, or permission mode. Refused for a " +
    "runbook a schedule fires, since editing one would silently change work that runs unattended; " +
    "that's the user's to change. When refused, say what you would have changed and let the user " +
    "decide, or save a new recipe with `create_runbook`. There is no way to delete a runbook; " +
    "that's the user's call too.",
  params: {
    runbook: "Id, from `list_runbooks` or `create_runbook`.",
    name: "New name. Omit to leave it.",
    description: "New one-line description. Omit to leave it.",
    prompt: "New prompt for the dispatched task's first turn. Omit to leave it.",
    priority: "hi, med or lo. Omit to leave it.",
    permission_mode:
      "New permission mode. Omit to leave it. \"bypassPermissions\" is refused here: only a human " +
      "can turn that on, from the UI.",
  },
  priorities: ["hi", "med", "lo"],
};

export const SET_BASE_BRANCH = {
  name: "set_base_branch",
  description:
    "Change the git branch a task's worktree is cut from, synced to, and merged into. Use it when " +
    "the work belongs on a feature or integration branch instead of the project's default. The " +
    "branch must already exist locally or on the remote; it cannot be another task's " +
    "`calandria/…` branch, which is checked out in a live worktree. Existing commits are kept; " +
    "Sync catches you up to the new base. To set the base for a whole plan, use `update_tag` " +
    "instead. Refuses a task with a turn running right now.",
  params: {
    branch:
      "Branch to base the task on, e.g. \"feature/auth\"; must already exist locally or on the " +
      "remote, never created from nothing. Pass \"\" to inherit the default from the task's tags, " +
      "or the project.",
    task:
      "Task id, from `list_tasks`. Omit for this session's own task. Any task in the same project " +
      "is fair game except one with a turn running right now.",
  },
};

export const REPORT_BASE_REWRITE = {
  name: "report_base_rewrite",
  description:
    "Report that you rewrote a branch's history (a rebase plus a force-push) so Calandria can flag every " +
    "other task based on it. Call it as the last step of a task that lands an integration branch. Tasks " +
    "cut from the pre-rewrite branch are pinned to commits that no longer exist, and nothing else tells " +
    "them: the sync banner only shows for the task the user has open. This flags them on the board and " +
    "writes the rebase command into each transcript. It does not rebase anything, and it never touches " +
    "another task's branch or worktree: each of those tasks runs its own rebase, from its own banner, " +
    "under its own guards. Every task named is verified against git first, so a branch that was not " +
    "actually rewritten flags nobody.",
  params: {
    branch:
      "Branch whose history you rewrote, e.g. \"integration/auth\". Omit for this task's own base branch, " +
      "which is the usual case for a task that lands the branch it was cut from.",
  },
};

export const CREATE_PR = {
  name: "create_pr",
  description:
    "Push this task's branch and open a pull request against its base branch, marking the work " +
    "finished in git. Offered only where the project lands by pull request. Use it once the work " +
    "is committed-worthy: it commits anything uncommitted, pushes, and runs `gh pr create`. A " +
    "later call updates the same PR instead of opening a second. It cannot merge; that is the " +
    "user's call, and there is no tool for it. A session's own `git push` and `gh pr create` are " +
    "usually refused; use this instead.",
  params: {
    title:
      "PR title. Omit to use the task's own title; write a Conventional Commit title if the " +
      "repository requires one, since the task's title is prose.",
    body:
      "PR body, as Markdown. Omit to compose it from the task's description and the latest " +
      "session summary; pass one when you can describe what actually changed and how it was " +
      "verified.",
  },
};

export const UPDATE_TAG = {
  name: "update_tag",
  description:
    "Edit a tag as the plan changes: rename it, rewrite its brief, or set the git branch its " +
    "tasks are based on. Setting `base_branch` points every task carrying this tag, from now on, " +
    "at that branch instead of the project's default; a member whose worktree is already cut " +
    "keeps its own. There is no delete; that's the user's call. This edits the tag itself; to " +
    "change which tags a task carries, use `update_task`'s `tags`.",
  params: {
    tag: "Id, or its exact name, from `list_tags`. An unrecognized value is refused, never a new tag.",
    name: "New name. Refused if another tag already has it.",
    description:
      "New brief for the plan, read by every session carrying the tag. Replaces the existing " +
      "text. Omit to leave it alone.",
    color:
      "New badge tint: one of Calandria's tag colors, as a hex string, or \"\" for the neutral " +
      "badge. A value outside the palette is refused with the accepted list.",
    base_branch:
      "Git branch tasks carrying this tag are cut from, synced to, and merged into, e.g. " +
      "\"feature/auth\". Applies to members whose worktree hasn't been cut yet (retarget one " +
      "already cut with `set_base_branch`). Pass \"\" to clear it.",
  },
};
