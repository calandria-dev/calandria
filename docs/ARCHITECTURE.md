---
title: "Architecture"
---

# Architecture

How Calandria is put together. This is the public companion to [`CLAUDE.md`](../CLAUDE.md)
(the in-repo codebase map agents read); if the two ever disagree, trust the code.

## Processes and entrypoints

Calandria runs as three processes behind one origin: a custom Next.js server, a terminal
sidecar, and the Next app itself. A managed-services supervisor lives inside the Next
process and gives each project its own long-running dev/test commands with their own
optional public hostname.

| Module | Responsibility | Invariant |
|-|-|-|
| `server.js` | Plain Node, CommonJS, Turbopack in dev. Fronts Next on one port, proxies `/pty` WebSocket upgrades to the sidecar, forwards dev HMR upgrades to Next, enforces origin auth on upgrades, dispatches public service hostnames through `lib/service-router.mjs`. | Everything rides one origin: a single https hostname carries the app and the terminal, and `wss://` is used automatically over https. Middleware never sees upgrades, so this file is the auth boundary for `/pty`. |
| `pty-server.js` | node-pty terminal sidecar. | Bound to `127.0.0.1` only, reached through the app origin at `/pty`, never exposed directly. |
| `app/`, `app/api/`, `lib/` | UI, REST routes, server logic. | Native modules (`better-sqlite3`, `node-pty`) and the agent SDKs stay in `serverExternalPackages`; Next must not bundle them. |
| `lib/services.ts` | Starts, stops, and restarts a project's configured `dev`/`setup`/`test` commands as detached process-group children, captures stdout/stderr into per-service ring buffers, publishes status/log events over SSE. | State lives on `globalThis` and survives HMR, like `lib/events.ts`. The registry persists in the `services` table; `server.js` restores and auto-restarts managed services on boot. |
| `lib/processTree.ts` | Kill, liveness, and recycled-pid guard for a service's process group. | Two OS mechanisms: POSIX process groups, win32 `taskkill`. The boot reaper verifies a persisted pid still runs the service's command before sending `SIGKILL`, so a recycled pid is never killed by mistake. |
| `lib/service-router.mjs` + `lib/service-host.mjs` | Public service-hostname reverse proxy, plus the pure hostname/token helpers it uses. | Each service gets a stable `<slug>--<appHost>` hostname when `CALANDRIA_SERVICE_HOSTS` is set, with per-service visibility (private, shared-link, public). WebSocket and HMR passthrough go through the same router. |

Managed services are on by default; `CALANDRIA_FEATURE_SERVICES=0` disables them. Each
project gets a stable `PORT` (`projects.port`, deterministic from
`CALANDRIA_SERVICE_PORT_BASE`) injected into every service's env and the PTY shell. `server.js`
probes a service's port before spawning it, so a conflict with an unmanaged process surfaces
as a readable `error` instead of an `EADDRINUSE` crash loop. A clean process exit sends
`SIGKILL` to every managed group on the way out.

## The turn lifecycle

A turn is one agent session run detached from the HTTP request that started it, owned by the
server process, persisted to SQLite as it goes. The runner is the only thing that starts,
resumes, or ends one.

1. The client `POST`s to `/api/tasks/[id]/messages`.
2. `lib/runner.ts`'s `startTurn()` launches the turn and the route returns immediately.
3. The turn runs server-side. Every event persists to SQLite and publishes on `lib/events.ts`
   (in-process pub/sub keyed by task id, plus a wildcard channel that sees every task's
   events).
4. If a turn is already running, a new message parks in the `pending_messages` queue instead
   of starting a second turn.
5. Stopping is only ever explicit, through `lib/abort.ts`.

A turn can be **lingering**: the model is done, but the session stays open so background work
can finish or a wakeup can fire. By default the wait has no deadline. `sendToLingeringTurn()`
hands a new message to the driver's open prompt iterable through `lib/turnInput.ts` (`send`
returning `false` means queue it instead), and it lands as an ordinary user message that
starts the next turn. Entering a linger drains the oldest parked follow-up first. A send is
refused while anything is still queued, so message order is preserved. The driver drops
`lingering` in the same tick it accepts a message, so the injected turn's bare `init` is never
announced as a wakeup firing.

