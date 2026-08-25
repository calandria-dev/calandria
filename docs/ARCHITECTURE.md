# Architecture

How Calandria is put together. This is the public companion to [`CLAUDE.md`](../CLAUDE.md)
(the in-repo codebase map agents read); if the two ever disagree, trust the code.

## Three processes, one origin

- **`server.js`** — custom Next.js server (plain Node, Turbopack in dev). Fronts Next on one
  port, proxies `/pty` WebSocket upgrades to the sidecar, and forwards dev HMR upgrades to
  Next. Because everything rides one origin, a Cloudflare Tunnel (or any reverse proxy)
  exposing a single https hostname carries both the app and the terminal — no second port,
  and `wss://` is used automatically over https.
- **`pty-server.js`** — the node-pty terminal sidecar, bound to `127.0.0.1` only; never
  exposed directly. The browser reaches it through the app origin at `/pty`.
- **The Next app** — UI in `app/`, REST under `app/api/`, server logic in `lib/`.

## The turn lifecycle

**`lib/runner.ts`** is the detached turn runner: `POST /api/tasks/[id]/messages` launches a
turn and returns immediately — the turn runs server-side, owned by the process (not by any
HTTP request), persisting every event to SQLite and publishing it on **`lib/events.ts`**
(in-process pub/sub keyed by task id, plus a wildcard channel that sees every task's
events). Stopping is only ever explicit, via `lib/abort.ts`. If a turn is already running,
the message parks in the `pending_messages` queue to run next.

