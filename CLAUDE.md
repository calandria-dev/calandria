# CLAUDE.md

Calandria is a local-first web app that runs many coding-agent sessions in parallel across
several projects from one screen. A **project** carries reusable context and a working
directory. A **task** is one agent session in its own git worktree, run against the user's local
Claude or Codex login. It never uses an API key.

## Commands

- `npm run dev`: app (:3000, `server.js`) plus the pty sidecar (:3001, `pty-server.js`) via
  concurrently. `npm run dev:next` and `npm run pty` run them separately.
- `npm run build` (turbopack), then `npm start` for production.
- `npm test`: vitest, serial on purpose: tests spawn many real git subprocesses. Single file:
  `npx vitest run tests/merge.test.ts`.
- `npm run test:e2e`: Playwright. Builds, then boots the real prod server against a hermetic
  temp instance with the deterministic mock agent (`lib/agents/mock/`, registered only when
  `CALANDRIA_E2E_MOCK_AGENT=1`), and drives onboarding → project → task → turn → diff → merge
  through the UI. `npm run preflight` = unit + e2e, the pre-push gate. `e2e/README.md` has the
  mock-turn directives, selector conventions, and the staleness gotcha: the server runs the
  **built** bundle.
- `npm run typecheck`: `next typegen && tsc --noEmit`, a few seconds. CI runs it as its own job
  (`.github/workflows/test.yml`). The `next typegen` half writes the gitignored `next-env.d.ts`
  and `.next/types` that `tsconfig.json` includes, so a clean tree checks the same files
  `next build` does, including the generated validator that pins every App Router handler to its
  route.
- **Tests in a container**: `npm run test:docker`, `typecheck:docker`, `test:e2e:docker` and
  `preflight:docker` run those scripts inside a Linux Node 22 image (`docker/test/Dockerfile`,
  driven by `scripts/docker-test.sh`). A file path passes through
  (`npm run test:docker -- tests/merge.test.ts`), but a vitest **flag** needs a second `--` or npm
  eats it: `-- -- tests/merge.test.ts -t "conflicts"`. A task worktree has no `node_modules` and
  the main checkout's is macOS-built, so the container installs its own into a shared named
  volume: one cold install, reused by every later run. `e2e/README.md` has the recipe: don't
  borrow node_modules, don't build on the Playwright image (Node 24, no `better-sqlite3`
  prebuild), and the `fatal: not a git repository` red herring. `.claude/skills/running-tests/SKILL.md`
  is the operating summary a session loads on demand.
- No lint script. TypeScript is strict, path alias `@/*` → repo root (mirrored in
  `vitest.config.ts`).

## Collecting context

Past two read-only Bash commands in a row, send the third to a synchronous collection subagent,
asking only for conclusions and `file:line`s. `buildProjectContext()` in
`lib/agents/shared.ts` enforces the same rule for every project on the instance; this section is
what only this repo knows.

Four dispatches this repo has already needed:

- *"Grep `project.branch` and `proj.branch` across `lib/` and `app/`. Report every call site as
  `file:line` with its enclosing signature and one line on what it assumes about the base branch."*
- *"Trace `withdraw_suggestion` through all five wiring points: `lib/agentToolDefs.mjs`,
  `lib/agentTools.ts`, `app/api/internal/agent-tools/`, the Claude driver's registration,
  `scripts/calandria-mcp.mjs`. Report `file:line` for each and the exact shape a new tool copies."*
  This is the template for adding any agent tool.
- *"Find every place `running` or `awaiting_input` renders a status dot, spinner or label across
  `app/shell/` and `lib/`. Report `file:line` plus the condition each tests."*
- *"Read `docs/DESKTOP_APP.md` and `docs/DESKTOP_E2E.md` in full and report which of openbox,
  dbus-x11, xdotool and dunst are installed on this host."*

This does not license a cheaper proxy for actually running something. If the answer is a
measurement (how many cases a file declares, which test is slowest, whether a build passes), run
it and read the number; static counting gives a different and wrong answer. A worktree has no
`node_modules`; installing them is part of the job.

Waiting is not delegation. Use `Bash(run_in_background)` and wait for the notification, or
`Monitor` for a stream, instead of polling a backgrounded run with repeated `tail`/`grep`.

## Architecture

Three processes and entrypoints, one origin:

- **`server.js`**: custom Next.js server, plain Node and CommonJS. Fronts Next on one port,
  proxies `/pty` WebSocket upgrades to the sidecar, forwards dev HMR upgrades to Next, enforces
  origin auth on WebSocket upgrades, and dispatches public service hostnames
  (`<slug>--<appHost>`) through `lib/service-router.mjs`. Middleware never sees upgrades, so this
  file is the auth boundary for the terminal.
- **`pty-server.js`**: node-pty sidecar, bound to `127.0.0.1` only, never exposed directly.
- **Next app**: UI in `app/`, REST under `app/api/`, server logic in `lib/`.