| Module | Responsibility | Invariant |
|-|-|-|
| `lib/runner.ts` | Detached turn runner: `startTurn()`, resume, queue drain. | `startResumeTurn()` runs the same `ensureWorktree` self-heal as every first-turn launch path, since a turn can also reach the runner through the queue drain in `run()`'s `finally`. An empty `worktree_path` falls the driver back to `project.repo_path`. |
| `lib/events.ts` | In-process pub/sub keyed by task id, plus `subscribeGlobal()` for every task's events. | `GET` on `/api/tasks/[id]/messages` is the SSE watch stream: a `snapshot` of the persisted transcript, then a live tail. Reconnect-safe, any number of viewers, fine with zero. |
| `lib/abort.ts` | The live-turn registry; outranks `tasks.running`, which can be stale after a restart mid-turn. | `activeTurnIds()` is what `drainActiveTurns` aborts on graceful shutdown. Stopping a turn is always explicit. |
| `lib/turnInput.ts` | Registers a lingering turn's open prompt iterable per turn. | SDK-free. `send` returning `false` means the message must be queued, not dropped. |
| `lib/turnActivity.ts` | Stamps every persisted event's timestamp; a sweep that runs only while a turn is live marks a turn idle after `CALANDRIA_TURN_IDLE_MS` (default 20 minutes) unless it is parked on the user. | In-memory only, since it describes a turn this process owns and persisting it would move `tasks.updated_at`, the board's sort key, on every idle tick. Publishes the coarse `turn_idle` event on `/api/events`, since an idle turn otherwise produces no transcript detail to publish. `schedulerHealth()`'s "looks stuck" banner reads the same mark. |
| `app/shell/IdleStop.tsx` | The Stop affordance hung off the idle mark. | Arms on the first press, states what it cannot know, stops on the second. Shown on list and board cards only; the session's own composer already has Stop. |
| `lib/idleNudge.ts` | Opt-in (`CALANDRIA_TURN_IDLE_NUDGE`, default off) message sent into an idle session. | Can only reach a LINGERING session, since a driver's `send` refuses a message mid-thought. At most once per turn, never on a scheduled run, never ahead of a queued follow-up. What it sends is a user message, the only channel a session has; what it records is a system notice, since the user did not type it. |

A task is a lineage of sessions. `/clear` ends generation N, condenses its transcript to a
summary, and generation N+1 starts fresh, seeded with all prior summaries. The task row
persists across generations; only the context window resets.

## Live updates

`GET /api/events` is one always-open `EventSource` per browser tab
(`app/shell/useGlobalEvents.ts`), broadcasting coarse lifecycle events for every task across
every project. This drives spinners, project badges, and the "N need you" pill without any
task-list polling. Only the selected task also opens a transcript stream.

Current event types: `turn_started`, `awaiting_input`, `ask_answered`, `suggested`,
`turn_end`, `task_updated`, `task_edited`, `turn_idle`, `background`, `agent_auth`,
`task_deleted`, `tasks_moved`, `runbooks_changed`, `tags_changed`, `notification`.

- Most events re-read the task row at publish time and carry a fresh snapshot of it plus its
  project's awaiting count. The runner persists before it publishes, so the snapshot a client
  receives is authoritative.
- A `suggested` event carries the id of the project the task was filed INTO, since
  `suggest_task` can target any project, and the id of the created task.
- `task_edited` fires when a mutation rewrites fields the coarse snapshot cannot carry (title,
  priority, dependency edges); the client refetches the row instead of patching it.
- Project-wide facts with no single row to re-read carry their own project id and skip the
  re-read entirely: `task_deleted`, `tasks_moved`, `runbooks_changed`, `tags_changed`.

Task order is not stored. `listTasks` sorts `suggested ASC`, then `updated_at DESC`, then
`created_at DESC`, then `rowid DESC` (a planning turn can file a whole batch inside one
millisecond). `tasks.position` still counts up per project and the move paths still renumber
it, since `topoMembers` uses it to tie-break a tag's steps, but nothing renders it as manual
board order: there is no `reorderTasks`, no `POST /api/tasks/reorder`, and no
`tasks_reordered` event. A board drag writes only the status its column implies.

## The agent-driver seam (`lib/agents/`)

The app talks to coding agents only through one interface. A driver normalizes its agent's
protocol into a common `StreamEvent` turn contract and a small set of one-shot helpers; every
other module reaches an agent through the driver, never through a CLI or SDK directly.

| Module | Responsibility | Invariant |
|-|-|-|
| `lib/agents/types.ts` | Defines `AgentDriver`. | Only `runTurn()`, `authStatus()`, `startLogin()`, `getLogin()`, `submitLoginCode()`, `cancelLogin()`, and `verify()` are required. `watchedSettingsFiles`, `listCommands()`, `planUsage()`, `summarizeTranscript()`, `draftProjectContext()`, `summarizeProjectRecap()`, `planTagRefresh()`, and `apiKey` are optional. |
| `lib/agents/registry.ts` | Resolves a driver by id: `getDriver(task.agent)`. | The id persists per task, defaulted from `projects.default_agent`; an unknown id falls back to Claude. |
| `lib/agents/capabilities.ts` | `getCapabilities()`, `listAgentIds()`, `isAgentId()`. | SDK-free. Modules that only need capability data or agent ids import this instead of `registry.ts`, since the agent SDKs are async ESM externals whose async-ness would otherwise propagate to every sync-compiled importer. `tests/importGraph.test.ts` pins the SDK-free set. |
| `lib/agents/shared.ts` | Agent-agnostic normalizers every driver reuses. | Project-context and conflict prompts, tool-call to title/peek/diff normalizers, the event queue. |
| `GET /api/agents` | Serves each driver's capability descriptor plus its persisted connection state. | Drives every run-control picker (model, reasoning, permission), the per-task agent picker, agent badges, and cost/ask feature gates. The UI has no hardcoded per-agent lists. |
| `/api/agents/[id]/{login,login/code,verify,api-key,status}` | Generic auth routes: resolve `getDriverStrict(id)`, call its auth surface. | A new agent needs no new routes. Credentials live under `$HOME` (Claude in `~/.claude`, Codex in `~/.codex`); optional per-token API keys persist to a `0600` file. |
| `listCommands(task, project)` | Optional `AgentDriver` method reporting the slash commands a turn on that task would expand. | `GET /api/tasks/[id]/commands` serves it, filtered by `lib/agentCommands.ts`. It is the app's only command enumeration: the schedule editor's prompt validation calls the same function, so the composer's `/` menu and the validator cannot disagree. A driver that omits it leaves the menu with Calandria's own commands. MCP prompt commands are harvested from the `init` message of the task's real turns (`recordMcpPrompts`) instead, since reading them directly would mean starting the user's MCP fleet. |