One exception, and it's the reason `pending_messages` isn't the whole story: a turn that
is **lingering** (the model is done, the session is only held open so background work can
finish or a wakeup can fire) has nothing in flight, and by default that wait has no
deadline. The Claude driver keeps its prompt iterable open for the whole linger, so
`sendToLingeringTurn()` hands the message straight to it through `lib/turnInput.ts` and it
starts the next turn immediately, persisted and published as an ordinary user message.
Order is kept at both ends: entering a linger first drains the oldest already-parked
follow-up into the same open session (that's the "sent when this turn ends" the composer
promised — the model's turn HAS ended), and a send is refused while anything is still
queued, so the caller parks it behind what came before.

`GET` on the same route is the SSE watch stream: a `snapshot` of the persisted transcript,
then a live tail — reconnect-safe, any number of viewers, zero viewers fine.

`GET /api/events` is the global lifecycle stream: one always-open SSE connection per client
tab broadcasting coarse turn boundaries (turn started / awaiting input / answered /
suggestion created / turn ended) for every task across every project. Each event carries a
fresh snapshot of the task row plus its project's awaiting count — that's how spinners,
project badges, and the "N need you" pill update instantly for tasks whose transcript
stream isn't open. There is no task-list polling.

Not every fact fits that snapshot. A mutation route publishes `task_edited` when it rewrites
fields the snapshot can't carry (title, priority, dependency edges) — the client refetches
the row instead of patching it. And three events aren't about a single task at all, so they
carry their own project id and skip the relay's re-read entirely: `task_deleted` (the row is
gone), `tasks_moved` (both ends, since the trays a selection LEFT have to lose it), and
`tasks_reordered` (a board drag rewrote the project's manual card order — `position` isn't
on the wire, or on the client's task model, so the tray refetches). Reorder is the one that
fires on every drop, so `reorderTasks` publishes only for projects whose *rendered* order
actually moved: dropping a card back where it started, or renumbering positions left
non-contiguous by a delete, is silent. The dragging tab holds its own echo until its writes
settle, so an optimistic drop is never snapped back by the event it caused.

**A task is a lineage of sessions.** Generation N ends at `/clear`; its transcript is
condensed to a summary, and generation N+1 starts with a clean context window seeded by all
prior summaries. The task persists — only the context window resets.

## The agent-driver seam (`lib/agents/`)

The app talks to coding agents only through the `AgentDriver` interface.

- **`types.ts`** defines the interface: a normalized `StreamEvent` turn contract, one-shot
  summarize/draft/recap helpers, a capability descriptor, and the login/verify auth surface.
- **`registry.ts`** resolves a driver by id — `getDriver(task.agent)`, persisted per task,
  defaulted per project via `projects.default_agent`.
- **`shared.ts`** holds the agent-agnostic pieces every driver reuses: project-context and
  conflict prompts, tool-call → title/peek/diff normalizers, the event queue.
- **`listCommands?(task, project)`** (optional) reports the slash commands a turn on that
  task would expand, so the composer's `/` menu is discovered from the agent rather than
  hardcoded. `GET /api/tasks/[id]/commands` serves it, filtered by `lib/agentCommands.ts`;
  a driver that omits it leaves the menu with Calandria's own commands. The Claude
  implementation reads the SDK's initialization response without sending a model request,
  under the same isolation as the one-shots (see `lib/agents/claude/commands.ts`). It is the
  app's only command enumeration: the schedule editor's prompt validation asks the same
  function, so the menu and the validator cannot disagree about what a session expands.
- **`GET /api/agents`** serves each driver's capability descriptor **plus its persisted
  connection state** to the client, which renders every run-control picker (model /
  reasoning / permission), the per-task agent picker, agent badges, and the cost/ask
  feature gates from that data — no hardcoded per-agent lists in the UI.
- Connecting an agent is driver-driven and route-generic:
  **`/api/agents/[id]/{login,login/code,verify,api-key,status}`** resolve
  `getDriverStrict(id)` and call its auth surface, so a new agent costs zero new routes;
  `connections.ts` records which agents are connected. Each agent's credentials live under
  `$HOME` (Claude `~/.claude`, Codex `~/.codex`); the optional per-token API-key paths
  persist to a 0600 file (`lib/anthropic-key.ts` / `lib/openai-key.ts`).

### The Claude driver (`lib/agents/claude/driver.ts`)

`runTurn()` via the Claude Agent SDK (resume or fresh session, project context appended to
the Claude Code system prompt), the Calandria MCP tools (`suggest_task` + `list_tasks` +
`get_task` + `update_task` + `withdraw_suggestion` + `list_projects` + `expose_service`),
`summarizeTranscript()` for `/clear`, and `draftProjectContext()` (a read-only agent loop
that explores the repo to refresh a project's saved context). Auth delegates to
`lib/claude-auth.ts`.

A **turn** pins `settingSources: ["user", "project", "local"]` — the SDK's own default when
the option is omitted, written out so an SDK bump can't silently strip the user's MCP
servers, plugins, skills and the repo's `CLAUDE.md` from every session. The **one-shots**
take the opposite policy: isolate capability, inherit config. Each sets `tools` (the real
restriction — `allowedTools` only pre-approves, and `bypassPermissions` pre-approves
everything anyway, so all three helpers used to run with the full toolset), plus
`strictMcpConfig: true` to drop the user's MCP fleet, `skills: []`,
`settings: { disableAllHooks: true, autoMemoryEnabled: false }` to close the surfaces the
tool list doesn't cover, and `persistSession: false` because nothing records their session
id. What they keep is `settingSources: ["user"]`: `~/.claude/settings.json` is also where a
Bedrock/Vertex/proxy user's `env` block and `apiKeyHelper` live, so full isolation there
fails the run with "Not logged in" while ordinary turns keep working. The two text-only
helpers get `tools: []` and one turn; `draftProjectContext` adds `project` to the sources
(that is what loads `CLAUDE.md`) and gets `["Read", "Grep", "Glob"]` — no Bash, which under
`bypassPermissions` was unreviewed execution in the user's checkout to produce prose.
`tests/claudeSettingSources.test.ts` pins both policies.

Sessions default to `permissionMode: "auto"` — the CLI's classifier screens each call and
escalates what it won't vouch for — and the picker offers `bypassPermissions`,
`acceptEdits`, `default` and `plan` alongside it. Every mode but `bypassPermissions` is a
real gate; the list in `lib/agents/claude/capabilities.ts` is the single source of truth
for what the driver honors, pinned against `permissionModeFor()` by
`tests/claudePermissionMode.test.ts` so a picker entry can never quietly resolve to
something else. `canUseTool` (the SDK callback the CLI also needs present before it
will expose `AskUserQuestion` at all) routes every call the SDK doesn't auto-approve
through **`lib/permissions.ts`**: a read-only allowlist passes silently — unless the CLI
flagged a `blockedPath`, which forces a prompt — then the project's remembered rules, then
a human. A prompt reuses the ask machinery wholesale (`lib/asks.ts`, `POST /answer`,
`tasks.awaiting_input`), yielding a `permission` StreamEvent the runner persists as an
answerable transcript card and settling on a `permission_decided`. Remembered rules
(`permission_rules`) are Bash-only and project-scoped — a command is the one input a user
can read in full and generalize — while non-Bash tools get allow-once plus the CLI's own
session-scoped suggestion. Every non-answer path denies: Stop, the SDK cancelling its own
request, an expired prompt, an unparseable answer, and a turn that ends with a card still
open (the runner settles it in its `finally`, and a restart settles any left in the DB).
An unattended auto-deny also parks queued follow-ups, the same way a dead login does.

The CLI can also refuse a call *without* consulting `canUseTool` — the `auto` classifier
vetoing something, or a deny rule in the loaded settings — which arrives as a
`system`/`permission_denied` message rather than a card. There is nothing to answer, but
the model just lost a tool call and the only other trace is an `is_error` tool_result that
reads like an ordinary failure. It carries the `tool_use_id`, so the driver yields a
`permission_denied` StreamEvent and the runner settles an already-decided permission card
onto the transcript row that call already created — the same component, read-only: the
tool, its input, who refused, and why. A turn denied three times gets three decided cards,
each on its own call. Nothing is parked on the user (`awaiting_input` is untouched), and
our own `canUseTool` denials don't emit this message, so the two paths can't double-render.

The message's `decision_reason` is the field documented as human-readable, but live
CLI 2.1.x leaves it unset and fills only `message` — which is written *for the model*
("IMPORTANT: You *may* attempt to accomplish this action using other tools…"), so
`blockedReason()` takes the head of it. `decision_reason_type` is stored raw and phrased at
render time, because the CLI emits values the SDK's own docs don't list.

### The Codex driver (`lib/agents/codex/driver.ts`)

Driven by the user's ChatGPT-plan `codex` login (no API key). Built on `@openai/codex-sdk`
(it spawns the `codex` CLI and speaks JSONL over stdio, same architecture as the Claude
driver): `startThread()` / `resumeThread(session_id)`, with the codex thread id emitted as
the `session` event so lineage/resume works unchanged. `events.ts` normalizes codex's
`ThreadItem` stream (agent_message → assistant; command_execution / file_change /
mcp_tool_call / web_search / todo_list / reasoning → tool + tool_result; `turn.completed`
usage → tokens plus an **estimated** `cost_usd`) into the `StreamEvent` contract.

Run controls map our permission modes to codex's sandbox/approval policy
(bypassPermissions → workspace-write + approvals-never; plan → read-only); reasoning
presets map to `model_reasoning_effort`. Capabilities declare `supportsMcpTools: true` (the
Calandria's tools reach codex through the portable stdio MCP bridge below, registered
per turn with a ~1-day `tool_timeout_sec` so a parked ask survives),
`supportsAsks: true` (codex has no native interactive-ask hook, but the bridge's
`ask_user` tool surfaces the same question card and blocks until the user answers) and
`reportsCostUsd: false` + `costIsEstimated: true` — ChatGPT-plan auth reports token counts
only, so `pricing.ts` estimates the dollar cost per turn (tokens × published API prices
for the resolved model) and the UI renders those figures with a `~`. The one upstream
limitation not papered over: the non-interactive CLI cannot pause a turn for **command
approval**, so on-request approval modes aren't offered — permission modes are
**workspace-write** (approvals never) and **read-only** (plan), labeled with codex's own
sandbox-mode names. Auth (`auth.ts`) drives
`codex login --device-auth` + `codex login status`. The one-shot helpers run as
`codex exec` one-shots in a **read-only sandbox** (no writes, no approvals, no network),
bounded by an item cap — the codex analog of the Claude helpers' `maxTurns` — so a
runaway helper turn is cut off rather than looping unbounded.
Binary via `CODEX_CLI_PATH` (else the SDK auto-resolves its bundled binary / PATH).

### Internal one-shots (`lib/agents/oneshots.ts`)

Routing for the internal jobs that run a turn **outside the main chat**: `/clear` handoff
summaries, project recaps, and "Refresh with AI" context drafts. Two policies:
**task-scoped** one-shots (`/clear` transcript summarization) follow the **task's own
agent**, so a Codex task's handoff note is written by Codex and counted against the Codex
login; **project-scoped** one-shots (recap, context draft) aren't tied to any one task, so
they run on the **utility agent**, resolved **connected-first**: the `utility_agent` app
setting when that agent is actually connected → the app default agent → the built-in
default → any connected agent at all — so a Codex-only instance gets working recaps and
context drafts with zero configuration, and when NO agent is connected the job fails fast
with an actionable "connect an agent in Settings → Agents" error instead of driving a dead
CLI. Either way, if the chosen driver doesn't implement a given helper, the utility
agent backstops it — so a new driver can ship `runTurn()` alone and still get working
summaries/recaps/drafts. AI conflict-resolution turns need no special routing:
`buildConflictPrompt()` (`lib/agents/shared.ts`) produces the prompt and the client sends
it as an ordinary message, so it flows through `startTurn()` → the task's driver like any
turn.

Unattended one-shots are server-gated by the `background_jobs` setting (default `on`).
Project recaps add a second `recap_mode` gate: `automatic` (default), `on_open`, or `off`.
The five-minute sweep requires `automatic`; opening a project accepts `automatic` or
`on_open`. Explicit `/clear`, Refresh with AI, and manual recap refreshes bypass the
unattended gate. Settings reads a single 30-day aggregation from `internal_usage` so the
controls show their run count and API-price-equivalent cost without polling.

### The agent-tool bridge (`scripts/calandria-mcp.mjs` + `lib/agentTools.ts`)

`suggest_task` / `list_tasks` / `get_task` / `update_task` / `withdraw_suggestion` /
`list_groups` / `list_projects` / `expose_service` / `ask_user` are the same Calandria
tools every driver exposes. The Claude driver mounts all but `ask_user` as an in-process SDK MCP server
(`createSdkMcpServer`) and gets asks natively via its AskUserQuestion hook; the portable
equivalent is **`scripts/calandria-mcp.mjs`**, a plain-Node stdio MCP server
(`@modelcontextprotocol/sdk`) the non-Claude drivers spawn per turn. It's a thin proxy: it
reads `CALANDRIA_TASK_ID` / `CALANDRIA_PROJECT_ID` / `CALANDRIA_BASE_URL` / `SERVICE_TOKEN` from env
(injected by the driver) and POSTs each tool call to the app's internal endpoints
(`app/api/internal/agent-tools/{suggest-task,list-tasks,get-task,update-task,withdraw-suggestion,list-groups,list-projects,expose-service,ask-user}`,
gated by the strict per-instance `SERVICE_TOKEN` in `middleware.ts`). `ask_user` is the asynchronous one: the
endpoint persists + publishes the same interactive question card the Claude hook produces,
parks a **detached** waiter on the user's answer (`lib/asks.ts`, tied to the turn's abort
signal), and the bridge **polls** the sibling `ask-user/wait` endpoint for the settled
outcome — no long-held HTTP request, and the ask survives page reloads because the card
lives in the transcript. Both the in-process server and the endpoints call the SAME shared
logic in **`lib/agentTools.ts`**, and both build their tool defs from the SAME constants in
**`lib/agentToolDefs.mjs`**, so the two paths can't drift.

`suggest_task` can file into ANY project, not just the session's — `list_projects` exists so
the agent can name one without guessing. `resolveTargetProject()` matches an exact id, else
a case-insensitive exact name, else refuses and lists the candidates; there is deliberately
no fallback to the calling project, because a silently misfiled task is worse than an error
the agent can retry. Resolution happens *before* the insert, so the task's agent,
`send_context` and board position all come from the **target**. Two consequences follow the
target too: `blocked_by` refs must resolve inside it (`setTaskDeps` is project-scoped, and
refs that don't are now reported back rather than dropped in silence), and the `suggested`
event carries the target's project id so `GET /api/events` can tell a client which tray to
refresh — the receiving project is usually not the one on screen.

Reading and writing EXISTING tasks splits along blast radius. Reads are inert, so they range
as widely as suggestion filing does: `list_tasks` takes the same optional `project` (resolved
by the same strict `resolveTargetProject`) and flags the caller's own row `current: true`;
`get_task` reads any row by id, defaulting to the session's own — that's how an agent
re-reads the brief it was started with. Writes are bounded by what nobody else is holding:
`update_task` writes the **calling task's own row** (the default, when its optional `task`
param is omitted) and, beyond that, only an **inert tray suggestion** — `suggested = 1 AND
started = 0 AND running = 0` — in any project. That second target is what lets a planning
turn go back and sharpen the roadmap it just filed; it ranges across projects because
`suggest_task` already files across them, and a task you can create in project B but not fix
there is a seam rather than a boundary. Everything else on the board is refused: a task the
user has accepted, or one another session has started, belongs to them. `suggested` carries
that whole rule because every path that puts a task to work clears it in the same write
(`POST /api/tasks/[id]/messages` sets `suggested: 0, running: 1` together), though
`updateTaskForAgent()` checks `started`/`running` anyway rather than trusting the
implication — the user-facing PATCH can write `suggested` directly.

Fields are title, description, priority and status, minus `cancelled` — on the caller's own
row that calls `abortTurn()` and would tear down the very turn making the call, and on
anyone else's it's a decision that needs a stated reason a bare status write has nowhere to
put (see `withdraw_suggestion` below) — plus **`blocked_by`**, which is the only way an agent
can order a plan at all. `suggest_task` takes blockers in the very call that invents the
task, i.e. before any of them has an id, so a planning turn — which files its tasks as one
parallel batch and works out the sequence afterwards — could never use it, and never did:
every dependency edge on a real board was drawn by the UI's edit dialog. The supported recipe
is two-phase, and the prompt in `buildProjectContext()` now spells it out rather than
mentioning dependencies once as a constraint: file every task, **wait for the ids**, then
call `update_task` per dependent task. Two rules differ from `suggest_task`'s version of the
param, both because this one REPLACES a set rather than filling a blank one. It is refused on
the **caller's own row** — blockers gate whether a task may START and a session calling this
already has, so the edge would be inert on the scheduler and a lie on the board (`on_hold` is
the honest verb, and the refusal says so). And an unusable ref **fails the whole call**, named
one at a time with its reason (not a task id / in another project / the task itself), where
`suggest_task` partitions and reports: wiring the refs we recognized and dropping the rest
would delete edges the agent never mentioned and still report success. A cycle refuses
everything too, `setTaskDeps` first and the row patch after, so a rename in the same call
can't land under a refusal that says nothing changed. Like `createSuggestedTask`, `updateTaskForAgent()`
re-reads both rows before writing, because a detached turn's snapshot can outlive the row
and a target read a moment ago may have been started since; the eligibility check and the
write share one synchronous block, which is atomic given better-sqlite3 and a single Node
process. Marking done fires `maybeAutoStartDependents()` against the **target's** id, and
that call lives with the callers rather than in `lib/agentTools.ts` — that module is pinned
SDK-free (`tests/importGraph.test.ts`) and `lib/autoStart.ts` reaches the runner.

The policy lives in `updateTaskForAgent()` alone, because the two paths differ in who names
the target: the Claude driver closes over the caller and hands the model's `task` argument
straight through, while the bridge's endpoint takes the caller from the env-injected
`CALANDRIA_TASK_ID` and the target from the request body — model-supplied, and the reason
`tests/codexUpdateTaskPolicy.test.ts` runs the real bridge against the real endpoint and
asserts on the database rather than on the refusal text.

**Groups** ride the same three tools plus one new read, and the create-vs-strict split is the
whole policy (`resolveGroupRef()` in `lib/agentTools.ts`, over `resolveGroup()` in the store).
`suggest_task`'s `group` is resolved AFTER `resolveTargetProject`, in the project the task is
actually filed into — a group never spans repositories, so a cross-project suggestion must
group where it lands — and a name that matches nothing is CREATED there with
`origin_task_id` set to the calling task. That's right for the planning verb: the common case
really is "this group doesn't exist yet", and a `create_group` round trip would repeat the
two-phase dance `blocked_by` already forces; a near-miss minting a duplicate is bounded by
`UNIQUE(project_id, name)` plus a result that names which of the two happened.
`update_task`'s `group` is the opposite — an existing id or exact name, `""` to ungroup,
never a create — because the task exists already and a typo would split a feature the user is
filtering by; an unknown ref fails the WHOLE call, the same fail-closed rule an unusable
`blocked_by` ref gets, so a rename sharing that call can't land under a refusal saying
nothing did. It resolves in the TARGET's project, not the caller's, for the same reason the
tool can write a tray suggestion anywhere. `list_tasks` gains a `group` filter (resolved
strictly — an unrecognized one is an error, never a silently unfiltered board) and every row
carries `group: {id, name}` either way, and **`list_groups(project?)`** returns each group's
description, derived counts and members with titles and statuses, so "how is the migration
going" is one call rather than N `get_task`s.

The receiving end is **`lib/groupContext.ts`**: `groupContextBlock(task)`, called from
`buildProjectContext()`, tells a member session which group it belongs to, what the group is
for, which step of how many it is (a topological sort over `depends_on` restricted to the
group, ties by `position` — the same order `GroupStrip.tsx` numbers, so the prompt and the
screen agree), its siblings with status markers and `← this task`, and `Planned in task "…"`
pointing at the session that filed the plan. Sibling DESCRIPTIONS are deliberately not
inlined — a seven-task group would spend a fifth of the session's starting context on work
this task isn't doing, and `get_task` is one call away. `send_context = 0` suppresses the
block exactly as it suppresses project context. The module is pinned SDK-free
(`tests/importGraph.test.ts`) because `lib/agents/shared.ts` reaches every driver.

**`withdraw_suggestion(task, reason)`** is the retraction verb, and it exists because the
nearest alternative was wrong twice over: an agent reaching for `status: "done"` to mean
"this one's redundant" both claims work nobody started is finished AND hits the exact
transition that fires `maybeAutoStartDependents()`, silently launching real sessions behind
it. Eligibility is the SAME `isInertSuggestion()` helper `update_task` uses — shared so the
two can't drift into "editable but not withdrawable" — and `reason` is required and must be
non-empty, because a retraction the user can't understand is worse than none. It is
deliberately **not** a delete: the tray's Dismiss button already hard-deletes via
`DELETE /api/tasks/:id` with no undo anywhere in this app, and destroying a proposal the user
hasn't read is not a call an agent gets to make. So the row is set to `cancelled` while
`suggested` stays `1` — it remains in the tray, struck through with `tasks.withdrawn_reason`
beside it and sorted below the live suggestions (`isWithdrawn` / `withdrawnLast` in
`app/orchestrator/format.ts`, honored by both the list tray and the board's Suggested
column) — and `task_edited` is published so other tabs refetch a field the coarse wire
payload can't carry. Reviving is centralised in `PATCH /api/tasks/[id]`, which clears the
reason and the cancelled status together whenever a withdrawn row leaves that state: three
callers reach it (the tray's Add and Start both patch `suggested: 0` and nothing else, the
board's drag sends a status too, the edit dialog re-statuses in place) and each would
otherwise have to remember both halves.

Withdrawing forced a change on a shared path. `lib/autoStart.ts`'s `blocks()` has always
counted **cancelled** as terminal — a dependent waiting on a task that will never finish
would deadlock — but the sweep only ever fired on the transition into `done`. Cancelling the
last blocker therefore cleared the edge and launched nothing, leaving an `auto_start`
dependent unblocked-but-never-started, forever. `maybeAutoStartDependents()` now fires on
any non-terminal → terminal transition, from `withdraw_suggestion` **and** from the
user-facing PATCH, so the scheduling decision follows from the resulting state rather than
from which endpoint produced it; the transcript note distinguishes `"X" is done` from
`"X" was cancelled`. Cancelling a task can now start work, which is what
**Start when unblocked** already promised — pinned in `tests/autoStart.test.ts` and
`tests/withdrawSuggestion.test.ts` so it can't quietly regress either way.

### Adding a third agent (e.g. Gemini, Cursor)

Implement the `AgentDriver` interface in `lib/agents/<id>/driver.ts` (`runTurn()` is the
only required method — the one-shot helpers are optional and fall back to the utility
agent), register it in `lib/agents/registry.ts`, and ship its CLI in the `Dockerfile`
(installed on `PATH` next to `claude` / `codex`). No edits to the runner, routes,
recap/refresh jobs, or UI data flow — the capability descriptor drives the pickers, the
`/api/agents/[id]/*` routes are generic, and `getDriver(task.agent)` resolves it
everywhere. The driver contract test (`tests/agentDriver.test.ts`) and the event-mapping
test (`tests/codexEvents.test.ts`) are the templates for pinning a new driver to the same
`StreamEvent` contract.

## Everything else, by module

- **`lib/db.ts`** — SQLite schema, migrations, seed. **`lib/store.ts`** — typed queries for
  projects / tasks / messages / summaries / sessions.
- **`lib/git.ts`** — per-task worktrees/branches, diffs, and merging (`mergeTask()`, plus
  `prepareWorktreeMerge()` / `completeWorktreeMerge()` / `abortWorktreeMerge()` for
  AI/manual conflict resolution; `worktreeSyncStatus()` / `fastForwardWorktree()` to catch
  a stale branch up to base). It also holds the app's only remote awareness:
  `fetchBase()` refreshes the base branch's remote-tracking ref best-effort (hard timeout,
  no interactive prompting, per-repo cooldown, run *outside* the repo lock),
  `remoteBaseStatus()` compares local base against it, and `advanceBaseBranch()` /
  `pushBaseBranch()` are the forward-only, never-forced ways to move it. New worktrees are
  cut from the fetched remote tip when local base is merely behind it — pinned to a SHA, so
  the ref can't move underneath `worktree add` and the task branch gets no upstream. The
  user's local base branch is only ever moved by an explicit click (or, as a tidy-up, by a
  merge that would otherwise fold the remote's commits into the task's own).
