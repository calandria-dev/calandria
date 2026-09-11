<div align="center">

![Calandria](docs/design/og.png)

### Run Claude Code, Codex and Antigravity in parallel across every project, from any browser.

Calandria is a self-hosted web control room for your coding agents. Run it
on your laptop or a server and use the same workspace from your computer,
tablet, or phone. Every task gets its own persistent agent session in its
own git worktree. Your existing Claude Max, Pro, or ChatGPT subscription
covers it. No API key needed.

[**calandria.dev**](https://calandria.dev) · [**Docs**](https://calandria.dev/docs) · [**Run locally**](#run-locally) · [**Self-host**](docs/SELF_HOSTING.md) · [**Request a feature**](https://github.com/calandria-dev/calandria/discussions/categories/ideas)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-8A2BE2.svg)](CONTRIBUTING.md)

![Calandria workspace showing projects and parallel agent tasks](docs/images/workspace.png)

</div>

## Why Calandria

- **Use it from anywhere.** Deploy once, then manage agents from any device
  with a browser.
- **Run many tasks without juggling terminals.** Each task has its own
  worktree, branch, transcript, and agent session.
- **Know where you're needed.** A cross-project inbox lists the sessions
  waiting for an answer while the rest keep working.
- **Review every change.** Read the diff next to the conversation, then
  merge, resolve conflicts, or open a pull request. Once a PR exists, its
  state (open, merged or closed, checks green or red, review approved or
  not) stays live on the task, so you don't need to open GitHub, and one
  button squash-merges it from there. Where the repo allows auto-merge, that
  click queues it and GitHub lands the PR the moment its checks pass.
- **Catch a red build.** A PR whose checks go red raises its task into the
  same "Needs you" inbox a parked question does, names the job that broke,
  and offers a one-click Fix CI that starts a turn seeded with the failing
  job's log, even on a task already marked done.
- **Start from the latest base.** Calandria fetches the base branch before
  cutting a task's worktree, so a PR merged on GitHub doesn't leave new tasks
  building on stale code. It also tells you when your own checkout has fallen
  behind.
- **Point a task at any branch.** A task can use its own base branch instead
  of the project default: it's cut from it, synced to it, merged into it, and
  PR'd against it. Several tasks can land on one feature branch while the
  rest keep shipping to `main`. A tag can set that branch for a whole plan.
  It shows when the branch has fallen behind the project default ("3 behind
  main"), with a Sync that merges the default into it, and a Create for a
  base branch nothing has made yet. Left alone, an integration branch
  drifts, and every task cut from it starts stale.
- **Say how work lands.** A project lands by merge or by pull request, and
  every session in it is told which. On a repo whose base branch requires a
  PR, agents stop reaching for a Merge that GitHub will reject, and so does
  the diff rail: Create PR becomes the primary button, and the local merge
  says up front that it can't be pushed. Calandria can read the branch's rules
  from GitHub and preselect the answer. A PR a session opened by hand, in a
  terminal, is linked to its task at the end of the turn, so it gets the same
  chip, state polling and reclaim as one opened through the app.

## How it works

1. Create tasks and, if you like, chain them into a pipeline.
2. Calandria gives each task an isolated worktree and starts it when its
   dependencies finish.
3. It alerts you when a session needs an answer.
4. You review the diff and merge.

![Task board with a tagged three-step pipeline and auto-start chips](docs/images/board.png)

Project context is written once and sent into each task. Turns run on the
server and transcripts are saved, so a browser reload or a sleeping laptop
doesn't interrupt anything. `/clear` starts a fresh context window and keeps
the task's history as a summary.

Each session is told to push bulk context collection into subagents. After two
read-only commands in a row, the third goes to a subagent instead, which
reports back its conclusions and `file:line`s rather than pouring file
contents into the session's own context window. This overrides the CLI's own
default, which runs that work directly in the shell and leaves subagents
unused unless you ask for one; the private notes repo's
[DELEGATION.md](https://github.com/calandria-dev/calandria-notes/blob/main/measurements/DELEGATION.md)
has the measurement behind it. Set `CALANDRIA_DELEGATE_COLLECTION=off` to leave
sessions on the CLI's defaults.

When a Claude turn starts background shell work or schedules a wakeup
(`ScheduleWakeup`, `CronCreate`, `/loop`), the session stays open after the
model stops. The task shows "working in background" or "waiting to wake at
12:00" with its age; when the work finishes or the wakeup fires, the agent
continues. No deadline applies by default, so a recurring `/loop` holds the
session open until you stop it. `CALANDRIA_BACKGROUND_LINGER_MS` adds an
optional auto-cut (a wakeup past it is cancelled and noted in the
transcript), and `CALANDRIA_BACKGROUND_LINGER=off` disables lingering and
reports every pending wakeup as cancelled at the end of the turn. A message
you send while a session is lingering goes straight in and starts the next
turn instead of waiting in the queue.

Because that wait has no deadline, a session can also sit live and silent
waiting on something that already finished: a poll against a dead service, a
watcher loop that never exits. After 20 minutes with no output and no tool
call, the task card and the session show "no activity for 34m" beside the
running indicator. Calandria doesn't stop the turn for you, since the server
can't tell a wedged wait from a slow one and cutting a real 40-minute test run
would be worse. It's also not a "needs you" item, since nothing needs an
answer. The card's one action is a **Stop this turn** chip below that line: it
arms on the first press and stops on the second, since a stray click is easy
to make on a list. The session view carries no such chip; the composer's Stop
covers it, next to the transcript to judge against. `CALANDRIA_TURN_IDLE_MS`
moves the window, and 0 turns the note off. A turn parked on a question or a
permission card is never marked, since that wait is meant to be open-ended.

By default, the session gets no nudge about this. Set
`CALANDRIA_TURN_IDLE_NUDGE=1` and a turn that goes quiet is sent one line
asking it to recheck what it's waiting on. This fires at most once per turn,
only while the session is lingering (a build or tool call in flight is never
interrupted), never on a scheduled run, and never ahead of a message you've
already queued. The transcript records that it was sent.

## What you get

- **Parallel, isolated tasks:** work across several repositories without
  agents mixing files or branches.
- **Repair a worktree in one click:** a turn never runs in your real
  checkout, so a task whose worktree can't be prepared stops instead. When
  the cause is stale git bookkeeping (a lock file from a crashed git, a
  worktree still registered at a directory that's gone), the error says so
  and offers **Repair worktree**: it clears the lock, prunes the
  registration, cuts the checkout again, and re-sends the message. Calandria
  names causes you have to fix yourself (a full disk, a detached HEAD) just
  as plainly, including on unattended scheduled runs.
- **Agent settings can't change behind your back:** Claude Code re-reads a
  task's `.claude/settings.json` at the start of every turn, and its hooks run
  shell commands with no permission prompt. That file lives in the task's own
  worktree, so a turn could write what the next turn obeys. Calandria checks it
  before each turn and, if it changed since the turn that ran last, holds the
  turn on a card showing the diff. Approve it and the turn runs; decline and it
  ends before the agent starts. Unattended and scheduled runs always decline.
- **Web-based and self-hostable:** run Calandria on your own machine or
  server and reach the same workspace from desktop or mobile.
- **One "Needs you" inbox:** jump to any session waiting for an answer.

  ![The Needs you inbox listing sessions waiting on an answer across projects](docs/images/inbox.png)

- **Snooze a task:** park it until an hour from now, tomorrow morning, or a
  date you pick. It stops counting toward the inbox, then returns to the
  category it left, marked as snoozed.
- **Start at the usage-window reset:** when a subscription limit stops your
  turns, queue a task to start (or a stalled session to resume) a minute
  after the reset the plan meter reports. This runs server-side with no tab
  open. Settings → Run defaults can queue that resume for you whenever a turn
  dies on the limit, per agent, off by default.
- **Persistent context:** reuse project knowledge and continue long-running
  work across fresh context windows.
- **Review-to-merge workflow:** inspect diffs, sync branches, resolve
  conflicts, merge, or open a GitHub PR from the same screen.
- **Attach any file:** drag, paste or pick a screenshot, a log bundle, a
  spreadsheet, or a PDF, up to 25 MB (`CALANDRIA_MAX_UPLOAD_MB`). The file is
  staged on disk outside the worktree and the message carries only its path,
  so nothing lands in the model's context until the agent opens it, and
  nothing lands in your diff. Staged files are swept with the task. The New
  task and Edit task dialogs take the same attachments on the task itself
  (drag, paste, or the Attach files button under the description); each one
  is named as a line in the description, and shown as a thumbnail or file
  chip on the task header and a paperclip count on its board card.
- **Collaborate on documents:** open a file the agent wrote as a document
  (mermaid fences render as diagrams), or click a file link in any message,
  then edit the text, attach comments to passages, and send it all back as
  one message. Calandria saves comments,
  edits and the general note as you go, so a reload or closing the modal
  loses nothing, and writes your edits straight into the task's worktree
  (default) or sends them as a diff for the agent to apply. Open it from the
  diff or from the Write/Edit card in the transcript.
- **Task pipelines:** make a task depend on one or more earlier tasks,
  branch work into parallel paths, and start each task automatically when
  its blockers finish.
- **Tags:** name the feature a task belongs to ("Auth migration", "0.4
  release") and filter the list or board by tag, one or several at once
  (union by default, intersection behind an any/all toggle). Each task shows
  a tinted badge per tag, progress comes from the tasks, and finished tags
  fold away. One lit chip expands into a strip with the tag's brief and its
  steps in dependency order, plus **Refresh tag**: an agent reads the whole
  plan against the code, rewords briefs that point at things that no longer
  exist, retires work the repo shows is already done, and rewrites the
  description. Every task change arrives as a revertable "Changed by agent"
  edit, and the job keeps running if you navigate away. ⌘K, the project page,
  and the Insights leaderboard all reach a tag by name. A tag can also set the git **base
  branch** its tasks are cut from, merged into, and synced against, so a
  five-task feature is pointed at `feature/auth` once. Each session is told
  which plan it belongs to and which step it is.
- **Runbooks:** save a task you run often ("push everything unpushed and
  babysit CI", "sweep my Jiras and report") as a named recipe and dispatch it
  in one click. Each run creates a fresh task, with a box for this-run-only
  instructions.
- **Scheduled tasks:** run a saved prompt on a recurring day and time in its
  own timezone, with nobody logged in, or **once** on a date you pick, for
  the "there's a release overnight, check on it at 04:00" job. Each firing
  creates a fresh task you review like any other, and a schedule can fire a
  runbook so one recipe serves both the clock and the button. A run that
  finished cleanly lands in **Ran clean**, its own group outside the "needs
  you" pill, with a Mark done button.

  ![Project page with a tag, two runbooks, and a weekday schedule](docs/images/project.png)

- **Notifications:** when a task stops and waits for you, when a turn fails,
  when a scheduled run fails, and when a start queued for the usage-window
  reset fires or is skipped. Calandria delivers these as a browser
  notification in any open tab and as a push to your phone with the app
  closed, and stays silent only when you're already looking at that task.
- **Installable app:** a PWA with its own icon and standalone window. Install
  from Chrome/Edge or iOS Add to Home Screen, and the "needs you" inbox lives
  on your phone's home screen (needs HTTPS; works behind Cloudflare Access).
  Settings → Diagnostics keeps a page-lifecycle log for an installed app that
  comes back unresponsive; see
  [the troubleshooting guide](docs/TROUBLESHOOTING.md#ios-home-screen-app-comes-back-frozen).
- **Desktop app:** a native shell for macOS, Windows and Linux with a tray
  icon, OS notifications and a dock badge. It runs a server of its own, and it
  can also attach to servers you host elsewhere: a URL behind Cloudflare
  Access, a LAN origin, or an SSH port-forward. Each instance keeps its own
  login, the badge counts what needs you across all of them, and a
  notification says which instance it came from.
  ([Connecting the desktop app](docs/SELF_HOSTING.md#connecting-the-desktop-app))
- **Built for a phone:** one pane at a time with a Board / Diffs / Terminals /
  Insights tab bar, a full-screen terminal sheet, and a project screen
  (recap, tags, runbooks, schedules) one tap from the task list.
- **A complete workspace:** chat, terminal, managed services, live logs, and
  token and usage insights in one place, including a live session/week
  plan-usage meter for a Claude Pro/Max or ChatGPT login.
- **Update notifications:** a titlebar pill when a newer release exists, with
  the release notes behind it and the upgrade steps for how this instance was
  installed. The server does the checking, six-hourly, so no browser tab calls
  github.com, and `CALANDRIA_UPDATE_CHECK=off` turns it off.
  ([Update notifications](docs/SELF_HOSTING.md#update-notifications))

<p align="center">
  <img src="docs/images/mobile-tasks.png" width="300" alt="Task list on a phone">
  &nbsp;&nbsp;
  <img src="docs/images/mobile.png" width="300" alt="A session waiting on an answer, on a phone">
</p>

![Calandria diff review beside an agent session](docs/images/changes.png)

[All features](docs/FEATURES.md)

## Supported agents

Calandria supports **Claude Code**, **OpenAI Codex** and Google's **Antigravity**
(the CLI behind Gemini) end to end. Choose an agent per task, or connect only the
one you use. All three work with subscription login, and API keys stay
optional, except in a container, where Antigravity needs one because its CLI
stores its token in the OS keyring. The same five permission modes apply to
every agent: a Codex task maps them onto Codex's sandbox and approval policy,
its approval requests land on the same permission card a Claude prompt does,
and a sandboxed Codex turn can still commit from its worktree. On a Linux
host that blocks the user namespaces Codex's sandbox needs, Settings →
Agents says so on the Codex card with the fix, and refuses the sandboxed
modes instead of running turns whose every command fails.

[Agent support, permissions, and usage details](docs/AGENTS.md)

### Local models

Either agent can run against a local model server. Set a project's **Model
provider** to *Local model*, point it at Ollama (`http://localhost:11434`) or
LM Studio (`http://localhost:1234`), name a model, and every task in that
project runs there: Claude Code through `ANTHROPIC_BASE_URL`, Codex through a
provider entry Calandria adds for the turn. The model picker becomes a text box
that suggests whatever the server reports it has, and Settings → Agents says
whether that server is answering. A local turn is recorded at zero cost, because
a model served off your own machine really is free. A **Custom base URL** may
not be, so its turns are recorded as *unpriced* rather than $0. They're left
out of every total, and the figures that omit them say so. Neither shows a
context percentage: the window of a model the catalog has never seen is not
knowable, so the chip reports tokens used instead. A cloud session can also
delegate a single task to the local model with
`suggest_task`'s `provider: "local"`. Set `CALANDRIA_LOCAL_MODEL_BASE_URL` once
for a Docker instance.

[Recipes and the allowlist](docs/AGENTS.md#local-models)

### LiteLLM gateway

A [LiteLLM](https://docs.litellm.ai) proxy is a fourth **Model provider**, on the same seam as the others, with no new driver needed. Set `CALANDRIA_LITELLM_BASE_URL` and a project routes its turns through the gateway.

Two billing modes:

- Billed to the gateway's own virtual key.
- Billed to your own plan, with the CLI's login forwarded through the gateway.

Every turn carries tags naming the project, task and agent, so LiteLLM's spend views break down by task on their own. A Claude task also joins to LiteLLM's spend log by session id, with no configuration needed on either side. Codex and Antigravity tasks route through the gateway too, each on the credential its own CLI reads, always billed to the gateway key.

Settings → Agents shows whether the gateway answers, which LiteLLM version it runs, how many models it serves, and the key's own spend, budget and reset time. When the proxy has no database, it says so plainly, since it then has no keys, budgets or spend to report.

A turn that exceeds the key's budget parks its queued follow-ups and offers a Retry, the same as a dead login, instead of retrying into the same rejection. Gateway spend is an estimate from the gateway's own price table, marked `≈` in Insights, where a cache-hit column also shows whether prompt caching survived the proxy's translation.

[Setup, billing modes and the two caveats](docs/AGENTS.md#litellm-gateway)

### Preparing a project for parallel tasks

Every task is its own git worktree, so it starts from a checkout holding
tracked files and nothing else: no `.env`, no `node_modules`, no build
output. Several run at once. Repos that assume one copy of themselves on the
machine hit this as port collisions, a shared dev database, or a first turn
spent working out how to install dependencies.

The `worktree-ready` skill in [`skills/`](skills/) audits a repository for
these problems and proposes the repo-side fixes. It works in Claude Code and
Codex:

```bash
scripts/install-skills.sh          # both agents, user scope
```

Then ask a task in that project whether it's ready to run five at a time.

## Run locally

You need Node 22+ on macOS, Linux, or Windows, and at least one supported
agent CLI.

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3000>. The first-run wizard connects Claude Code or
Codex and walks you through a short tutorial.

Windows runs natively with the same three commands. It needs Windows 10
1809+ or Server 2019+ (for ConPTY, which the terminal uses), Git for Windows
on PATH, and Node 22+. The typecheck, unit, and end-to-end suites all run on
`windows-latest` in CI. WSL2 also works; it runs the Linux build unchanged.
See [Windows setup, both ways](docs/INSTALLATION.md#windows).

Prefer a container? A multi-arch image (`linux/amd64` + `linux/arm64`) is
published publicly. `latest` is the newest tagged release; `edge` tracks
nightly builds of `main`.

```bash
docker pull ghcr.io/calandria-dev/calandria:latest
```

Use `npm run dev` only when developing Calandria itself. For Docker tags and
provenance, authentication, networking, and secure remote access, see the
[self-hosting guide](docs/SELF_HOSTING.md). To layer site-specific CLIs and
config on top of the published image, start from
[`examples/overlay/`](examples/overlay/).

### One instance per database

Calandria locks `calandria.db` at boot and won't start if another
process already owns it, naming the holder. Two servers sharing one database
would overwrite each other's running tasks. Give a second instance its own
`CALANDRIA_DB_DIR`.

### Disk usage

The database does not grow forever. A retention sweep runs on the schedule
ticker and removes the record of **finished** tasks: transcripts, review
comments, retired sessions, and staged attachments after 180 days, spend
rows after 400 (longer, so Insights keeps its full 180-day range). It then
checkpoints the WAL so the space is reclaimed. Live tasks are never touched.
`CALANDRIA_RETENTION=off` keeps everything. The windows and the opt-in
`VACUUM` are in the [self-hosting guide](docs/SELF_HOSTING.md).

Per-task worktrees are the bigger disk cost (a full checkout each) and have
their own switch. Calandria warns in the log and in Settings → Storage once
the worktrees directory passes `CALANDRIA_WORKTREES_DISK_WARN_GB` (default
20). Reclaiming them in bulk is manual unless you set
`CALANDRIA_WORKTREE_RETENTION=on`, which removes the checkouts of finished
tasks after 14 days. It never deletes the branch, and it skips (and names)
any checkout holding uncommitted edits or unmerged commits.

The prompt case doesn't wait on a clock. When a task's work **lands** (its
pull request reports merged, or Calandria merged the branch locally), the
session header offers **Reclaim**: fast-forward the local base branch from
origin, remove the worktree, delete the local branch and mark the task done,
in one click. Project settings can have the server do that by itself (off by
default). Neither path discards uncommitted edits, or commits the remote
never saw, without you confirming it.

### Backups and upgrades

`npm run backup` takes a hot backup with the app running: a WAL-safe
`VACUUM INTO` snapshot of the database plus uploads, keys, and the agent CLI
logins, in one timestamped archive. Don't `cp` a live SQLite database. See
[Backup & restore](docs/SELF_HOSTING.md#backup--restore) for the flags, the
cold-copy alternative, and the restore procedure.

Take a backup before upgrading, because upgrades only run one way. Each
build stamps the database with the schema version it understands, and an
older build pointed at a database a newer one already migrated won't boot. Rolling back means re-pinning the previous image tag *and* restoring
that backup. See [Rolling back an
upgrade](docs/SELF_HOSTING.md#rolling-back-an-upgrade).

## Privacy

Calandria has no telemetry and no analytics. It makes no outbound requests
you didn't configure. Network traffic comes from your agents, your git
remotes, and your own integrations.

## Community

- [Request a feature or share an idea](https://github.com/calandria-dev/calandria/discussions/categories/ideas)
- [Ask a question](https://github.com/calandria-dev/calandria/discussions/categories/q-a)
- [Report a bug](https://github.com/calandria-dev/calandria/issues/new?template=bug_report.yml)
- [Contribute](CONTRIBUTING.md)

See [COMMUNITY.md](docs/COMMUNITY.md) for where each kind of conversation
belongs.

## Documentation

Everything below is also published, rendered and searchable, at
[**calandria.dev/docs**](https://calandria.dev/docs): the same files, so
either reader is current.

- [Installation and local development](docs/INSTALLATION.md)
- [Features](docs/FEATURES.md)
- [Document collaboration](docs/DOCUMENT_COLLABORATION.md)
- [Agents](docs/AGENTS.md)
- [Insights and usage](docs/INSIGHTS.md)
- [Managed services](docs/SERVICES.md)
- [Bundled agent skills](skills/README.md)
- [Self-hosting](docs/SELF_HOSTING.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Windows: native and WSL2 setup](docs/INSTALLATION.md#windows) · [platform notes](docs/WINDOWS.md)
- [Desktop app spike](docs/DESKTOP_APP.md) · [desktop e2e testing](docs/DESKTOP_E2E.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](SECURITY.md)

## License

[Apache-2.0](LICENSE)

## Name and lineage

In a CANDU reactor, a calandria is the vessel that hundreds of parallel fuel
channels run through, each working in isolation inside one coordinated
machine, which is what this software does.

Calandria began as a fork of
[Operator](https://github.com/iishyfishyy/operator-oss) by
[@iishyfishyy](https://github.com/iishyfishyy). It keeps Operator's
Apache-2.0 license; see [LICENSE](LICENSE) and [NOTICE](NOTICE). Calandria
is not affiliated with the upstream project or its hosted service. File
bugs and ideas for Calandria in
[this repo's issues](https://github.com/calandria-dev/calandria/issues).