### Claude (`lib/agents/claude/driver.ts`)

Runs a turn through the Claude Agent SDK, resuming or starting fresh, with project context
appended to the system prompt.

- Permission modes: `auto` (the CLI's own classifier screens each call), `bypassPermissions`,
  `acceptEdits`, `default`, `plan`. Every mode except `bypassPermissions` is a real gate.
  `lib/agents/claude/capabilities.ts` is the single source of truth for which modes the
  driver honors.
- `settingSources: ["user", "project", "local"]` is pinned explicitly on every turn so an SDK
  bump cannot silently strip the user's MCP servers, plugins, skills, or the repo's
  `CLAUDE.md`.
- One-shot helpers (`summarizeTranscript`, `draftProjectContext`, `planTagRefresh`) set
  `tools` explicitly, `strictMcpConfig: true`, `skills: []`,
  `settings: { disableAllHooks: true, autoMemoryEnabled: false }`, and
  `persistSession: false`. They keep `settingSources: ["user"]` only, since
  `~/.claude/settings.json` can hold a Bedrock/Vertex/proxy user's `env` block and
  `apiKeyHelper` that a turn still needs. The two text-only helpers get `tools: []` and one
  turn; `draftProjectContext` and `planTagRefresh` get `["Read", "Grep", "Glob"]`, no Bash.
- `canUseTool` routes every call the SDK does not auto-approve through
  `lib/permissionPrompt.ts`, the one `promptPermission()` implementation Codex's app-server
  transport also calls; the policy underneath is `lib/permissions.ts`. It is also the
  callback that must be present before the CLI exposes `AskUserQuestion` at all. Remembered
  rules are Bash-only; a non-Bash tool call gets allow-once plus the CLI's own session-scoped
  suggestion instead of a stored rule.
- `decision_reason` is documented but unset by live CLI 2.1.x; `blockedReason()` reads
  `message` instead, since that is the field the CLI actually fills. `decision_reason_type` is
  stored raw and phrased at render time, since the CLI emits values the SDK's own docs don't
  list.
- Auth delegates to `lib/claude-auth.ts`.

Tools mounted in-process: `suggest_task`, `list_tasks`, `list_tags`, `get_task`,
`update_task`, `move_task`, `withdraw_suggestion`, `set_base_branch`, `create_pr`
(conditional), `update_tag`, `list_projects`, `expose_service`, `create_runbook`,
`list_runbooks`, `update_runbook`.

### Codex (`lib/agents/codex/driver.ts`)

Runs on the user's ChatGPT-plan `codex` login; no API key required. Built on
`@openai/codex-sdk`, which spawns the `codex` CLI (`CODEX_CLI_PATH`, or the SDK's bundled
binary or PATH) and speaks JSONL over stdio: `startThread()` / `resumeThread(session_id)`,
with the codex thread id emitted as the `session` event.

- `events.ts` normalizes codex's `ThreadItem` stream into `StreamEvent`: `agent_message`
  becomes `assistant`; `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
  `todo_list`, and `reasoning` become `tool`/`tool_result`; `turn.completed` usage becomes
  tokens plus an estimated `cost_usd`.
- Turns run on `codex app-server`, the CLI's JSON-RPC IDE protocol, by default
  (`appServerClient.ts` the transport, `appServerTurn.ts` the turn, `appServerEvents.ts` the
  adapter that respells v2 items onto the same `StreamEvent` contract as exec).
  `CODEX_TRANSPORT=exec` falls back to the SDK's `codex exec` path, which auto-rejects every
  approval request inside the CLI before Calandria sees it. On app-server, approval requests
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`) go through `lib/permissionPrompt.ts`, the same
  `promptPermission()` the Claude gate calls, and `item/tool/requestUserInput` lands on the
  ask card.