- **`lib/services.ts`** — the managed-services supervisor: starts/stops/restarts a
  project's configured `dev`/`setup`/`test` commands as detached process-group children
  **owned by the server** (not a turn or a tab), captures their stdout/stderr into a
  per-service ring buffer, and publishes status/log events over SSE. State lives on
  `globalThis` (survives HMR), like `lib/events.ts`. Each project gets a stable `PORT`
  (`projects.port`, deterministic from `CALANDRIA_SERVICE_PORT_BASE`) injected into every
  service's env and the PTY shell. On by default (`CALANDRIA_FEATURE_SERVICES=0` disables):
  the registry is **persisted** (`services` table) and `server.js` restores +
  auto-restarts managed services on boot — first **reaping any process group a crashed
  server left orphaned** (the spawn pid is persisted per row; the reaper verifies the
  group still runs the service's command before `SIGKILL`ing it, so a recycled pid is
  never killed by mistake), and probing the port first so a conflict with an unmanaged
  process surfaces as a readable `error` on the service instead of an EADDRINUSE crash
  loop. A clean process exit SIGKILLs every managed group on the way out. **Public
  hostnames are a separate opt-in** (`CALANDRIA_SERVICE_HOSTS`): each service then gets a
  stable `<slug>--<appHost>` hostname with per-service visibility (private /
  shared-link / public), dispatched through the reverse-proxy router in
  **`lib/service-router.mjs`** (WebSocket/HMR passthrough included), with the pure
  hostname/token helpers in **`lib/service-host.mjs`**.
