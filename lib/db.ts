import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs";
import { DB_DIR, DB_PATH, PROJECTS_DIR, SERVICE_PORT_BASE } from "./config";
import { consumeDbRecoveryAuthorization, dbLockMode } from "./db-lock.mjs";
import { SCHEMA_VERSION, schemaTooNew, schemaTooNewMessage } from "./schema-version.mjs";
import { loadPersistedApiKey } from "./anthropic-key";
import { loadPersistedOpenAiKey } from "./openai-key";

// Single shared connection. Stored outside the repo (CALANDRIA_DB_DIR, default
// ~/.calandria) so `git clean`/re-clone can't wipe it. The file is calandria.db
// on a fresh install and a pre-rename orchestrator.db wherever one already
// exists — resolved once in lib/storage.mjs, never moved. See lib/config.ts.

declare global {
  // eslint-disable-next-line no-var
  var __calandriaDb: Database.Database | undefined;
}

export function init(db: Database.Database) {
  // Before anything writes: a database stamped NEWER than this build understands
  // belongs to a version we can't reason about, and touching it is how a rolled-
  // back image tag silently eats data. server.js runs the same gate against the
  // file at boot (lib/schema-version.mjs) so the refusal is a boot failure with a
  // message; this one covers every other way a connection gets opened.
  assertSchemaVersionSupported(db);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Default is 0ms: a write racing the concurrent read-only `sqlite3` inspection
  // this design explicitly supports (lib/db-lock.mjs) throws SQLITE_BUSY
  // immediately as a 500 instead of briefly stalling. See issue #14 item 3.
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '',
      sub         TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '#C2603C',
      context     TEXT NOT NULL DEFAULT '',
      building    TEXT NOT NULL DEFAULT '',
      conventions TEXT NOT NULL DEFAULT '',
      repo_path   TEXT NOT NULL DEFAULT '',
      branch      TEXT NOT NULL DEFAULT 'main',
      -- How work is meant to LAND on that branch: 'merge' (Calandria merges the
      -- task branch locally) or 'pr' (the branch is protected, so finishing means
      -- opening a pull request). See LandingMode in lib/types.ts; the agent is
      -- told which one is true by buildProjectContext (lib/agents/shared.ts).
      landing_mode TEXT NOT NULL DEFAULT 'merge',
      -- 1 = when a task's work LANDS (its PR reports merged, or it is merged
      -- locally), reclaim its checkout without being asked: fast-forward the
      -- local base branch, remove the worktree, delete the local task branch and
      -- mark the task done. Off by default and per project, because "landed" is
      -- only a disposal signal in a repo whose landing discipline the user has
      -- actually set up. See lib/reclaim.ts.
      auto_reclaim INTEGER NOT NULL DEFAULT 0,
      -- Per-project managed services: the dev server command (long-running) plus
      -- optional one-shot setup/test commands, supervised by lib/services.ts.
      -- port is the project's stable, deterministic port (see lib/config.ts),
      -- injected as PORT into each service's env and the project's PTY shell.
      dev_command   TEXT NOT NULL DEFAULT '',
      setup_command TEXT NOT NULL DEFAULT '',
      test_command  TEXT NOT NULL DEFAULT '',
      port          INTEGER NOT NULL DEFAULT 0,
      -- Which agent driver new tasks in this project run under (lib/agents/).
      default_agent TEXT NOT NULL DEFAULT 'claude',
      -- 1 = include the saved project context in new agent sessions; the default
      -- each new task's own send_context is seeded from.
      send_context INTEGER NOT NULL DEFAULT 1,
      position    INTEGER NOT NULL DEFAULT 0,
      deprecated  INTEGER NOT NULL DEFAULT 0,
      -- 1 for the built-in "Welcome" tutorial project so it's excluded from the
      -- "instance in use" onboarding check and can be surfaced with coach marks.
      seeded      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority    TEXT NOT NULL DEFAULT 'med',
      status      TEXT NOT NULL DEFAULT 'not_started',
      suggested   INTEGER NOT NULL DEFAULT 0,
      -- The agent driver this task's sessions run under (lib/agents/registry.ts).
      agent       TEXT NOT NULL DEFAULT 'claude',
      -- 1 = prepend the saved project context to this task's sessions (seeded
      -- from the project's send_context at creation; adjustable at task start).
      send_context INTEGER NOT NULL DEFAULT 1,
      model       TEXT,
      resolved_model TEXT,
      reasoning   TEXT,
      permission_mode TEXT,
      session_id  TEXT,
      worktree_path TEXT NOT NULL DEFAULT '',
      work_branch   TEXT NOT NULL DEFAULT '',
      base_sha      TEXT NOT NULL DEFAULT '',
      -- The branch this task is based on: cut from, synced to, merged into.
      -- '' = inherit the project's default (projects.branch). Pinned by the
      -- launch paths at the moment the worktree is cut (lib/baseBranch.ts).
      base_branch   TEXT NOT NULL DEFAULT '',
      merged_at     INTEGER NOT NULL DEFAULT 0,
      pr_url        TEXT NOT NULL DEFAULT '',
      -- Live GitHub PR state, refreshed in the background from "gh pr view"
      -- (lib/prState.ts). pr_url alone was write-once display data: it says a
      -- PR exists and nothing more, so the app could never tell whether the
      -- work was still open, red, approved or already landed.
      --   pr_number  the number parsed out of pr_url at CREATE time, so nothing
      --              re-derives it per render (0 = no PR)
      --   pr_state   'open' | 'merged' | 'closed' ('' = never refreshed)
      --   pr_checks  the check rollup collapsed to what a human acts on:
      --              'pending' | 'passing' | 'failing' | 'none' (no CI at all)
      --   pr_review  gh's reviewDecision verbatim (APPROVED /
      --              CHANGES_REQUESTED / REVIEW_REQUIRED; '' = not required)
      --   pr_merged_at  when GitHub says it merged (0 = it hasn't). Distinct
      --              from merged_at, which is OUR local merge into the base
      --              branch: a PR merged on github.com never touched this box.
      --   pr_synced_at  when we last heard from GitHub — the staleness clock
      --              every refresh trigger reads before spawning gh.
      --   pr_draft   1 while the PR is a draft. Separate from pr_state, which
      --              only says open/merged/closed: a draft is open and cannot
      --              be merged by anyone, so Squash & merge must see it.
      --   pr_merge_state  gh's mergeStateStatus verbatim (CLEAN / BLOCKED /
      --              DIRTY / BEHIND / UNSTABLE / UNKNOWN; '' = unknown). DIRTY
      --              is the one that means conflicts, which no amount of
      --              waiting for CI will fix.
      --   pr_failing  JSON array of the RED entries behind pr_checks='failing'
      --              ({name,url,workflow,verdict}), '' otherwise. "checks
      --              failing" is a verdict nobody can act on; this is what
      --              names the broken job and links its run, and what seeds the
      --              "Fix CI" turn.
      pr_number     INTEGER NOT NULL DEFAULT 0,
      pr_state      TEXT NOT NULL DEFAULT '',
      pr_checks     TEXT NOT NULL DEFAULT '',
      pr_review     TEXT NOT NULL DEFAULT '',
      pr_merged_at  INTEGER NOT NULL DEFAULT 0,
      pr_synced_at  INTEGER NOT NULL DEFAULT 0,
      pr_draft      INTEGER NOT NULL DEFAULT 0,
      pr_merge_state TEXT NOT NULL DEFAULT '',
      pr_failing    TEXT NOT NULL DEFAULT '',
      generation  INTEGER NOT NULL DEFAULT 1,
      started     INTEGER NOT NULL DEFAULT 0,
      running     INTEGER NOT NULL DEFAULT 0,
      awaiting_input INTEGER NOT NULL DEFAULT 0,
      -- 1 while a live turn lingers on run_in_background work (model turn
      -- ended, session held open for the tasks to settle). Always alongside
      -- running=1; reset with it on crash recovery.
      background_pending INTEGER NOT NULL DEFAULT 0,
      -- What the linger is waiting on, phrased for the activity line ("waiting
      -- to wake at 12:00"); '' whenever background_pending is 0.
      background_note TEXT NOT NULL DEFAULT '',
      -- Opt-in pipeline behavior: 1 = start this task's first turn automatically
      -- the moment its last unfinished blocker is marked done (lib/autoStart.ts).
      auto_start  INTEGER NOT NULL DEFAULT 0,
      -- Why an agent retracted this suggestion (the withdraw_suggestion tool).
      -- Non-empty only alongside status='cancelled' AND suggested=1: the row
      -- stays in the tray, struck through, with this text as the explanation.
      -- Cleared by whatever revives the row, so it can never outlive the state
      -- it describes (PATCH /api/tasks/[id]).
      withdrawn_reason TEXT NOT NULL DEFAULT '',
      -- ms epoch of the most recent agent edit the user hasn't reviewed yet;
      -- 0 = nothing outstanding. The badge on the task card is this column, so
      -- it rides on SELECT t.* with no extra query.
      agent_edited_at INTEGER NOT NULL DEFAULT 0,
      -- When a snoozed task comes back (ms epoch; 0 = never snoozed). The whole
      -- of snoozing is this one column and the fact that the status column is
      -- left alone: ahead of now the task is drawn in the Snoozed category,
      -- behind it the task is back in its own status group wearing a "was
      -- snoozed" chip, and the user opening it clears the value to 0. Nothing
      -- sweeps this — a past deadline simply stops matching — so a wake can't
      -- be missed by an app that was shut down when it came due.
      snoozed_until INTEGER NOT NULL DEFAULT 0,
      -- When an UNATTENDED run finished cleanly and nobody has acknowledged it
      -- yet (ms epoch; 0 = nothing outstanding). A scheduled turn that succeeds
      -- deliberately leaves awaiting_input at 0 — it is not asking anybody
      -- anything — so without this column the task rested at 'in_progress'
      -- with nothing running and no path out of it, and every firing added a
      -- permanent "In progress" row (issue #28). Written by lib/runner.ts on
      -- the scheduled-success path, cleared by the next turn that starts here
      -- and by any explicit status write (PATCH /api/tasks/[id]). The status column is
      -- left alone for the same reason a snooze leaves it alone: the state is
      -- "ran, unread", not a status of its own, so acknowledging it is an
      -- ordinary status write rather than a restore.
      unread_run_at INTEGER NOT NULL DEFAULT 0,
      -- Queued to start on its own at this instant (ms epoch; 0 = not queued).
      -- The one stored fact behind "start at the usage-window reset": a server
      -- sweep (lib/deferredStart.ts) launches an unstarted task's first turn or
      -- resumes a started one once it passes, then zeroes it. Any turn launch
      -- consumes it too, so a task the user started by hand is never re-run.
      start_at INTEGER NOT NULL DEFAULT 0,
      position    INTEGER NOT NULL DEFAULT 0,
      -- Context-window occupancy as the agent's stream last reported it (the
      -- latest main-session request's input-side tokens). NULL = never
      -- measured: the gauge then falls back to the current generation's last
      -- usage row and labels itself an estimate. Reset to NULL by /clear.
      context_measured INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation  INTEGER NOT NULL DEFAULT 1,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation  INTEGER NOT NULL,
      summary     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- Follow-up messages the user typed while a turn was still running, parked
    -- FIFO per task. The runner pops the oldest one as the next turn when the
    -- current turn ends (see lib/runner.ts). Cleared on startup — a turn that
    -- was mid-flight when the process died can't be resumed, so its queue is moot.
    CREATE TABLE IF NOT EXISTS pending_messages (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation  INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    -- One row per agent session (one generation of a task). Lets us show every
    -- session that ran under a project. claude_session_id is the agent's own
    -- opaque session/thread id (named for the first driver; a Codex thread id
    -- lands in the same column) — the app only stores and resumes it, never
    -- interprets it.
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation        INTEGER NOT NULL,
      claude_session_id TEXT,
      started_at        INTEGER NOT NULL,
      ended_at          INTEGER,
      UNIQUE(task_id, generation)
    );

    -- One row per completed Claude turn, carrying the SDK result message's
    -- token usage + dollar cost. Cumulative spend per task/project is SUM(...).
    CREATE TABLE IF NOT EXISTS task_usage (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      generation            INTEGER NOT NULL,
      -- NULLable, and the NULL is load-bearing: it means "this endpoint's price
      -- is unknown", which is a different fact from a measured zero. See the
      -- provider column below and ProviderPricing in lib/agentEnv.ts. Every
      -- aggregate sums this column, so an unpriced turn contributes nothing to
      -- a total instead of dragging it down with an invented $0.00.
      cost_usd              REAL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL
    );

    -- Agent work performed outside a task chat: summaries, recaps, context
    -- drafts, and connection verification. Deliberately has no foreign keys so
    -- deleting a project/task does not erase historical overhead spend.
    CREATE TABLE IF NOT EXISTS internal_usage (
      id                    TEXT PRIMARY KEY,
      job                   TEXT NOT NULL,
      agent                 TEXT NOT NULL,
      requested_agent       TEXT NOT NULL,
      fallback              INTEGER NOT NULL DEFAULT 0,
      project_id            TEXT,
      task_id               TEXT,
      ok                    INTEGER NOT NULL DEFAULT 1,
      ms                    INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL NOT NULL DEFAULT 0,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL
    );

    -- One row per successful merge that actually landed commits (re-merges of an
    -- already-merged branch don't record). additions/deletions are the line
    -- stats of what that merge introduced on the base branch — captured at merge
    -- time because worktrees (the only other source of diff stats) are deleted
    -- with their task. Feeds the Insights "code merged per day" charts.
    CREATE TABLE IF NOT EXISTS task_merges (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent      TEXT NOT NULL DEFAULT 'claude',
      additions  INTEGER NOT NULL DEFAULT 0,
      deletions  INTEGER NOT NULL DEFAULT 0,
      merged_at  INTEGER NOT NULL
    );

    -- Task ordering: a task "depends on" (is blocked by) another. While any
    -- depends_on_id task isn't 'done', the dependent task is shown as blocked and
    -- can't be started. Both sides cascade-delete with their task. CREATE IF NOT
    -- EXISTS means older DBs pick this up automatically — no migrate() entry needed.
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_id)
    );

    -- The audit trail behind the "edited by an agent" chip: one row per
    -- update_task write that used to be refused (not the caller's own row, not
    -- an unreviewed tray suggestion) and now goes through, on a task the user
    -- already accepted. actor_* denormalizes the calling session rather than
    -- foreign-keying tasks(id), because the calling task can be deleted long
    -- after this edit happened and the diff panel must still say who made it.
    -- changes is JSON (AgentEditChange[] — see lib/types.ts). reverted_at is
    -- 0 until the user presses Revert on this specific edit.
    CREATE TABLE IF NOT EXISTS task_agent_edits (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      project_id    TEXT NOT NULL,
      actor_task_id TEXT NOT NULL DEFAULT '',
      actor_title   TEXT NOT NULL DEFAULT '',
      actor_agent   TEXT NOT NULL DEFAULT '',
      changes       TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      reverted_at   INTEGER NOT NULL DEFAULT 0,
      acknowledged_at INTEGER NOT NULL DEFAULT 0
    );

    -- What a task's agent-configuration files looked like the last time a turn
    -- was allowed to run under them (issue #43). One row per (task, file), where
    -- 'file' is worktree-relative and comes from the driver's own
    -- watchedSettingsFiles — today '.claude/settings.json', which the Claude CLI
    -- re-reads on every turn and whose 'hooks' run shell commands outside the
    -- permission gate entirely. The runner hashes the file before each turn and
    -- holds the turn on a card when the hash moved (lib/settingsDrift.ts).
    --
    -- Its own table rather than a column on tasks: 'content' is the acknowledged
    -- copy, kept so the card can show a real diff rather than "something
    -- changed", and listTasks selects t.* straight onto the wire — a settings
    -- file per task card is not something the board should be shipping. hash is
    -- over the FULL file even when content was too big to keep, so an oversize
    -- file still compares correctly; content is '' in that case.
    -- CREATE IF NOT EXISTS means older DBs pick it up with no migrate() entry.
    CREATE TABLE IF NOT EXISTS task_settings_snapshots (
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      file       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      content    TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, file)
    );

    -- Remembered "always allow" answers to a tool-permission prompt (the
    -- canUseTool gate under acceptEdits / plan — see lib/permissions.ts).
    -- Project-scoped on purpose: approving "npm test" for one repo must not
    -- approve it everywhere. match_kind is 'bash_prefix' (leading command
    -- tokens) or 'bash_exact' (one literal command line) — Bash-only, because a
    -- command is the one tool input a user can read in full and generalize.
    -- CREATE IF NOT EXISTS means older DBs pick it up with no migrate() entry.
    CREATE TABLE IF NOT EXISTS permission_rules (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tool       TEXT NOT NULL,
      match_kind TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, tool, match_kind, value)
    );

    -- A recurring prompt: "run /jira-tasks at 08:30 on weekdays". Project-keyed
    -- and deliberately its OWN table rather than a column on a task row, so a
    -- schedule outlives the tasks it mints (each firing creates a fresh one).
    -- time_of_day is wall clock in 'timezone', which is an IANA zone name and
    -- never an offset — the offset changes twice a year and the wall time must
    -- not. next_fire_at is a CACHE of lib/schedule/time.ts, recomputed on edit,
    -- after each firing, and revalidated on boot (tzdata moves).
    CREATE TABLE IF NOT EXISTS schedules (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      days_mask       INTEGER NOT NULL,          -- Sun=1 … Sat=64; weekdays = 62
      time_of_day     TEXT NOT NULL,             -- 'HH:MM'
      timezone        TEXT NOT NULL,             -- IANA zone
      enabled         INTEGER NOT NULL DEFAULT 1,
      agent           TEXT NOT NULL DEFAULT 'claude',
      permission_mode TEXT,
      send_context    INTEGER NOT NULL DEFAULT 1,
      priority        TEXT NOT NULL DEFAULT 'med',
      catch_up_ms     INTEGER NOT NULL DEFAULT -1, -- -1 = use the instance default
      once_date       TEXT NOT NULL DEFAULT '',    -- 'YYYY-MM-DD' = fire once then spend; '' = weekly
      next_fire_at    INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    -- One row per OCCURRENCE, including the ones that never ran. Without the
    -- non-firing rows a schedule that quietly stopped looks exactly like one
    -- that had nothing to do, which is the failure this feature must not have.
    --
    -- UNIQUE(schedule_id, scheduled_for) is the DURABLE CLAIM: it is what makes
    -- a double fire impossible when two ticks overlap, when a tick races "Run
    -- now", or when a restart re-adjudicates a slot it already handled. A
    -- select-then-insert check is racy; this is not.
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id            TEXT PRIMARY KEY,
      schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      scheduled_for INTEGER NOT NULL,
      claimed_at    INTEGER NOT NULL,
      fired_at      INTEGER NOT NULL DEFAULT 0,
      finished_at   INTEGER NOT NULL DEFAULT 0,
      task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      status        TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      detail        TEXT NOT NULL DEFAULT '',
      dst_adjusted  TEXT NOT NULL DEFAULT '',
      UNIQUE(schedule_id, scheduled_for)
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, scheduled_for DESC);

    -- A saved task-launch preset: "push everything unpushed and babysit CI".
    -- Project-keyed and its OWN table for the same reason schedules are one —
    -- it outlives every task it dispatches, and each Run MINTS A FRESH TASK.
    --
    -- This is a schedules row with the clock taken off, which is why the two
    -- share lib/dispatch.ts. What it deliberately does NOT have is a run
    -- ledger: a schedule needs one because an occurrence that never fired at
    -- 08:30 leaves no other trace, whereas a dispatch produces a visible task
    -- immediately. "Last run" is a tasks.runbook_id query, and denormalized
    -- counters would start lying the first time a minted task is deleted.
    CREATE TABLE IF NOT EXISTS runbooks (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',   -- becomes the minted task's brief
      prompt          TEXT NOT NULL,              -- the minted task's first USER message
      agent           TEXT NOT NULL DEFAULT 'claude',
      permission_mode TEXT,
      send_context    INTEGER NOT NULL DEFAULT 1,
      priority        TEXT NOT NULL DEFAULT 'med',
      position        INTEGER NOT NULL DEFAULT 0,
      -- '' = the user wrote it; otherwise the agent id that filed it via
      -- create_runbook. Provenance only — a runbook is inert until someone
      -- presses Run, so an agent-created one needs no review tray.
      created_by      TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runbooks_project ON runbooks(project_id);

    -- A named, project-scoped label a task can carry — the noun a multi-task
    -- feature was missing (docs/superpowers/specs/2026-08-27-tags-design.md;
    -- its one-per-task ancestor is the task-grouping spike from 2026-08-24).
    -- Deliberately NOT a task: no session, no worktree, no status of its own.
    -- Status is derived per read from the members (done when every member is
    -- terminal), never stored, so a deleted task can't leave it stale.
    -- UNIQUE(project_id, name) is what makes exact-name resolution from an
    -- agent unambiguous; a rename collision is a 409. origin_task_id is
    -- provenance — the planning session that filed the tag — and SET NULL
    -- because deleting the plan must not delete the set it named. Membership
    -- lives in task_tags below, not in a column on tasks: a task carries as
    -- many tags as it has reasons to.
    CREATE TABLE IF NOT EXISTS tags (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT NOT NULL DEFAULT '',
      color          TEXT,                       -- optional badge tint (hex), from the project palette
      origin_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      position       INTEGER NOT NULL DEFAULT 0, -- chip order; created_at order for now
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_tags_project ON tags(project_id);

    -- Which tasks carry which tags. CASCADE on both ends: deleting a tag
    -- untags its members (it never deletes them — a tag is a label over work,
    -- not the work), and deleting a task takes its rows with it. "position" is
    -- the order this task's tags render and inject their context in, so a task
    -- whose primary tag is the auth migration says so first.
    CREATE TABLE IF NOT EXISTS task_tags (
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);

    -- App-level key/value preferences that must be readable server-side (e.g. the
    -- default reasoning level + permission mode a task inherits when it hasn't
    -- overridden them). Distinct from the browser-local UI settings in localStorage.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Web Push subscriptions (lib/push/store.ts), one row per BROWSER that
    -- enabled push in Settings → Notifications. endpoint is the push service's
    -- per-subscription URL and is the identity: a browser re-subscribing
    -- (page load re-sync, pushsubscriptionchange) upserts on it. Not tied to a
    -- user: an instance is single-user, so every row hears every notification.
    -- last_status/last_error are the most recent delivery's answer, kept so the
    -- device list can show a subscription that is failing rather than silently
    -- keeping a dead one; a 404/410 (the push service says it's gone) deletes
    -- the row outright.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id              TEXT PRIMARY KEY,
      endpoint        TEXT NOT NULL UNIQUE,
      p256dh          TEXT NOT NULL,
      auth            TEXT NOT NULL,
      expiration_time INTEGER,
      label           TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      last_sent_at    INTEGER NOT NULL DEFAULT 0,
      last_status     INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT NOT NULL DEFAULT ''
    );

    -- Persisted service registry (lib/services.ts writes through to this).
    -- Processes never survive a restart; these rows do — so a managed dev server
    -- (desired_state='running') is auto-restarted on boot and its public URL
    -- (slug--<host>) stays stable. slug is the public hostname label, globally
    -- UNIQUE because the hostname carries no project. An expose_service entry
    -- (managed=0 — we don't own the command) persists for URL/visibility
    -- continuity only and is never auto-started.
    CREATE TABLE IF NOT EXISTS services (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      kind          TEXT NOT NULL,
      command       TEXT NOT NULL DEFAULT '',
      port          INTEGER NOT NULL DEFAULT 0,
      managed       INTEGER NOT NULL DEFAULT 1,
      desired_state TEXT NOT NULL DEFAULT 'stopped',  -- 'running' | 'stopped'
      visibility    TEXT NOT NULL DEFAULT 'private',  -- 'private' | 'shared' | 'public'
      share_token   TEXT NOT NULL DEFAULT '',
      -- pid of the spawned process group leader while a managed service runs
      -- (0 = not running). Persisted so boot can detect and reap a process
      -- group orphaned by a server crash before respawning on the same port.
      pid           INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );

    -- Review comments on a task's diff (Changes tab). CREATE IF NOT EXISTS means
    -- older DBs pick this up automatically — no migrate() entry needed.
    CREATE TABLE IF NOT EXISTS task_comments (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      file          TEXT NOT NULL,
      -- 'old' or 'new' — which diff column's line numbering this anchors to
      -- (old/new are independent counters, so a bare line number collides).
      side          TEXT NOT NULL DEFAULT 'new',
      line_start    INTEGER NOT NULL,
      line_end      INTEGER NOT NULL,
      body          TEXT NOT NULL,
      sent_to_agent INTEGER NOT NULL DEFAULT 0,
      -- The diff's HEAD when this was written (NULL for pre-migration rows).
      -- TaskChanges only inlines a comment when this matches the live diff.
      anchor_sha    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

    -- Passage comments from the document collaboration modal: task_comments'
    -- document twin, anchored by the selected text + nearest heading instead
    -- of a line number, and stamped with the FILE's blob sha rather than the
    -- worktree HEAD (see TaskDocComment in lib/types.ts). Persisted so a
    -- review survives a reload; sent rows are never edited or deleted.
    CREATE TABLE IF NOT EXISTS task_doc_comments (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      file          TEXT NOT NULL,
      quote         TEXT NOT NULL,
      heading       TEXT,
      body          TEXT NOT NULL,
      sent_to_agent INTEGER NOT NULL DEFAULT 0,
      anchor_sha    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_doc_comments_task ON task_doc_comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_services_project ON services(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on_id);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_pending_task ON pending_messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_task ON summaries(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_usage_task ON task_usage(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_usage_project ON task_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_internal_usage_created ON internal_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_task_merges_project ON task_merges(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_merges_task ON task_merges(task_id);
    CREATE INDEX IF NOT EXISTS idx_permission_rules_project ON permission_rules(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_agent_edits_task ON task_agent_edits(task_id, created_at);
  `);

  migrate(db);

  // Crash recovery runs only for the process that OWNS this database, and only
  // on the boot that claimed it — see recoverFromCrash().
  if (consumeDbRecoveryAuthorization(DB_DIR)) recoverFromCrash(db);

  seedIfEmpty(db);
  ensureOnboardingFlag(db);

  // Re-apply a persisted Anthropic API key (the "I have a key instead" path) to
  // this process's env so the SDK's claude children inherit it after a restart.
  loadPersistedApiKey();
  // Same for a persisted OpenAI API key (the Codex "I have a key instead" path)
  // so the `codex` children pick it up.
  loadPersistedOpenAiKey();
}

/**
 * Clear the wreckage a dead process left behind: turns that will never finish,
 * follow-ups queued behind them, permission cards nobody can answer, and
 * schedule runs stuck mid-flight.
 *
 * Every statement here is destructive, and every one of them is destructive
 * against a LIVE instance too — which is why this is gated on owning the
 * database rather than run unconditionally at boot. Before the boot lock
 * existed, starting a second process while the first was mid-turn wiped the
 * first's running flags, dropped its queued follow-ups and settled cards a
 * human was still looking at, all silently. See lib/db-lock.mjs.
 *
 * One transaction: these four facts describe a single moment (the state the
 * predecessor died in), and a crash halfway through recovery would leave a
 * database that is neither the old truth nor the new one.
 */
function recoverFromCrash(db: Database.Database) {
  db.transaction(() => {
    // Reset any stale "running" flags left over from a crash/restart. A linger
    // (background_pending) is in-memory state of the dead process's CLI child
    // exactly like running is, so it resets in the same breath — the work it
    // described died with that process.
    db.prepare("UPDATE tasks SET running = 0, background_pending = 0, background_note = '' WHERE running = 1 OR background_pending = 1").run();
    // Drop any queued follow-ups: the turns they were lined up behind died with
    // the previous process, so there's nothing left to dequeue them.
    db.prepare("DELETE FROM pending_messages").run();
    settleOpenCards(db);

    reapInFlightScheduleRuns(db);
  })();
}

/**
 * Settle every interactive card the previous process left parked on the user.
 *
 * A permission card with no `outcome` and a question card with neither
 * `answers` nor `dismissed` are the same fact: the turn that opened them died
 * with that process, and the registry it would have been answered through
 * (lib/asks.ts) lives in memory, so no answer can ever reach them. Left alone
 * they render live buttons — indistinguishable from a card somebody is actually
 * waiting on — and pressing one resolves nothing: POST /answer returns
 * `resolved: false` and the pick lands as an ordinary message into a fresh
 * turn, which is not what the card offered.
 *
 * The question card is marked DISMISSED rather than given answers, because a
 * transcript must never claim the user said something they did not. That is the
 * same distinction `PermissionOutcome.auto` draws on the other card.
 *
 * (`json_valid` guards the handful of tool rows that predate JSON content;
 * `json_extract` would raise on those. The `dismissed IS NULL` clause is also
 * what backfills rows written before that field existed, on first boot.)
 *
 * Exported so tests can drive it directly; recoverFromCrash above is the only
 * production caller.
 */
export function settleOpenCards(db: Database.Database): { permissions: number; asks: number } {
  const permissions = db
    .prepare(
      `UPDATE messages
          SET content = json_set(content, '$.permission.outcome',
                json('{"decision":"deny","auto":true,"reason":"interrupted","note":"The app restarted before this was answered."}'))
        WHERE role = 'tool'
          AND content LIKE '%"permission"%'
          AND json_valid(content)
          AND json_extract(content, '$.permission.request.id') IS NOT NULL
          AND json_extract(content, '$.permission.outcome') IS NULL`
    )
    .run().changes;
  const asks = db
    .prepare(
      `UPDATE messages
          SET content = json_set(content, '$.ask.dismissed',
                json('{"reason":"restarted","note":"Not answered \u2014 the app restarted before an answer arrived."}'))
        WHERE role = 'tool'
          AND content LIKE '%"ask"%'
          AND json_valid(content)
          AND json_extract(content, '$.ask.id') IS NOT NULL
          AND json_extract(content, '$.ask.answers') IS NULL
          AND json_extract(content, '$.ask.dismissed') IS NULL`
    )
    .run().changes;
  return { permissions, asks };
}

/**
 * Settle any schedule run left mid-flight by the previous process.
 *
 * The same class of reason as the `tasks.running` reset above, and it lives
 * beside it for the same reason: the turn that owned the row died with that
 * process, and nothing else will ever come back for it. Here the consequence is
 * worse than a stuck spinner, because a `claimed`/`running` row is what
 * isScheduleBusy() reads for overlap detection: a row orphaned in the launch
 * window (a crash between claimRun and startRun — the whole preflight, CLI
 * probe included) makes the schedule look permanently busy, so every later
 * occurrence records `skipped_overlap`, and the card's Stop control is gated on
 * the blocking run having a task_id, which this one never got. The schedule
 * goes quiet until retention prunes the row ~50 occurrences later.
 *
 * Deliberately here rather than in startScheduler(): this runs once per process
 * before anything can read the ledger, whereas startScheduler() is skipped
 * entirely when CALANDRIA_SCHEDULER is off — the one configuration where nothing
 * else would ever clear the wedge, while the API still serves it.
 *
 * Exported so tests/scheduleStore.test.ts can drive it directly;
 * recoverFromCrash above is the only production caller.
 */
export function reapInFlightScheduleRuns(db: Database.Database): number {
  const info = db
    .prepare(
      `UPDATE schedule_runs
          SET status = 'interrupted',
              detail = CASE WHEN detail = '' THEN 'the app restarted while this run was in flight' ELSE detail END,
              finished_at = ?
        WHERE status IN ('claimed', 'running') AND finished_at = 0`
    )
    .run(Date.now());
  return info.changes;
}

// The first-run wizard shows when `onboarding_complete` is unset. A brand-new DB
// leaves it unset (just the single seed project) so the wizard runs; an existing
// in-use instance — one with real history — is marked complete so an upgrade
// never drops a returning user back into onboarding.
function ensureOnboardingFlag(db: Database.Database) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'onboarding_complete'").get();
  if (row) return;
  const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
  // "In use" ignores the built-in Welcome project (seeded = 1): a fresh instance
  // has only that, and must still see the wizard. Any real project, or any run
  // history, means this is an upgrade of a live instance — skip onboarding.
  const inUse =
    n("SELECT COUNT(*) AS n FROM sessions") > 0 ||
    n("SELECT COUNT(*) AS n FROM task_usage") > 0 ||
    n("SELECT COUNT(*) AS n FROM projects WHERE seeded = 0") > 0;
  if (inUse) db.prepare("INSERT INTO settings (key, value) VALUES ('onboarding_complete', '1')").run();
}

/**
 * Refuse a database stamped by a build that knew more about the schema than
 * this one does. See lib/schema-version.mjs for why this is a refusal and not a
 * warning; the message is shared with the boot-time gate in server.js so an
 * operator reads the same words wherever the refusal surfaces.
 *
 * Older-or-equal proceeds untouched — that's every ordinary upgrade, and the
 * additive migrations below are what make it safe.
 */
export function assertSchemaVersionSupported(db: Database.Database) {
  const found = db.pragma("user_version", { simple: true }) as number;
  if (schemaTooNew(found)) throw new Error(schemaTooNewMessage(found, DB_PATH));
}

// Add columns introduced after a DB was first created (older database files).
export function migrate(db: Database.Database) {
  const cols = (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, def: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
  };
  add("sub", "TEXT NOT NULL DEFAULT ''");
  add("color", "TEXT NOT NULL DEFAULT '#C2603C'");
  add("context", "TEXT NOT NULL DEFAULT ''");
  add("branch", "TEXT NOT NULL DEFAULT 'main'");
  // How work lands on that branch (lib/types.ts LandingMode). 'merge' is right
  // for every pre-existing project: it is exactly what they were already doing,
  // and the ruleset probe (lib/github.ts detectLandingMode) only ever PRESELECTS
  // a different answer in the settings form for a human to save.
  add("landing_mode", "TEXT NOT NULL DEFAULT 'merge'");
  // Reclaim the checkout automatically once work lands (lib/reclaim.ts). 0 for
  // every pre-existing project: an unattended reclaim deletes a local branch,
  // and no upgrade may start doing that on the strength of a default.
  add("auto_reclaim", "INTEGER NOT NULL DEFAULT 0");
  add("recap", "TEXT NOT NULL DEFAULT ''");
  add("recap_at", "INTEGER NOT NULL DEFAULT 0");
  add("recap_covers_at", "INTEGER NOT NULL DEFAULT 0");
  // Provider override for the project's turns (lib/agentEnv.ts): JSON over an
  // allowlist of the env keys the two CLIs read to pick an endpoint and model,
  // so a project can run against Ollama / LM Studio without a new driver.
  // '' = no override, the agent's own cloud login — every pre-existing project.
  add("agent_env", "TEXT NOT NULL DEFAULT ''");
  add("deprecated", "INTEGER NOT NULL DEFAULT 0");
  add("seeded", "INTEGER NOT NULL DEFAULT 0");
  // Per-project managed-services config + the project's deterministic port.
  add("dev_command", "TEXT NOT NULL DEFAULT ''");
  add("setup_command", "TEXT NOT NULL DEFAULT ''");
  add("test_command", "TEXT NOT NULL DEFAULT ''");
  add("port", "INTEGER NOT NULL DEFAULT 0");
  // Backfill a stable port for every project still on 0, in creation order, so an
  // existing instance picks up deterministic ports without a clash. New projects
  // are assigned their port at creation (see store.ts createProject).
  const unported = db.prepare("SELECT id FROM projects WHERE port = 0 ORDER BY created_at ASC, id ASC").all() as { id: string }[];
  if (unported.length) {
    const maxRow = db.prepare("SELECT COALESCE(MAX(port), 0) AS n FROM projects").get() as { n: number };
    let next = Math.max(maxRow.n, SERVICE_PORT_BASE - 1) + 1;
    const setPort = db.prepare("UPDATE projects SET port = ? WHERE id = ?");
    db.transaction(() => { for (const p of unported) setPort.run(next++, p.id); })();
  }
  // Detached "Refresh with AI" job state (drafting now runs in the background,
  // not inside the HTTP request — see lib/contextRefresh.ts).
  add("refresh_status", "TEXT NOT NULL DEFAULT 'idle'");  // idle | running | done | error
  add("refresh_draft", "TEXT NOT NULL DEFAULT ''");       // drafted context awaiting review
  add("refresh_error", "TEXT NOT NULL DEFAULT ''");
  add("refresh_started_at", "INTEGER NOT NULL DEFAULT 0");
  // Agent-driver seam (lib/agents/): which driver new tasks default to. Every
  // pre-seam project ran Claude, so the column default backfills correctly.
  add("default_agent", "TEXT NOT NULL DEFAULT 'claude'");
  // Whether new sessions get the saved project context. Default 1 preserves the
  // always-included behavior for existing projects.
  add("send_context", "INTEGER NOT NULL DEFAULT 1");
  // Manual sidebar ordering. Backfill in creation order so existing projects
  // keep the order they had when this column was the implicit sort.
  if (!cols.includes("position")) {
    db.exec("ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE projects SET position = (
        SELECT COUNT(*) FROM projects p2
        WHERE p2.created_at < projects.created_at
           OR (p2.created_at = projects.created_at AND p2.id < projects.id)
      )
    `);
  }
  // Fold legacy building+conventions into the unified context field where empty.
  // One-shot: gated on a persisted settings marker so it runs at most once, ever.
  // Without the guard this re-ran on EVERY boot, and because updateProject never
  // clears building/conventions, a user who intentionally emptied a project's
  // context would silently have it refilled from stale legacy text each restart.
  if (cols.includes("building") && !db.prepare("SELECT 1 FROM settings WHERE key = 'migrated_building_fold'").get()) {
    db.prepare(
      `UPDATE projects SET context = TRIM(building || CASE WHEN conventions != '' THEN char(10) || conventions ELSE '' END)
       WHERE context = '' AND (building != '' OR conventions != '')`
    ).run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated_building_fold', '1')").run();
  }

  // Per-task git worktree isolation columns (added after first release).
  const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes("worktree_path")) db.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("work_branch")) db.exec("ALTER TABLE tasks ADD COLUMN work_branch TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("base_sha")) db.exec("ALTER TABLE tasks ADD COLUMN base_sha TEXT NOT NULL DEFAULT ''");
  // Per-task base branch (see the CREATE TABLE note). '' on every pre-existing
  // row reads as "inherit from the project", so an existing database keeps
  // behaving exactly as it did: there is no data to move and no index to add,
  // since nothing queries by base branch.
  if (!taskCols.includes("base_branch")) db.exec("ALTER TABLE tasks ADD COLUMN base_branch TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("merged_at")) db.exec("ALTER TABLE tasks ADD COLUMN merged_at INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("awaiting_input")) db.exec("ALTER TABLE tasks ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0");
  // Background-linger state (see BACKGROUND_LINGER_MS in lib/config.ts).
  if (!taskCols.includes("background_pending")) db.exec("ALTER TABLE tasks ADD COLUMN background_pending INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("background_note")) db.exec("ALTER TABLE tasks ADD COLUMN background_note TEXT NOT NULL DEFAULT ''");
  // Per-task model selection (NULL = inherit Claude's default) and the model the
  // SDK actually resolved for the last turn (shown as a badge in the chat).
  if (!taskCols.includes("model")) db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
  if (!taskCols.includes("resolved_model")) db.exec("ALTER TABLE tasks ADD COLUMN resolved_model TEXT");
  // Per-task run controls (added after model selection): thinking preset + permission mode.
  if (!taskCols.includes("reasoning")) db.exec("ALTER TABLE tasks ADD COLUMN reasoning TEXT");
  if (!taskCols.includes("permission_mode")) db.exec("ALTER TABLE tasks ADD COLUMN permission_mode TEXT");
  // Per-task provider override, laid over the project's (lib/agentEnv.ts). This
  // is how a frontier-model session delegates a task to a local model, or a
  // task in a local-model project is sent back to the cloud. '' = inherit.
  if (!taskCols.includes("agent_env")) db.exec("ALTER TABLE tasks ADD COLUMN agent_env TEXT NOT NULL DEFAULT ''");
  // Agent-driver seam: which driver runs this task's sessions. Every pre-seam
  // task ran Claude, so the column default backfills existing rows correctly.
  if (!taskCols.includes("agent")) db.exec("ALTER TABLE tasks ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
  // GitHub PR opened from this task's branch via "Create PR" ("" = none yet).
  if (!taskCols.includes("pr_url")) db.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT NOT NULL DEFAULT ''");
  // Live PR state (see the CREATE TABLE note). The defaults are the honest
  // reading for every pre-existing row: we have never asked GitHub about them.
  if (!taskCols.includes("pr_number")) db.exec("ALTER TABLE tasks ADD COLUMN pr_number INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("pr_state")) db.exec("ALTER TABLE tasks ADD COLUMN pr_state TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("pr_checks")) db.exec("ALTER TABLE tasks ADD COLUMN pr_checks TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("pr_review")) db.exec("ALTER TABLE tasks ADD COLUMN pr_review TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes("pr_merged_at")) db.exec("ALTER TABLE tasks ADD COLUMN pr_merged_at INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("pr_synced_at")) db.exec("ALTER TABLE tasks ADD COLUMN pr_synced_at INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("pr_draft")) db.exec("ALTER TABLE tasks ADD COLUMN pr_draft INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes("pr_merge_state")) db.exec("ALTER TABLE tasks ADD COLUMN pr_merge_state TEXT NOT NULL DEFAULT ''");
  // Which checks are red (see the CREATE TABLE note). '' on every existing row
  // is honest for the same reason the others' defaults are: the rollup we
  // stored a verdict from was never kept, so the next refresh fills it in.
  if (!taskCols.includes("pr_failing")) db.exec("ALTER TABLE tasks ADD COLUMN pr_failing TEXT NOT NULL DEFAULT ''");
  // pr_number IS derivable from the URL we already stored, so backfill it here
  // rather than leaving old rows at 0 until someone re-clicks Create PR. Runs
  // over the handful of rows that have a URL and no number, so it is a no-op on
  // every boot after the first. The other columns can't be backfilled — only
  // GitHub knows them — and the refresh triggers fill them on first sight.
  db.exec(
    `UPDATE tasks SET pr_number = CAST(substr(pr_url, instr(pr_url, '/pull/') + 6) AS INTEGER)
     WHERE pr_url LIKE '%/pull/%' AND pr_number = 0`
  );
  // Per-task "send saved project context" flag (default 1 = the old always-on
  // behavior; seeded from the project's send_context for tasks created later).
  if (!taskCols.includes("send_context")) db.exec("ALTER TABLE tasks ADD COLUMN send_context INTEGER NOT NULL DEFAULT 1");
  // Per-task auto-start opt-in: launch the first turn when the last blocker is
  // marked done (default off preserves the old never-auto-start behavior).
  if (!taskCols.includes("auto_start")) db.exec("ALTER TABLE tasks ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0");
  // Why an agent withdrew a tray suggestion (lib/agentTools withdrawSuggestionForAgent).
  // Empty on every pre-existing row, which is correct: nothing was ever withdrawn before.
  if (!taskCols.includes("withdrawn_reason")) db.exec("ALTER TABLE tasks ADD COLUMN withdrawn_reason TEXT NOT NULL DEFAULT ''");
  // Agent-edit chip (see the CREATE TABLE note + task_agent_edits). 0 is the
  // honest value for every pre-existing row: nothing was recorded before this
  // column existed, so there's nothing outstanding to flag.
  if (!taskCols.includes("agent_edited_at")) db.exec("ALTER TABLE tasks ADD COLUMN agent_edited_at INTEGER NOT NULL DEFAULT 0");
  // Per-row "Keep changes" stamp (see TaskAgentEdit.acknowledged_at). 0 on
  // every pre-existing row: an edit acked before the column existed reads as
  // outstanding again, which costs one extra ack and loses nothing.
  const editCols = (db.prepare("PRAGMA table_info(task_agent_edits)").all() as { name: string }[]).map((c) => c.name);
  if (!editCols.includes("acknowledged_at")) db.exec("ALTER TABLE task_agent_edits ADD COLUMN acknowledged_at INTEGER NOT NULL DEFAULT 0");
  // Measured context-window occupancy (see the schema comment). No backfill:
  // NULL is the honest value for every pre-existing row, and is exactly what
  // routes the gauge to the usage-derived estimate it showed before.
  if (!taskCols.includes("context_measured")) db.exec("ALTER TABLE tasks ADD COLUMN context_measured INTEGER");
  // Which schedule minted this task (lib/scheduler.ts). SET NULL rather than
  // cascade — deleting a schedule must not delete the work it produced.
  if (!taskCols.includes("schedule_id")) db.exec("ALTER TABLE tasks ADD COLUMN schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL");
  // When a snoozed task comes back (see the CREATE TABLE note). 0 on every
  // pre-existing row is exactly right — nothing was ever snoozed before — and
  // because the state is derived from the value rather than stored beside it,
  // there is no companion column to backfill consistently.
  if (!taskCols.includes("snoozed_until")) db.exec("ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0");
  // Unacknowledged clean unattended run (see the CREATE TABLE note). 0 on every
  // pre-existing row deliberately: backfilling the scheduled tasks already
  // stranded in "In progress" would resurface months of finished runs as an
  // unread pile, and the state is about the run that just happened.
  if (!taskCols.includes("unread_run_at")) db.exec("ALTER TABLE tasks ADD COLUMN unread_run_at INTEGER NOT NULL DEFAULT 0");
  // Queued-to-start deadline (see the CREATE TABLE note). 0 on every existing
  // row is right for the same reason as snoozed_until: nothing was queued.
  if (!taskCols.includes("start_at")) db.exec("ALTER TABLE tasks ADD COLUMN start_at INTEGER NOT NULL DEFAULT 0");
  // Which runbook dispatched this task (lib/dispatch.ts). Same SET NULL for the
  // same reason — and it is also what "last run" is read from, since runbooks
  // deliberately keep no ledger of their own.
  if (!taskCols.includes("runbook_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN runbook_id TEXT REFERENCES runbooks(id) ON DELETE SET NULL");
  }
  // Created here rather than in the schema block above: on an older DB that
  // block runs BEFORE this ALTER, so indexing the column there fails with
  // "no such column: runbook_id".
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_runbook ON tasks(runbook_id)");
  // Groups became TAGS: the container a task could be in ONE of is now a label
  // it can carry several of (docs/superpowers/specs/2026-08-27-tags-design.md).
  // The schema block above has already created the empty `tags` + `task_tags`
  // tables, so this is a copy-then-drop rather than a rename: every group
  // becomes a tag with its id intact (so origin_task_id, and any id a user
  // bookmarked, still resolve), and every `tasks.group_id` becomes the one row
  // that task has in task_tags. The column goes with the old table — leaving it
  // behind would give two answers to "which tags does this task carry", and the
  // stale one would be the one SQLite kept updating on nothing.
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
  );
  if (tables.has("task_groups")) {
    db.exec(
      `INSERT OR IGNORE INTO tags (id, project_id, name, description, color, origin_task_id, position, created_at, updated_at)
       SELECT id, project_id, name, description, color, origin_task_id, position, created_at, updated_at FROM task_groups`
    );
    if (taskCols.includes("group_id")) {
      // EXISTS rather than a join for the FK's sake: a group_id pointing at a
      // row that never made it across would be refused by task_tags' own FK.
      db.prepare(
        `INSERT OR IGNORE INTO task_tags (task_id, tag_id, position, created_at)
         SELECT t.id, t.group_id, 0, ? FROM tasks t
         WHERE t.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM tags g WHERE g.id = t.group_id)`
      ).run(Date.now());
      // SQLite refuses to drop an indexed column, so the index goes first.
      db.exec("DROP INDEX IF EXISTS idx_tasks_group");
      db.exec("ALTER TABLE tasks DROP COLUMN group_id");
    }
    db.exec("DROP INDEX IF EXISTS idx_task_groups_project");
    db.exec("DROP TABLE task_groups");
  }
  // The recorded agent edits that named the old field. `update_task`'s revert
  // path switches on `field`, so a row left saying "group" would render a
  // field that no longer exists and revert to nothing at all — silently. The
  // scalar becomes the one-element list `tags` now carries.
  const legacyEdits = db
    .prepare("SELECT id, changes FROM task_agent_edits WHERE changes LIKE '%\"field\":\"group\"%'")
    .all() as { id: string; changes: string }[];
  if (legacyEdits.length) {
    const upd = db.prepare("UPDATE task_agent_edits SET changes = ? WHERE id = ?");
    for (const row of legacyEdits) {
      try {
        const changes = JSON.parse(row.changes) as { field: string; before_value?: unknown; after_value?: unknown }[];
        for (const c of changes) {
          if (c.field !== "group") continue;
          c.field = "tags";
          c.before_value = typeof c.before_value === "string" && c.before_value ? [c.before_value] : [];
          c.after_value = typeof c.after_value === "string" && c.after_value ? [c.after_value] : [];
        }
        upd.run(JSON.stringify(changes), row.id);
      } catch {
        // Unparseable history is history: the chip renders what it can and the
        // revert refuses, which is what it already did for a malformed row.
      }
    }
  }
  // An optional link from a schedule to the runbook it fires, so "the morning
  // sweep" is one recipe edited in one place. SET NULL is the FK's answer;
  // deleteRunbook() gets there first and copies the recipe back into the
  // schedule (lib/runbooks/store.ts), because a schedule left with no prompt
  // fires nothing every morning and says nothing about why.
  const schedCols = (db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]).map((c) => c.name);
  if (!schedCols.includes("runbook_id")) {
    db.exec("ALTER TABLE schedules ADD COLUMN runbook_id TEXT REFERENCES runbooks(id) ON DELETE SET NULL");
  }
  // One-time schedules (lib/schedule/time.ts). '' on every pre-existing row is
  // exactly right: they are all weekly, and '' is already what the recurring
  // path means by "no date pinned".
  if (!schedCols.includes("once_date")) db.exec("ALTER TABLE schedules ADD COLUMN once_date TEXT NOT NULL DEFAULT ''");
  // A tag's DEFAULT base branch: where a whole plan's tasks are cut from, set
  // once instead of N times (phase 2 of the per-task base branch design). Same
  // '' = inherit convention as tasks.base_branch, so every existing row keeps
  // behaving exactly as it does today. Read AFTER the task_groups → tags
  // migration above, so a database arriving on the old table gets the column
  // too. A task carrying several tags takes the base from the first one that
  // sets it, in task_tags.position order — see lib/baseBranch.ts.
  const tagCols = (db.prepare("PRAGMA table_info(tags)").all() as { name: string }[]).map((c) => c.name);
  if (!tagCols.includes("base_branch")) db.exec("ALTER TABLE tags ADD COLUMN base_branch TEXT NOT NULL DEFAULT ''");
  // Manual task ordering (list groups + board columns both render in position
  // order). Backfill matches the sort that was implicit before the column
  // existed — priority then created_at, per project — so an upgrade doesn't
  // visibly reshuffle anyone's list.
  if (!taskCols.includes("position")) {
    db.exec("ALTER TABLE tasks ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE tasks SET position = (
        SELECT COUNT(*) FROM tasks t2
        WHERE t2.project_id = tasks.project_id
          AND (
            (CASE t2.priority WHEN 'hi' THEN 0 WHEN 'med' THEN 1 ELSE 2 END)
              < (CASE tasks.priority WHEN 'hi' THEN 0 WHEN 'med' THEN 1 ELSE 2 END)
            OR ((CASE t2.priority WHEN 'hi' THEN 0 WHEN 'med' THEN 1 ELSE 2 END)
                  = (CASE tasks.priority WHEN 'hi' THEN 0 WHEN 'med' THEN 1 ELSE 2 END)
                AND (t2.created_at < tasks.created_at
                     OR (t2.created_at = tasks.created_at AND t2.id < tasks.id)))
          )
      )
    `);
  }

  // Orphan-reaping pid tracking for managed services (added after the services
  // table shipped; see lib/services.ts restoreServices).
  const svcCols = (db.prepare("PRAGMA table_info(services)").all() as { name: string }[]).map((c) => c.name);
  if (!svcCols.includes("pid")) db.exec("ALTER TABLE services ADD COLUMN pid INTEGER NOT NULL DEFAULT 0");

  // Side-qualified, diff-versioned comment anchors (added after task_comments
  // shipped). Existing rows get side='new' (the old single-namespace behavior
  // treated every anchor as one bucket, which is closest to 'new') and a NULL
  // anchor_sha, which TaskChanges renders as outdated rather than guessing.
  const commentCols = (db.prepare("PRAGMA table_info(task_comments)").all() as { name: string }[]).map((c) => c.name);
  if (!commentCols.includes("side")) db.exec("ALTER TABLE task_comments ADD COLUMN side TEXT NOT NULL DEFAULT 'new'");
  if (!commentCols.includes("anchor_sha")) db.exec("ALTER TABLE task_comments ADD COLUMN anchor_sha TEXT");

  // Which driver produced each usage row, stamped at write time (Insights breaks
  // spend down by provider). Backfilled from the task's current agent — exact
  // for every pre-existing row since tasks couldn't switch agents until now.
  const usageCols = (db.prepare("PRAGMA table_info(task_usage)").all() as { name: string }[]).map((c) => c.name);
  if (!usageCols.includes("agent")) {
    db.exec("ALTER TABLE task_usage ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE task_usage SET agent = COALESCE((SELECT t.agent FROM tasks t WHERE t.id = task_usage.task_id), 'claude') WHERE agent = ''");
  }
  // Subagent (Task-tool sidechain) tokens, which the other four columns never
  // counted. Deliberately NULLable with no backfill: old rows were written
  // before the figure was measured, and defaulting them to 0 would assert every
  // historical fan-out spent nothing rather than admitting it wasn't recorded.
  if (!usageCols.includes("subagent_tokens")) {
    db.exec("ALTER TABLE task_usage ADD COLUMN subagent_tokens INTEGER");
  }
  // Which endpoint the turn ran against: '' for the agent's own cloud (every
  // row before this shipped, and every row since with no override), else the
  // override's host[:port] ("localhost:11434"). What the row is WORTH follows
  // from that host — a local model server bills nothing (cost_usd = 0, a
  // measurement), a custom base URL bills something nobody has told us
  // (cost_usd IS NULL) — and this column is what lets Insights tell all three
  // apart. See ProviderPricing in lib/agentEnv.ts.
  if (!usageCols.includes("provider")) {
    db.exec("ALTER TABLE task_usage ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
  }

  // cost_usd shipped NOT NULL DEFAULT 0, which left no way to say "unknown".
  // Every turn against ANY provider override was written 0, so an instance
  // pointing the custom-base-URL preset at a PAID third party (OpenRouter,
  // Together, a Bedrock or Vertex proxy, a hosted vLLM) had every one of those
  // turns silently billed at nothing. Widening the column to NULLable is the
  // whole fix at this layer: SUM() skips NULLs, so an unpriced turn stops
  // contributing a fake zero to a total the moment the runner writes one.
  //
  // SQLite cannot drop NOT NULL in place, so this is the documented 12-step
  // table rebuild, narrowed to what applies: foreign keys OFF (they cannot be
  // toggled inside a transaction, and the rename would otherwise be seen by the
  // enforcement machinery mid-flight), rebuild in one transaction, keys back
  // ON. Existing rows keep their recorded 0 rather than being reinterpreted as
  // unknown: we know what those turns were written as, we do not know what they
  // would have cost, and rewriting history from a schema migration would be a
  // guess dressed as a correction. Only turns from here on carry the new fact.
  const costCol = (db.prepare("PRAGMA table_info(task_usage)").all() as { name: string; notnull: number }[])
    .find((c) => c.name === "cost_usd");
  if (costCol && costCol.notnull) {
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec("ALTER TABLE task_usage RENAME TO task_usage_old");
        db.exec(`
          CREATE TABLE task_usage (
            id                    TEXT PRIMARY KEY,
            project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            generation            INTEGER NOT NULL,
            cost_usd              REAL,
            input_tokens          INTEGER NOT NULL DEFAULT 0,
            output_tokens         INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            created_at            INTEGER NOT NULL,
            agent                 TEXT NOT NULL DEFAULT '',
            subagent_tokens       INTEGER,
            provider              TEXT NOT NULL DEFAULT ''
          );
        `);
        // Column-named on both sides: the old table's column ORDER depends on
        // which of the three ALTERs above a given database has already run.
        db.exec(`
          INSERT INTO task_usage
            (id, project_id, task_id, generation, cost_usd, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, created_at, agent, subagent_tokens, provider)
          SELECT id, project_id, task_id, generation, cost_usd, input_tokens, output_tokens,
                 cache_read_tokens, cache_creation_tokens, created_at, agent, subagent_tokens, provider
            FROM task_usage_old ORDER BY rowid;
        `);
        db.exec("DROP TABLE task_usage_old");
        // The rename took the indexes with it; the CREATE INDEX IF NOT EXISTS
        // pass above already ran this boot, so recreate them here.
        db.exec("CREATE INDEX IF NOT EXISTS idx_task_usage_task ON task_usage(task_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_task_usage_project ON task_usage(project_id)");
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  // The agent thread's last reported CUMULATIVE token counters, as JSON. Only
  // drivers whose usage reporting is cumulative-per-thread need it (Codex
  // re-reports the whole thread's totals on every turn.completed), so a turn's
  // own usage is the delta against this baseline — see lib/agents/codex/events.ts.
  const sessCols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!sessCols.includes("usage_cum")) {
    db.exec("ALTER TABLE sessions ADD COLUMN usage_cum TEXT");
    // Seed the baseline for codex threads that already ran: every usage row they
    // recorded WAS a cumulative report, so the newest one is the thread's total
    // so far. Without this, the first turn after upgrading would re-bill the
    // whole thread one last time. (Rows written before the agent column exists
    // are covered by the backfill above, which runs first.) The output side of a
    // codex report can't be split back into plain vs reasoning tokens, so it
    // seeds as a single output figure — worst case that costs one turn its
    // output tokens, never a double charge on the much larger input side.
    db.exec(`
      UPDATE sessions SET usage_cum = (
        SELECT json_object(
                 'input', u.input_tokens, 'cachedInput', u.cache_read_tokens,
                 'cacheWrite', u.cache_creation_tokens, 'output', u.output_tokens, 'reasoning', 0)
          FROM task_usage u
         WHERE u.task_id = sessions.task_id AND u.generation = sessions.generation AND u.agent = 'codex'
         ORDER BY u.created_at DESC, u.rowid DESC LIMIT 1
      )
      WHERE claude_session_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM task_usage u2
                     WHERE u2.task_id = sessions.task_id AND u2.generation = sessions.generation AND u2.agent = 'codex');
    `);
  }

  // Backfill the sessions table from existing message history (one row per
  // task generation). Idempotent via UNIQUE(task_id, generation) + OR IGNORE,
  // so it only ever fills gaps for sessions that predate the sessions table.
  db.exec(`
    INSERT OR IGNORE INTO sessions (id, project_id, task_id, generation, claude_session_id, started_at, ended_at)
    SELECT lower(hex(randomblob(10))), t.project_id, m.task_id, m.generation,
           CASE WHEN m.generation = t.generation THEN t.session_id ELSE NULL END,
           MIN(m.created_at), MAX(m.created_at)
    FROM messages m JOIN tasks t ON t.id = m.task_id
    WHERE m.role IN ('user', 'assistant', 'tool')
    GROUP BY m.task_id, m.generation;
  `);

  // Last, and only once everything above has actually run: stamp what this
  // build made of the file, so a LATER build that is OLDER than this one
  // refuses to open it instead of writing to a schema it doesn't know
  // (assertSchemaVersionSupported above, and the boot gate in server.js).
  // Stamping unconditionally rather than only when it differs — it's a header
  // write, and a pre-stamp database reads back 0 and has to be moved forward.
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// The built-in tutorial. A brand-new instance gets a "Welcome" project backed by
// a real (tiny) repo plus two tasks that teach the whole loop — start a session,
// answer a question, review a diff, merge — before the user touches their own
// code. It's an ordinary project: deletable, and it never comes back (the
// persistent `seed_done` flag guards against a re-seed after it's removed, even
// if the projects table is momentarily empty again).
function seedIfEmpty(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  if (count.n > 0) return;
  const done = db.prepare("SELECT value FROM settings WHERE key = 'seed_done'").get();
  if (done) return;

  const now = Date.now();
  const pid = nanoid();

  // Scaffold the tiny site into PROJECTS_DIR so diffs/merges are real. If it
  // fails (permissions, read-only home), the project is still created but with a
  // blank repo_path, so the app never crashes on first boot — the user just sets
  // a working directory themselves.
  const repoPath = scaffoldWelcomeRepo();

  db.prepare(
    `INSERT INTO projects (id, name, icon, sub, color, context, repo_path, branch, port, seeded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    pid,
    "Welcome",
    "W",
    "start here",
    "#C2603C",
    WELCOME_CONTEXT,
    repoPath,
    "main",
    SERVICE_PORT_BASE,
    now
  );

  const seedTask = (title: string, description: string, priority: string, suggested: number) =>
    db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, description, priority, status, suggested, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?)`
      )
      .run(nanoid(), pid, title, description, priority, suggested, now, now);

  // The hands-on task: it drives the full loop in one turn — a question, a
  // one-file edit, a diff to review, a one-click merge. Its title + description
  // become the injected task context, so the steps are written as instructions
  // to the agent.
  seedTask("Try me: add a tagline", TUTORIAL_TASK_DESC, "hi", 0);
  // A pre-loaded "suggested" task so the tray isn't empty — this is exactly what
  // a Claude session drops there when it proposes follow-up work.
  seedTask(
    "Add a dark-mode toggle",
    "Give Aurora a light/dark theme toggle: a small button that flips the page between a light and a dark palette and remembers the choice. Touch index.html and styles.css (and a little JS if you need it).",
    "med",
    1
  );

  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_done', '1')").run();
  // Remember which project is the tutorial so the client can surface coach marks
  // and the post-merge nudge for it (also derivable from projects.seeded = 1).
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_project_id', ?)").run(pid);
}

// Claude-facing project context for the Welcome tutorial. Describes the actual
// scaffolded repo (so the session behaves), with one line of framing. The
// heavier "how Calandria works" teaching lives in the UI coach marks, not here.
const WELCOME_CONTEXT =
  "Aurora is a tiny one-page website, a placeholder landing page. The repo has just three files: " +
  "index.html (the page), styles.css (its styling), and README.md. It's intentionally minimal so " +
  "every change is small and easy to review.\n\n" +
  "This \"Welcome\" project is a guided tour of Calandria. Starting the task on the right runs a real " +
  "Claude session end to end. It streams its tool calls, asks you a question, makes a small change, " +
  "and hands you a diff to review and merge, all in your own workspace. When you're comfortable, " +
  "delete this project and add one for your real codebase.";

const TUTORIAL_TASK_DESC =
  "This is a 2-minute hands-on tour of Calandria. It walks the whole loop in one session.\n\n" +
  "Please do exactly this:\n" +
  "1. First, ask me which tagline style I'd like using a question with a few options: for example, " +
  "Playful, Professional, and Minimal. Wait for my answer before editing.\n" +
  "2. Read index.html, then add a single short tagline line directly under the <h1> headline, in the " +
  "style I chose. Keep the change to that one file so the diff is tiny.\n" +
  "3. Tell me in one sentence what you changed, and that it's ready to review in the Changes tab and merge.\n\n" +
  "Keep it small. One line of copy is perfect.";

// Write the Aurora demo site into PROJECTS_DIR/welcome. Returns the path, or ""
// if anything goes wrong (best-effort; must never throw — runs during DB init).
function scaffoldWelcomeRepo(): string {
  try {
    const dir = path.join(PROJECTS_DIR, "welcome");
    // Don't clobber an existing folder — a prior boot may have created it, and it
    // could already be a git repo with the user's tutorial edits.
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(WELCOME_FILES)) {
        fs.writeFileSync(path.join(dir, name), body);
      }
    }
    return dir;
  } catch {
    return "";
  }
}

// The scaffolded site. Deliberately plain HTML/CSS (no build step) so a task's
// edit produces a clean, readable one-file diff. index.html has no tagline yet —
// that's what "Try me: add a tagline" fills in, right under the <h1>.
const WELCOME_FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aurora</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="hero">
      <h1>Aurora</h1>
      <!-- A tagline goes here -->
      <a class="cta" href="#">Get started</a>
    </main>
  </body>
</html>
`,
  "styles.css": `:root {
  --bg: #faf7f2;
  --ink: #2a2622;
  --muted: #6b645c;
  --accent: #c2603c;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg);
  color: var(--ink);
}

.hero {
  text-align: center;
  padding: 48px;
}

.hero h1 {
  margin: 0;
  font-size: 56px;
  letter-spacing: -0.02em;
}

.tagline {
  margin: 12px 0 0;
  font-size: 18px;
  color: var(--muted);
}

.cta {
  display: inline-block;
  margin-top: 28px;
  padding: 12px 22px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  font-weight: 600;
}
`,
  "README.md": `# Aurora

A tiny one-page site used for the Calandria welcome tour. Three files, no build step:

- \`index.html\`: the page
- \`styles.css\`: the styling
- \`README.md\`: this file

Small on purpose, so every change is easy to read and merge.
`,
};

export function getDb(): Database.Database {
  if (!global.__calandriaDb) {
    // Create the app-data home on first run (idempotent).
    fs.mkdirSync(DB_DIR, { recursive: true });
    const db = new Database(DB_PATH);
    try {
      init(db);
    } catch (err) {
      // init() can refuse outright (a database from a newer build), and an
      // unusable connection must not be left open holding the file.
      db.close();
      throw err;
    }
    global.__calandriaDb = db;
    warnIfUnowned();
  }
  return global.__calandriaDb;
}

/**
 * server.js claims the database before it serves anything (lib/db-lock.mjs), so
 * a production process opening it read/write WITHOUT that claim reached the DB
 * some other way — a bare `next start`, a stray script — and is exactly the
 * second writer the lock exists to stop. It gets a warning rather than a throw:
 * the same code path is how `next build` and the test suite legitimately open a
 * database they should never claim, and failing those closed would cost more
 * than this catches. Skipped entirely under the CALANDRIA_DB_LOCK=off escape hatch,
 * which is a deliberate choice to run unguarded.
 */
function warnIfUnowned() {
  if (process.env.NODE_ENV !== "production") return;
  if (dbLockMode(DB_DIR) !== "unowned") return;
  console.warn(
    `[db] WARN: opened ${DB_PATH} without holding the boot lock. If another Calandria ` +
      `process is running against this database, the two will corrupt each other's task ` +
      `state. Start the app via server.js, which claims the lock before serving.`
  );
}