### The turn lifecycle

- `POST /api/tasks/[id]/messages` calls `startTurn()` (`lib/runner.ts`) and returns; the turn runs
  detached, owned by the server process. Every event persists to SQLite and fans out through
  `lib/events.ts`, an in-process pub/sub keyed by task id plus a wildcard channel
  (`subscribeGlobal()`) for every task's events.
- `GET` on the same route is the SSE watch stream: a `snapshot` of the persisted transcript, then
  a live tail. Reconnect-safe, any number of viewers, fine with zero. Stopping is only ever
  explicit (`lib/abort.ts`).
- If a turn is already running, POST parks the message in `pending_messages`. The exception is a
  **LINGERING** turn (model done, session held open for background work or a wakeup): the wait is
  unbounded, and `sendToLingeringTurn()` hands the message to the driver's open prompt iterable via
  `lib/turnInput.ts` (registered per turn, SDK-free; `send` returning false means queue it
  instead), landing as an ordinary user message that starts the next turn. Entering a linger drains
  the oldest parked follow-up first, and a send is refused while anything is still queued. The
  driver drops `lingering` in the same tick it accepts a message, so the injected turn's bare
  `init` is never announced as a wakeup firing. An optional linger deadline exists and re-anchors
  when a message is accepted into the lingering session.
- Worktree isolation is guaranteed by the runner, not by its callers: `startResumeTurn()` runs the
  same `ensureWorktree` self-heal as both first-turn launch paths (POST /messages and
  `lib/autoStart.ts`), since a turn can also reach the runner through the queue drain in `run()`'s
  finally. An empty `worktree_path` there falls the driver back to `project.repo_path`
  (`tests/queueDrainWorktree.test.ts`).

### Live updates without polling

- Only the selected task has a transcript stream open. `GET /api/events` is one always-open
  EventSource per tab (`app/shell/useGlobalEvents.ts`) broadcasting coarse lifecycle events for
  every task across every project: turn started, awaiting input, answered, suggestion created,
  turn ended, a task's fields edited elsewhere. This drives spinners, project badges and the "N need
  you" pill. There is no task-list polling.
- Each payload re-reads the task row at publish time; the runner persists before it publishes, so
  the snapshot is authoritative (`tests/agentDriver.test.ts`). A `suggested` event carries the
  project the task was filed INTO, since `suggest_task` can target any project. Project-wide facts
  with no one row to re-read (`task_deleted`, `tasks_moved`, `runbooks_changed`, `tags_changed`)
  carry their own project id and short-circuit the re-read.
- Task order is not stored. `listTasks` sorts `updated_at DESC`, then `created_at`, then `rowid`
  (a planning turn files its whole batch inside one millisecond). `tasks.position` still counts up
  per project and the move paths still renumber it, but nothing renders it: there is no manual
  board order, `reorderTasks`, `POST /api/tasks/reorder` or `tasks_reordered` event, and a board
  drag writes only the status its column implies. `position` stays on the client's `TaskRow`
  because `topoMembers` tie-breaks a tag's steps by it, so "step 3 of 7" doesn't renumber on every
  run.

### The agent seam

- **`lib/agents/`** talks to coding agents only through the `AgentDriver` interface (`types.ts`):
  a normalized `StreamEvent` turn contract, one-shot summarize/draft/recap helpers, a capability
  descriptor, a login/verify auth surface. Only `runTurn()` is required. `getDriver(task.agent)`
  (`registry.ts`) resolves a driver (`tasks.agent`, defaulted from `projects.default_agent`;
  unknown ids fall back to Claude). `shared.ts` holds agent-agnostic normalizers (project-context
  and conflict prompts, tool-call to title/peek/diff, the event queue). Session/thread ids are
  opaque per driver: `sessions.claude_session_id` stores any driver's id.
- Three drivers ship, all registered unconditionally: `lib/agents/claude/` (Claude Code, via
  `@anthropic-ai/claude-agent-sdk`), `lib/agents/codex/` (OpenAI Codex, via `@openai/codex-sdk`
  spawning the `codex` CLI), `lib/agents/gemini/` (Antigravity/Gemini, spawning the `agy` CLI, no
  SDK). Non-Claude drivers get the same Calandria tools plus `ask_user` through the stdio MCP
  bridge `scripts/calandria-mcp.mjs` → `/api/internal/agent-tools/*`; the bridge polls a `wait`
  endpoint for the answer (`lib/agentTools.startAskUser`). Claude can be put on that same bridge
  (`CALANDRIA_CLAUDE_TOOL_TRANSPORT=stdio`) and is then the only agent withheld `ask_user`, having
  its own. `lib/agents/CLAUDE.md` holds per-driver detail: permission modes, model catalog and
  Vertex corrections, MCP inheritance, one-shot isolation, slash-command discovery, adding another
  agent.
- A task is a lineage of sessions: `/clear` ends generation N, condenses its transcript to a
  summary, and generation N+1 starts fresh seeded with all prior summaries.
