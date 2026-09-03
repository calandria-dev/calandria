# CLAUDE.md

Calandria is a local-first web app that runs many coding-agent sessions in parallel across
several projects from one screen. A **project** carries reusable context and a working
directory. A **task** is one agent session in its own git worktree, run against the user's local
Claude or Codex login rather than an API key.

## Commands

- `npm run dev` — app (:3000, `server.js`) plus the pty sidecar (:3001, `pty-server.js`) via
  concurrently. `npm run dev:next` and `npm run pty` run them separately.
- `npm run build` (turbopack), then `npm start` for production.
- `npm test` — vitest, serial on purpose: tests spawn many real git subprocesses. Single file:
  `npx vitest run tests/merge.test.ts`.
- `npm run test:e2e` — Playwright. Builds, then boots the real prod server against a hermetic
  temp instance with the deterministic mock agent (`lib/agents/mock/`, registered only when
  `CALANDRIA_E2E_MOCK_AGENT=1`), and drives onboarding → project → task → turn → diff → merge
  through the UI. `npm run preflight` = unit + e2e, the pre-push gate. `e2e/README.md` has the
  mock-turn directives, selector conventions, and the staleness gotcha: the server runs the
  **built** bundle.
- `npm run typecheck` — `next typegen && tsc --noEmit`, a few seconds. CI runs it as its own job
  (`.github/workflows/test.yml`). The `next typegen` half writes the gitignored `next-env.d.ts`
  and `.next/types` that `tsconfig.json` includes, so a clean tree checks the same files
  `next build` does, including the generated validator that pins every App Router handler to its
  route.
- **Tests in a container** — `npm run test:docker`, `typecheck:docker`, `test:e2e:docker` and
  `preflight:docker` run those scripts inside a Linux Node 22 image (`docker/test/Dockerfile`,
  driven by `scripts/docker-test.sh`). A file path passes through
  (`npm run test:docker -- tests/merge.test.ts`), but a vitest **flag** needs a second `--` or npm
  eats it: `-- -- tests/merge.test.ts -t "conflicts"`. A task worktree has no `node_modules` and
  the main checkout's is macOS-built, so the container installs its own into a shared named
  volume: one cold install, reused by every later run. `e2e/README.md` has the recipe, the two
  dead ends it encodes (don't borrow node_modules; don't build on the Playwright image, which is
  Node 24 with no `better-sqlite3` prebuild) and the `fatal: not a git repository` red herring.
  `.claude/skills/running-tests/SKILL.md` is the operating summary a session loads on demand.
- No lint script. TypeScript is strict, path alias `@/*` → repo root (mirrored in
  `vitest.config.ts`).

## Collecting context

Measured across 198 task sessions in this repo (`docs/DELEGATION.md` has the method and the full
table): 79% of the tool calls a first turn makes are Bash, and only ~12% of those are decisions the
model has to see raw output for. Half of all first-turn Bash calls sit inside unbroken runs of
three or more read-only commands — the longest measured is 43 — and collection steps put **59% of
the context a first turn accumulates** into the window, where every later step re-reads it. Across
the 25 most expensive first turns, `Agent` was called zero times.

**The rule that follows is in the session prompt, not here** — `buildProjectContext()` in
`lib/agents/shared.ts`, so it reaches every project on the instance rather than only this repo:
past two read-only commands in a row, the third goes to a synchronous collection subagent, asked
for conclusions and `file:line`s rather than file contents. It is stated there because this
section said it first and was measured losing: the CLI's own auto-mode guidance points the other
way in the same window, and from here the rule fired only after the reading it was meant to
replace — 10.3 read-only Bash calls per run against 3.6 from the prompt. An appended system prompt
is where it competes on equal footing. What stays here is what only this repo knows.

Four dispatches this repo has already needed, each replacing a measured sweep:

- *"Grep `project.branch` and `proj.branch` across `lib/` and `app/`. Report every call site as
  `file:line` with its enclosing signature and one line on what it assumes about the base branch."*
  — the 34-call sweep that opened the per-task-base-branch work.
- *"Trace `withdraw_suggestion` through all five wiring points — `lib/agentToolDefs.mjs`,
  `lib/agentTools.ts`, `app/api/internal/agent-tools/`, the Claude driver's registration,
  `scripts/calandria-mcp.mjs`. Report `file:line` for each and the exact shape a new tool copies."*
  — a 33-call sweep, and the template for adding any agent tool.
- *"Find every place `running` or `awaiting_input` renders a status dot, spinner or label across
  `app/shell/` and `lib/`. Report `file:line` plus the condition each tests."* — the 43-call sweep,
  the longest measured.
- *"Read `docs/DESKTOP_APP.md` and `docs/DESKTOP_E2E.md` in full and report which of openbox,
  dbus-x11, xdotool and dunst are installed on this host."* — a reading errand costs the
  coordinator two sentences instead of two files.

