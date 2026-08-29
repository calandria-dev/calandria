---
title: "Architecture"
---

# Architecture

How Calandria is put together. This is the public companion to [`CLAUDE.md`](../CLAUDE.md)
(the in-repo codebase map agents read); if the two ever disagree, trust the code.

## Three processes, one origin

- **`server.js`** is a custom Next.js server (plain Node, Turbopack in dev). It fronts Next
  on one port, proxies `/pty` WebSocket upgrades to the sidecar, and forwards dev HMR
  upgrades to Next. Everything rides one origin, so a Cloudflare Tunnel or any reverse proxy
  exposing a single https hostname carries both the app and the terminal: no second port,
  and `wss://` is used automatically over https.
- **`pty-server.js`** is the node-pty terminal sidecar, bound to `127.0.0.1` only, never
  exposed directly. The browser reaches it through the app origin at `/pty`.
- **The Next app**: UI in `app/`, REST under `app/api/`, server logic in `lib/`.

## The turn lifecycle

**`lib/runner.ts`** is the detached turn runner. `POST /api/tasks/[id]/messages` launches a
turn and returns immediately. The turn runs server-side, owned by the process rather than
by any HTTP request, persisting every event to SQLite and publishing it on **`lib/events.ts`**
(in-process pub/sub keyed by task id, plus a wildcard channel that sees every task's
events). Stopping is only ever explicit, via `lib/abort.ts`. If a turn is already running,
the message parks in the `pending_messages` queue to run next.

One exception: a turn can be **lingering**, meaning the model is done and the session stays
open only so background work can finish or a wakeup can fire. A lingering turn has nothing
in flight, and by default the wait has no deadline. The Claude driver keeps its prompt
iterable open for the whole linger, so `sendToLingeringTurn()` hands the message straight to
it through `lib/turnInput.ts`, and it starts the next turn immediately, persisted and
published as an ordinary user message. Order is kept at both ends: entering a linger first
drains the oldest already-parked follow-up into the same open session, since the model's
turn has already ended and that follow-up was waiting for exactly this. A send is refused
while anything is still queued, so a new message waits behind what came before.

`lib/turnActivity.ts` watches the same open-endedness from the other side. It stamps the
moment of every event the runner persists, and a sweep that runs only while a turn is live
marks any turn that has produced nothing for `CALANDRIA_TURN_IDLE_MS` (20 minutes) — unless
it is parked on the user, which is silent for a legitimate reason. The mark is a report, not
a deadline: `schedulerHealth()`'s "looks stuck" banner is the model, and the same argument
applies (the server cannot distinguish a wedged wait from a slow one, so it says how long
and lets the human judge). It is in-memory only, both because it describes a turn this
process owns and because persisting it would move `tasks.updated_at` — the board's sort key
— every time a task went QUIET. The one coarse `turn_idle` event on `/api/events` is how a
card learns it, since a turn that has stopped producing transcript detail publishes nothing
else at all.

`app/shell/IdleStop.tsx` is the one affordance hung off that mark, and it inherits the same
argument. A signal the server refuses to act on unilaterally should not be one click from a
mis-aim either, so the chip arms on the first press, states what it cannot know, and stops
on the second. It is on the list and board cards only: the session already has Stop in its
composer, a few hundred pixels under the idle note, with the transcript in between to judge
against — a second one there would be the same verb twice, under two policies.

`lib/idleNudge.ts` is the opt-in other half (`CALANDRIA_TURN_IDLE_NUDGE`, off), hung on the
same transition: the model is the only party that can judge its own wait, and reaching it
costs a turn's tokens. It can only reach a LINGERING session, because the driver's `send`
refuses a message mid-thought — so the case the mark refuses to act on, a slow turn that is
genuinely working, is unreachable rather than merely guarded against. It lands at most once
per turn, never on a scheduled run (nobody would read the outcome), and never ahead of a
queued follow-up. What it sends is a user message, because that is the only channel a session
has; what it records is a system notice, because the user didn't type it.

`GET` on the same route is the SSE watch stream: a `snapshot` of the persisted transcript,
then a live tail. It is reconnect-safe, supports any number of viewers, and works with zero
viewers.

`GET /api/events` is the global lifecycle stream: one always-open SSE connection per client
tab, broadcasting coarse turn boundaries (turn started, awaiting input, answered, suggestion
created, turn ended) for every task across every project. Each event carries a fresh
snapshot of the task row plus its project's awaiting count. That is how spinners, project
badges, and the "N need you" pill update instantly for tasks whose transcript stream isn't
open. There is no task-list polling.

Not every fact fits that snapshot. A mutation route publishes `task_edited` when it rewrites
fields the snapshot can't carry (title, priority, dependency edges), and the client refetches
the row instead of patching it. Some events aren't about a single task at all, so they carry
their own project id and skip the relay's re-read entirely: `task_deleted` (the row is gone),
`tasks_moved` (both ends, since the trays a selection left also need to lose it),
`runbooks_changed`, and `tags_changed` (no task row is involved).