- Internal jobs run through `lib/agents/oneshots.ts` under two routing policies. Task-scoped work
  (`/clear` summarization) follows the task's own agent. Project-scoped work (recap, "Refresh with
  AI") runs the utility agent, resolved connected-first: `utility_agent` setting if connected, else
  app default, else built-in default, else any connected agent; nothing connected raises an
  actionable error. Unattended work is gated by `background_jobs` (default on), recap scheduling
  additionally by `recap_mode` (`automatic` default, `on_open`, `off`); explicit `/clear`, Refresh
  with AI and manual recap still run regardless. A driver missing a helper is backstopped by the
  utility agent. Every one-shot funnels through one `run()` wrapper that records the agent and
  model that actually ran it plus `fallback` via `addInternalUsage()`. `resolveUtilityAgent()`
  reports the same resolution without throwing, for `GET /api/agents` to show Settings the
  effective agent and its `(fallback)` hint.
- Agent choice is connected-first everywhere: the first-run wizard requires an agent, not
  specifically Claude (`completeOnboarding` in `lib/onboarding.ts`); new tasks pick their agent via
  `defaultAgentFor()` (`app/shell/agents.ts`) and `resolveConnectedAgent()` (`lib/agentTools.ts` in
  `suggest_task`); idle, unstarted tasks can still switch before their first session fixes the
  driver lineage. AI conflict-resolution turns send `buildConflictPrompt()` output as an ordinary
  message through `startTurn()`.

### The permission gate

- Under every mode but `bypassPermissions`, the SDK's `canUseTool` is a real gate: a read-only
  allowlist, then the project's remembered Bash rules (`permission_rules`), then a permission card
  that parks the turn on the user via `lib/asks.ts` and `/answer`. Every non-answer path denies
  (Stop, expiry, unwatched turn, unparseable answer), and an unattended auto-deny parks the
  pending queue.
