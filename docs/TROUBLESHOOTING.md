# Troubleshooting

First-incident runbooks for the failure modes a self-hoster actually hits. The rest of `docs/`
is setup and architecture; this file is what to do when something's already wrong.

| Symptom | Section |
|-|-|
| App won't start, `[config]`/`[server]`/`[db-lock]` warnings, or a boot refusal | [Common boot failures](#common-boot-failures) |
| `SQLITE_CORRUPT`, `database disk image is malformed`, garbled tasks after a crash | [Database corruption](#database-corruption) |
| Disk filling up, container out of space | [Disk usage and sizing](#disk-usage-and-sizing) |
| A turn fails with "Failed to authenticate" / the titlebar shows a broken-connection banner | [Headless re-authentication](#headless-re-authentication) |
| Upgrading, or need to roll back a version | [Upgrade rollback](#upgrade-rollback) |

## Common boot failures

**Numeric env var warnings.** A handful of env vars are parsed as plain integers rather than
durations, because they have no meaningful "unset" fallback to silently prefer (ports, buffer
sizes). A typo'd value logs a named warning and falls back to the documented default instead of
surfacing later as an opaque failure — before this validation existed, a bad
`ORCH_SERVICE_PORT_BASE` showed up as a SQLite bind-type error on project creation, nowhere near
the env var that caused it. The warning format is `[<source>] <VAR>=<value> is not a number;
using default <default>`, with `<source>` naming where the check ran:

| Prefix | File | Vars checked |
|-|-|-|
| `[config]` | `lib/config.ts` | `ORCH_SERVICE_PORT_BASE`, `ORCH_SERVICE_LOG_LINES`, `ORCH_GIT_FETCH_TIMEOUT_MS`, `ORCH_GIT_FETCH_COOLDOWN_MS` |
| `[db-lock]` | `lib/db-lock.mjs` | `ORCH_DB_LOCK_WAIT_MS` |
| `[server]` | `server.js` | `PORT`, `PTY_PORT` |
| `[pty-server]` | `pty-server.js` | `PTY_PORT` |

If you see one of these at boot, the app is running fine — on the *default* for that var, not
the value you set. Fix the env var and restart; there's nothing else to recover. (A separate,
older class of timeout knobs — `ORCH_PERMISSION_PROMPT_TIMEOUT_MS`,
`ORCH_SCHEDULE_TICK_MS`, and similar — use the same fallback-to-default behavior but don't warn;
`lib/config.ts`'s `ms()` vs `num()` is the line between the two.)

**"Another Calandria process is already running against this database."** A hard refusal to
boot, not a warning — the app is single-process by design (turns run detached, owned by the
server, and boot clears wreckage a dead predecessor left behind). The error names the holder's
pid, host, and start time when available. See **One process per database** in
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md#notes--caveats) for what causes it and how to resolve
it — don't reach for `ORCH_DB_LOCK=off` as a fix; it disables the exact protection this error is
giving you.

## Database corruption

Everything the app knows — projects, tasks, transcripts, summaries, usage/cost history, merge
records, schedules, runbooks, remembered permission rules, settings — lives in one SQLite
database, `orchestrator.db` (+ its WAL-mode sidecars `orchestrator.db-wal` and
`orchestrator.db-shm`) under `ORCH_DB_DIR` (default `~/.zen-orchestrator`; see "Where data
lives" in the top-level `CLAUDE.md`). `lib/db.ts` opens it in `journal_mode = WAL` with a 5s
`busy_timeout`.

**Symptoms.** The app fails to boot with a SQLite error, a route 500s referencing
`better-sqlite3`, or (more insidious) the app runs but a task's history looks wrong — missing
messages, a transcript that ends mid-sentence with no error. The last pattern usually means a
process was killed (OOM, `docker kill`, a host power-loss) mid-write, tearing the WAL rather than
corrupting the main file outright.

**Check it.** Stop the app first — a live WAL-mode connection is a moving target for a read-only
inspection. Then, against the volume/directory:

```bash
sqlite3 orchestrator.db "PRAGMA integrity_check;"
```

`ok` means the b-tree structure is sound (this does not prove application-level consistency, just
that SQLite can read every page). Anything else is a list of the specific corruption found.
Concurrent read-only inspection while the app is running is explicitly supported (that's why the
boot mutex lives in a *separate* `orchestrator.lock.db` rather than locking the real file — see
`lib/db-lock.mjs`), but do the integrity check with the app stopped so a WAL checkpoint mid-scan
can't produce a false read.

**What `recoverFromCrash()` handles automatically.** Every boot that wins the single-process lock
(`lib/db-lock.mjs`) runs a recovery pass in `lib/db.ts` — but it clears *process* wreckage, not
*file* corruption:

- Resets any `tasks.running = 1` left over from a process that died mid-turn.
- Drops everything in `pending_messages` — the turns those follow-ups were queued behind died
  with the old process, so there's nothing left to dequeue them into.
- Auto-denies any tool-permission card still open (`role = 'tool'` rows carrying an unresolved
  `permission` block), with the note "The app restarted before this was answered."
- Marks any `schedule_runs` row stuck in `claimed`/`running` as `interrupted`.

This runs once per boot, only for the process that actually won the lock (never against a live
instance — see `consumeDbRecoveryAuthorization()`), and it's why an ungraceful container restart
looks clean rather than leaving zombie "running" tasks or unanswerable permission cards. It does
**nothing** for a torn WAL frame or a corrupted b-tree page — that's a file-integrity problem,
and SQLite's own crash safety (the WAL) is what normally prevents it; `recoverFromCrash()` only
runs after the file has already opened successfully.

**Manual recovery, in order of preference:**

1. **Restore from a backup.** There's no built-in backup/restore tooling yet — full
   backup/restore/upgrade-safety story is tracked in
   [issue #13](https://github.com/calandria-dev/calandria/issues/13). Until then, back up by
   stopping the app and copying `orchestrator.db*` (all three files together, so the WAL isn't
   left behind).
2. **Recover what SQLite can still read.** With the app stopped:
   ```bash
   sqlite3 orchestrator.db ".recover" | sqlite3 orchestrator-recovered.db
   sqlite3 orchestrator-recovered.db "PRAGMA integrity_check;"
   ```
   `.recover` walks every page it can and reconstructs a fresh database from what's salvageable
   — rows in a damaged page are lost, everything else survives. Once the recovered file passes
   `integrity_check`, stop the app, replace `orchestrator.db` with it (removing the stale
   `-wal`/`-shm` sidecars alongside it), and restart.
3. **Start clean.** If nothing is recoverable, see below for what that costs.

**What's lost if you delete the DB.** Deleting `orchestrator.db*` (or pointing `ORCH_DB_DIR` at
an empty directory) does **not** touch your code: cloned repos (`ORCH_PROJECTS_DIR`, default
`~/projects`) and task worktrees (`ORCH_WORKTREES_DIR`, default
`~/.agent-orchestrator/worktrees`) live in separate directories and are untouched — but they
become orphaned, since nothing in a fresh database points at them. Your `claude`/`codex` CLI
logins also survive (they live under `~/.claude` / `~/.codex`, not the app's DB), so agents
reconnect with "Verify connection" rather than a fresh OAuth flow. What does **not** survive:
every project and task, every transcript and generation summary, session/thread ids (so an old
`claude` session on disk can no longer be resumed through the app), usage and cost history,
merge records, schedules and their run ledger, runbooks, remembered permission rules, and the
agent-connection/onboarding state in `settings` (cosmetic — re-verify to restore the "connected"
badge). Chat attachments under `ORCH_DB_DIR/uploads` (`lib/uploads.ts`) sit inside the same
directory tree as the DB by default, so a wholesale `ORCH_DB_DIR` wipe takes them too; deleting
only the `.db*` files leaves them on disk, orphaned. Orphaned worktrees aren't cleaned up
automatically — find and remove them by hand (`git worktree list` in each project's repo).

## Disk usage and sizing

Three things grow over the life of an instance, and only one of them is bounded automatically.

**The database itself** (`orchestrator.db` + WAL) stays small in absolute terms — it holds text
(transcripts, summaries, settings) and small numeric rows, no binaries. `orchestrator.db-wal`
grows between checkpoints; SQLite's default auto-checkpoint (~1000 pages) handles this on its
own, with one caveat: a long-held read connection can defer a checkpoint, so a `sqlite3
orchestrator.db` session left open for an inspection is worth closing when you're done. There's
no scheduled `wal_checkpoint` or `VACUUM` in this app (tracked as part of
[issue #13](https://github.com/calandria-dev/calandria/issues/13)).

**Task worktrees** (`ORCH_WORKTREES_DIR`, default `~/.agent-orchestrator/worktrees`) are the real
disk cost, and they're the one thing that does **not** shrink on its own. Every task gets its own
full git worktree — effectively a second checkout of the project repo — for the life of the task,
even after it's merged. On a repo with a large working tree (node_modules, build artifacts,
vendored assets), N concurrent-or-completed tasks costs roughly N× that repo's checked-out size.
Uncommitted build output, installed dependencies, or anything else a task's agent wrote into the
worktree counts too — a repo whose `npm install` alone is 500MB turns 20 old task worktrees into
10GB before you've noticed.

Inspect it directly:

```bash
du -sh "$ORCH_WORKTREES_DIR"/*        # per-worktree — worktree dirs are named by task id
git -C <repo> worktree list           # cross-check against what git itself thinks exists
```

**The maintenance UI worktree-reclaim path** is the built-in fix: Settings → Storage →
"Reclaim task worktrees" (`app/orchestrator/WorktreePrune.tsx`, backed by `GET`/`POST
/api/maintenance/worktrees`). It lists every merged-or-Done task whose worktree is still on disk,
with its measured size (`worktreeDiskUsage()` in `lib/git.ts`, via `du -sk`) and whether removing
it is safe. "Safe" means no uncommitted changes and no commits on the task's branch that the base
branch hasn't absorbed yet (`worktreePruneSafety()`) — `merged_at` only records that a task was
merged *at least once*, so a task that kept going after its first merge can still be carrying
unmerged work. Safe worktrees are removed with the branch kept by default (so reopening the task
still has its diff base), or with `deleteBranch` to also drop it. A Done-but-unsafe task can be
force-discarded (`discardChanges`), which throws away the uncommitted edits or unmerged commits —
the UI states the cost before you confirm it. Running turns are excluded and re-checked at
execution time under the task's lock, so a worktree can never disappear out from under an agent
mid-turn.

**Uploads** (`ORCH_DB_DIR/uploads/<taskId>`, `lib/uploads.ts`) are the smallest and most bounded
of the three — 10MB per attachment (`MAX_UPLOAD_BYTES`) — and are removed automatically
(`removeTaskUploads()`) whenever the task or its project is hard-deleted. They are **not** cleared
by the worktree-reclaim path above, since a merged/Done task can still be opened to review its
history; they only disappear with the task itself.

**Rough sizing guidance:** budget generously for worktrees (they scale with your repo × how many
tasks you run in parallel before pruning, not with chat volume), a few hundred MB is plenty for
the database on almost any instance, and uploads are self-limiting. If disk pressure is a
recurring problem, the worktree-reclaim UI is the lever to pull first, and a smaller
`ORCH_WORKTREES_DIR` retention habit (pruning merged tasks weekly) beats any config knob — there
isn't one to auto-prune on a schedule today.

## Headless re-authentication

Calandria drives the `claude` CLI against your own Claude subscription login, not an API key, and
that login is an OAuth session that can expire or be revoked independently of the container being
fine. In a headless deployment (no desktop, no interactive shell attached) this needs a specific
recovery path, but the app is built for it — `claude auth login`'s OAuth flow already falls back
to a manual paste-code exchange when it can't open a browser (exactly the headless case), which is
how the setup wizard connects the account from the browser in the first place; re-auth is the same
flow, driven by `lib/claude-auth.ts`. (Codex's own login is device-code style rather than
paste-code — `lib/agents/codex/capabilities.ts` — but fails and is flagged through the same
agent-agnostic machinery described below.)

**Symptoms.** A turn fails and its transcript carries the provider's own rejection text verbatim
— for Claude, something like `Failed to authenticate: OAuth session expired and could not be
refreshed`; for Codex, `not logged in` / `please run codex login` / a bare `401`
(`lib/authFailure.ts` classifies both, agent-agnostically). Because the credential is
per-instance, not per-task, **every** task on that agent fails the same way — the first one to
run just reveals it first. Once detected:

- The titlebar shows a persistent, non-dismissible banner: *"`<Agent>` has stopped working — the
  sign-in expired... No session can run until it's reconnected."* (`AgentAuthBanner` in
  `app/orchestrator/AgentConnect.tsx`), broadcast to every open tab via `GET /api/events` the
  moment any task hits the failure.
- The failing task's transcript gets a standing notice with a one-click **Reconnect** button.
- Any message queued behind the failing turn (`pending_messages`) stays parked rather than
  draining and failing one by one.
- The instance-wide flag persists in `settings` as `agent_auth_broken_<agentId>`
  (`lib/agents/connections.ts`) until a successful turn or a fresh login clears it — so the
  banner survives a restart, and grep-ing logs for `agent_auth_broken` or the provider phrases
  above is the fast path to confirming this is what happened.

**Recovery.** No shell access to the container is needed:

1. Open the app in a browser and go to **Settings → Agents** (or click **Reconnect** on the
   banner / the failing task's notice).
2. Click **Sign in again**. The app spawns `claude auth login` under a pseudo-tty inside the
   container and parses the authorize URL out of its output (`lib/claude-auth.ts`) — it never
   needs a browser *in* the container (`BROWSER=true` makes the CLI skip trying to open one
   locally).
3. Open the printed URL in **your own** browser, sign in, and get the one-time code.
4. Paste the code back into the app's login card. The app forwards it to the waiting CLI
   (`submitClaudeCode()`), confirms via `claude auth status`, and runs a one-shot verification
   turn to prove the connection actually works before declaring success — not just that
   credentials exist on disk (`verifyTurn()`).
5. The reconnect clears the broken-connection flag and banner immediately
   (`clearAgentAuthBroken()`), and any parked queue drains on the next turn.

The new credentials land under `$HOME/.claude` (or `~/.codex`) inside the container, which is
part of the same persistent volume as the database — a restart doesn't lose the fix. If a login
session is abandoned mid-flow, it self-expires after 15 minutes rather than leaving a stale
pending state.

## Upgrade rollback

Not covered here — pulling an older image tag against a database written by a newer one has no
defined-safe path today (no schema version stamp, no compatibility check; migrations are
additive-only by convention, not enforced). Full backup/restore/upgrade-safety design is tracked
in [issue #13](https://github.com/calandria-dev/calandria/issues/13).