Task order isn't one of those facts, because it isn't stored. `listTasks` sorts by
`updated_at DESC`, so the coarse lifecycle events that already flow for every turn are what
re-sort a tray: the most recently active task is the top card, in every bucket and in the
Suggested tray, without anyone dragging it.

**A task is a lineage of sessions.** Generation N ends at `/clear`; its transcript is
condensed to a summary, and generation N+1 starts with a clean context window seeded by all
prior summaries. The task persists; only the context window resets.

## The agent-driver seam (`lib/agents/`)

The app talks to coding agents only through the `AgentDriver` interface.

- **`types.ts`** defines the interface: a normalized `StreamEvent` turn contract, one-shot
  summarize/draft/recap helpers, a capability descriptor, and the login/verify auth surface.
- **`registry.ts`** resolves a driver by id via `getDriver(task.agent)`. The id is persisted
  per task and defaults per project from `projects.default_agent`.
- **`shared.ts`** holds the agent-agnostic pieces every driver reuses: project-context and
  conflict prompts, tool-call to title/peek/diff normalizers, and the event queue.
- **`listCommands?(task, project)`** is optional. It reports the slash commands a turn on
  that task would expand, so the composer's `/` menu is discovered from the agent instead of
  hardcoded. `GET /api/tasks/[id]/commands` serves it, filtered by `lib/agentCommands.ts`. A
  driver that omits it leaves the menu with Calandria's own commands. The Claude
  implementation reads the SDK's initialization response without sending a model request,
  under the same isolation as the one-shots (`lib/agents/claude/commands.ts`). It is the
  app's only command enumeration: the schedule editor's prompt validation calls the same
  function, so the menu and the validator can't disagree about what a session expands. MCP
  prompt commands are the one gap the isolation creates: reading them means starting the
  user's MCP fleet, so they're harvested instead from the `init` message of the task's real
  turns (`recordMcpPrompts`) and merged into the same answer.
- **`GET /api/agents`** serves each driver's capability descriptor plus its persisted
  connection state to the client, which renders every run-control picker (model, reasoning,
  permission), the per-task agent picker, agent badges, and the cost/ask feature gates from
  that data. The UI has no hardcoded per-agent lists.
- Connecting an agent is driver-driven and route-generic:
  **`/api/agents/[id]/{login,login/code,verify,api-key,status}`** resolve
  `getDriverStrict(id)` and call its auth surface, so a new agent needs no new routes.
  `connections.ts` records which agents are connected. Each agent's credentials live under
  `$HOME` (Claude in `~/.claude`, Codex in `~/.codex`); the optional per-token API-key paths
  persist to a 0600 file (`lib/anthropic-key.ts` / `lib/openai-key.ts`).

### The Claude driver (`lib/agents/claude/driver.ts`)

`runTurn()` runs a turn via the Claude Agent SDK, resuming or starting fresh, with project
context appended to the Claude Code system prompt. It exposes the Calandria MCP tools
(`suggest_task`, `list_tasks`, `get_task`, `update_task`, `withdraw_suggestion`,
`set_base_branch`, `create_pr`, `update_tag`, `list_projects`, `expose_service`),
`summarizeTranscript()` for `/clear`, and `draftProjectContext()`, a read-only agent loop
that explores the repo to refresh a project's saved context. Auth delegates to
`lib/claude-auth.ts`.

A turn pins `settingSources: ["user", "project", "local"]`. That is the SDK's own default
when the option is omitted; it's written out explicitly so an SDK bump can't silently strip
the user's MCP servers, plugins, skills, and the repo's `CLAUDE.md` from every session.

The one-shot helpers isolate capability but still inherit config. Each sets `tools`
explicitly, since that is the real restriction: `allowedTools` only pre-approves calls, and
`bypassPermissions` pre-approves everything anyway, so all three helpers used to run with
the full toolset regardless. Each also sets `strictMcpConfig: true` to drop the user's MCP
fleet, `skills: []`, `settings: { disableAllHooks: true, autoMemoryEnabled: false }` to close
surfaces the tool list doesn't cover, and `persistSession: false` since nothing records
their session id. They keep `settingSources: ["user"]`, since `~/.claude/settings.json` also
holds a Bedrock/Vertex/proxy user's `env` block and `apiKeyHelper`; full isolation there
would fail the run with "Not logged in" while ordinary turns kept working. The two
text-only helpers get `tools: []` and one turn. `draftProjectContext` adds `project` (to
load `CLAUDE.md`) and gets `["Read", "Grep", "Glob"]` with no Bash, which under
`bypassPermissions` would have meant unreviewed execution in the user's checkout to produce
prose. `tests/claudeSettingSources.test.ts` pins both policies.

Sessions default to `permissionMode: "auto"`, where the CLI's own classifier screens each
call and escalates whatever it won't vouch for. The picker also offers `bypassPermissions`,
`acceptEdits`, `default`, and `plan`. Every mode except `bypassPermissions` is a real gate.
`lib/agents/claude/capabilities.ts` is the single source of truth for which modes the driver
honors, and `tests/claudePermissionMode.test.ts` pins it against `permissionModeFor()` so a
picker entry can't quietly resolve to something else.