- `lib/permissionPrompt.ts`'s `promptPermission()` is the one gate implementation, called by both
  drivers: Claude's `canUseTool` and Codex's app-server approval requests
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`). Each driver only translates the verdict into its own
  protocol's answer shape (`PermissionResult` for Claude; accept / acceptForSession / decline /
  cancel for Codex) and passes in what only it knows (Claude's `blockedPath` and the CLI's
  `suggestions` payload; an explicit session-scoped grant for Codex). `lib/permissions.ts` stays
  pure underneath the prompt module.
- Rules are minted from the card, or by typing one into Settings → Run defaults
  (`POST /api/settings/permissions`). The typed path runs the same `prefixVerdict()` the card uses
  and stores what it returns, never the raw typed line. A refused prefix is a 400, not a downgrade
  to `bash_exact` (the card can fall back and show the fallback rule; a form can't), and the
  refusal carries the reason. `ruleMatches()` goes through `bashCommandOf()`, so a rule naming any
  tool other than Bash never matches a call.
- Refusals the CLI makes without calling `canUseTool` are handled by the Claude driver and land as
  an already-decided card on the transcript row (`lib/agents/CLAUDE.md`).
- The gate also runs BEFORE the turn (`lib/settingsDrift.ts`, issue #43). Files a driver names in
  `watchedSettingsFiles` (`<worktree>/.claude/settings.json` for Claude) are re-read from disk
  every turn, since `hooks` run shell commands outside `canUseTool` and `permissions.allow`
  approves calls with no gate call at all. Turn N could write what turn N+1 obeys, and so could the
  base-branch catch-up. The runner hashes each file before `runTurn`; a moved
  hash parks the turn on a `PermissionRequest` (`kind: "settings"`) through the same registry and
  `/answer` route. Approving adopts the new version as baseline (`task_settings_snapshots`);
  declining ends the turn before the agent starts and flags the task. A first sighting is recorded
  silently; an unattended or scheduled run refuses outright on drift.

### Agent tools (`lib/agentTools.ts`)

- `suggest_task` takes an optional `project` (id or exact name, from `list_projects`) and files
  into any project. `resolveTargetProject()` refuses an unrecognized value outright. It never
  falls back to the calling project. It resolves before the insert, so agent, `send_context`
  and position come from the target. `blocked_by` follows the target too (unusable refs reported
  back, not dropped). The `suggested` event carries `suggestedProjectId` and the id of the created
  task; the runner settles that id onto the `suggest_task` tool row, and `Transcript.tsx` renders a
  **suggestion card** there with the tray's own Start/Add/Dismiss.
- Only the two ids persist (`ToolData.suggestion`); the card's state is re-read per render via
  `GET /api/tasks/[id]/suggestion`, so a reload always shows the current state (*Session started*,
  *Added*, *Withdrawn*, or *no longer exists*) and never double-offers Start or 404s on a
  Dismissed row. Start is withheld for a suggestion filed into a different project; that card
  names the target project and offers only the two actions that don't navigate.
- Correlation is by the tool's own `name` (on the `tool` StreamEvent and `ToolData`, not the
  re-wordable title), matched as a substring in `lib/suggestionCard.ts`
  (`mcp__calandria__suggest_task` in-process, `calandria__suggest_task` over the bridge). A
  parallel batch settles one card per call in memory; the stdio bridge's endpoint has no tool_use
  id, so it patches the newest unclaimed `suggest_task` row instead.
- **Every tool answers through `lib/agentToolGuard.mjs`; adding one must not opt out.** It rewrites
  a throw, an over-long call, or a blank result into a sentence naming the tool, and passes a
  healthy answer through untouched, so an empty result can never read as a quiet success. Applied
  to the whole tools array in the Claude driver and to `registerTool` in the bridge, from one
  `.mjs` copy. Bound by `CALANDRIA_AGENT_TOOL_TIMEOUT_MS` (10 min; 0 for `ask_user`, which waits on
  a human), since the CLI's own per-call MCP timeout defaults to ~27.7 hours. `create_pr` names its
  PR by number and URL, the only way a session records in git that its work is finished.
- `list_tasks` takes the same optional `project` and flags the caller `current: true`; `get_task`
  reads any id, defaulting to the session's own.
- `update_task` writes any task in any project: the caller's own row by default, or any other,
  including ones the user accepted or started. The only refusal is `running=1`. Writes to another
  task record in `task_agent_edits` (per-field before/after), stamp `agent_edited_at`, and surface
  a "Changed by agent" chip with per-edit Revert (`GET`/`POST /api/tasks/[id]/agent-edits`). Covers
  title, description, priority and status minus `cancelled` (own row would `abortTurn()` the
  caller; another row needs a reason, via `withdraw_suggestion`). Does not carry the project;
  re-parenting is `move_task`.
- `update_task` also covers `blocked_by`, the only way an agent can order a plan: `suggest_task`
  can't take it (the ids don't exist yet at filing time), so the recipe is file every task, wait
  for ids, then `update_task` per dependent (`buildProjectContext()` spells this out). Two things
  differ from `suggest_task`'s version: refused on the caller's own row (names `on_hold`, since a
  running session gating its own start would be inert and a lie), and an unusable ref fails the
  whole call, named one at a time with its reason (not an id, another project, or the task itself).
  It is never partitioned and reported the way `suggest_task` handles refs. A cycle refuses
  everything; `setTaskDeps` runs before the
  row patch so a rename in the same call can't land under a no-op refusal.
- `updateTaskForAgent()` owns this whole policy so the two callers (Claude driver, bridge endpoint)
  can't drift. The caller is always trusted (the Claude driver closes over its own task id; the
  bridge's endpoint reads `CALANDRIA_TASK_ID`), while the target is always taken as the model's
  word for it, which is why the caller's own row and an arbitrary target task get different
  treatment above. It re-reads both rows first (a detached turn's snapshot can be stale) and the
  check and write share one synchronous block. It publishes `task_edited` against the target and returns
  an `autoStartDependents` flag. It does not call `maybeAutoStartDependents()` itself, since
  `lib/autoStart.ts` reaches the runner while `lib/agentTools.ts` is pinned SDK-free.
  `tests/codexUpdateTaskPolicy.test.ts` runs the real stdio bridge against the real endpoint and
  asserts on the DB.
- `move_task(tasks, project)` re-parents tasks (issue #24) via `lib/taskMove.ts`, the board's own
  operation. It is a SET operation: a `blocked_by` edge survives iff both ends move together,
  chains go whole, dropped edges are named. It takes no discard acknowledgement: the bulk route
  demands those as lists of ids, never a boolean (a boolean sent instead is ignored and falls back
  to the ordinary per-task refusal), and started/mid-turn tasks are refused per task while the rest
  move. `moveTasks`' `resetCheckout` (a `Set`) does double duty: it waives the started-task refusal
  AND clears the worktree columns together, since as one flag over a batch an unanswered started
  task would otherwise move with its columns cleared and its worktree orphaned in the repo it left.
  `GET /api/tasks/move?ids=…` (`previewDiscards`) puts a cost beside each row before it's ticked;
  it runs sequentially, a pair of git subprocesses per STARTED task, since nothing without a
  checkout touches git. A row that picks up unsaved work after its preview is refused by the
  teardown's re-read and reported in the response's `skipped` field. A move off an accepted row is
  recorded like an `update_task` edit under a `project` field; Revert re-runs the move backward.
  It never writes `project_id` directly.
- `withdraw_suggestion(task, reason)` is the retraction verb, on the same `isInertSuggestion()`
  screen `update_task` uses. `reason` is required and non-empty. Not a delete: the row goes
  `cancelled` with `suggested` left at 1, struck through with `tasks.withdrawn_reason` shown and
  sorted below live ones. `PATCH /api/tasks/[id]` clears the reason and the cancelled status
  together on revival, since all three ways back (tray, board drag, edit dialog) would otherwise
  each need to remember both halves.
- `blocks()` counts `cancelled` as terminal, and `maybeAutoStartDependents()` fires on any
  non-terminal → terminal transition (not just into `done`), from both the tool and the
  user-facing PATCH, so cancelling the last blocker in the UI can start an `auto_start` dependent.

### Key modules (by responsibility)

- `lib/db.ts`: SQLite schema and migrations, single shared connection, WAL. `lib/store.ts`:
  typed queries. `lib/types.ts`: shared types.
- `lib/abort.ts`: the live-turn registry and liveness signal; outranks `tasks.running`, which can
  be stale after a restart mid-turn. `activeTurnCount()` feeds `calandria_turns_active`
  (`lib/metrics.ts`); `activeTurnIds()` is what `drainActiveTurns` (`lib/runner.ts`) aborts on
  graceful shutdown.
- `lib/db-lock.mjs`: enforces one app process per database via a kernel file lock (`BEGIN
  IMMEDIATE` on `calandria.lock.db`, held RESERVED for the connection's life, released by the OS on
  SIGKILL), claimed by `server.js` before `app.prepare()`, never by `getDb()`. The lock file is
  named after the database it guards, so a pre-rename `orchestrator.db` is guarded by
  `orchestrator.lock.db` and an older build still running isn't missed.
  `CALANDRIA_DB_LOCK_WAIT_MS` (10s) covers a predecessor still shutting down. `recoverFromCrash()`
  clears a dead predecessor's running flags, `pending_messages`, unanswered permission cards and
  `claimed`/`running` schedule runs at boot, gated by `consumeDbRecoveryAuthorization()` (true at
  most once, only for a database this process claimed, never under vitest or `next build`) so it
  can't wipe a live second instance. `locking_mode = EXCLUSIVE` is not layered on top: it retains
  SHARED after a failed write, which could deadlock two racing processes out of the upgrade, and
  held RESERVED already excludes every other writer. A separate lock file, not `calandria.db`
  itself, keeps a read-only `sqlite3` inspection working and leaves WAL alone; the holder's pid and
  host are a best-effort JSON sidecar for the error message only, never used to decide ownership.
  `CALANDRIA_DB_LOCK=off` still authorizes recovery, and is read only by the acquire call so a
  stray env var during a build can't authorize a wipe. Stated limit: this coordinates processes
  sharing a kernel, so two containers on one shared volume may not see each other's lock, already
  an unsafe configuration since WAL needs shared memory.
- `lib/git.ts`: per-task worktrees and branches, diffs, merge (`mergeTask`,
  `prepareWorktreeMerge`/`completeWorktreeMerge`/`abortWorktreeMerge`), base-branch sync
  (`worktreeSyncStatus`/`fastForwardWorktree`), and the app's only network git (`fetchBase`,
  `remoteBaseStatus`, `advanceBaseBranch`, `pushBaseBranch`, plus `createTaskPr`'s push in
  `lib/github.ts`). Fetching is best-effort: hard timeout, no interactive prompting, per-repo
  cooldown, outside the repo lock. New worktrees cut from the fetched remote tip are pinned to a
  SHA when local base is behind it. The user's local base branch only ever moves forward, never
  forced, only on an explicit click or a pre-merge tidy-up.
- `lib/taskMove.ts`: re-parents tasks, shared by the single (`POST /api/tasks/[id]/move`, 409 on
  refusal) and bulk (`POST /api/tasks/move`, per-task refusal report) routes. Owns the eligibility
  screen (`hasTurn`), the sorted `withTaskLocks` acquisition that makes it atomic with the write,
  the worktree teardown that lets a started task move, and the `tasks_moved` event. `discard_worktree`
  and `discard_unsafe` acknowledgements are re-read at teardown, never taken from the move preview,
  and bulk requires them as lists of ids (never a flag, so a caller can't consent for a batch with
  one boolean). `canPick` in `TasksColumn.tsx` gates only on `running`.
- `lib/services.ts`, managed-services supervisor: shell-spawned child process trees, log ring
  buffers, SSE status. `lib/processTree.ts`: kill, liveness and recycled-pid guard for those
  trees, across two OS mechanisms: POSIX process groups versus win32 `taskkill`.
  `lib/service-router.mjs`/`lib/service-host.mjs`: the public service-hostname reverse
  proxy and host/token helpers.
- `lib/runbooks/store.ts`: runbook CRUD and delete-detaches-linked-schedules. `lib/runbookTools.ts`
  is the agent-tool policy behind `create_runbook`/`list_runbooks`/`update_runbook`; both DB-only,
  in `tests/importGraph.test.ts`'s `PINNED` set. `lib/dispatch.ts` is the
  mint-a-task-and-launch-its-first-turn core shared by runbooks and the scheduler; reaches the
  runner, so not pinned.
- `lib/contextRefresh.ts`: "Refresh with AI" as a detached background job polled via GET.
  `lib/tagRefresh.ts`: same shape for a tag, but applies its outcome (task edits go through
  `lib/agentTools.ts` as revertable edits) instead of drafting one. `lib/recap.ts`: the staleness
  and activity sweep. All three are project-scoped one-shots on the utility agent
  (`lib/agents/oneshots.ts`).
- `lib/retention.ts`: scheduled prune of tables that would otherwise grow forever, on
  `lib/scheduler.ts`'s ticker. `prunableTaskIds()` is the whole policy: terminal, idle, unsnoozed,
  no parked follow-up, no in-flight schedule run, cold by `updated_at`. Never prunes the session
  `tasks.session_id` names or `summaries`. Reclaim runs `wal_checkpoint(TRUNCATE)`. Windows,
  defaults and opt-in `VACUUM` are in `docs/SELF_HOSTING.md`. The shared ticker in
  `lib/scheduler.ts` starts when EITHER the scheduler or retention is enabled, since an instance
  that turned scheduled work off still wants its disk swept.
- `lib/worktreeSweep.ts`: same prune policy for checkouts, reusing `prunableTaskIds()` with a
  separate cutoff (`CALANDRIA_WORKTREE_RETENTION_DAYS`, 14), gated terminal-only and never over
  work (`worktreePruneSafety()`). The branch is always kept. Off by default. Clears via
  `clearTaskWorktreePath()`, never `updateTask` (which stamps `updated_at`). The disk warning is
  not gated on the sweep: logged over `CALANDRIA_WORKTREES_DISK_WARN_GB`, served on
  `schedulerHealth()`, shown in Settings → Storage.
- `lib/reclaim.ts`: LANDED → RECLAIMED. A merged PR (`pr_state`) or a local merge (`merged_at`)
  both reach `landedVia()`, then one path fast-forwards local base from origin (`fetchBase` with
  `force`), removes the worktree, deletes the local branch, marks the task done. The remote branch
  is deleted by the merge itself, not by reclaim: `mergeTaskPr` passes `--delete-branch`, while a
  plain github.com merge instead needs the repo's `delete_branch_on_merge` setting (off by
  default).
  `maybeAutoReclaim()` fires silently on `projects.auto_reclaim`;
  `POST /api/tasks/[id]/reclaim` is the manual button and the only place the unsafe
  acknowledgement is given. `worktreePruneSafety()` blocks a local merge on `ahead > 0` but must
  not block a PR (a squash leaves the branch permanently ahead); `unpushedCommits()` is used
  there instead. Only the status write stamps `updated_at`. In `DYNAMIC_ONLY` because it sweeps
  dependents; `lib/prState.ts` is there for the same reason.
- `lib/runbooks/store.ts`, `lib/dispatch.ts`, `app/shell/Runbooks.tsx`: a `runbooks` row is a
  saved prompt plus agent, permission mode, priority, send_context; pressing Run mints a fresh task
  (`tasks.runbook_id`) via `dispatchPromptTask`, the same preflight and launch a schedule firing
  uses. `background_jobs` does not gate a dispatch, since it's a button press, so it may park on a
  permission card. "Last run" is `lastRunOf()` over `tasks.runbook_id`, tie-broken on `rowid`.
  `schedules.runbook_id` (`resolveScheduleRecipe`) lets a schedule point at a runbook; the
  schedule's own columns are the fallback and the editor copies the runbook's recipe into them on
  save. `deleteRunbook()` copies the recipe back into every linked schedule before deleting, since
  `ON DELETE SET NULL` would leave the schedule firing nothing. Cross-project links are refused at
  save and fire time. Agents get `create_runbook`/`list_runbooks`/`update_runbook`
  (`lib/runbookTools.ts`) and no delete; `update_runbook` is refused for any runbook a schedule
  fires. `created_by` is read off the caller's own task row, never a parameter. Live refresh rides
  `runbooks_changed`.
- `lib/scheduler.ts`, `lib/schedule/`: the largest of three server-owned periodic tickers, the
  only one `CALANDRIA_SCHEDULER` governs (turning it off does not stop the other two).
  `lib/deferredStart.ts` sweeps `tasks.start_at` on its own `setInterval` at `SCHEDULE_TICK_MS`,
  ungated. `lib/prState.ts` polls open PRs (`CALANDRIA_PR_POLL_MS`, self-stopping when none are
  open) and feeds `maybeAutoReclaim`. Retention prune, worktree sweep and the disk warning ride the
  scheduler's ticker but launch nothing. Each schedule firing mints a fresh task
  (`tasks.schedule_id`) and launches its first turn like `lib/autoStart.ts`. `lib/schedule/time.ts`
  is `Intl`-only wall-clock math: an IANA zone, never an offset, with both DST edges decided.
  `UNIQUE(schedule_id, scheduled_for)` on `schedule_runs` makes a double fire impossible across
  overlapping ticks, a Run-now race, or a restart; one sweep consumes the backlog, recording older
  slots `missed` and firing the newest once as `catch_up` if inside the window. Scheduled turns
  carry `interactionPolicy: "deny"` (`lib/runContext.ts`), settling the permission gate and any
  `ask_user` instead of parking on the watcher-count heuristic the gate ordinarily uses to decide,
  and the runner leaves `awaiting_input` at 0 on success. A clean run
  marks `tasks.unread_run_at` instead of leaving a permanent "in progress" row; the board shows it
  as "Ran clean" until a status write or the next session opening. The ticker starts from a boot
  self-ping to `/api/instance/scheduler` (its own route, since `/api/instance/services-restore` is
  pinned SDK-free). `app/shell/Schedules.tsx` validates a slash prompt against the project's real
  command registry on save (`POST /api/schedules/validate`, `lib/schedule/commands.ts`);
  `fireSchedule` re-checks at fire time and settles the run `failed` on an unknown command. The
  probe is bounded (`CALANDRIA_SCHEDULE_PROBE_MS`) since it runs inside the ticker's single-flight
  sweep; `schedulerHealth()` serves `lastTickAt`/`startedAt`/`tickMs` for a "looks stuck" banner. A
  `claimed`/`running` run row orphaned by a crash is settled `interrupted` at DB init; `claimRun`
  treats only a unique-constraint failure as "somebody else owns this slot", logging and throwing
  on anything else.
- `lib/promptLimits.ts`, `lib/authFailure.ts`, `lib/approvalFailure.ts`: recoverable turn
  failures, classified agent-agnostically from the error text. Each appends a durable notice the UI
  matches verbatim to render one recovery button: `/clear` for context overflow, Reconnect for a
  dead login, Retry for an approval-policy block. A dead login parks the pending queue and flags
  the agent instance-wide (`agent_auth_broken_<id>`, `lib/agents/connections.ts`, relayed as an
  `agent_auth` event); any successful turn clears it.
- `lib/config.ts`: all per-instance config, env-driven with documented defaults.
  `lib/features.ts`: feature flags (env → `resolveFeatures()` server-side, `window.__FEATURES`
  client-side).
- Auth: `middleware.ts` gates every HTTP route, with no matcher on purpose. `lib/auth/origin.mjs`
  selects the provider: no-login local mode by default, Cloudflare Access when `CF_ACCESS_*` is
  set. Both modes have a browser-origin boundary and different rules, held together in
  `lib/auth/local-origin.mjs`. Local mode pins the target: loopback and `PUBLIC_BASE_URL` are
  trusted, plus explicit LAN origins via `CALANDRIA_ALLOWED_ORIGINS`. This is the DNS-rebinding
  defense a mode with no login needs. Access mode can't use a target allowlist (tunnel hostname is
  unknowable) and doesn't need one, since a rebound host produces no valid assertion; but its JWT
  proves identity, not intent (`CF_Authorization` is `SameSite=None`), so
  `sameOriginWebSocketRequestAllowed` gates upgrades and `sameOriginHttpRequestAllowed` gates
  `middleware.ts`. CORS does not cover the HTTP half: `Request.json()` ignores Content-Type while
  `text/plain` is CORS-safelisted, so a preflight-free `no-cors` POST reaches every JSON route
  (`/api/tasks/[id]/messages` included) and many mutating routes act on the path alone (`/merge`,
  `/abort`, `/clear`, `/pr`, …). The HTTP rule rejects only a present-and-mismatched Origin, never
  on `Sec-Fetch-Site: cross-site` (cross-site navigations send no Origin;
  `tests/localOrigin.test.ts` pins that case). `pty-server.js` mirrors the same mode-aware pair on
  top of its own loopback-peer check; it must not assume it runs behind `server.js`, and must not
  enforce the other mode's policy. Threat model in `lib/cf-access.mjs`. Health, version and usage
  routes accept `SERVICE_TOKEN` or the read-only `CALANDRIA_FLEET_TOKEN` instead;
  `docker/entrypoint.sh` mints one when Access mode supplies none. **When adding a route or
  upgrade path, decide which gate covers it.**
- UI: `app/Shell.tsx` is the three-column shell (projects, tasks, live session); pieces live in
  `app/shell/` (`useTaskStream.ts` for the one-EventSource-per-task logic, `SessionRail.tsx` for
  the DIFF/PREVIEW/CONTEXT tabs). `app/Terminal.tsx` is xterm.js over the `/pty` proxy.
  `TerminalDrawer` (`app/shell/Layout.tsx`) opens in the project's `repo_path`, with a Project/Task
  toggle that re-roots the shell at the selected task's `worktree_path`. The scope is a pin, not a
  derivation from the selected task, since `TerminalView` respawns the shell whenever `cwd`
  changes. The Task button is disabled until the task has a worktree (cut on the first turn);
  `worktree_path` is on the client's `TaskRow` because `listTasks` selects `t.*`.

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
| DB (projects, tasks, transcripts, summaries) | `calandria.db` in `CALANDRIA_DB_DIR` (default `~/.calandria`; a pre-rename `~/.zen-orchestrator/orchestrator.db` is kept in place, never moved: see `lib/storage.mjs`) |
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
  image in the `Dockerfile`. Next's build output doesn't include them.
- **`next.config.mjs` stays JS**, not TS: prod containers prune dev deps and a `.ts` config needs
  the `typescript` package at runtime.
- **HMR-surviving server state lives on `globalThis`**: `lib/events.ts`, `lib/abort.ts`,
  `lib/asks.ts` and `lib/services.ts` all follow this pattern. Single Node process, no external
  queue or broker.
- **Long work is a detached background job, never a held HTTP request** (turns, context refresh,
  services). Anything multi-minute must survive page reloads and tunnel drops. Only live turns
  register in `lib/abort.ts`, so that is all a sleep daemon or the shutdown drain can see.
- **Native modules** (`better-sqlite3`, `node-pty`) and the Agent SDK are in
  `serverExternalPackages`; don't let Next bundle them. `postinstall` fixes node-pty's exec bit.
- **Don't import `lib/agents/registry.ts` from a low-level module.** The agent SDKs are ESM
  externals, which Turbopack compiles async, and async-ness propagates to every transitive
  importer, so a route entry compiled sync then reads every export back as `undefined`. Modules
  that only need capability data or agent ids import `lib/agents/capabilities.ts`
  (`getCapabilities` / `listAgentIds` / `isAgentId`) instead. `tests/importGraph.test.ts` pins the
  SDK-free set; add new low-level modules to its `PINNED` list.
- **A module that launches turns but is reached from ordinary route entries must reach the runner
  through `await import()`, not a static import**: `lib/autoStart.ts` and `lib/deferredStart.ts`,
  pinned by the same test's `DYNAMIC_ONLY` list. Sync-compiled route entries are the hazard
  (`PATCH /api/tasks/[id]` and the internal agent-tools routes call the auto-start sweep); a
  dynamic import resolves the namespace regardless of propagation. Same reason
  `/api/instance/scheduler` loads `lib/scheduler.ts` that way.
- **Nothing behind `registry.ts` may import a launcher back, dynamic edges included.** A driver
  needing a launcher takes it as an injected callback instead (`TurnHooks` in `lib/agents/types.ts`:
  every `startTurn` / `startResumeTurn` caller passes `AUTO_START_HOOKS`, and the tool callback
  reports a cleared blocker instead of sweeping it), keeping the import graph a DAG, pinned by the
  acyclicity case in `tests/importGraph.test.ts`. This class of bug only shows in the built server,
  so its regression test is an e2e (`e2e/04-turn-behaviors.spec.ts`).
- **Tests are hermetic.** `tests/setup.ts` points `CALANDRIA_DB_DIR` and `CALANDRIA_WORKTREES_DIR`
  at tmp dirs and pins git config before the module graph loads, since config is read at import
  time. Use `tests/helpers.ts` for git fixtures. New env-read-at-import config the suite depends on
  must be set there too. Platform-dependent spellings (`NUL` versus `/dev/null`, a shell the pty
  sidecar can spawn, a tree kill, `onPosix` for a case that pins POSIX semantics) come from
  `tests/platform.ts`; don't re-derive them per file. Env that only a fork or one machine needs
  goes in `tests/setup.local.ts`, an optional second `setupFiles` entry, gitignored and absent from
  a clean checkout, layered on top by `vitest.config.ts`, the seam a downstream repo uses instead
  of forking `tests/setup.ts`.
- **Delete is hard delete** throughout: no soft-delete, no undo.
- **Auth is layered.** Next middleware for HTTP, `server.js` for WebSocket upgrades, per-service
  visibility for public service hostnames. Both Cloudflare Access mode and no-login local mode
  have an origin boundary; keep `lib/auth/local-origin.mjs` shared instead of letting the HTTP and
  WebSocket policies drift. When adding a route or upgrade path, decide which gate covers it.
- **Commits are detailed** and explain the why. **Keep `README.md` current** with app state when
  behavior changes. Markdown tables use minimal separators (`|-|-|`).
- **A push isn't done until its CI runs conclude.** Watch to terminal state, diagnose red before
  rerunning, and file an issue for anything CI-broken. Full policy in `.github/CLAUDE.md`.
- **Prose and comments are plain technical writing.** No em dashes and no contrast constructions
  ("rather than", "not X but Y"). A comment states what the code does and the invariant to keep,
  never its history. History and measurements belong in the notes repo:
  https://github.com/calandria-dev/calandria-notes.

## More detail

`README.md` (product overview and quick start) · `docs/` (features, agents, services,
self-hosting, architecture) · `.env.example` (every env var, documented) ·
`lib/agents/CLAUDE.md` (per-driver detail, loaded when you open that directory).

This file is loaded into every session in this repo before any code is read. New material belongs
in the nearest directory-scoped `CLAUDE.md` instead of here.