- `policy.ts` maps the five permission modes to codex's sandbox, approval policy, reviewer and
  writable roots (`docs/AGENTS.md` has the table); reasoning presets map to
  `model_reasoning_effort`.
- Under app-server, `item/agentMessage/delta` and `item/reasoning/summaryTextDelta` become
  `assistant_delta`, published but never persisted (the completed item still writes the
  transcript's real `assistant` row or "🧠 Thinking" tool row); the Claude driver emits the
  same event from the SDK's partial messages (`includePartialMessages`). Codex-only:
  `item/commandExecution/outputDelta` becomes `tool_output_delta`, which grows the peek of the
  already-started tool row instead of a bubble; the completed item's `tool_result` still
  carries the full `aggregated_output`, which replaces the live peek on reload. The Claude SDK
  has no comparable output stream to map.
- Auth (`auth.ts`) drives `codex login --device-auth` and `codex login status`.
- Capability descriptor: `supportsMcpTools: true` (Calandria's tools reach codex through the
  stdio bridge), `supportsAsks: true` (the bridge's `ask_user` tool blocks until the user
  answers), `reportsCostUsd: false` and `costIsEstimated: true` (ChatGPT-plan auth reports
  token counts only; `pricing.ts` estimates dollar cost from tokens times published prices).
- One-shot helpers run as `codex exec` one-shots in a read-only sandbox (no writes, no
  approvals, no network), bounded by an item cap.

### Antigravity / Gemini (`lib/agents/gemini/driver.ts`)

Spawns the `agy` CLI directly; no SDK. Runs on the user's Google login and needs no API key
outside a container, since the CLI's token normally lives in the OS keyring (see
[AGENTS.md](AGENTS.md#antigravity-gemini)).

- `gemini/home.ts` gives each task its own `HOME`, since the CLI reads MCP servers from one
  user-global file.
- `gemini/events.ts` normalizes NDJSON off stdout into `StreamEvent`.
- Usage is cumulative per conversation: a turn's spend is a delta against the
  `sessions.usage_cum` baseline.
- `gemini/pricing.ts` estimates cost from Google's published prices; the CLI reports no
  dollar figure. `gemini/planUsage.ts` reads plan quota from the CLI's own `/usage` command.

### Internal one-shots (`lib/agents/oneshots.ts`)

Routes jobs that run a turn outside the main chat: `/clear` handoff summaries, project
recaps, "Refresh with AI" context drafts, and tag refreshes.

- Task-scoped one-shots (`/clear` summarization) follow the task's own agent.
- Project-scoped one-shots (recap, context draft, tag refresh) run the utility agent,
  resolved connected-first: the `utility_agent` setting if connected, else the app default,
  else the built-in default, else any connected agent. If no agent is connected, the job
  fails with an actionable error instead of driving a dead CLI.
- If the resolved driver does not implement a given helper, the utility agent backstops it.
- `background_jobs` (default on) gates unattended one-shots. `recap_mode` (`automatic`
  default, `on_open`, `off`) additionally gates recap scheduling: the five-minute sweep
  requires `automatic`, opening a project accepts `automatic` or `on_open`. Explicit `/clear`,
  Refresh with AI, and manual recap still run regardless of both gates.
- Every one-shot funnels through one `run()` wrapper that records the agent and model that
  actually ran it, plus a `fallback` flag, through `addInternalUsage()`.
- `resolveUtilityAgent()` reports the same resolution without throwing, for `GET /api/agents`
  to show Settings the effective agent and its `(fallback)` hint. Settings reads a single
  30-day aggregation from `internal_usage` so the controls show run count and estimated cost
  without polling.
- `lib/contextRefresh.ts` runs "Refresh with AI" as a detached job:
  `GET /api/projects/[id]/refresh-context` polls it. The draft is for the user to review; it
  is never auto-saved.
- `lib/tagRefresh.ts` is the same shape for a tag: `GET /api/tags/[id]/refresh` polls it.
  Unlike the context draft, its outcome applies directly, since task edits go through
  `lib/agentTools.ts` as revertable "Changed by agent" edits. Retiring is limited to work that
  has none in it: an unreviewed suggestion is withdrawn, an accepted-but-never-started task is
  cancelled revertably, and a started task is only named in the report.
- `lib/recap.ts` holds the staleness-and-activity sweep behind the same routing.

AI conflict-resolution turns need no special routing: `buildConflictPrompt()`
(`lib/agents/shared.ts`) produces the prompt, and the client sends it as an ordinary message
through `startTurn()`.

### Adding another agent

1. Implement `AgentDriver` in `lib/agents/<id>/driver.ts`. `runTurn()` is the only required
   method.
2. Register the driver in `lib/agents/registry.ts` **and** `lib/agents/capabilities.ts`
   (`listAgentIds()` reads the second; a driver registered only in the first is connectable
   but invisible to every id-level lookup).
3. Ship its CLI in the `Dockerfile`, on `PATH` next to `claude`, `codex`, and `agy`.

`tests/agentDriver.test.ts` (driver contract) and `tests/codexEvents.test.ts` (event mapping)
are the templates for pinning a new driver to the `StreamEvent` contract.
`tests/claudeSettingSources.test.ts` and `tests/claudePermissionMode.test.ts` pin the Claude
driver's isolation and permission-mode policies specifically.

The Antigravity driver is the worked example for a CLI with no SDK: spawn the binary, parse
its stream, mock `node:child_process` in the tests. Its capability descriptor also carries two
fields no other driver needs, `loginCompletesOutOfBand` and `connectHint`, since that login can
finish without a code box and cannot finish at all in a container. Both are data the connect
card renders, never a branch on an agent id, which is the rule to hold to for any driver whose
login shape doesn't fit the other two.

## The permission gate

Under every mode but `bypassPermissions`, the SDK's `canUseTool` is a real gate that can park
a turn on the user before a tool call runs. A second gate runs before the turn even starts, to
catch settings a hook could have changed outside that callback.

1. `lib/permissions.ts` checks a read-only allowlist first; it passes silently unless the CLI
   flagged a `blockedPath`, which forces a prompt.
2. The check falls through to the project's remembered Bash rules (`permission_rules`).
3. If still undecided, it raises a permission card through `lib/asks.ts`, which parks the turn
   on the user via `tasks.awaiting_input` until `POST /api/tasks/[id]/answer` settles it.

Rules in `permission_rules` are Bash-only and project-scoped: minted from the card, or typed
into Settings → Run defaults (`POST /api/settings/permissions`). The typed path runs the same
`prefixVerdict()` the card uses and stores what it returns, never the raw typed line. A
refused prefix is a 400, not a silent downgrade to `bash_exact`. `ruleMatches()` goes through
`bashCommandOf()`, so a rule naming any tool other than Bash never matches a call.

Every non-answer path denies: Stop, an expired prompt, an unwatched turn, or an unparseable
answer. An auto-deny under an unattended run also parks the pending queue.

`lib/settingsDrift.ts` runs the gate BEFORE the turn. Files a driver names in
`watchedSettingsFiles` (`<worktree>/.claude/settings.json` for Claude) are re-read from disk
and hashed every turn, since hooks run shell commands outside `canUseTool` and
`permissions.allow` approves calls with no gate call at all. The runner hashes each file
before `runTurn`; a changed hash publishes a `notice` and parks the turn on a
`PermissionRequest` with `kind: "settings"` through the same registry and `/answer` route.
Approving adopts the new version as baseline (`task_settings_snapshots`); declining ends the
turn before the agent starts, parks the queue, and flags the task. A first sighting is
recorded silently. An unattended or scheduled run refuses outright on drift, settling the run
`failed`.

A refusal the CLI makes without ever calling `canUseTool` (its own `auto` classifier veto, or
a deny rule in loaded settings) arrives as a `system`/`permission_denied` message instead. The
driver turns that into a `permission_denied` `StreamEvent`, and the runner settles an
already-decided card onto the transcript row the call already created, read-only, naming the
tool, its input, who refused, and why. A turn denied three times gets three decided cards, one
per call; `awaiting_input` stays untouched, since nothing is parked on the user. Calandria's
own `canUseTool` denials never emit this message, so the two paths cannot double-render.

## Agent tools (`lib/agentTools.ts`)

The tool roster is the same across drivers: `suggest_task`, `list_tasks`, `get_task`,
`update_task`, `move_task`, `withdraw_suggestion`, `set_base_branch`, `create_pr`,
`list_tags`, `update_tag`, `list_projects`, `expose_service`, `create_runbook`,
`list_runbooks`, `update_runbook`, `ask_user`.

- Claude mounts every tool but `ask_user` in-process (`createSdkMcpServer`) and gets asks
  through its own `AskUserQuestion` hook.
- Every other driver reaches the same tools through `scripts/calandria-mcp.mjs`, a stdio MCP
  server that reads `CALANDRIA_TASK_ID`, `CALANDRIA_PROJECT_ID`, `CALANDRIA_BASE_URL`, and
  `SERVICE_TOKEN` from env and POSTs each call to `app/api/internal/agent-tools/*`
  (`ask-user`, `ask-user/wait`, `create-pr`, `create-runbook`, `expose-service`, `get-task`,
  `list-projects`, `list-runbooks`, `list-tags`, `list-tasks`, `move-task`,
  `set-base-branch`, `suggest-task`, `update-runbook`, `update-tag`, `update-task`,
  `withdraw-suggestion`), gated by `SERVICE_TOKEN` in `middleware.ts`.
- Both paths share the same logic in `lib/agentTools.ts` and the same tool definitions in
  `lib/agentToolDefs.mjs`, so the two paths cannot drift.
- `ask_user` is asynchronous: the endpoint persists and publishes the same interactive
  question card the Claude hook produces, parks a detached waiter on the answer, and the
  bridge polls `ask-user/wait` for the outcome. No HTTP request is held open.
- Every tool answers through `lib/agentToolGuard.mjs`, which rewrites a throw, an over-long
  call, or a blank result into a sentence naming the tool. A healthy answer passes through
  untouched. Bound by `CALANDRIA_AGENT_TOOL_TIMEOUT_MS` (10 minutes; 0 for `ask_user`, which
  waits on a human).

| Tool | Reference |
|-|-|
| `suggest_task` | Files into any project via the optional `project` param (id or exact name from `list_projects`). `resolveTargetProject()` matches an exact id, then a case-insensitive exact name, else refuses and lists the candidates; it never falls back to the calling project. Resolution happens before the insert, so agent, `send_context`, and position all come from the target. |
| suggestion card | Correlated by the tool's own `name`, matched as a substring in `lib/suggestionCard.ts` (`mcp__calandria__suggest_task` in-process, `calandria__suggest_task` over the bridge, since the stdio bridge's endpoint has no `tool_use` id and patches the newest unclaimed `suggest_task` row instead; the runner re-reads that field before stamping a `tool_result` over it, so the two writers cannot clobber each other). Only the created task's id persists (`ToolData.suggestion`); state is re-read per render via `GET /api/tasks/[id]/suggestion`, so a reload always shows *Session started*, *Added*, *Withdrawn*, or *no longer exists*, and never double-offers Start. Start is withheld for a suggestion filed into a different project; that card names the target project and offers only Add and Dismiss. |
| `list_tasks`, `get_task` | Read-only. `list_tasks` takes the same optional `project`, an optional `tag` filter resolved strictly, and flags the caller `current: true`; every row carries `tags: [{id, name}]`. `get_task` reads any id, defaulting to the caller's own. Both carry `base_branch` already resolved through the task, first tag, project chain (`lib/baseBranch.ts`). |
| `update_task` | Writes any task in any project: the caller's own row by default, or any other, including one the user already accepted or started. The sole refusal is `running = 1`. A write to another task records in `task_agent_edits` (actor, per-field before/after, timestamp), stamps `agent_edited_at`, and surfaces a "Changed by agent" chip with per-edit Revert. Editable fields: title, description, priority, status minus `cancelled` (the caller's own row would `abortTurn()` the caller; another row needs a stated reason, via `withdraw_suggestion`), plus `blocked_by`. Does not carry the project; re-parenting is `move_task`. |
| `blocked_by` recipe | `suggest_task` cannot take blockers, since the ids do not exist yet at filing time. The two-phase recipe, spelled out in `buildProjectContext()`: 1. File every task with `suggest_task`. 2. Wait for the returned ids. 3. Call `update_task` per dependent, setting `blocked_by`. `update_task`'s version differs from a hypothetical create-time version in two ways: refused on the caller's own row (names `on_hold` instead), and an unusable ref fails the whole call, named one at a time with its reason. `setTaskDeps` is project-scoped and runs before the row patch, so a rename in the same call can't land under a refusal that claims nothing changed. |
| `move_task(tasks, project)` | Re-parents tasks via `lib/taskMove.ts`, the same operation the board uses. A SET operation: a `blocked_by` edge survives iff both ends move together; every dropped edge is named. Takes no discard acknowledgement as a boolean; the bulk route demands discard lists as ids. Started or mid-turn tasks are refused per task while the rest of the batch moves; the user gives that answer from the board's Move dialog instead. Moving an already-accepted task records the move in `task_agent_edits` under a `project` field; Revert runs `moveTasksToProject()` backward, ahead of even the base branch, so a refusal leaves the edit entirely un-reverted. |
| `withdraw_suggestion(task, reason)` | The retraction verb, gated by the same `isInertSuggestion()` screen `update_task` uses. `reason` is required and non-empty. Not a delete (Dismiss already hard-deletes via `DELETE /api/tasks/:id` with no undo): the row goes `cancelled` with `suggested` left at `1`, struck through with `tasks.withdrawn_reason` shown, sorted below live suggestions. `PATCH /api/tasks/[id]` clears the reason and the cancelled status together on revival, since the tray's Add and Start, the board's drag, and the edit dialog would otherwise each have to remember both halves. |
| `list_tags(project?)`, `update_tag` | `list_tags` returns each tag's description, base branch, derived counts, and member tasks with titles and statuses. `resolveTagRefs()` in `lib/agentTools.ts` splits create-vs-strict: `suggest_task`'s `tags` creates an unmatched name (bounded by `UNIQUE(project_id, name)`); `update_task`'s `tags` accepts only existing ids or exact names and fails the whole call on an unknown ref. |
| `lib/tagContext.ts` | `tagContextBlock(task)`, called from `buildProjectContext()`, emits one block per tag the task carries: name, purpose, step N of M (topological order over `depends_on`, tie-broken by `tasks.position`), sibling statuses, and the task that planned it. `send_context = 0` suppresses every block. |

