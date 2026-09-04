---
title: "Troubleshooting"
---

# Troubleshooting

First-incident runbooks for the failure modes a self-hoster actually hits. The rest of `docs/`
is setup and architecture; this file is what to do when something's already wrong.

| Symptom | Section |
|-|-|
| App won't start, `[config]`/`[server]`/`[db-lock]` warnings, or a boot refusal | [Common boot failures](#common-boot-failures) |
| `SQLITE_CORRUPT`, `database disk image is malformed`, garbled tasks after a crash | [Database corruption](#database-corruption) |
| Disk filling up, container out of space | [Disk usage and sizing](#disk-usage-and-sizing) |
| Running natively on Windows: `npm install` compiling `better-sqlite3`, "Filename too long", a worktree that won't delete, a hard stop | [Native Windows](#native-windows) |
| Running under WSL2: locking errors, "not logged in" agents, slow git, service hostnames | [WSL2 on Windows](#wsl2-on-windows) |
| A turn fails with "Failed to authenticate" / the titlebar shows a broken-connection banner | [Headless re-authentication](#headless-re-authentication) |
| Upgrading, or need to roll back a version | [Upgrade rollback](#upgrade-rollback) |
| Wondering how long turns take, what they cost, or why one failed | [Reading the logs](#reading-the-logs) |

## Reading the logs

One shared module (`lib/log.mjs`) emits every log line, in one of two shapes for the whole
instance, chosen by `CALANDRIA_LOG_FORMAT`:

- **`text`** (the default): `[component] message key=value key=value`. The bracket tag names
  the subsystem: `[server]`, `[pty-server]`, `[runner]`.
- **`json`**: one JSON object per line with `ts` (ISO-8601), `level` (`info`/`warn`/`error`),
  `component`, `msg`, then that line's own fields at the top level. Use this when something
  downstream parses the output, such as `docker logs` piped at a collector, or `jq` at the
  terminal.

The turn runner and both plain-Node entrypoints emit this way today. A few other call sites
(`[config]`, `[db-lock]`, `[scheduler]`, the routes) still print bracket-tagged prose through
`console`, so a `json` instance still produces a few non-JSON lines, all `warn`/`error` and none
on the turn path. `server.js` and `pty-server.js` read the variable themselves, so export it in
the environment that launches both; a `.env` file read by Next alone won't reach them. Any value
other than `json` or `text` logs a warning once and falls back to `text`.

Every turn logs twice, at start and at settle. Those two lines answer how long turns take on
this box, which task burned the tokens, and whether last night's schedule actually ran:

```
[runner] turn start task=lM5-igB project=cal agent=claude generation=0 origin=schedule resume=true
[runner] turn ok task=lM5-igB ms=84120 tokens_in=1204 tokens_out=8801 cache_read=412003 tokens_total=422008 cost_usd=0.4113
```

`origin` says why the turn is running (`user`, `schedule`, `dependency`). The settle line's
`msg` gives the outcome:

| `turn …` | Means |
|-|-|
| `ok` | the session opened, ran, and ended without an error |
| `failed` | the turn errored, or a tool call was auto-denied because nobody was watching; logged at `error` level with the message in `error=` |
| `stopped` | the Stop button (or a shutdown drain) cut it, not a failure |
| `interrupted` | the agent session never opened, so the turn produced nothing; logged at `warn` |

A scheduled run is settled with the same four outcomes in the ledger. These are also the label
values on `calandria_turns_finished_total`, incremented from this same statement; see
[Metrics](SELF_HOSTING.md#metrics) for a graph instead of raw log lines.

Token counts are per turn, summed from the same usage reports that write the `task_usage`
table; an agent that reports no usage logs zeros rather than the task's running total. Some
useful one-liners in JSON mode:

```bash
# The ten slowest turns, newest first
docker logs calandria-alice 2>&1 | jq -rc 'select(.msg|startswith("turn ")) | [.ts,.msg,.task,.ms] | @tsv' | sort -k4 -n | tail
# What this instance spent, by task
docker logs calandria-alice 2>&1 | jq -rc 'select(.msg=="turn ok") | [.task,.cost_usd] | @tsv'
# Everything that failed, with the reason
docker logs calandria-alice 2>&1 | jq -c 'select(.level=="error")'
```

Calandria's own agent tools (`suggest_task`, `create_pr` and the rest) log too, under
`[agent-tools]`: `agent tool call received` the moment a call reaches the server, and
`agent tool call settled` with `outcome=` (`ok`, `error`, `timeout`, `blank`) and `ms=` when it
answers, each carrying `tool=`, `task=` and `transport=` (`in-process` for a Claude session,
`bridge` for the stdio bridge Codex uses). A call the Claude CLI answered itself, which never
reaches Calandria, shows instead as `[claude] agent tool call cut off before Calandria answered`,
and the turn's `ok` line then carries `tool_cutoffs=N`. So "did the session's `create_pr` land?"
is: a `received` line means it did reach the server, a `cut off` line with no `received` line
means it never did. `CALANDRIA_CLAUDE_DEBUG_DIR` adds the CLI's own per-turn debug log for the
latter case.

## Common boot failures

**Numeric env var warnings.** A handful of env vars (ports, buffer sizes) are parsed as plain
integers. A typo'd value logs a named warning and falls back to the documented default. The
format is `[<source>] <VAR>=<value> is not a number; using default <default>`, with `<source>`
naming where the check ran:

| Prefix | File | Vars checked |
|-|-|-|
| `[config]` | `lib/config.ts` | `CALANDRIA_SERVICE_PORT_BASE`, `CALANDRIA_SERVICE_LOG_LINES`, `CALANDRIA_GIT_FETCH_TIMEOUT_MS`, `CALANDRIA_GIT_FETCH_COOLDOWN_MS` |
| `[db-lock]` | `lib/db-lock.mjs` | `CALANDRIA_DB_LOCK_WAIT_MS` |
| `[server]` | `server.js` | `PORT`, `PTY_PORT` |
| `[pty-server]` | `pty-server.js` | `PTY_PORT` |

The app is running fine, on the default for that var, not the value you set. Fix the env var and
restart. A separate, older class of timeout knobs (`CALANDRIA_PERMISSION_PROMPT_TIMEOUT_MS`,
`CALANDRIA_SCHEDULE_TICK_MS`, and similar) falls back to its default the same way but doesn't
warn; `lib/config.ts`'s `ms()` versus `num()` is the line between the two.

**"Another Calandria process is already running against this database."** A hard refusal to
boot: the app runs as a single process, turns run detached and owned by the server, and boot
clears wreckage a dead predecessor left behind. The error names the holder's pid, host, and
start time when available. See **One process per database** in
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md#notes--caveats) for causes and fixes. Don't reach for
`CALANDRIA_DB_LOCK=off`; it disables the protection this error is giving you.

**"was written by a NEWER version of Calandria."** Another hard refusal, and the one you get
from rolling an image tag backwards. The database carries the schema version of the build that
last migrated it (`PRAGMA user_version`, [`lib/schema-version.mjs`](../lib/schema-version.mjs)),
and this build's number is lower than that. Booting anyway would keep writing to the database
and lose whatever the newer version stored, so the app stops instead. The message prints both
numbers and the two ways out: go back to the newer tag (nothing to restore), or stay on this
build and restore the pre-upgrade backup. See
[Rolling back an upgrade](SELF_HOSTING.md#rolling-back-an-upgrade) in SELF_HOSTING.md. There's no
down-migration and no override flag.

## WSL2 on Windows

WSL2 is one of the two supported ways to run Calandria on Windows ([setup](INSTALLATION.md#wsl2));
[Native Windows](#native-windows) below is the other. Inside WSL2 the app runs as an ordinary
Linux build, so everything else in this file applies, and the native section below doesn't.
Three failures are specific to the WSL2 boundary.

**Anything under `/mnt/c` or `\\wsl$`.** `CALANDRIA_DB_DIR`, `CALANDRIA_WORKTREES_DIR`, and
project repos must live on the WSL2 ext4 root. Those cross-boundary filesystems (drvfs/9p) don't
implement file locking, so `lib/db-lock.mjs`'s SQLite mutex can't exclude a second process: two
instances can open the same database and corrupt the WAL instead of one boot being refused.
Symptoms range from a `[db-lock]` boot that should have refused and didn't, through
`SQLITE_IOERR`/`SQLITE_BUSY` mid-turn, to the torn-WAL damage in
[Database corruption](#database-corruption). Git on those paths is also 10-50x slower, which
shows up as every task launch and diff crawling. Fix: move the directories to `/home/<you>/…`
(recreating a worktree is cheap; move or re-clone repos) and restart.

**Agents report "not logged in" despite a working Windows login.** WSL2 has its own `$HOME`, so
a Claude or Codex login done on the Windows side is invisible to the CLIs inside it. Run
`claude` / `codex` from the WSL2 shell and complete the browser login there, or reconnect the
agent from Settings → Agents. If a turn already failed, recover it the same way as
[Headless re-authentication](#headless-re-authentication).

**Service hostnames don't open from the Windows browser.** `localhost:3000` is forwarded
automatically, but subdomains of `localhost` are not, and `<slug>--<host>` service URLs
(`CALANDRIA_SERVICE_HOSTS=1`, see [Managed services](SERVICES.md)) resolve through DNS like
anywhere else. Either use the port directly, or add each hostname to
`C:\Windows\System32\drivers\etc\hosts` pointing at `127.0.0.1`. There's no wildcard-hosts-file
equivalent; a real wildcard DNS record is the only way to avoid one entry per service.

## Native Windows

Native Windows is supported ([setup](INSTALLATION.md#native-windows),
[platform notes](WINDOWS.md)). The four failures below come from Windows itself.

**`npm install` fails compiling `better-sqlite3`.** Hundreds of lines of MSVC output ending in
`gyp ERR! build error`, with `C2039: 'GetPrototype': is not a member of 'v8::Object'` or
`LNK1117: syntax error in option 'opt:lldltojobs=2'` among them, and one line above the wall
that is the actual cause:

```
prebuild-install warn install No prebuilt binaries found (target=26.7.0 runtime=node arch=x64 libc= platform=win32)
```

This shouldn't happen on a current checkout, so check your version first. Older `better-sqlite3`
releases (up to 12) fell back to compiling from source when no matching prebuilt binary existed,
and that source build fails on current Node: the addon uses V8 APIs newer Node removed, and
Node's `common.gypi` sets clang LTO flags MSVC's linker rejects. Installing Visual Studio build
tools doesn't help.

Calandria depends on `better-sqlite3` 13, which ships one N-API binary per platform, ABI-stable
across Node versions, inside the npm package. There's no compile-from-source fallback. Fix:

- **Older checkout.** Update, and delete `node_modules` before retrying; a half-rolled-back
  install leaves directories npm then fails to replace (`EPERM: rmdir`).
- **Unsupported platform.** It bundles `linux`, `darwin` and `win32` x64/arm64 (plus musl
  variants for linux). Anything else, such as 32-bit Windows or armv7, still compiles from
  source and needs a real toolchain.

A Node version below the supported floor fails differently: `.npmrc` sets `engine-strict`, so
`npm install` refuses it outright with one `EBADENGINE` line.

**`MAX_PATH`, "Filename too long" on a task launch or an agent's `npm install`.** Git for
Windows refuses paths over 260 characters unless `core.longpaths` is on, and a task's checkout
starts deep before the repository's own tree begins: `%USERPROFILE%\.calandria\worktrees\<task
id>\`. Add a `node_modules` chain to that and `git worktree add` fails part-way through the
checkout. Calandria passes `-c core.longpaths=true` on its own git invocations (cutting,
diffing, merging a worktree), but the agent's own `git`, `npm`, and your editor read the
ordinary config, so set it once for the machine:

```
git config --global core.longpaths true
```

That's a Git for Windows setting only; the underlying Win32 path limit is separate, and some
tools stay subject to it regardless. `CALANDRIA_WORKTREES_DIR=C:\w` (a short root near the drive
letter) buys back about 30 characters per path if a repository still overflows.

**"Couldn't remove the task's worktree" on discard, prune, or delete.** POSIX lets an open file
be unlinked and disappear; Windows returns `EBUSY`/`EPERM`/`ENOTEMPTY` while any process holds a
handle on it. The usual holder is Calandria's own task-scoped terminal, rooted inside the
worktree being removed; an editor with the folder open or a Defender scan of a fresh checkout
cause the same error. Teardown retries and clears an antivirus scan on its own, but close a
shell sitting in the directory (or `cd` it out of the worktree) and close the editor window
before retrying. Nothing is lost: the task row and its branch stay intact.

**Turns look like they simply stopped after you shut the server down.** Only Ctrl+C in the
terminal running `npm start` reaches the shutdown drain, which aborts each in-flight turn and
writes its interrupted state to the transcript. `taskkill /F`, Task Manager's End task, and
closing the console window are all `TerminateProcess`: they run no handler, so the drain never
starts. `taskkill` without `/F` asks a GUI message loop to close, and Node has none, so that
doesn't help either. A service wrapper (NSSM, WinSW, `sc`) is only as graceful as its own
configured shutdown method, so pin that method if you use one. No data is lost: the next boot
clears the running flags, pending messages, unanswered permission cards, and orphaned schedule
runs a hard stop left behind, but the interrupted turns carry no notice explaining themselves.
To stop the server from outside its console, stop the tasks first.

## Database corruption

Everything the app tracks (projects, tasks, transcripts, summaries, usage and cost history,
merge records, schedules, runbooks, remembered permission rules, settings) lives in one SQLite
database, `calandria.db` (plus its WAL-mode
sidecars `calandria.db-wal` and `calandria.db-shm`) under `CALANDRIA_DB_DIR` (default
`~/.calandria`; see "Where data lives" in the top-level `CLAUDE.md`). `lib/db.ts` opens it with
`journal_mode = WAL` and a 5s `busy_timeout`. An install predating the rename still has
`orchestrator.db` under `~/.zen-orchestrator`; substitute that name in the commands below if
that's what you have.

**Symptoms.** The app fails to boot with a SQLite error, a route 500s referencing
`better-sqlite3`, or the app runs but a task's history looks wrong (missing messages, a
transcript that ends mid-sentence with no error). The last pattern usually means a process was
killed (OOM, `docker kill`, a host power-loss) mid-write, tearing the WAL rather than corrupting
the main file outright.

**Check it.** Stop the app first; a live WAL-mode connection is a moving target for a read-only
inspection. Then, against the volume/directory:

```bash
sqlite3 calandria.db "PRAGMA integrity_check;"
```

`ok` means the b-tree structure is sound (this doesn't prove application-level consistency, just
that SQLite can read every page). Anything else is a list of the specific corruption found. The
boot mutex lives in a separate `calandria.lock.db` rather than locking the real file (see
`lib/db-lock.mjs`), so a read-only inspection while the app is running is possible, but run the
integrity check with the app stopped so a WAL checkpoint mid-scan can't produce a false read.

**What `recoverFromCrash()` handles automatically.** Every boot that wins the single-process lock
(`lib/db-lock.mjs`) runs a recovery pass in `lib/db.ts` that clears process wreckage, not file
corruption:

- Resets any `tasks.running = 1` left over from a process that died mid-turn.
- Drops everything in `pending_messages`: the turns those follow-ups were queued behind died
  with the old process, so there's nothing left to dequeue them into.
- Auto-denies any tool-permission card still open (`role = 'tool'` rows carrying an unresolved
  `permission` block), with the note "The app restarted before this was answered."
- Marks any `schedule_runs` row stuck in `claimed`/`running` as `interrupted`.

This runs once per boot, only for the process that wins the lock, never against a live instance
(see `consumeDbRecoveryAuthorization()`), which is why an ungraceful container restart looks
clean instead of leaving zombie "running" tasks or unanswerable permission cards. It does
nothing for a torn WAL frame or a corrupted b-tree page: `recoverFromCrash()` only runs after
the file has already opened successfully. A file-integrity problem needs the manual recovery
below.

**Manual recovery, in order of preference:**

1. **Restore from a backup.** `npm run backup` takes a WAL-safe hot snapshot (`VACUUM INTO`, no
   downtime, no application lock) plus uploads, the VAPID key, and the agent CLI logins. Restore
   procedure: [Backup & restore](SELF_HOSTING.md#backup--restore) in SELF_HOSTING.md. If you're
   here without one: `cp calandria.db` alone drops everything still in the write-ahead log, and
   copying the pair from under a running app can tear it, so don't do either next time.
2. **Recover what SQLite can still read.** With the app stopped:
   ```bash
   sqlite3 calandria.db ".recover" | sqlite3 calandria-recovered.db
   sqlite3 calandria-recovered.db "PRAGMA integrity_check;"
   ```
   `.recover` walks every page it can and reconstructs a fresh database from what's salvageable:
   rows in a damaged page are lost, everything else survives. Once the recovered file passes
   `integrity_check`, stop the app, replace `calandria.db` with it (removing the stale
   `-wal`/`-shm` sidecars alongside it), and restart.
3. **Start clean.** If nothing is recoverable, see below for what that costs.

**What's lost if you delete the DB.** Deleting `calandria.db*` (or pointing `CALANDRIA_DB_DIR` at
an empty directory) doesn't touch your code: cloned repos (`CALANDRIA_PROJECTS_DIR`, default
`~/projects`) and task worktrees (`CALANDRIA_WORKTREES_DIR`, default `~/.calandria/worktrees`)
stay on disk but become orphaned; find and remove them by hand (`git worktree list` in each
project's repo). Your `claude`/`codex` CLI logins also survive (under `~/.claude` / `~/.codex`,
not the app's DB), so agents reconnect with "Verify connection" rather than a fresh OAuth flow.
What doesn't survive: every project and task, every transcript and generation summary,
session/thread ids (an old `claude` session on disk can no longer be resumed through the app),
usage and cost history, merge records, schedules and their run ledger, runbooks, remembered
permission rules, and the agent-connection/onboarding state in `settings` (cosmetic; re-verify to
restore the "connected" badge). Chat attachments under `CALANDRIA_DB_DIR/uploads`
(`lib/uploads.ts`) sit inside the same directory tree as the DB by default, so a wholesale wipe
takes them too; deleting only the `.db*` files leaves them orphaned on disk.

## Disk usage and sizing

Three things grow over the life of an instance. Two are bounded automatically; the middle one
is the one that will fill your disk.

**The database itself** (`calandria.db` + WAL) stays small; it holds text (transcripts,
summaries, settings) and small numeric rows, no binaries. `calandria.db-wal` grows between
checkpoints; SQLite's default auto-checkpoint (about 1000 pages) handles this on its own, except
that a long-held read connection can defer a checkpoint, so close a `sqlite3 calandria.db`
session left open for an inspection when you're done. The retention sweep ages out finished
tasks' rows and checkpoints the WAL after deleting, reclaiming the space. `VACUUM`, the only
operation that shrinks the file itself rather than freeing pages inside it, is opt-in behind
`CALANDRIA_RETENTION_VACUUM`. Both are covered in
[SELF_HOSTING.md](SELF_HOSTING.md#notes--caveats) under **Retention**.

**Task worktrees** (`CALANDRIA_WORKTREES_DIR`, default `~/.calandria/worktrees`) are the real
disk cost, and the one thing that doesn't shrink on its own. Every task gets its own full git
worktree, a second checkout of the project repo, for the life of the task, even after it's
merged. On a repo with a large working tree (node_modules, build artifacts, vendored assets), N
concurrent-or-completed tasks cost roughly N times that repo's checked-out size, plus whatever
uncommitted build output or dependencies the agent wrote into the worktree: a repo whose `npm
install` alone is 500MB turns 20 old task worktrees into 10GB before you've noticed.

Inspect it directly:

```bash
du -sh "$CALANDRIA_WORKTREES_DIR"/*   # per-worktree; worktree dirs are named by task id
git -C <repo> worktree list           # cross-check against what git itself thinks exists
```

**The maintenance UI worktree-reclaim path** is the built-in fix: Settings → Storage →
"Reclaim task worktrees" (`app/shell/WorktreePrune.tsx`, backed by `GET`/`POST
/api/maintenance/worktrees`). It lists every merged-or-Done task whose worktree is still on
disk, with its measured size (`worktreeDiskUsage()` in `lib/git.ts`, via `du -sk`) and whether
removing it is safe. Safe means no uncommitted changes and no commits on the task's branch that
the base branch hasn't absorbed yet (`worktreePruneSafety()`); `merged_at` only records that a
task was merged at least once, so a task that kept going after its first merge can still carry
unmerged work. Safe worktrees are removed with the branch kept by default (or dropped too, with
`deleteBranch`). A Done-but-unsafe task can be force-discarded (`discardChanges`), which throws
away the uncommitted edits or unmerged commits; the UI states the cost before you confirm it.
Running turns are excluded and re-checked at execution time under the task's lock, so a worktree
can't disappear out from under an agent mid-turn.

**Uploads** (`CALANDRIA_DB_DIR/uploads/<taskId>`, `lib/uploads.ts`) are the smallest and most
bounded of the three (10MB per attachment, `MAX_UPLOAD_BYTES`) and are removed automatically
(`removeTaskUploads()`) whenever the task or its project is hard-deleted. The worktree-reclaim
path above doesn't clear them, since a merged/Done task can still be opened to review its
history; they only disappear with the task itself.

**Rough sizing guidance:** budget generously for worktrees, since they scale with repo size times
parallel task count, not with chat volume. A few hundred MB is plenty for the database on almost
any instance, and uploads are self-limiting. If disk pressure is a recurring problem, use the
worktree-reclaim UI; there's no scheduled auto-prune, so prune merged tasks weekly by hand.

## Headless re-authentication

Calandria drives the `claude` CLI against your own Claude subscription login, not an API key.
That login is an OAuth session that can expire or be revoked independently of the container. In
a headless deployment (no desktop, no interactive shell attached), recovering it uses the same
manual paste-code exchange the setup wizard uses to connect the account in the first place
(`claude auth login`'s OAuth flow falls back to it when it can't open a browser), driven by
`lib/claude-auth.ts`. Codex's own login is device-code style rather than paste-code
(`lib/agents/codex/capabilities.ts`), but a failure is flagged through the same agent-agnostic
machinery described below.

**Symptoms.** A turn fails and its transcript carries the provider's own rejection text
verbatim: for Claude, something like `Failed to authenticate: OAuth session expired and could
not be refreshed`; for Codex, `not logged in`, `please run codex login`, or a bare `401`
(`lib/authFailure.ts` classifies both). The credential is per-instance, so every task on that
agent fails the same way; the first one to run just reveals it first. Once detected:

- The titlebar shows a persistent, non-dismissible banner: *"`<Agent>` has stopped working. The
  sign-in expired. No session can run until it's reconnected."* (`AgentAuthBanner` in
  `app/shell/AgentConnect.tsx`), broadcast to every open tab via `GET /api/events` the moment any
  task hits the failure.
- The failing task's transcript gets a standing notice with a one-click Reconnect button.
- Any message queued behind the failing turn (`pending_messages`) stays parked rather than
  draining and failing one by one.
- The instance-wide flag persists in `settings` as `agent_auth_broken_<agentId>`
  (`lib/agents/connections.ts`) until a successful turn or a fresh login clears it, so the
  banner survives a restart. Grep logs for `agent_auth_broken` or the provider phrases above to
  confirm.
- The same banner, worded *"The connection no longer applies"*, means the Claude connection was
  verified against one backend and Claude Code is now configured for another (Anthropic, Vertex
  AI or Amazon Bedrock, by `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_BEDROCK` in
  `~/.claude/settings.json` or the env). The record is dropped rather than kept as a "connected"
  that every turn would disprove, and the reason names both backends. Recovery is the same:
  reconnect, which verifies against the backend the CLI now uses.

**Recovery.** No shell access to the container is needed:

1. Open the app in a browser and go to Settings → Agents (or click Reconnect on the banner or
   the failing task's notice).
2. Click Sign in again. The app spawns `claude auth login` under a pseudo-tty inside the
   container and parses the authorize URL out of its output (`lib/claude-auth.ts`); `BROWSER=true`
   makes the CLI skip trying to open a browser locally, so nothing needs one inside the
   container.
3. Open the printed URL in your own browser, sign in, and get the one-time code.
4. Paste the code back into the app's login card. The app forwards it to the waiting CLI
   (`submitClaudeCode()`), confirms via `claude auth status`, and runs a one-shot verification
   turn (`verifyTurn()`) to confirm the connection actually works.
5. The reconnect clears the broken-connection flag and banner immediately
   (`clearAgentAuthBroken()`), and any parked queue drains on the next turn.

The new credentials land under `$HOME/.claude` (or `~/.codex`) inside the container, on the same
persistent volume as the database, so a restart doesn't lose the fix. If a login session is
abandoned mid-flow, it expires after 15 minutes rather than leaving a stale pending state.

## Upgrade rollback

Pulling an older image tag against a database a newer build already migrated is a clean refusal
rather than a silent hazard: every build stamps the schema version it understands (`PRAGMA
user_version`), and boot refuses a database stamped higher. See the entry in
[Common boot failures](#common-boot-failures) above for the message.

A rollback needs two moves: re-pin the image and restore the database from the backup you took
before the upgrade. The step-by-step runbook, including the case where you don't have a backup,
is [Rolling back an upgrade](SELF_HOSTING.md#rolling-back-an-upgrade) in SELF_HOSTING.md. There's
no down-migration, so take a backup before every upgrade
([Backup & restore](SELF_HOSTING.md#backup--restore)).