- **`lib/contextRefresh.ts`** — "Refresh with AI" as a **detached background job** (a
  multi-minute draft never holds an HTTP request open across a tunnel): `startRefreshJob()`
  seeds the utility agent with recent git activity, runs `draftProjectContext()` in the
  repo (read-only), and persists the result for the client to poll via
  `GET /api/projects/[id]/refresh-context`. The draft is for the user to review — never
  auto-saved.
- **`lib/recap.ts`** — "where you left off" staleness/activity logic + background sweep.
- **`app/Orchestrator.tsx`** — the dark mission-control client UI (projects rail · task
  list · live session, the session split into transcript + `SessionRail`
  DIFF/PREVIEW/CONTEXT tabs); one `EventSource` per selected task renders from server
  events, so a reload, sleep, or task switch mid-turn just catches up.
- **`app/Terminal.tsx`** + **`pty-server.js`** — xterm.js ↔ same-origin `/pty` WebSocket
  (proxied by `server.js`) ↔ `node-pty` sidecar bound to `127.0.0.1`.

## Where data lives

| What | Where |
|-|-|
| Projects, tasks, transcripts, summaries, session index | `calandria.db` (SQLite) in `CALANDRIA_DB_DIR`, default `~/.calandria` |
| The single-instance boot lock | `calandria.lock.db` beside it — a pure mutex holding no data (see below) |
| Per-task git worktrees | `CALANDRIA_WORKTREES_DIR`, default `~/.calandria/worktrees` — deliberately outside every repo |
| Cloned project repos | `CALANDRIA_PROJECTS_DIR`, default `~/projects` |
| Your apps' actual code | each project's working directory — never inside Calandria's own tree |
| Claude Code's raw session logs | `~/.claude/projects/...` (managed by Claude Code) |