`canUseTool` is the SDK callback that also has to be present before the CLI will expose
`AskUserQuestion` at all. It routes every call the SDK doesn't auto-approve through
**`lib/permissions.ts`**: a read-only allowlist passes silently unless the CLI flagged a
`blockedPath`, which forces a prompt; otherwise the check falls through to the project's
remembered rules, then to a human. A prompt reuses the ask machinery wholesale
(`lib/asks.ts`, `POST /answer`, `tasks.awaiting_input`), yielding a `permission` StreamEvent
that the runner persists as an answerable transcript card and settles as
`permission_decided`. Remembered rules (`permission_rules`) are Bash-only and
project-scoped, because a command is the one input a user can read in full and generalize;
non-Bash tools get allow-once plus the CLI's own session-scoped suggestion. Every non-answer path denies: Stop, the SDK cancelling its own request, an expired prompt,
an unparseable answer, or a turn ending with a card still open (settled by the runner's
`finally`, or by a restart for any left in the DB). An unattended auto-deny also parks
queued follow-ups, the same way a dead login does.

The same card is also raised **before** a turn, by the runner rather than by a tool call
(**`lib/settingsDrift.ts`**, issue #43). `AgentDriver.watchedSettingsFiles` names the files a
driver re-reads from disk every turn and then obeys — `<worktree>/.claude/settings.json` for
Claude, derived from `SETTING_SOURCES` so a re-added source arrives watched — and those files
live where the agent's own writes land, so turn N can write what turn N+1 loads (hooks run
shell commands outside `canUseTool` entirely). The runner hashes each one before calling
`runTurn`, compares against `task_settings_snapshots`, and on a change publishes a `notice`
plus a `PermissionRequest` carrying `kind: "settings"` and the diff. Approving adopts the new
version as the baseline and the turn proceeds; declining ends the turn before the driver is
touched, parks the queue and leaves `awaiting_input` set. A first sighting is recorded
silently — nothing has run under an older version — and a declared-unattended run (a
schedule) refuses immediately, settling the run `failed`.

The CLI can also refuse a call without consulting `canUseTool`: the `auto` classifier can
veto something, or a deny rule in the loaded settings can block it. That arrives as a
`system`/`permission_denied` message rather than a card. There is nothing to answer, but the
model has lost a tool call, and without special handling the only trace would be an
`is_error` tool_result that reads like an ordinary failure. The message carries the
`tool_use_id`, so the driver yields a `permission_denied` StreamEvent and the runner settles
an already-decided permission card onto the transcript row that call already created. It's
the same component, read-only, showing the tool, its input, who refused, and why. A turn
denied three times gets three decided cards, one per call. Nothing is parked on the user
(`awaiting_input` is untouched), and our own `canUseTool` denials don't emit this message, so
the two paths never double-render.