**And none of this licenses a cheaper proxy for actually running something.** If the answer is a
measurement — how many cases a file declares, which test is slowest, whether a build passes — run
it and read the number. Measured: a session asked to inventory the suite counted `it(` with grep
instead of running vitest, reported `tests/importGraph.test.ts` as 4 cases when it declares 57
(they're generated in a loop), and left the slowest file out of its "five slowest" list. Static
counting is not a cheap version of measuring, it is a different and wrong answer. A worktree has no
`node_modules`; installing them is part of the job, not a reason to estimate.

One shape that isn't delegation: waiting. Polling a backgrounded run with repeated `tail` and
`grep -c` was 105 of one session's 194 Bash calls. Use `Bash(run_in_background)` and wait for the
notification, or `Monitor` for a stream.

## Architecture

Three processes and entrypoints, one origin:

- **`server.js`** — custom Next.js server, plain Node and CommonJS. Fronts Next on one port,
  proxies `/pty` WebSocket upgrades to the sidecar, forwards dev HMR upgrades to Next, enforces
  origin auth on WebSocket upgrades, and dispatches public service hostnames
  (`<slug>--<appHost>`) through `lib/service-router.mjs`. Middleware never sees upgrades, so this
  file is the auth boundary for the terminal.
- **`pty-server.js`** — node-pty sidecar, bound to `127.0.0.1` only, never exposed directly.
- **Next app** — UI in `app/`, REST under `app/api/`, server logic in `lib/`.

### The turn lifecycle (core flow)

`POST /api/tasks/[id]/messages` doesn't run the turn. It calls `startTurn()` in **`lib/runner.ts`**
and returns. The turn runs detached, owned by the server process: every event is persisted to
SQLite and fanned out through **`lib/events.ts`**, an in-process pub/sub keyed by task id with a
wildcard channel (`subscribeGlobal()`) that sees every task's events. `GET` on the same route is
the SSE watch stream: a `snapshot` of the persisted transcript, then a live tail. It is
reconnect-safe, takes any number of viewers, and is fine with zero. Stopping is only ever explicit
(`lib/abort.ts`).

If a turn is already running, POST parks the message in `pending_messages` to run next. The
exception is a **LINGERING** turn (model done, session held open for background work or a wakeup),
where there is nothing to wait for and the wait is unbounded by default. There,
`sendToLingeringTurn()` hands the message to the driver's still-open prompt iterable via
`lib/turnInput.ts` (registered per turn, SDK-free; `send` returning false means "queue it
instead"), and it lands as an ordinary user message starting the next turn. Order is kept at both
ends: entering a linger drains the oldest parked follow-up into the same session, and a send is
refused while anything is still queued. The driver drops `lingering` in the same tick it accepts,
so the injected turn's bare `init` (identical to a cron wake's, measured) is never announced as a
wakeup firing, and the optional linger deadline re-anchors.

Worktree isolation is guaranteed by the runner, not by its callers. `startResumeTurn()` runs the
same `ensureWorktree` self-heal as the two first-turn launch paths (POST /messages and
`lib/autoStart.ts`), because a turn can also reach the runner through the queue drain in `run()`'s
finally, which only pops a message. An empty `worktree_path` there falls the driver back to
`project.repo_path` and edits the user's real checkout (`tests/queueDrainWorktree.test.ts`).

### Live updates without polling

Only the SELECTED task has a transcript stream open. Everything else stays live through
`GET /api/events`: one always-open EventSource per tab (`app/shell/useGlobalEvents.ts`)
broadcasting coarse lifecycle events for every task across every project — turn started, awaiting
input, answered, suggestion created, turn ended, and a task's fields edited by the user in another
tab or by `update_task`. That drives spinners, project badges and the "N need you" pill for
unselected tasks. There is no task-list polling.

Each payload re-reads the task row at publish time. The runner persists before it publishes, so
the snapshot is authoritative (`tests/agentDriver.test.ts`). It also carries the project's fresh
awaiting count, plus, on a `suggested` event, the project the task was filed INTO, which
`suggest_task` can point anywhere. Project-wide facts have no one row to re-read, so
`task_deleted`, `tasks_moved`, `runbooks_changed` and `tags_changed` carry their own project id
and short-circuit before it.

Task ORDER is not among them, because it isn't stored. `listTasks` sorts `updated_at DESC`, then
`created_at`, then `rowid` (a planning turn files its whole batch inside one millisecond), so the
top card in every bucket, Suggested tray included, is the most recently active task and gets there
on the lifecycle events that already flow. That replaced the manual board order: `tasks.position`
still counts up per project and the move paths still renumber it, but nothing renders it, so
`reorderTasks`, `POST /api/tasks/reorder` and the `tasks_reordered` event are gone with it, and a
board drag writes only the status its column implies (a drop inside one column is a no-op).
`position` stays on the client's `TaskRow` for one reason: it's the filing sequence `topoMembers`
tie-breaks a tag's steps by, so "step 3 of 7" doesn't renumber every time a member runs.

### The agent seam

**`lib/agents/`** is where the app talks to coding agents, and only through the `AgentDriver`
interface in `types.ts`: a normalized `StreamEvent` turn contract, one-shot summarize / draft /
recap helpers, a capability descriptor, and a login/verify auth surface. Only `runTurn()` is
required; the rest are optional. `getDriver(task.agent)` in `registry.ts` resolves a driver
(`tasks.agent`, defaulted from `projects.default_agent`; unknown ids fall back to Claude), and
`shared.ts` holds the agent-agnostic normalizers (project-context and conflict prompts, tool-call
to title/peek/diff, the event queue). `GET /api/agents` exposes each driver's capabilities to the
client. Session and thread ids are opaque per driver: `sessions.claude_session_id` stores any
driver's id.

Two drivers ship: `lib/agents/claude/` (Claude Code, via `@anthropic-ai/claude-agent-sdk`) and
`lib/agents/codex/` (OpenAI Codex, via `@openai/codex-sdk` spawning the `codex` CLI). Non-Claude drivers get the same
Calandria tools, plus `ask_user`, through the stdio MCP bridge `scripts/calandria-mcp.mjs` →
`/api/internal/agent-tools/*`. `ask_user` restores interactive asks: the card is persisted and
published by `lib/agentTools.startAskUser`, and the bridge polls the `wait` endpoint for the
answer.

**`lib/agents/CLAUDE.md` holds the per-driver detail** — permission modes, model catalog and
Vertex corrections, MCP inheritance, one-shot isolation, slash-command discovery, and how to add a
third agent.

**A task is a lineage of sessions.** `/clear` ends generation N, condenses its transcript to a
summary, and generation N+1 starts fresh seeded with all prior summaries.

**Internal jobs run through `lib/agents/oneshots.ts`** — the turns that run *outside* the main
chat, under two routing policies. **Task-scoped** work (`/clear` transcript summarization) follows
the **task's own agent**, so a Codex task's handoff note bills the Codex login. **Project-scoped**
work (recap, the "Refresh with AI" context draft) runs the **utility agent**, resolved
connected-first: the `utility_agent` setting if it's connected, else the app default, else the
built-in default, else any connected agent. With nothing connected it raises an actionable error
rather than reaching a dead CLI. Unattended work is gated server-side by `background_jobs`
(default `on`), and recap scheduling additionally by `recap_mode` (`automatic` default, `on_open`,
`off`); explicit `/clear`, Refresh with AI and manual recap refreshes still run. A driver that
doesn't implement a helper is backstopped by the utility agent. Every one-shot funnels through one
`run()` wrapper that records the agent and MODEL that **actually** ran it plus `fallback` via
`addInternalUsage()`, since both fallback paths are invisible otherwise. `resolveUtilityAgent()`
reports the same resolution without throwing, so `GET /api/agents` can hand Settings the effective
utility agent and its `(fallback)` hint.

Agent choice is connected-first everywhere else too. The first-run wizard requires **an** agent,
not Claude: finishing with only Codex connected adopts it as the app default and retargets the
seeded tutorial (`completeOnboarding` in `lib/onboarding.ts`). New tasks pick their agent through
`defaultAgentFor()` (`app/shell/agents.ts`) in the New-task dialog and `resolveConnectedAgent()`
(`lib/agentTools.ts`) in `suggest_task`; idle, unstarted tasks can still switch before their first
session fixes the driver lineage. AI conflict-resolution turns need no special routing: the client
sends `buildConflictPrompt()` output as an ordinary message through `startTurn()`.

### The permission gate

Under every mode but `bypassPermissions`, the SDK's `canUseTool` is a real gate
(**`lib/permissions.ts`**): a read-only allowlist, then the project's remembered Bash rules
(`permission_rules`), then a permission card that parks the turn on the user through the same
`lib/asks.ts` and `/answer` machinery an AskUserQuestion uses. Every non-answer path denies (Stop,
expiry, unwatched turn, unparseable answer), and an unattended auto-deny parks the pending queue
the way a dead login does.

Rules are minted from the card and, since the card is unreachable on a turn nobody is watching, by
typing one into Settings → Run defaults (`POST /api/settings/permissions`). The typed path is not
a second policy: `ruleFromTypedCommand()` runs the same `prefixVerdict()` the card's offer does
and stores what IT returns, never the typed line, or Settings would be the way to mint
`bash_prefix: "sudo"`. Two things differ from the card. A refused prefix is a **400 rather than a
downgrade to `bash_exact`**, because the card can fall back while showing the user the exact rule
it will create and a form can't. And the refusal carries the REASON, since no proposed command is
on screen to explain itself. Bash-only is enforced rather than assumed: `ruleMatches()` goes
through `bashCommandOf()`, so a row naming any other tool never matches a call and would just read
like a grant.

Refusals the CLI makes without ever calling `canUseTool` are handled by the Claude driver and land
as an already-decided card on the transcript row (see `lib/agents/CLAUDE.md`).

**The gate also runs BEFORE the turn does** (`lib/settingsDrift.ts`, issue #43). The files a
driver names in `watchedSettingsFiles` — `<worktree>/.claude/settings.json` for Claude — are
re-read from disk every turn and are executable config (`hooks` run shell commands outside
`canUseTool` entirely; `permissions.allow` approves calls with no gate call at all), while living
where the agent's own writes land. So turn N could write what turn N+1 obeys, and so could the
base-branch catch-up. The runner hashes each one before calling `runTurn`, and a hash that moved
since this task last ran parks it on an ordinary `PermissionRequest` (`kind: "settings"`) — same
registry, same `/answer` route, same transcript row, because a second answering path is a second
thing to get wrong. Approving adopts the new version as the baseline (`task_settings_snapshots`),
so a repo that legitimately changes its settings asks once; declining ends the turn before the
agent starts, parks the queue and leaves the task flagged. A first sighting is recorded silently —
a task inherits its repo's settings the way it inherits its repo's code — and an unattended or
scheduled run refuses outright, because nobody objecting is not the same as somebody agreeing.

### Agent tools (`lib/agentTools.ts`)

`suggest_task` takes an optional `project` (id or exact name, from `list_projects`) and can file
into ANY project. `resolveTargetProject()` is strict: an unrecognized value is refused outright,
never falling back to the calling project. It resolves BEFORE the insert, so the new task's agent,
`send_context` and position come from the target. `blocked_by` follows the target too
(`setTaskDeps` is project-scoped; unusable refs are reported back rather than dropped), and the
`suggested` event carries the target's project id (`suggestedProjectId` on the wire) so the
receiving tray refreshes even when it isn't the project on screen. It also carries the id of the
task it CREATED, which is what makes a suggestion reviewable where it was made: the runner settles
it onto the `suggest_task` tool row the call produced — the same move a CLI-side refusal makes with
its already-decided card (the permission gate above) — and `Transcript.tsx` renders a **suggestion
card** there with the tray's own Start / Add / Dismiss, wired to `useShell`'s handlers so a session
started from the transcript is indistinguishable from one started from the tray.

Only the two ids are persisted (`ToolData.suggestion`); everything the card shows is re-read per
render through `GET /api/tasks/[id]/suggestion`, so a reloaded transcript says *Session started* /
*Added* / *Withdrawn* / *no longer exists* instead of offering Start twice or 404ing on a row that
Dismiss hard-deleted. **Start is deliberately withheld for a suggestion filed into a DIFFERENT
project**: starting it mints and selects that task, dragging the user out of the session they are
reading into a project they may not have on screen, which is worse than the tray round trip it
saves. Such a card names the target project and offers only the two actions that don't navigate.

Correlation is by the tool's own `name` — now on the `tool` StreamEvent and on `ToolData`, because
a title is human prose and free to be re-worded — matched as a SUBSTRING in `lib/suggestionCard.ts`
since the prefix belongs to the driver rather than the tool (`mcp__calandria__suggest_task`
in-process, `calandria__suggest_task` over the bridge). A turn on the runner's stream settles in
memory, queueing each call so a parallel batch lands one card apiece; the stdio bridge's endpoint
is reached out of band with no tool_use id, so it patches the newest unclaimed `suggest_task` row
instead — which is why the runner re-reads that one field before writing a `tool_result` over the
top.

**Every tool answers through `lib/agentToolGuard.mjs`, and adding one must not opt out.** Twice
(2026-08-24, 2026-08-30) a live turn's tool calls started coming back with no content and no error
for 20-50 minutes before healing themselves, and the sessions reported a withdrawal, a runbook and
a pull request that were never written — an empty result is indistinguishable from a quiet success,
so the model cannot notice. The guard rewrites a throw, an over-long call and a blank result as a
sentence naming the tool, and passes a healthy answer through untouched. It is applied to the whole
tools ARRAY in the Claude driver and to `registerTool` itself in the bridge, so a tool added later
cannot forget; both use the one `.mjs` copy, because a guard on one end only is one the other
loses. The bound (`CALANDRIA_AGENT_TOOL_TIMEOUT_MS`, 10 min; 0 for `ask_user`, which waits on a
human) exists because nothing below has a usable one — the CLI's per-call MCP timeout defaults to
~27.7 hours and can't be set per in-process server. `create_pr` names its PR by number and URL for
the same reason: it is the only way a session says in git that its work is finished.

Reads range as widely as filing does: `list_tasks` takes the same optional `project` and flags the
caller `current: true`, and `get_task` reads any id, defaulting to the session's own.

`update_task` writes **any task in any project**: the caller's own row by default, or any other
id, including ones the user accepted or started. The only refusal is `running=1`. A write the old
`suggested=1 && started=0 && running=0` gate would have refused now lands, but is recorded in
`task_agent_edits` (per-field before/after) and stamps `agent_edited_at`, surfacing a "Changed by
agent" chip with per-edit Revert and a Keep-changes ack (`GET`/`POST /api/tasks/[id]/agent-edits`).
Visibility and undo replaced the narrower gate. It covers title, description, priority and status
minus `cancelled`: on the own row that would `abortTurn()` the very turn calling it, and on
anyone else's it needs a stated reason, which is `withdraw_suggestion` below. It does NOT carry
the project — re-parenting is `move_task`, below.

It also covers **`blocked_by`, the only way an agent can order a plan at all.** `suggest_task`
takes blockers in the call that INVENTS the task, before any of them has an id, so a planning turn
(one parallel batch of `suggest_task` calls, the sequence worked out afterwards) could never use
it, and never did: every dependency edge on a real board was drawn by the edit dialog, and no
transcript contains the "Blocked by N task(s)" line `depNote()` returns. The recipe is two-phase
and `buildProjectContext()` spells it out: file every task, WAIT for the ids, then `update_task`
per dependent. Two rules differ from `suggest_task`'s version of the param, both because this one
REPLACES a set rather than filling a blank one:

- Refused on the CALLER'S OWN ROW. Blockers gate whether a task may START and a session calling
  this already has, so the edge would be inert on the scheduler and a lie on the board; the
  refusal names `on_hold`.
- An unusable ref FAILS THE WHOLE CALL, named one at a time with its reason (not an id, another
  project, the task itself), where `suggest_task` partitions and reports. Wiring what we
  recognized and dropping the rest would delete edges the agent never mentioned and still report
  success. A cycle refuses everything too, and `setTaskDeps` runs before the row patch (its guard
  throws before it writes), so a rename in the same call can't land under a refusal that says
  nothing changed.

`updateTaskForAgent()` owns the whole policy so the two callers can't drift. The caller is always
trusted (the Claude driver closes over it; the bridge's endpoint reads `CALANDRIA_TASK_ID`) and
the target is always the model's word for it. It re-reads both rows first, because a detached
turn's snapshot outlives deletions and a target can be started between read and write; the check
and the write share one synchronous block, atomic under better-sqlite3 in a single process. It
publishes `task_edited` against the TARGET so clients refetch fields the coarse wire payload can't
carry, and returns an `autoStartDependents` flag instead of calling `maybeAutoStartDependents()`
itself, because `lib/autoStart.ts` reaches the runner while `lib/agentTools.ts` is pinned SDK-free.
`tests/codexUpdateTaskPolicy.test.ts` runs the real stdio bridge against the real endpoint and
asserts on the DB, because Codex is the path where the MODEL names the target.

**`move_task(tasks, project)`** re-parents tasks (issue #24), running `lib/taskMove.ts` — the
board's own operation — so a move keeps the row rather than retyping it into a new one. A separate
verb for `set_base_branch`'s reason and one more: it's async and locking, and it's a SET operation,
since a `blocked_by` edge survives iff BOTH ends move in the same call. Chains go whole; every
dropped edge is named, because a task that looks ready and isn't is the issue's one stated failure
mode. **It takes no discard acknowledgement**: the bulk route asks for those as lists of ids so one
switch can't answer for eleven checkouts, and an agent verb must not be the shortcut past that —
started tasks (and anything mid-turn, including the caller) are refused per task while the rest
still move, and the internal endpoint ignores a flag sent anyway. A move off a row the user had
accepted is recorded like an `update_task` edit under a new `project` field, and its Revert re-runs
the move backwards rather than writing `project_id`, which would strand the task's sessions and
spend.

**`withdraw_suggestion(task, reason)`** is the retraction verb, on the SAME `isInertSuggestion()`
screen (shared, so the two policies can't drift): an agent reaching for `status: "done"` to mean
"this is redundant" both lies and fires the auto-start sweep. `reason` is required and non-empty.
It is not a delete, since the tray's Dismiss already hard-deletes with no undo. The row goes
`cancelled` with `suggested` left at 1, so it stays in the tray, struck through with
`tasks.withdrawn_reason` shown and sorted below live ones (`isWithdrawn` / `withdrawnLast` in
`app/shell/format.ts`, honored by both the list tray and the board), publishing `task_edited`.
`PATCH /api/tasks/[id]` owns reviving and clears the reason AND the cancelled status together,
because the three ways back (tray Add/Start patches only `suggested: 0`, board drag adds a status,
edit dialog re-statuses) would otherwise each need to remember both halves.

That forced a shared-path fix. `blocks()` always counted **cancelled** as terminal, but
`maybeAutoStartDependents()` only fired on the transition into `done`, so cancelling the last
blocker left an `auto_start` dependent unblocked and never launched. It now fires on any
non-terminal → terminal transition, from the tool and from the user-facing PATCH, so cancelling in
the UI can start work, which is what "Start when unblocked" promised. The note distinguishes
`is done` from `was cancelled`.

### Key modules (by responsibility)

- `lib/db.ts` — SQLite schema and migrations (single shared connection, WAL). `lib/store.ts` —
  typed queries. `lib/types.ts` — shared types.
- `lib/abort.ts` — the live-turn registry and the app's liveness signal. It outranks
  `tasks.running`, which can be stale after a restart mid-turn, while this map dies with the
  process. `activeTurnCount()` is what `lib/metrics.ts` exports as `calandria_turns_active` for an
  external sleep daemon; `activeTurnIds()` is what the graceful-shutdown drain (`drainActiveTurns`
  in `lib/runner.ts`) aborts before exit.
- `lib/db-lock.mjs` — **one app process per database**, claimed by `server.js` before
  `app.prepare()` and never by `getDb()`, so `next build` and the suite don't hold a lock they
  shouldn't. Single-process is the design: turns run detached and owned by the server, and the bus,
  abort and ask registries are in memory. `recoverFromCrash()` opens every boot by clearing what a
  dead predecessor left (running flags, `pending_messages`, unanswered permission cards,
  `claimed`/`running` schedule runs) in one transaction, since the four facts describe a single
  moment. That pass would wipe a LIVE second instance's work in progress, so it sits behind
  `consumeDbRecoveryAuthorization()`: true at most once, only for a database this process claimed,
  never under vitest or `next build`.

  The mutex is a **kernel file lock**: an uncommitted `BEGIN IMMEDIATE` on a dedicated
  `calandria.lock.db`, holding RESERVED for the connection's life. The lock file is named after the
  database it guards, so a pre-rename `orchestrator.db` is guarded by `orchestrator.lock.db` and an
  older build still running can't be missed. It is not a pid+heartbeat lease: no heartbeat to miss,
  no staleness window, no pid-liveness heuristic to get wrong (pids are small and reused in a
  container, and `docker restart` keeps the hostname), and the OS releases it on SIGKILL, so a
  crashed instance is reclaimed instantly. `CALANDRIA_DB_LOCK_WAIT_MS` (10s) covers only a
  predecessor still shutting down. `locking_mode = EXCLUSIVE` is NOT layered on: it retains SHARED
  after a FAILED write, so two racing processes could deadlock each other out of the upgrade, and
  held RESERVED already excludes every other writer. A separate lock file, rather than
  `calandria.db` itself, keeps a read-only `sqlite3` inspection working and leaves WAL alone; the
  holder's pid and host are a best-effort JSON sidecar for the error message, never for deciding
  ownership. State lives on `globalThis` because `server.js` loads this through Node's ESM loader
  while `lib/db.ts` loads it through Turbopack's bundle: two module instances, one realm.
  `CALANDRIA_DB_LOCK=off` is the escape hatch and still authorizes recovery ("don't stop me", not
  "run crippled"); only the acquire call reads it, so a stray env during a build can't authorize a
  wipe. Stated limit: it coordinates processes sharing a kernel, so two containers on one volume
  may not see each other, a configuration already unsafe because WAL needs shared memory.
- `lib/git.ts` — per-task worktrees and branches, diffs, merge (`mergeTask`,
  `prepareWorktreeMerge` / `completeWorktreeMerge` / `abortWorktreeMerge`), base-branch sync
  (`worktreeSyncStatus` / `fastForwardWorktree`), and the app's **only** network git (`fetchBase`,
  `remoteBaseStatus`, `advanceBaseBranch`, `pushBaseBranch`, plus `createTaskPr`'s push in
  `lib/github.ts`). Fetching is best-effort by contract — hard timeout, no interactive prompting,
  per-repo cooldown, outside the repo lock — so a task launch survives no network, no remote and a
  dead credential. New worktrees are cut from the fetched remote tip when local base is merely
  behind it, pinned to a SHA: a ref can move before `worktree add`, and a remote-tracking start
  point would give the task branch an upstream. The user's local base branch only ever moves
  forward, never forced, and only on an explicit click or as a pre-merge tidy-up, so a task cut
  from the remote tip isn't credited with the commits it rode in on.
- `lib/taskMove.ts` — re-parenting tasks as an operation, shared by the single
  (`POST /api/tasks/[id]/move`) and bulk (`POST /api/tasks/move`) routes, which differ only in
  manner: the single one refuses with 409, the bulk one reports a refusal per task and moves the
  rest. It owns the eligibility screen (`hasTurn`, which the row's own flags can't see), the sorted
  `withTaskLocks` acquisition that makes that screen atomic with the write, the worktree teardown
  that lets a STARTED task move, and the one `tasks_moved` event a whole selection publishes.
  `lib/store.ts`'s `moveTasks` is the DB half: one transaction, positions renumbered per
  destination, inherited settings re-derived, the project-keyed child rows (sessions, task_usage,
  task_merges) re-pointed so spend and insights follow the task, and a dependency edge kept only
  when BOTH ends are moving, so a chain selected whole arrives intact.

  A started task's checkout was cut from the OLD repo, so it can only move by being destroyed.
  `discard_worktree` is that acknowledgement, `discard_unsafe` the second one demanded when
  `worktreePruneSafety` finds work in there. Both are re-read at teardown rather than taken from
  the `GET /api/tasks/[id]/move` preview the modal rendered, so nothing unsaved is discarded
  without having been named. Teardown runs BEFORE the write, leaving a row every launch path
  self-heals rather than an orphaned worktree nothing points at, and `ensureWorktree` refuses to
  adopt a leftover checkout not registered to the repo it's cutting from, since worktree paths are
  keyed by task id and the fresh worktree lands at the very path the old one occupied.

  **Bulk takes both acknowledgements as LISTS OF IDS, never a flag**, since one checkbox over
  eleven irreversible answers isn't consent. A boolean is ignored, so a caller sending the single
  route's `true` gets the ordinary refusal. `moveTasks`' `resetCheckout` is a `Set` for the same
  reason: it both waives the started-task refusal and clears the columns, so as one flag over the
  batch an unanswered started task would move with its columns cleared and its worktree orphaned in
  the repo it left. `GET /api/tasks/move?ids=…` (`previewDiscards`) puts a cost beside each row
  before it's ticked; it is sequential, being a pair of git subprocesses per STARTED task while
  nothing without a checkout touches git. Refusals stay per task on the way out too: three dirty
  worktrees don't refuse the eight clean ones, and a row that picks up unsaved work after its
  preview is refused by the teardown's re-read and reported in `skipped`. `canPick` in
  `TasksColumn.tsx` therefore gates only on `running`: a started row is selectable, a mid-turn one
  never is.
- `lib/services.ts` — managed-services supervisor: shell-spawned child process trees owned by the
  server, log ring buffers, SSE status. `lib/processTree.ts` — kill, liveness and recycled-pid
  guard for those trees, POSIX process groups versus win32 `taskkill`. `lib/service-router.mjs`
  and `lib/service-host.mjs` — the public service-hostname reverse proxy and pure host/token
  helpers.
- `lib/runbooks/store.ts` — runbook CRUD and the delete-detaches-linked-schedules transaction.
  `lib/runbookTools.ts` — the agent-tool policy behind `create_runbook`, `list_runbooks` and
  `update_runbook`. Both are DB-only and in `tests/importGraph.test.ts`'s `PINNED` set.
  `lib/dispatch.ts` — the mint-a-task-and-launch-its-first-turn core shared by runbooks and the
  scheduler; it reaches the runner, so it is not pinned.
- `lib/contextRefresh.ts` — "Refresh with AI" as a detached background job, polled via GET rather
  than held open. `lib/tagRefresh.ts` — the same shape for a tag ("Refresh tag"), except that it
  APPLIES its outcome instead of drafting one: task edits go through `lib/agentTools.ts` and land
  as revertable "Changed by agent" rows, and only work with nothing in it may be retired.
  `lib/recap.ts` — the staleness and activity sweep. All three are project-scoped one-shots that
  run on the utility agent via `lib/agents/oneshots.ts`.
- `lib/retention.ts` — the scheduled prune of the tables that used to grow forever (issue #15),
  riding `lib/scheduler.ts`'s ticker on its own much longer clock, because this process owns the
  database and a second daemon would need a second lock. `prunableTaskIds()` is the whole policy,
  and is where a new "a done task can still be live" fact belongs: terminal, idle, unsnoozed, no
  parked follow-up, no in-flight schedule run, cold by `updated_at`. Two rows are never pruned,
  since dropping either is silent damage: the session `tasks.session_id` names (the resume key AND
  the Codex `usage_cum` baseline, whose loss makes the next turn re-bill the thread) and
  `summaries`. Reclaim is `wal_checkpoint(TRUNCATE)`, because the deletes land in the WAL first and
  an unchecked prune raises the footprint before lowering it. Windows, defaults and the opt-in
  `VACUUM` are in `docs/SELF_HOSTING.md`. Knock-on in `lib/scheduler.ts`: the ticker starts when
  EITHER the scheduler or retention is on, since the instance that turned scheduled work off still
  wants its disk swept.
- `lib/worktreeSweep.ts` — the same policy for the CHECKOUTS (issue #15 item 2), the disk story
  measured in gigabytes rather than rows. Same ticker, same clock, and `prunableTaskIds()` reused
  verbatim rather than a second predicate; only the cutoff differs
  (`CALANDRIA_WORKTREE_RETENTION_DAYS`, 14). Reclaiming a worktree LOOKS harmless, since
  `ensureWorktree` self-heals a missing checkout on the next turn, so sweeping a live task's
  checkout "works" while silently discarding its state. Two rules stop that: terminal-only (that
  predicate) and never over work (`worktreePruneSafety()`, refused in `lib/taskMove.ts`'s words, so
  a log line and a refused move say the same thing). The branch is always kept — a checkout is
  regenerable, a branch is the task's diff, and a fourteen-day silence is no evidence the diff is
  anywhere else — `lib/reclaim.ts` is the case where it demonstrably is. The sweep is OFF
  by default, unlike the table prune, whose 180/400-day windows are longer than most instances have
  existed; a window in weeks would start deleting on the first tick after an upgrade nobody asked
  for. The clear goes through `clearTaskWorktreePath()` rather than `updateTask`, which stamps
  `updated_at` — both the board's sort key and retention's clock — and a reclaim nobody asked for
  must not float a six-month-old task to the top of Done. The DISK WARNING is not gated on the
  sweep, since the instance that didn't opt in is the one that needs telling: measured each pass,
  logged while over `CALANDRIA_WORKTREES_DISK_WARN_GB`, served on `schedulerHealth()`, shown above
  the reclaim list in Settings → Storage. The ticker starts for it too.
- `lib/reclaim.ts` — LANDED → RECLAIMED, the definitive signal the sweep's clock stands in for.
  A merged PR (`pr_state`) and a local merge (`merged_at`) are one fact arriving two ways
  (`landedVia()`), so ONE path does the whole tail: fast-forward the local base from origin
  (`fetchBase` grew `force` — this runs BECAUSE something just landed, so the launch-time fetch
  is stale by definition), remove the worktree, delete the LOCAL branch (the remote one went
  with the merge: `mergeTaskPr` passes `--delete-branch`; a github.com merge instead needs the
  repo's `delete_branch_on_merge`, off by default), mark the task done. `maybeAutoReclaim()` is the
  silent-unless-`projects.auto_reclaim` trigger the three merge routes and `refreshPrState`
  call; `POST /api/tasks/[id]/reclaim` is the session header's button, and the only place the
  unsafe acknowledgement can be given. `worktreePruneSafety()` stays in the loop but is READ
  PER LANDING: uncommitted edits block both; `ahead > 0` blocks a local merge (mergeTask makes
  base a descendant, so those commits post-date it) and must NOT block a PR, since a squash
  leaves every landed branch permanently ahead and gating on it means the feature never fires.
  `unpushedCommits()` replaces it there — what the remote never received wasn't in what GitHub
  merged. Only the STATUS write stamps `updated_at`, and only when the reclaim is what moved
  the task to done; the columns go through `clearTaskWorktreePath()` for the sweep's reason.
  In `DYNAMIC_ONLY` (it sweeps dependents), which is why `lib/prState.ts` moved there.
- **Runbooks** (`lib/runbooks/store.ts`, `lib/dispatch.ts`, `app/shell/Runbooks.tsx`) are
  schedules with the clock taken off. A `runbooks` row is a saved prompt plus agent, permission
  mode, priority and send_context, and pressing Run MINTS A FRESH TASK (tagged `tasks.runbook_id`)
  exactly as a firing does. `fireSchedule`'s mint-and-launch tail was lifted into
  **`lib/dispatch.ts`** (`dispatchPromptTask`), so both paths share one preflight (project,
  `repo_path`, agent connected, `validatePrompt`), one worktree cut, one opening user message and
  one `startTurn`. What stays in `lib/scheduler.ts` is what makes a firing a firing: `claimRun` /
  `startRun` / `settleRun`, `next_fire_at`, the wall-clock stamp, `SCHEDULED_RUN_CONTEXT`. Two
  seams hold the extraction together: `onTaskCreated` fires between `createTask` and the launch, so
  the ledger link lands while the launch can still fail, and `DispatchResult` carries the task on
  FAILURE whenever the row was already minted, so a fallen-over launch is retryable and reaches the
  client instead of being stranded.

  `background_jobs` does NOT reach the dispatcher: it governs work nobody is watching, and a
  runbook is a button press. A dispatch correspondingly passes NO `RunContext`, so unlike a
  scheduled turn it may legitimately park on a permission card. There is also no run ledger and no
  counters. A schedule needs `schedule_runs` because an occurrence that never fired leaves no other
  trace, while a dispatch produces a visible task immediately, so "last run" is `lastRunOf()` over
  `tasks.runbook_id`, tie-broken on `rowid` (two dispatches in one millisecond really do collide,
  and `created_at DESC` alone would show the older run as the latest). Counters were rejected for
  lying the first time a minted task is deleted.

  **A schedule may point at a runbook** (`schedules.runbook_id`, resolved by
  `resolveScheduleRecipe`), so one recipe serves both triggers. The schedule's own columns stay
  populated as the fallback, and the editor writes the runbook's recipe into them on save. The
  hazard — unattended automation reading a mutable row — is made visible rather than prevented
  (both editors state the coupling), except for deletion: `deleteRunbook()` copies the recipe BACK
  into every linked schedule in one transaction before deleting, since `ON DELETE SET NULL` alone
  would leave a schedule with no prompt firing nothing every morning. A cross-project link is
  refused at save time and again at fire time, because a runbook is written against one repo's
  command registry.

  Agents get `create_runbook`, `list_runbooks` and `update_runbook` (`lib/runbookTools.ts`, shared
  by the Claude driver and the stdio bridge so the two can't drift) and no delete, since hard
  delete with no undo is the user's call. `update_runbook` is REFUSED for any runbook a schedule
  fires, naming them: the runbook analogue of `isInertSuggestion()`, touch what nothing has
  committed to. `created_by` is provenance shown on the card, not a tool parameter: both paths read
  the agent off the caller's own task row, so a model can't file under another agent's name. Live
  refresh rides `runbooks_changed`, a project-keyed global event alongside `task_deleted`; it skips
  `/api/events`'s re-read enrichment more completely than its siblings, since no task row is
  involved at all and its publishers key the bus with `""`.
- **Scheduled tasks** (`lib/scheduler.ts`, `lib/schedule/`) are the largest of **three**
  server-owned periodic tickers, and the only one `CALANDRIA_SCHEDULER` governs. The other two also
  launch turns, so turning schedules off does NOT mean nothing runs unattended.
  `lib/deferredStart.ts` sweeps `tasks.start_at` on its own `setInterval` at the same
  `SCHEDULE_TICK_MS`, launching or resuming each task queued for the usage-window reset; it is
  deliberately ungated, because it isn't a schedule and `CALANDRIA_SCHEDULER=off` must not silently
  disable a button the task hero offers. `lib/prState.ts` polls open PRs
  (`CALANDRIA_PR_POLL_MS`, self-stopping when none are open), and a merge it observes reaches
  `maybeAutoReclaim`, which can auto-start dependents. All three start from the one boot ping
  below. What rides the SCHEDULER's ticker launches nothing (retention prune, worktree sweep, disk
  warning), and the recap sweep that resembles one is a browser `setInterval`, so it does nothing
  with no tab open. A `schedules` row owns a prompt and a project; each firing MINTS A FRESH TASK
  (tagged `tasks.schedule_id`) and launches its first turn the way `lib/autoStart.ts` does.
  `lib/schedule/time.ts` is `Intl`-only
  wall-clock math: an IANA zone, never an offset, with both DST edges decided (a nonexistent wall
  time fires when the gap closes; an ambiguous one fires once, on the earlier pass).
  `UNIQUE(schedule_id, scheduled_for)` on `schedule_runs` is the durable claim that makes a double
  fire impossible across overlapping ticks, a Run-now race, or a restart. One sweep consumes the
  whole backlog: older slots are recorded `missed` and the newest fires once as `catch_up` if it's
  inside the window, never silently skipped.

  Scheduled turns carry a `RunContext` (`lib/runContext.ts`) marking them
  `interactionPolicy: "deny"`, so the permission gate settles instead of parking on the
  watcher-count heuristic, and the runner settles the run from its own `finally` and leaves
  `awaiting_input` at 0 on success. Otherwise every morning's run would file a permanent item in
  the "N need you" pill. Quiet is not invisible, though: a clean run rests on `tasks.unread_run_at`
  (issue #28), a mark OVER the status the way a snooze is, which the board draws as its own "Ran
  clean" group and which a status write (the card's Mark done) or the next turn's session opening
  clears. Without it a success landed on running=0 / awaiting_input=0 / `in_progress` and nothing
  ever moved it, so every firing left another permanent "In progress" row.

  The ticker — and the other two above with it — starts from a boot self-ping to
  `/api/instance/scheduler`, its own route because `/api/instance/services-restore` is PINNED
  SDK-free while the scheduler reaches the runner. The editor (`app/shell/Schedules.tsx`)
  validates a slash prompt against the project's real command
  registry before saving, via `POST /api/schedules/validate` (`lib/schedule/commands.ts`), since an
  unknown command is a SUCCESS at run time ("Unknown command: /x") and this is the only cheap place
  to catch it; `fireSchedule` re-checks at FIRE time, where an unknown command settles the run
  `failed` and mints nothing. The two must therefore agree: `slashCommandOf` returns null for a
  token followed by `/` (a path, so `/etc/passwd, tell me…` is an ordinary prompt), and the probe
  imports the driver's own `SETTING_SOURCES` rather than copying it, since validating against a
  different registry than the turn gets would fail a real command every morning. Save still never
  blocks: the probe reads one session's list and is a typo catcher, not an authority. It is also
  BOUNDED (`CALANDRIA_SCHEDULE_PROBE_MS`), because it runs inside the ticker's single-flight sweep
  and an unbounded read on a stalled CLI would leave `ticking` true forever, stopping every schedule
  on the instance with no error to show for it. Against that same failure, `schedulerHealth()`
  serves `lastTickAt`, `startedAt` and `tickMs`, which the card ages into a "looks stuck" banner.

  Two more places a schedule must not go quiet. A `claimed`/`running` run row orphaned by a crash is
  settled `interrupted` at DB init (`lib/db.ts`, beside the `tasks.running` reset), or it wedges
  overlap detection for ~50 occurrences. And `claimRun` treats ONLY a unique-constraint failure as
  "somebody else owns this slot"; anything else is logged and thrown rather than vanishing.
  `interactionPolicy: "deny"` covers asks as well as permissions: the Claude driver's
  AskUserQuestion hook and the bridge's `ask_user` both settle immediately as a decided permission
  card (that hook fires in EVERY permission mode, including `bypassPermissions`, so parking there
  was the one wedge even a bypassPermissions schedule couldn't dodge), and any such denial settles
  the run `failed`, because a turn that stopped short of the job must never report a green "ran".
- `lib/promptLimits.ts`, `lib/authFailure.ts` and `lib/approvalFailure.ts` — the *recoverable*
  turn failures, classified agent-agnostically from the error text. Each appends a durable notice
  to the persisted transcript line, which the UI matches verbatim to render one recovery button:
  `/clear` for context overflow, Reconnect for a dead login, Retry for an approval-policy block. A
  dead login additionally parks the pending queue, since every follow-up would fail identically,
  and flags the agent instance-wide (`agent_auth_broken_<id>` in `lib/agents/connections.ts`,
  relayed on `/api/events` as an `agent_auth` event) so the titlebar banner shows in every tab; any
  successful turn clears it. An approval block is Codex-specific in practice; the driver's
  self-heal is in `lib/agents/CLAUDE.md`.
- `lib/config.ts` — all per-instance config, env-driven with documented defaults.
  `lib/features.ts` — feature flags (env → `resolveFeatures()` server-side, `window.__FEATURES`
  client-side).
- Auth: `middleware.ts` gates every HTTP route, with no matcher on purpose. The provider is
  selected by `lib/auth/origin.mjs`: no-login local mode by default, Cloudflare Access when
  `CF_ACCESS_*` is set. **Both** modes have a browser-origin boundary, and they are different
  rules; `lib/auth/local-origin.mjs` holds both. Local mode pins the *target* — loopback and
  `PUBLIC_BASE_URL` are trusted, with explicit LAN origins via `CALANDRIA_ALLOWED_ORIGINS` — which
  is the DNS-rebinding defense a mode with no login needs.

  Access mode can't use a target allowlist (the tunnel hostname is unknowable and
  `PUBLIC_BASE_URL` is optional) and doesn't need one, since a rebound host produces no valid
  assertion. But the JWT proves identity, not *intent*: `CF_Authorization` is `SameSite=None`, so
  the edge stamps a valid assertion on whatever a hostile page made the victim's browser send.
  Hence `sameOriginWebSocketRequestAllowed` on upgrades, since a JWT-only gate hands a shell to a
  cross-site WebSocket hijack, **and** `sameOriginHttpRequestAllowed` in `middleware.ts`. CORS does
  not already cover the HTTP half; that was audited and disproved. `Request.json()` ignores
  Content-Type while `text/plain` is CORS-safelisted, so a preflight-free `no-cors` POST reaches
  every JSON route, `/api/tasks/[id]/messages` included, and many mutating routes ignore the body
  and act on the path alone (`/merge`, `/abort`, `/clear`, `/pr`, …), reachable by a bare
  cross-site form post. The HTTP rule is *narrower* than local mode's, rejecting only a
  present-and-mismatched Origin and never on `Sec-Fetch-Site: cross-site`, because cross-site
  navigations send no Origin and people really do link to a tunnel hostname;
  `tests/localOrigin.test.ts` pins that navigation case against being "fixed" into the strict
  version. `pty-server.js` mirrors the same mode-aware pair on top of its unforgeable loopback-peer
  check: it must not assume it's behind `server.js`, and it must not enforce the other mode's
  policy, a combination that killed the terminal on Access deployments with `PUBLIC_BASE_URL`
  empty. Threat model in `lib/cf-access.mjs`. Health, version and usage routes accept the shared
  `SERVICE_TOKEN` or the read-only `CALANDRIA_FLEET_TOKEN` instead; under Access that token is also
  what the in-container callers use, so `docker/entrypoint.sh` mints one when none is supplied.
- UI: `app/Shell.tsx` is the three-column shell (projects, tasks, live session), with the pieces in
  `app/shell/` (`useTaskStream.ts` owns the one-EventSource-per-task logic; `SessionRail.tsx` the
  DIFF / PREVIEW / CONTEXT tabs). `app/Terminal.tsx` is xterm.js over the `/pty` proxy.
  `TerminalDrawer` (`Layout.tsx`) opens in the project's `repo_path` and carries a Project/Task
  segmented toggle that re-roots the shell in the selected task's `worktree_path`: a real shell in
  the checkout a task's changes live in, so tests can run against them before the merge. The scope
  is a **pin**, not a derivation from the selected task, because `TerminalView` tears down and
  respawns the shell whenever its `cwd` changes, so deriving it would kill a running `npm run dev`
  every time the user clicked a different task card. The Task button is disabled until the task HAS
  a worktree (cut on the first turn), which is why `worktree_path` is on the client's `TaskRow`;
  `listTasks` selects `t.*`, so it was already on the wire.

### Scope

`skills/` ships agent skills to USERS' projects, installed by `scripts/install-skills.sh` into
`~/.claude/skills` and `~/.agents/skills`, or into a target repo. `.claude/skills/` is this repo's
own tooling for people developing Calandria. Don't cross them.

This repo is the whole product: self-hosted only, with no control plane behind it. Don't add
hosted, fleet or billing features, or first-party identity; the only auth modes are the two in
`lib/auth/`. Site-specific CLIs and config are an end user's concern, layered on the published
image the way `examples/overlay/` shows, not merged in here.

### Where data lives

| What | Where |
|-|-|
| DB (projects, tasks, transcripts, summaries) | `calandria.db` in `CALANDRIA_DB_DIR` (default `~/.calandria`; a pre-rename `~/.zen-orchestrator/orchestrator.db` is kept in place, never moved — `lib/storage.mjs`) |
| Per-task git worktrees | `CALANDRIA_WORKTREES_DIR` (default `~/.calandria/worktrees`; a populated legacy `~/.agent-orchestrator/worktrees` is kept, since git pins absolute paths), always **outside** every repo |
| Cloned project repos | `CALANDRIA_PROJECTS_DIR` (default `~/projects`) |

## Codebase graph

A graphify knowledge graph of this repo (~2,700 nodes) lives in the main checkout at
`/home/penmoid/repos/calandria/graphify-out/graph.json`. `graphify-out/` is gitignored, so task
worktrees never contain it; always pass the absolute path. For architecture, "what calls X" or
"where does Y live" questions, query it before grepping or reading files:

```bash
graphify query "<question>" --graph /home/penmoid/repos/calandria/graphify-out/graph.json
```

(`explain "<node>"` and `path "A" "B"` take the same `--graph` flag.) Post-commit and
post-checkout hooks in the main checkout rebuild it on every commit there, so it tracks main.
Unmerged worktree changes aren't in it; verify locations against your working tree before editing.

## Conventions & gotchas

- **Env-driven, zero code edits per instance.** Every per-instance knob is an env var with a
  documented default. Add new ones to `lib/config.ts` (or `lib/features.ts` for flags) **and**
  `.env.example`. `server.js` and `pty-server.js` can't import TS, so they read the same env names
  directly; keep the names in sync.
- **Plain-Node entrypoints stay plain.** `server.js` is CommonJS, so anything it needs from `lib/`
  must be `.mjs` and dynamic-imported, and every such `.mjs` file must be COPY'd into the runtime
  image in the `Dockerfile`. Next's build output doesn't include them, and this has bitten before.
- **`next.config.mjs` stays JS**, not TS: prod containers prune dev deps and a `.ts` config needs
  the `typescript` package at runtime.
- **HMR-surviving server state lives on `globalThis`** — `lib/events.ts`, `lib/abort.ts`,
  `lib/asks.ts` and `lib/services.ts` all follow this pattern. Single Node process, no external
  queue or broker.
- **Long work is a detached background job, never a held HTTP request** (turns, context refresh,
  services). Anything multi-minute must survive page reloads and tunnel drops. Only live turns
  register in `lib/abort.ts`, so that is all a sleep daemon or the shutdown drain can see.
- **Native modules** (`better-sqlite3`, `node-pty`) and the Agent SDK are in
  `serverExternalPackages`; don't let Next bundle them. `postinstall` fixes node-pty's exec bit.
- **Don't import `lib/agents/registry.ts` from a low-level module.** The agent SDKs are ESM
  externals, which Turbopack compiles async, and async-ness propagates to every transitive
  importer, so a route entry compiled sync then reads every export back as `undefined` (this
  500'd `/api/services/grant` in prod). Modules that only need capability data or agent **ids**
  import `lib/agents/capabilities.ts` (`getCapabilities` / `listAgentIds` / `isAgentId`) instead.
  `tests/importGraph.test.ts` pins the SDK-free set; add new low-level modules to its `PINNED`
  list.

  **A module that launches turns but is reached from ordinary route entries must reach the runner
  through `await import()`, not a static import** — `lib/autoStart.ts` and `lib/deferredStart.ts`,
  pinned by the same test's `DYNAMIC_ONLY` list. Sync-compiled route entries are the whole hazard
  (`PATCH /api/tasks/[id]` and the internal agent-tools routes call the auto-start sweep), and a
  dynamic import resolves the namespace regardless of propagation. Same reason
  `/api/instance/scheduler` loads `lib/scheduler.ts` that way.

  **And nothing behind `registry.ts` may import a launcher back, dynamic edges included.** The
  Claude driver's tool callbacks used to `await import("../../autoStart")`
  (`autoStart → runner → registry → claude/driver → autoStart`). Turbopack counted the cycle even
  though the edge was dynamic, stopped propagating async-ness into `autoStart`, and emitted sync
  factories reading `startTurn` off a pending Promise, so EVERY auto-start died with "startTurn is
  not a function" in prod while dev and vitest stayed green. The driver now takes what it needs as
  an injected callback (`TurnHooks` in `lib/agents/types.ts`: every `startTurn` /
  `startResumeTurn` caller passes `AUTO_START_HOOKS`, and the tool callback reports a cleared
  blocker instead of sweeping it), so the graph is a DAG, pinned by the acyclicity case in
  `tests/importGraph.test.ts`. Only the built server shows this class of bug, so the behavioral
  regression test is an e2e (`e2e/04-turn-behaviors.spec.ts`).
- **Tests are hermetic.** `tests/setup.ts` points `CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR`
  at tmp dirs and pins git config *before the module graph loads*, since config is read at import
  time. Use `tests/helpers.ts` for git fixtures. New env-read-at-import config the suite depends on
  must be set there too. Platform-dependent spellings (`NUL` versus `/dev/null`, a shell the pty
  sidecar can spawn, a tree kill, `onPosix` for a case that pins POSIX semantics) come from
  `tests/platform.ts`; don't re-derive them per file. Env that only a fork or one machine needs
  goes in `tests/setup.local.ts`, an optional second `setupFiles` entry, gitignored and absent from
  a clean checkout, layered on top by `vitest.config.ts`. That's the seam a downstream repo uses
  instead of forking `tests/setup.ts`.
- **Delete is hard delete** throughout: no soft-delete, no undo.
- **Auth is layered.** Next middleware for HTTP, `server.js` for WebSocket upgrades, per-service
  visibility for public service hostnames. Both Cloudflare Access mode and no-login local mode
  have an origin boundary; keep `lib/auth/local-origin.mjs` shared rather than letting the HTTP and
  WebSocket policies drift. When adding a route or upgrade path, decide which gate covers it.
- **Commits are detailed** and explain the why. **Keep `README.md` current** with app state when
  behavior changes. Markdown tables use minimal separators (`|-|-|`).
- **A push isn't done until its CI runs conclude.** Watch to terminal state, diagnose red before
  rerunning, and file an issue for anything CI-broken. Full policy in `.github/CLAUDE.md`.

## More detail

`README.md` (product overview and quick start) · `docs/` (features, agents, services,
self-hosting, architecture) · `.env.example` (every env var, documented) ·
`lib/agents/CLAUDE.md` (per-driver detail, loaded when you open that directory).

**Before adding to this file, read `docs/CONTEXT_BUDGET.md`.** This file is 21,348 measured
tokens, loaded into every session in this repo before any code is read, so new material belongs in
the nearest directory-scoped `CLAUDE.md` unless you need it before you'd open that directory. Don't restate `docs/` prose here; that duplication has already
drifted.