With the env unset, nothing is ever moved automatically: if `~/.calandria` holds
no database but the pre-rename `~/.zen-orchestrator/orchestrator.db` exists, the
old path keeps being used and boot prints one hint line. Inside an explicit
`CALANDRIA_DB_DIR`, `calandria.db` wins and an existing `orchestrator.db` is the
fallback. A populated legacy `~/.agent-orchestrator/worktrees` is kept where it
is, because git registers each worktree by absolute path in the parent repo's
`.git/worktrees/<id>/gitdir` — relocating would need `git worktree repair` per
project; an empty one is abandoned. All of this resolves in one shared module,
`lib/storage.mjs`; see `docs/SELF_HOSTING.md` for the manual migration recipe.

### One process per database

Single-process isn't a limitation to work around, it's the design: turns run detached
and owned by the server, the event bus and the abort/ask registries are in-memory on
`globalThis`, and `init()` opens every boot by clearing what a crash left behind —
running flags, the pending-message queue, unanswered permission cards, in-flight
schedule runs. Point a second process at the same database and that recovery pass runs
against a *live* instance: it wipes the first's running flags, drops its queued
follow-ups and settles cards a human is still reading, while the first keeps writing to
rows the second believes are idle.

So **`server.js` claims the database before `app.prepare()`** (`lib/db-lock.mjs`) and
exits with the holder's pid and host if it can't. The mutex is a kernel file lock — a
`BEGIN IMMEDIATE` transaction opened on a dedicated `calandria.lock.db` and never
committed, holding SQLite's RESERVED lock for the life of the connection. That's chosen
over a pid+heartbeat lease file deliberately: there's no heartbeat to miss, no staleness
window to tune, and no pid-liveness heuristic to get wrong (pids are small and reused
inside a container, and `docker restart` keeps the hostname, so "pid 7 on host abc is
alive" proves nothing). The OS drops the lock when the process dies, so recovery after a
SIGKILL is immediate. Boot still retries for `CALANDRIA_DB_LOCK_WAIT_MS`, which covers only
the second or so a predecessor spends shutting down. `locking_mode = EXCLUSIVE` is
pointedly *not* layered on top: in that mode a connection retains its SHARED lock even
after a failed write, so two racing processes could deadlock each other out of the
upgrade forever.

A separate lock file, rather than locking `calandria.db` itself, keeps a concurrent
read-only `sqlite3 calandria.db` inspection working and leaves WAL alone. Who holds
it is a best-effort JSON sidecar read only to write a good error message — it never
decides ownership, so one left by a hard kill can't wedge anything.

The recovery pass then sits behind `consumeDbRecoveryAuthorization()`, true at most once
and only for a database this process actually claimed. Under vitest and `next build` it
is never authorized, which is correct: recovery belongs to the owner. Ownership state
lives on `globalThis` because `server.js` loads the module through Node's ESM loader
while `lib/db.ts` loads it through Turbopack's bundle — two module instances, one realm.

The lock coordinates processes sharing a kernel. Two *containers* on one volume may not
see each other's locks, but sharing a WAL database across sandboxes is independently
unsafe; one instance, one volume.

**Stack:** Next.js (App Router) + TypeScript · React 19 · better-sqlite3 ·
`@anthropic-ai/claude-agent-sdk` · xterm.js + node-pty sidecar · streaming over SSE.