`blocks()` counts `cancelled` as terminal. `maybeAutoStartDependents()` fires on any
non-terminal → terminal transition, not only into `done`, from both the tool and the
user-facing PATCH, so cancelling the last blocker in the UI can start an `auto_start`
dependent.

## Scheduler and tickers

Three server-owned periodic tickers run background work: firing schedules, sweeping stale
data, and polling open PRs. Runbooks are the saved-prompt building block schedules and manual
runs both dispatch through.

| Module | Responsibility | Invariant |
|-|-|-|
| `lib/scheduler.ts` + `lib/schedule/` | The largest of the three tickers, governed by `CALANDRIA_SCHEDULER`. Each schedule firing mints a fresh task (`tasks.schedule_id`) and launches its first turn. | `UNIQUE(schedule_id, scheduled_for)` on `schedule_runs` makes a double fire impossible. `lib/schedule/time.ts` is `Intl`-only wall-clock math with an IANA zone. Scheduled turns carry `interactionPolicy: "deny"`. |
| `lib/deferredStart.ts` | Sweeps `tasks.start_at` on its own `setInterval` at `SCHEDULE_TICK_MS`. | Ungated by `CALANDRIA_SCHEDULER`; turning the scheduler off does not stop deferred starts. |
| `lib/prState.ts` | Polls open PRs via `CALANDRIA_PR_POLL_MS`, feeds `maybeAutoReclaim`. | Self-stopping when no PRs are open. |
| `lib/retention.ts` | Scheduled prune of tables that would otherwise grow forever. `prunableTaskIds()` is the whole policy. | Prunable: terminal, idle, unsnoozed, no parked follow-up, no in-flight schedule run, cold by `updated_at`. Never prunes the session `tasks.session_id` names or `summaries`. |
| `lib/worktreeSweep.ts` | Same prune policy for checkouts, separate cutoff (`CALANDRIA_WORKTREE_RETENTION_DAYS`, default 14). | Terminal-only, never over work (`worktreePruneSafety()`). Off by default. The branch is always kept; clears via `clearTaskWorktreePath()`, never `updateTask`. |
| `lib/reclaim.ts` | LANDED → RECLAIMED: fast-forwards local base from origin, removes the worktree, deletes the local branch, marks the task done. | `maybeAutoReclaim()` fires on `projects.auto_reclaim`, and only for a task `taskIsFinishedWith()` reports as over (`prunableTaskIds()`' predicate for one task), since a landing says nothing about whether the session is still open. `POST /api/tasks/[id]/reclaim` is the manual button and is not held off by it. `worktreePruneSafety()` blocks a local merge on `ahead > 0` but not a PR merge, since a squash leaves the branch permanently ahead. |
| `lib/runbooks/store.ts`, `lib/dispatch.ts`, `lib/runbookTools.ts` | A `runbooks` row is a saved prompt plus agent, permission mode, priority, `send_context`. Pressing Run mints a task via `dispatchPromptTask`. | Agents get `create_runbook`/`list_runbooks`/`update_runbook`, no delete tool. `schedules.runbook_id` lets a schedule point at a runbook; the schedule's own columns are the fallback. |

## Storage

SQLite holds every durable record; a single shared connection serializes all writes inside
one Node process. Git worktrees and cloned repos live outside `~/.calandria` entirely, so a
database reset never touches a user's code.

| Module | Responsibility | Invariant |
|-|-|-|
| `lib/db.ts` | Schema and migrations. | Single shared connection, WAL mode. |
| `lib/store.ts` | Typed queries. | The only place raw SQL for a given table should live. |
| `lib/types.ts` | Shared types. | Mirrors the schema `lib/db.ts` defines. |
| `lib/db-lock.mjs` | One app process per database: `BEGIN IMMEDIATE` on `calandria.lock.db`, held RESERVED for the connection's life, released by the OS on `SIGKILL`. Claimed by `server.js` before `app.prepare()`. | `CALANDRIA_DB_LOCK_WAIT_MS` (default 10s) covers a predecessor still shutting down. `consumeDbRecoveryAuthorization()` returns true at most once, only for a database this process claimed, never under vitest or `next build`; ownership state lives on `globalThis` since `server.js` and `lib/db.ts` load the module through two different loaders sharing one realm. `locking_mode = EXCLUSIVE` is not layered on top, since it retains a SHARED lock after a failed write, which could deadlock two racing processes out of the upgrade. A separate lock file, not `calandria.db` itself, keeps a read-only `sqlite3` inspection working; a best-effort JSON sidecar records the holder's pid and host for the error message only, never to decide ownership. The lock only coordinates processes sharing a kernel: run one instance per volume. |
| `lib/storage.mjs` | Path resolution for every on-disk location. | See the table below. |
| `lib/git.ts` | Per-task worktrees and branches, diffs, merge (`mergeTask`, `prepareWorktreeMerge`/`completeWorktreeMerge`/`abortWorktreeMerge`), base-branch sync (`worktreeSyncStatus`/`fastForwardWorktree`), and the app's only network git (`fetchBase`, `remoteBaseStatus`, `advanceBaseBranch`, `pushBaseBranch`). | New worktrees cut from the fetched remote tip are pinned to a SHA when local base is behind it. The user's local base branch only ever moves forward, never forced, only on an explicit click or a pre-merge tidy-up. |

### Where data lives

| What | Where |
|-|-|
| Projects, tasks, transcripts, summaries, session index | `calandria.db` in `CALANDRIA_DB_DIR` (default `~/.calandria`); a pre-rename `~/.zen-orchestrator/orchestrator.db` is kept in place, never moved |
| Per-task git worktrees | `CALANDRIA_WORKTREES_DIR` (default `~/.calandria/worktrees`); a populated legacy `~/.agent-orchestrator/worktrees` is kept, since git pins each worktree's path absolutely |
| Cloned project repos | `CALANDRIA_PROJECTS_DIR` (default `~/projects`), always outside every repo |
| Claude Code's raw session logs | `~/.claude/projects/...`, managed by Claude Code itself |

With the env unset, nothing moves automatically. Inside an explicit `CALANDRIA_DB_DIR`,
`calandria.db` wins if present, with `orchestrator.db` as fallback. See
`docs/SELF_HOSTING.md` for the manual migration recipe.

## Auth

Every HTTP route and WebSocket upgrade is gated. Two provider modes exist and neither can
borrow the other's defense, since local mode has no login to prove identity and Access mode
cannot enumerate the tunnel hostnames a target allowlist would need.

| Module | Responsibility | Invariant |
|-|-|-|
| `middleware.ts` | Gates every HTTP route. | No matcher, on purpose: every route is covered by default. |
| `lib/auth/origin.mjs` | Selects the provider. | No-login local mode by default; Cloudflare Access when `CF_ACCESS_*` is set. |
| `lib/auth/local-origin.mjs` | Shared origin-boundary logic for both modes. | Both modes have a browser-origin boundary; this module keeps the HTTP and WebSocket policies from drifting apart. |
| `lib/cf-access.mjs` | Cloudflare Access threat model. | `CF_Authorization` is `SameSite=None` and proves identity, not intent. |
| `pty-server.js` | Mirrors the same mode-aware origin check on top of its own loopback-peer check. | Must not assume it runs behind `server.js`; must not enforce the other mode's policy. |

Local mode trusts loopback, `PUBLIC_BASE_URL`, and explicit LAN origins named in
`CALANDRIA_ALLOWED_ORIGINS`. This is the DNS-rebinding defense a mode with no login needs.

Access mode cannot use a target allowlist, since the tunnel hostname is unknowable in
advance, and does not need one, since a rebound host produces no valid assertion. Its JWT
proves identity but not intent, so `sameOriginWebSocketRequestAllowed` gates upgrades and
`sameOriginHttpRequestAllowed` gates `middleware.ts` on top of it.

CORS does not cover the HTTP half: `Request.json()` ignores `Content-Type` while
`text/plain` is CORS-safelisted, so a preflight-free `no-cors` POST reaches every JSON route.
The HTTP rule rejects only a present-and-mismatched `Origin`, never on `Sec-Fetch-Site:
cross-site`, since a cross-site navigation sends no `Origin` at all.

Health, version, and usage routes accept `SERVICE_TOKEN` or the read-only
`CALANDRIA_FLEET_TOKEN` instead of an origin check. `docker/entrypoint.sh` mints one when
Access mode supplies none.

When adding a route or upgrade path, decide which gate covers it.

## UI shell

The browser side is a three-column shell over the live-updates and turn-lifecycle APIs above:
projects on the left, tasks in the middle, the selected task's live session on the right.

| Module | Responsibility |
|-|-|
| `app/Shell.tsx` | The three-column shell: projects, tasks, live session. |
| `app/shell/useTaskStream.ts` | The one-`EventSource`-per-task transcript logic for the selected task. |
| `app/shell/useGlobalEvents.ts` | The one-`EventSource`-per-tab lifecycle stream from `GET /api/events`. |
| `app/shell/SessionRail.tsx` | The DIFF/PREVIEW/CONTEXT tabs beside the transcript. |
| `app/shell/Runbooks.tsx` | Runbook list and editor UI. |
| `app/shell/Schedules.tsx` | Schedule list and editor UI; validates a slash prompt against the project's command registry on save. |
| `app/Terminal.tsx` | xterm.js over the `/pty` WebSocket, proxied by `server.js` to the `pty-server.js` sidecar. |
| `app/shell/Layout.tsx` (`TerminalDrawer`) | Opens in the project's `repo_path`, with a Project/Task toggle that re-roots the shell at the selected task's `worktree_path`. The scope is a pin, not a derivation from the selected task: `TerminalView` respawns the shell whenever `cwd` changes. |

**Stack:** Next.js (App Router) + TypeScript, React 19, better-sqlite3,
`@anthropic-ai/claude-agent-sdk`, xterm.js + node-pty sidecar, streaming over SSE.