`decision_reason` is documented as the human-readable field, but live CLI 2.1.x leaves it
unset and fills only `message`, which is written for the model ("IMPORTANT: You *may*
attempt to accomplish this action using other tools…"). `blockedReason()` takes the head of
that string instead. `decision_reason_type` is stored raw and phrased at render time, because
the CLI emits values the SDK's own docs don't list.

### The Codex driver (`lib/agents/codex/driver.ts`)

The Codex driver runs on the user's ChatGPT-plan `codex` login; it needs no API key. It's
built on `@openai/codex-sdk`, which spawns the `codex` CLI and speaks JSONL over stdio, the
same architecture as the Claude driver: `startThread()` / `resumeThread(session_id)`, with
the codex thread id emitted as the `session` event so lineage and resume work unchanged.
`events.ts` normalizes codex's `ThreadItem` stream into the `StreamEvent` contract:
`agent_message` becomes `assistant`; `command_execution`, `file_change`, `mcp_tool_call`,
`web_search`, `todo_list`, and `reasoning` become `tool` and `tool_result`; and
`turn.completed` usage becomes tokens plus an estimated `cost_usd`.

Run controls map our permission modes to codex's sandbox/approval policy
(`bypassPermissions` to workspace-write with approvals-never, `plan` to read-only); reasoning
presets map to `model_reasoning_effort`. The capability descriptor declares
`supportsMcpTools: true`: Calandria's tools reach codex through the portable stdio MCP
bridge described below, registered per turn with a roughly one-day `tool_timeout_sec` so a
parked ask survives. It declares `supportsAsks: true` because codex has no native
interactive-ask hook, but the bridge's `ask_user` tool surfaces the same question card and
blocks until the user answers. It declares `reportsCostUsd: false` and
`costIsEstimated: true` because ChatGPT-plan auth reports token counts only; `pricing.ts`
estimates the dollar cost per turn from tokens times published API prices for the resolved
model, and the UI renders those figures with a `~`.

One upstream limitation: the non-interactive CLI cannot pause a turn for command approval,
so on-request approval modes aren't offered. The only permission modes are workspace-write
(approvals never) and read-only (plan), labeled with codex's own sandbox-mode names. Auth
(`auth.ts`) drives `codex login --device-auth` and `codex login status`. The one-shot
helpers run as `codex exec` one-shots in a read-only sandbox (no writes, no approvals, no
network), bounded by an item cap, codex's analog of the Claude helpers' `maxTurns`, so a
runaway helper turn is cut off instead of looping unbounded. The binary path comes from
`CODEX_CLI_PATH`, or the SDK auto-resolves its bundled
binary or PATH.

### Internal one-shots (`lib/agents/oneshots.ts`)

`lib/agents/oneshots.ts` routes the internal jobs that run a turn outside the main chat:
`/clear` handoff summaries, project recaps, and "Refresh with AI" context drafts. Two
policies apply. Task-scoped one-shots (`/clear` transcript summarization) follow the task's
own agent, so a Codex task's handoff note is written by Codex and billed to the Codex login.
Project-scoped one-shots (recap, context draft) aren't tied to any one task, so they run on
the utility agent, resolved connected-first: the `utility_agent` app setting if that agent is
actually connected, else the app default agent, else the built-in default, else any
connected agent at all. That order gives a Codex-only instance working recaps and context
drafts with zero configuration; if no agent is connected, the job fails fast with an
actionable "connect an agent in Settings → Agents" error instead of driving a dead CLI.
Either way, if the chosen driver doesn't implement a given helper, the utility agent
backstops it, so a new driver can ship `runTurn()` alone and still get working summaries,
recaps, and drafts.

AI conflict-resolution turns need no special routing: `buildConflictPrompt()`
(`lib/agents/shared.ts`) produces the prompt, and the client sends it as an ordinary message,
so it flows through `startTurn()` to the task's driver like any other turn.

Unattended one-shots are server-gated by the `background_jobs` setting (default `on`).
Project recaps add a second `recap_mode` gate: `automatic` (default), `on_open`, or `off`.
The five-minute sweep requires `automatic`; opening a project accepts `automatic` or
`on_open`. Explicit `/clear`, Refresh with AI, and manual recap refreshes bypass the
unattended gate. Settings reads a single 30-day aggregation from `internal_usage` so the
controls show their run count and API-price-equivalent cost without polling.

### The agent-tool bridge (`scripts/calandria-mcp.mjs` + `lib/agentTools.ts`)

`suggest_task`, `list_tasks`, `get_task`, `update_task`, `withdraw_suggestion`,
`set_base_branch`, `create_pr`, `list_tags`, `update_tag`, `list_projects`, `expose_service`,
and `ask_user` are the same Calandria tools every driver exposes. The Claude driver mounts all
but `ask_user` as an in-process SDK MCP server (`createSdkMcpServer`) and gets asks natively
through its AskUserQuestion hook. The portable equivalent is **`scripts/calandria-mcp.mjs`**,
a plain-Node stdio MCP server (`@modelcontextprotocol/sdk`) that non-Claude drivers spawn
per turn. It's a thin proxy: it reads `CALANDRIA_TASK_ID`, `CALANDRIA_PROJECT_ID`,
`CALANDRIA_BASE_URL`, and `SERVICE_TOKEN` from env (injected by the driver) and POSTs each
tool call to the app's internal endpoints
(`app/api/internal/agent-tools/{suggest-task,list-tasks,get-task,update-task,withdraw-suggestion,set-base-branch,list-tags,update-tag,list-projects,expose-service,ask-user}`),
gated by the strict per-instance `SERVICE_TOKEN` in `middleware.ts`. `ask_user` is the
asynchronous one: the endpoint persists and publishes the same interactive question card the
Claude hook produces, parks a detached waiter on the user's answer (`lib/asks.ts`, tied to
the turn's abort signal), and the bridge polls the sibling `ask-user/wait` endpoint for the
settled outcome. No HTTP request is held open, and the ask survives page reloads because the
card lives in the transcript. Both the in-process server and the endpoints call the same
shared logic in **`lib/agentTools.ts`** and build their tool definitions from the same
constants in **`lib/agentToolDefs.mjs`**, so the two paths can't drift.

`suggest_task` can file a task into any project; `list_projects` lets the agent name one
without guessing. `resolveTargetProject()` matches an exact id, else a case-insensitive
exact name, else refuses and lists the candidates. It never falls back to the calling
project, because a silently misfiled task is worse than an error the agent can retry.
Resolution happens before the insert, so the task's agent, `send_context`, and board
position all come from the target project. Two consequences follow from that: `blocked_by`
refs must resolve inside the target project (`setTaskDeps` is project-scoped, and refs that
don't resolve are reported back rather than dropped silently), and the `suggested` event
carries the target's project id so `GET /api/events` can tell a client which tray to
refresh, since the receiving project is usually not the one on screen.

A filed suggestion is also shown **where it was made**. The `suggested` event carries the id
of the task it created, and the runner settles it onto the `suggest_task` tool row the call
already produced — the same move an already-decided permission card makes, so the proposal
sits with the call rather than floating beside it. The transcript then renders a card with
the title, priority, blockers, the project it landed in, and the tray's own three actions
(Start · Add · Dismiss), wired to the same handlers the tray uses so a session started here
is indistinguishable from one started there. Only two ids are persisted onto the row
(`ToolData.suggestion`); everything shown is re-read from the task through
`GET /api/tasks/[id]/suggestion` on every render, which is what keeps a transcript reloaded
next week honest — an accepted, started, withdrawn or hard-deleted suggestion renders as
such instead of offering Start a second time or 404ing on click.

**Start is deliberately not offered for a suggestion filed into a DIFFERENT project.**
Starting one mints its session and selects it, which for a cross-project card means being
pulled out of the session you are reading and into a project you may not have had on screen
— a bigger and less recoverable interruption than the tray round trip it saves. Such a card
names the project the task went to and offers Add and Dismiss, neither of which navigates.

Correlation is by tool name, not by title: the tool StreamEvent (and the persisted
`ToolData`) carries the agent's own `name` for the call, and `lib/suggestionCard.ts` matches
`suggest_task` as a substring because every driver prefixes it differently
(`mcp__calandria__suggest_task` in-process, `calandria__suggest_task` over the bridge). A
turn running through the runner settles in memory; the stdio bridge's endpoint has no
tool_use id to correlate with — a Codex session's MCP client calls it out of band — so it
patches the newest unclaimed `suggest_task` row instead, and the runner re-reads that field
before stamping a `tool_result` over the top so the two writers can't clobber each other.

Reading and writing existing tasks splits by blast radius. Reads are inert, so they range as
widely as suggestion filing: `list_tasks` takes the same optional `project` (resolved by the
same strict `resolveTargetProject`) and flags the caller's own row `current: true`;
`get_task` reads any row by id, defaulting to the session's own, which is how an agent
re-reads the brief it started with. Writes are bounded by one thing: whether somebody else
is holding the row right now. `update_task` writes any task in any project: the caller's own
row by default (when its optional `task` param is omitted), or any id from `list_tasks`,
including one the user has already accepted or another session has started. The sole
refusal is `running = 1`, since a turn streaming into that row this instant may be mid-read
of the fields the call would rewrite.

Everything else lands. The gate that used to stop more writes,
`suggested = 1 AND started = 0 AND running = 0`, punished the case that matters most: a
chain of accepted tasks going stale the moment one fact underneath it changes, with no way
for an agent to fix what it had already worked out. The replacement records what the old
rule would have refused, rather than granting it for free: a write that isn't on the
caller's own row and isn't an unreviewed tray suggestion is recorded in `task_agent_edits`
(actor, per-field before/after, timestamp) and stamps `tasks.agent_edited_at`, which the
task card surfaces as a "Changed by agent" chip. Opening it shows the diff with a per-edit
Revert and a Keep-changes action that clears the flag
(`GET`/`POST /api/tasks/[id]/agent-edits`). Writes on the caller's own row, or on an
untouched tray suggestion, are unchanged from before and aren't recorded, since those were
already the agent's to make freely.

`update_task`'s editable fields are title, description, priority, and status, minus
`cancelled`, plus `blocked_by`. `cancelled` is excluded because on the caller's own row it
would call `abortTurn()` and tear down the very turn making the call, and on anyone else's
row it's a decision that needs a stated reason, which a bare status write has nowhere to
put (see `withdraw_suggestion` below).

`blocked_by` is the only way an agent can order a plan at all. `suggest_task` takes
blockers in the same call that invents the task, before any of the tasks has an id, so a
planning turn that files a batch of tasks and works out the sequence afterward can't use it
there. In practice it never has: every dependency edge on a real board was drawn through the
UI's edit dialog. The supported recipe is two-phase, and the prompt in
`buildProjectContext()` spells it out: file every task, wait for the ids, then call
`update_task` per dependent task.

`update_task`'s version of `blocked_by` differs from `suggest_task`'s in two ways, both
because it replaces a set instead of filling a blank one. It is refused on the caller's own
row, because blockers gate whether a task may start and a session calling this has already
started; the edge would be inert on the scheduler and misleading on the board, so the
refusal names `on_hold` as the honest status instead. And an unusable ref fails the whole
call, named one at a time with its reason (not a task id, in another project, or the task
itself), unlike `suggest_task`, which partitions and reports: wiring the refs it recognized
and dropping the rest would delete edges the agent never mentioned while still reporting
success. A cycle refuses everything too; `setTaskDeps` runs before the row patch, so a
rename in the same call can't land under a refusal that claims nothing changed.

Like `createSuggestedTask`, `updateTaskForAgent()` re-reads both rows before writing,
because a detached turn's snapshot can outlive the row and a target read a moment ago may
have started since. The eligibility check and the write share one synchronous block, atomic
under better-sqlite3 in a single Node process. Marking a task done fires
`maybeAutoStartDependents()` against the target's id. That call lives with the callers
rather than inside `lib/agentTools.ts`, because that module is pinned SDK-free
(`tests/importGraph.test.ts`) while `lib/autoStart.ts` reaches the runner. For the stdio
bridge, the caller is the internal route, which fires the sweep itself. For the Claude
driver, it's the `TurnHooks` callback the launcher injected through `startTurn`
(`lib/agents/types.ts`): the driver reports the cleared task and nothing more, because a
driver importing `lib/autoStart.ts` would close a cycle back through
`lib/agents/registry.ts`, the same cycle that once compiled `lib/autoStart.ts`
synchronously and broke every auto-start in production.

The whole policy lives in `updateTaskForAgent()`, because the two paths differ in how they
learn the target: the Claude driver closes over the caller and hands the model's `task`
argument straight through, while the bridge's endpoint takes the caller from the
env-injected `CALANDRIA_TASK_ID` and the target from the request body. Because the target
is model-supplied in both cases, `tests/codexUpdateTaskPolicy.test.ts` runs the real bridge
against the real endpoint and asserts on the database rather than on the refusal text.

Tags reuse the same three tools plus one new read, and the create-vs-strict split is the
whole policy (`resolveTagRefs()` in `lib/agentTools.ts`, over `resolveTag()` in the store).
`suggest_task`'s `tags` are resolved after `resolveTargetProject`, in the project the task
is actually filed into, because a tag never spans repositories and a cross-project
suggestion has to tag where it lands. A name that matches nothing is created there with
`origin_task_id` set to the calling task, which fits the planning verb: the common case is
that the tag doesn't exist yet, and a separate `create_tag` round trip would repeat the
two-phase dance `blocked_by` already forces. A near-miss minting a duplicate is bounded by
`UNIQUE(project_id, name)`, and the result names the reused tags and the created ones
separately.

`update_task`'s `tags` works the opposite way: existing ids or exact names only, never a
create, because the task already exists and a typo would split a feature the user is
filtering by. It replaces the set (`[]` clears it), and an unknown ref fails the whole call,
the same fail-closed rule an unusable `blocked_by` ref gets, so a rename sharing that call
can't land under a refusal that claims nothing changed. Resolution is all-or-nothing across
the list for the same reason: filing under two of the three tags an agent named, while
reporting success, is worse than refusing outright. It resolves in the target's project
rather than the caller's, for the same reason the tool can write any task anywhere.

`list_tasks` gains a `tag` filter, resolved strictly so an unrecognized one is an error
rather than a silently unfiltered board, and every row carries `tags: [{id, name}]`
regardless. **`list_tags(project?)`** returns each tag's description, base branch, derived
counts, and tasks with titles and statuses, so "how is the migration going" is one call
instead of N `get_task` calls. Task rows on both `list_tasks` and `get_task` carry
`base_branch` already resolved through the task, first tag, project chain
(`lib/baseBranch.ts`), so an agent asking what it's based on never reimplements the
fallback.

**`lib/tagContext.ts`** consumes what tags resolve to. `tagContextBlock(task)`, called from
`buildProjectContext()`, emits one block per tag the task carries, in tag order
(`task_tags.position`). Each block names the tag, states what it's for, gives which step of
how many this task is (a topological sort over `depends_on` restricted to that tag, ties
broken by `tasks.position`, the same order `TagStrip.tsx` numbers, so the prompt and the
screen agree), lists its siblings with status markers and `← this task`, and adds
`Planned in task "…"` pointing at the session that filed the plan. One block per tag is why
tags replaced groups: a task that is step 3 of the auth migration and also part of the 0.4
release needs both facts, and neither implies the other.

Sibling descriptions aren't inlined, because a seven-task plan would spend a fifth of the
session's starting context on work this task isn't doing, and three tags would multiply
that by three; `get_task` is one call away for whichever sibling matters. `send_context = 0`
suppresses every block exactly as it suppresses project context. The module is pinned
SDK-free (`tests/importGraph.test.ts`) because `lib/agents/shared.ts` reaches every driver.

**`withdraw_suggestion(task, reason)`** is the retraction verb. It exists because the
nearest alternative was wrong twice over: an agent reaching for `status: "done"` to mean
"this one's redundant" would both claim that unstarted work is finished and trigger the
exact transition that fires `maybeAutoStartDependents()`, silently launching real sessions
behind it. Eligibility uses the same `isInertSuggestion()` helper `update_task` uses, shared
so the two can't drift into "editable but not withdrawable." `reason` is required and must
be non-empty, because a retraction the user can't understand is worse than none.

It is not a delete: the tray's Dismiss button already hard-deletes via
`DELETE /api/tasks/:id` with no undo anywhere in the app, and destroying a proposal the user
hasn't read isn't a call an agent should make. Instead the row is set to `cancelled` while
`suggested` stays `1`. It remains in the tray, struck through, with `tasks.withdrawn_reason`
shown beside it and sorted below the live suggestions (`isWithdrawn` / `withdrawnLast` in
`app/shell/format.ts`, honored by both the list tray and the board's Suggested column), and
`task_edited` is published so other tabs refetch a field the coarse wire payload can't
carry.

Reviving is centralized in `PATCH /api/tasks/[id]`, which clears the reason and the
cancelled status together whenever a withdrawn row leaves that state. Three callers reach
it: the tray's Add and Start both patch `suggested: 0` and nothing else, the board's drag
sends a status too, and the edit dialog re-statuses in place. Each would otherwise have to
remember both halves.

Withdrawing forced a change on a shared path. `lib/autoStart.ts`'s `blocks()` has always
counted `cancelled` as terminal, because a dependent waiting on a task that will never
finish would deadlock, but the sweep only fired on the transition into `done`. Cancelling
the last blocker cleared the edge but launched nothing, leaving an `auto_start` dependent
unblocked but never started. `maybeAutoStartDependents()` now fires on any non-terminal to
terminal transition, from `withdraw_suggestion` and from the user-facing PATCH, so the
scheduling decision follows from the resulting state rather than from which endpoint
produced it. The transcript note distinguishes `"X" is done` from `"X" was cancelled`.
Cancelling a task can now start work, matching what "Start when unblocked" promises;
`tests/autoStart.test.ts` and `tests/withdrawSuggestion.test.ts` pin both directions so this
can't regress.

### Adding a third agent (e.g. Gemini, Cursor)

Implement the `AgentDriver` interface in `lib/agents/<id>/driver.ts`. `runTurn()` is the
only required method; the one-shot helpers are optional and fall back to the utility agent.
Register the driver in `lib/agents/registry.ts` and ship its CLI in the `Dockerfile`,
installed on `PATH` next to `claude` and `codex`. Nothing else needs to change: the
capability descriptor drives the pickers, the `/api/agents/[id]/*` routes are generic, and
`getDriver(task.agent)` resolves the new driver everywhere it's used. `tests/agentDriver.test.ts`
(the driver contract test) and `tests/codexEvents.test.ts` (the event-mapping test) are
templates for pinning a new driver to the same `StreamEvent` contract.

## Everything else, by module

- **`lib/db.ts`** holds the SQLite schema, migrations, and seed data. **`lib/store.ts`**
  holds typed queries for projects, tasks, messages, summaries, and sessions.
- **`lib/git.ts`** handles per-task worktrees and branches, diffs, and merging: `mergeTask()`,
  plus `prepareWorktreeMerge()` / `completeWorktreeMerge()` / `abortWorktreeMerge()` for AI
  or manual conflict resolution, and `worktreeSyncStatus()` / `fastForwardWorktree()` to
  catch a stale branch up to base. It also holds the app's only remote awareness.
  `fetchBase()` refreshes the base branch's remote-tracking ref on a best-effort basis (hard
  timeout, no interactive prompting, per-repo cooldown, run outside the repo lock);
  `remoteBaseStatus()` compares local base against it; and `advanceBaseBranch()` /
  `pushBaseBranch()` move it forward, never forced. New worktrees are cut from the fetched
  remote tip when local base is merely behind it, pinned to a SHA so the ref can't move
  underneath `worktree add` and the task branch gets no upstream. The user's local base
  branch moves only on an explicit click, or as a tidy-up before a merge that would
  otherwise fold the remote's commits into the task's own.
- **`lib/services.ts`** is the managed-services supervisor. It starts, stops, and restarts a
  project's configured `dev`/`setup`/`test` commands as detached process-group children
  owned by the server, not by a turn or a browser tab, captures their stdout/stderr into a
  per-service ring buffer, and publishes status/log events over SSE. State lives on
  `globalThis` and survives HMR, like `lib/events.ts`. Each project gets a stable `PORT`
  (`projects.port`, deterministic from `CALANDRIA_SERVICE_PORT_BASE`) injected into every
  service's env and the PTY shell.

  Managed services are on by default (`CALANDRIA_FEATURE_SERVICES=0` disables them). The
  registry is persisted in the `services` table, and `server.js` restores and auto-restarts
  managed services on boot. It first reaps any process group a crashed server left orphaned:
  the spawn pid is persisted per row, and the reaper verifies the group still runs the
  service's command before sending `SIGKILL`, so a recycled pid is never killed by mistake.
  It also probes the port first, so a conflict with an unmanaged process surfaces as a
  readable `error` on the service instead of an EADDRINUSE crash loop. A clean process exit
  sends `SIGKILL` to every managed group on the way out.

  Public hostnames are a separate opt-in (`CALANDRIA_SERVICE_HOSTS`): each service then gets
  a stable `<slug>--<appHost>` hostname with per-service visibility (private, shared-link,
  or public), dispatched through the reverse-proxy router in **`lib/service-router.mjs`**
  (with WebSocket/HMR passthrough), backed by the pure hostname/token helpers in
  **`lib/service-host.mjs`**.
- **`lib/contextRefresh.ts`** runs "Refresh with AI" as a detached background job, so a
  multi-minute draft never holds an HTTP request open across a tunnel. `startRefreshJob()`
  seeds the utility agent with recent git activity, runs `draftProjectContext()` in the repo
  read-only, and persists the result for the client to poll via
  `GET /api/projects/[id]/refresh-context`. The draft is for the user to review; it is never
  auto-saved.
- **`lib/recap.ts`** holds the "where you left off" staleness and activity logic, plus its
  background sweep.
- **`app/Shell.tsx`** is the client UI: a projects rail, task list, and live session, with
  the session split into the transcript and the `SessionRail` DIFF/PREVIEW/CONTEXT tabs. One
  `EventSource` per selected task renders from server events, so a reload, sleep, or task
  switch mid-turn just catches up.
- **`app/Terminal.tsx`** and **`pty-server.js`**: xterm.js talks to the same-origin `/pty`
  WebSocket (proxied by `server.js`), which reaches the `node-pty` sidecar bound to
  `127.0.0.1`.

## Where data lives

| What | Where |
|-|-|
| Projects, tasks, transcripts, summaries, session index | `calandria.db` (SQLite) in `CALANDRIA_DB_DIR`, default `~/.calandria` |
| The single-instance boot lock | `calandria.lock.db` beside it, a pure mutex holding no data (see below) |
| Per-task git worktrees | `CALANDRIA_WORKTREES_DIR`, default `~/.calandria/worktrees`, kept outside every repo |
| Cloned project repos | `CALANDRIA_PROJECTS_DIR`, default `~/projects` |
| Your apps' actual code | each project's working directory, never inside Calandria's own tree |
| Claude Code's raw session logs | `~/.claude/projects/...` (managed by Claude Code) |

With the env unset, nothing is moved automatically. If `~/.calandria` holds no database but
the pre-rename `~/.zen-orchestrator/orchestrator.db` exists, the old path keeps being used
and boot prints one hint line. Inside an explicit `CALANDRIA_DB_DIR`, `calandria.db` wins if
present, and an existing `orchestrator.db` is the fallback. A populated legacy
`~/.agent-orchestrator/worktrees` is kept where it is, because git registers each worktree
by absolute path in the parent repo's `.git/worktrees/<id>/gitdir`; relocating it would need
a `git worktree repair` run per project. An empty legacy worktrees directory is abandoned
instead. All of this resolves in one shared module, `lib/storage.mjs`; see
`docs/SELF_HOSTING.md` for the manual migration recipe.

### One process per database

Calandria runs as a single process against its database because of how the rest of the app
is built: turns run detached and owned by the server, the event bus and the abort/ask
registries are in-memory on `globalThis`, and `init()` opens every boot by clearing what a
crash left behind (running flags, the pending-message queue, unanswered permission cards,
in-flight schedule runs). If a second process pointed at the same database, that recovery
pass would run against a live instance: it would wipe the first process's running flags,
drop its queued follow-ups, and settle cards a human is still reading, while the first
process kept writing to rows the second believed were idle.

`server.js` claims the database before `app.prepare()` (`lib/db-lock.mjs`), and exits with
the holder's pid and host if it can't. The mutex is a kernel file lock: a `BEGIN IMMEDIATE`
transaction opened on a dedicated `calandria.lock.db` and never committed, holding SQLite's
RESERVED lock for the life of the connection. This is a plain lock file rather than a
pid-and-heartbeat lease, because a lease needs a heartbeat to miss, a staleness window to
tune, and a pid-liveness heuristic that doesn't hold up: pids are small and reused inside a
container, and `docker restart` keeps the hostname, so "pid 7 on host abc is alive" proves
nothing. The OS drops the file lock when the process dies, so recovery after a SIGKILL is
immediate. Boot still retries for `CALANDRIA_DB_LOCK_WAIT_MS`, which covers only the second
or so a predecessor spends shutting down. `locking_mode = EXCLUSIVE` is not layered on top,
because in that mode a connection keeps its SHARED lock even after a failed write, so two
racing processes could deadlock each other out of the upgrade.

A separate lock file, rather than locking `calandria.db` itself, keeps a concurrent
read-only `sqlite3 calandria.db` inspection working and leaves WAL alone. A best-effort JSON
sidecar records who holds the lock, read only to write a useful error message; it never
decides ownership, so a sidecar left behind by a hard kill can't wedge anything.

The recovery pass sits behind `consumeDbRecoveryAuthorization()`, which returns true at most
once, and only for a database this process actually claimed. Under vitest and `next build`
it is never authorized, since recovery should only run for the process that owns the
database. Ownership state lives on `globalThis` because `server.js` loads the module through
Node's ESM loader while `lib/db.ts` loads it through Turbopack's bundle: two module
instances sharing one realm.

The lock only coordinates processes sharing a kernel. Two containers on one volume may not
see each other's locks, but sharing a WAL database across sandboxes is unsafe regardless:
run one instance per volume.

**Stack:** Next.js (App Router) + TypeScript · React 19 · better-sqlite3 ·
`@anthropic-ai/claude-agent-sdk` · xterm.js + node-pty sidecar · streaming over SSE.
