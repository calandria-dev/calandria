---
title: "Supported agents"
---

# Supported agents

Calandria supports Claude Code and OpenAI Codex as first-class task agents. Connect either
one or both, choose a default, and override the agent for an individual task. With only one
agent connected, the New-task and Edit-task dialogs skip the agent picker, since there is
nothing to choose. It reappears once a second agent is connected, or when a task already
points at an agent that isn't.

## Support matrix

| Agent | Authentication | Task support | Notes |
|-|-|-|-|
| Claude Code | Max/Pro login or optional API key | Full | Reference driver; supports interactive questions and reported cost data |
| OpenAI Codex | ChatGPT login or optional API key | Full | Supports interactive questions through Calandria's bridge; estimated cost data |

Connecting either agent completes first-run setup and makes it the initial default. Claude
is not required when only Codex is connected, or vice versa. Project recaps, context drafts,
and other utility jobs prefer a connected agent automatically.

## Choosing a model

Each driver publishes its own model catalog, and Calandria offers it in four places: the
**New task** and **Edit task** dialogs, the session rail's picker (which changes a running
task's model for its next turn), and **Settings → Run defaults → Default model**. The list
comes from the agent, not Calandria: a Vertex-routed instance sees the corrected context
windows its aliases actually resolve to, and a new driver's models appear with no UI change.

Every picker leads with an **Inherit** entry, following the same fallback chain as reasoning
level and permission mode: the task's own pick wins; failing that, the agent's default from
Settings; failing that, nothing is sent and the CLI's own configured model runs. That's why
an instance that has never opened Settings still honors a model set in
`~/.claude/settings.json` or `~/.codex/config.toml`.

The Settings default is per agent. There is no instance-wide default, because a model id
names one provider's catalog and `opus` is not a value Codex can run. Switching an
unstarted task's agent drops its model back to Inherit rather than carrying over an id the
new driver would silently ignore.

## Authentication and billing

The recommended path is the subscription login offered by the first-run wizard or
**Settings → Agents**. Subscription turns consume plan quota and have no marginal API
charge. Calandria removes stray `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` values from its
launch environment by default, so an inherited shell variable can't switch a session to
API billing.

To use API-key billing, connect a key in the app or set `CALANDRIA_ALLOW_API_KEY_ENV=1` for
a headless environment that intends to bill via API key.

## Claude Code

Claude Code is the reference driver and the first target for new agent-facing features. It
supports parallel tasks, resume and `/clear` lineage, interactive questions, project
context, diff workflows, and usage reporting.

Task sessions run inside isolated worktrees under one of five permission modes, listed here
from most autonomous to least. The names match what Claude Code itself calls them, the same
strings `--permission-mode` takes, so nothing needs translating between Calandria and the
agent's own docs:

| Mode | What it does |
|-|-|
| **bypassPermissions** | Never asks; bypasses every permission check. The only mode that skips the gate entirely. |
| **auto** | *(the default)* A model classifier screens each call, approving what it judges safe and escalating the rest to a permission card. |
| **acceptEdits** | File edits auto-apply; commands and everything else prompt. |
| **default** | Claude Code's standard prompting; anything not already approved asks. |
| **plan** | Proposes a plan without editing; leaving the plan asks. |

Every mode except bypassPermissions gates calls for real: whatever it doesn't auto-approve
parks the turn on a permission card in the transcript. Read-only tools never prompt.
"Always allow" remembers a command for that project only, and every remembered approval is
listed and revocable in Settings → Run defaults, where you can also add one up front
instead of waiting for a prompt. A typed-in rule goes through the same check as the card:
Bash commands only, and "and its arguments" stores only the command and its subcommand
(`git push origin main` becomes `git push …`), refusing outright when no honest prefix
describes the line, for example a `sudo` wrapper, an env assignment, or anything the shell
could reinterpret. A prompt nobody answers is declined automatically, so an auto-started
task can't sit wedged waiting on someone who isn't there. That's the trade-off of the
default: unattended work that trips the classifier stops and reports why instead of pressing
on. Set the app default to bypassPermissions for fleets that must never stop.

Claude Code can also refuse a call on its own, without asking Calandria first: the auto
classifier vetoing something, or a deny rule in your own `~/.claude` settings. That shows up
in the transcript as a permission card that arrives already decided, attached to the call it
stopped, showing what the agent tried to run, who refused it, and why. There are no buttons,
because the decision is already made. If it should have been allowed, change the task's
permission mode.

A task session's settings can change **between** turns, so those are gated too. Claude Code
re-reads `<worktree>/.claude/settings.json` at the start of every turn, and that file is
executable configuration: its `hooks` run shell commands on tool and session events without
ever reaching the permission gate, `permissions.allow` approves calls without a prompt, and
`env` reaches every subprocess a tool spawns. It also sits in the task's worktree, which is
where the agent's own edits land — so one turn could write the file the next turn obeys, and
so could a commit the worktree picks up when it catches up to its base branch. Calandria
hashes the file before each turn and compares it with the version that task last ran under.
Unchanged, nothing happens. Changed, the turn is held before the agent starts, on a card
showing the diff: approve it and the turn runs and that version becomes the new baseline;
decline and the turn ends without the agent ever loading it. The first turn of a task takes
whatever the repository ships as its baseline, silently — that came with the code. Scheduled
and unattended runs never approve one: they refuse and the run is recorded as failed, because
nobody being there is not the same as somebody agreeing.

The SDK also has a `dontAsk` mode ("deny anything not pre-approved, don't prompt"), which
Calandria doesn't offer. Under `dontAsk` the CLI decides everything itself and never asks
Calandria, so none of the above applies: not the read-only allowlist, not your remembered
approvals, not the cards. "Pre-approved" would mean allow rules in your own Claude Code
settings file. `default` plus **Always allow** already gives you deny-unless-allowed, with a
prompt when you want one and a revocable record of everything you granted.

Calandria is a control layer, not an additional security sandbox. Review
[the security model](../SECURITY.md) before exposing an instance.

A task session also loads your own Claude Code configuration: `~/.claude` settings, MCP
servers, plugins and skills, plus the repository's `CLAUDE.md`, so it behaves like the
`claude` CLI you already use, with Calandria's own tools added on top. Your MCP servers'
tools go through the permission modes above like everything else.

Skills follow the same inheritance: a Claude session sees `~/.claude/skills` and the
repository's `.claude/skills`; a Codex session sees `~/.agents/skills` and the repository's
`.agents/skills`. Neither reads the other's directory, and neither reads the other's
instruction file: Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`. A project you
might open with either agent needs both files present, even if one is a stub pointing at
the other. Calandria ships a skill for preparing a repo to be worked on in many worktrees
at once; `skills/README.md` covers installing it for both agents.

Calandria's own background jobs don't inherit any of this. A `/clear` handoff note, a
project recap, and a "Refresh with AI" context draft are internal transformations, not
sessions you're sitting in, so they run with your MCP servers, plugins, skills, and hooks
switched off. Otherwise every four-bullet recap would start your entire MCP fleet to offer
tools it can never call. They still read `~/.claude/settings.json`, because that's also
where a Bedrock/Vertex/proxy setup keeps its `env` block and `apiKeyHelper`, so they
authenticate the same way your ordinary turns do. The context draft additionally loads the
repository's `CLAUDE.md`, since describing the repo is its job, and can read, search, and
list files, but not run commands or write anything.

## OpenAI Codex

Codex supports parallel tasks, diff review and merge, `/clear` lineage, project context,
interactive questions, and usage tracking. Calandria supplies interactive questions through
its MCP bridge because the upstream non-interactive CLI has no such hook of its own.

Three upstream differences are visible:

- ChatGPT-plan authentication reports tokens but not dollar cost, so Calandria estimates
  the API-price equivalent and marks it with `~`.
- The context-window gauge is an estimate, marked `≈`. Claude's stream reports each model
  request's usage, so a Claude task's gauge shows the window's actual contents as of the
  latest request. `codex exec` reports only the thread's running totals on
  `turn.completed`, so a Codex task's gauge is derived from its last turn's usage report,
  and a turn spans many requests (every tool call re-reads the whole context), so a
  tool-heavy turn over-reads. The per-request figure exists in the Codex binary
  (`last_token_usage`) but only on the app-server protocol, which the SDK doesn't use.
- The non-interactive CLI can't pause an active turn for a command-approval prompt.
  Calandria offers Codex's own **workspace-write** (writable sandbox, never asks) and
  **read-only** (plan) modes instead of a mid-turn approval mode, and asks Codex not to
  require approvals (`approval_policy=never`). If an enterprise-managed Codex configuration
  disallows that, Calandria detects the CLI's downgrade warning on the first affected turn
  and switches to the compatible `on-request` policy automatically; the failed turn gets a
  one-click Retry. `CODEX_APPROVAL_POLICY` remains the manual override. Claude's permission
  cards have no Codex equivalent yet: the MCP bridge that carries `ask_user` could carry
  approvals the same way, but the CLI would first need to route an approval request to a
  tool call instead of a terminal prompt.
- Codex tasks get Calandria's own tools but not the MCP servers from your
  `~/.codex/config.toml`, where a Claude task does get yours. Same missing approver as
  above: an inherited server's tools are offered to the model, and every call returns
  `user cancelled MCP tool call`. Calandria unmounts them rather than leave tools that can't
  work. Set `CODEX_INHERIT_MCP=1` to mount them anyway, worthwhile if you've set
  `default_tools_approval_mode = "approve"` on your own servers. Each agent's card in
  **Settings → Agents** states which side of this it's on, so you can check before picking
  an agent for a task.

## Local models

A project, or a single task, can run its turns against a local model server instead of the
agent's cloud login. There is no separate driver: both CLIs already accept a different
endpoint, and Calandria sets it per turn. Claude Code reads `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN` from its environment. Codex reads its provider from
`~/.codex/config.toml`, so Calandria passes a provider entry of its own as a config override
(`model_provider = "calandria-local"`, on the Responses wire API) and leaves your
`config.toml` alone. Everything else, worktrees, diff review, merge, tools, asks, works as
it does in the cloud.

**Setup.** Open the project's settings and set **Model provider** to *Local model*. The base
URL defaults to the instance's `CALANDRIA_LOCAL_MODEL_BASE_URL` (`http://localhost:11434`;
a Docker instance uses `http://host.docker.internal:11434`). Name a model the server has
pulled. Save. From then on every task in the project runs there, and its session header
carries a `local` chip beside the agent mark.

- **Ollama** (0.14 or later for Claude Code, 0.13 or later for Codex): `ollama pull
  qwen3-coder`, then base URL `http://localhost:11434`, model `qwen3-coder`. Ollama's
  Anthropic endpoint requires an auth token and ignores its value; the preset sends
  `ollama`. Run a model with at least a 32K context window.
- **LM Studio**: start the local server, load a model, then base URL `http://localhost:1234`
  and the model's identifier as LM Studio shows it.

**Picking a model.** Once a project is on an endpoint, the model field stops being
the driver's catalog and becomes a text box: the vendor's line-up is not what that
machine has, and only the machine knows. Its suggestions are what the server itself
reports — Calandria asks Ollama's `GET /api/tags` first (its names are the ids the
Anthropic endpoint wants, tag included), then `GET /v1/models` for LM Studio and
anything else OpenAI-compatible. Anything can still be typed, so a model pulled a
minute ago works before any probe has seen it. The probe is always server-side
(`GET /api/projects/[id]/models`): the endpoint is loopback on the machine
Calandria runs on, which the browser usually can't reach at all.

Settings → Agents reports the instance's default endpoint the same way — *Ollama at
localhost:11434: reachable, 4 models* — separately from the agents above it, because
an agent's *connected* is its CLI login and says nothing about a local server. A
project on Ollama runs through a Claude login it never uses, and fails with a
perfectly good one when Ollama is down. `CALANDRIA_MODEL_PROBE_MS` (2500ms) bounds
how long the probe waits.

**What the override can and can't carry.** The stored form is `projects.agent_env`, a JSON
object over a fixed allowlist: the two base URLs, the Anthropic auth token, the model
variables Claude Code's `opus`/`sonnet`/`haiku` aliases resolve through, and the model Codex
should run. Nothing else gets through, so the field can't set `PATH` or `NODE_OPTIONS` for
the spawned CLI. The model you name is written to every alias, so a task whose picker says
`sonnet` still lands on the local model.

**What a turn against an override costs.** Whatever the driver reports, it isn't measuring
this endpoint: Claude Code prices the model id it was *told* and Codex prices an unknown id
at the CLI-default family, both against a catalog the endpoint doesn't bill from. So the
ledger decides, and it distinguishes the two presets rather than lumping them together:

- **Local model** — an endpoint on this machine or your own network. Recorded at **$0**,
  which is a measurement: nothing is being charged.
- **Custom base URL** — free text, and just as likely to be OpenRouter, Together, Fireworks
  or a Bedrock/Vertex proxy as anything free. Recorded as **unpriced** (`task_usage.cost_usd`
  is NULL, distinct from a zero). Those turns are left out of every cost total, and each
  place a total is shown marks it: the session header's usage chip prints `—` when a task has
  nothing else to count and `$x.xx+` when it does, and Insights suffixes the Spend KPI and the
  project, tag and provider tables with a `+` whose tooltip names the count. Tokens are kept
  either way — an unpriced turn still filled a context window.

The old behaviour billed every override at $0, so pointing the custom preset at a paid third
party made that spend disappear from Insights with nothing on screen admitting the number was
a placeholder. Rows written before this shipped keep their recorded 0; only turns from here
on carry the distinction.

**Credentials.** Redirecting the base URL drops the instance's own Anthropic and OpenAI keys
from that turn's environment: a custom endpoint is a third party, and it gets only the token
you typed for it. The reverse holds too. A project-level `ANTHROPIC_AUTH_TOKEN` is honoured
only when the same override points the base URL somewhere other than Anthropic, so the
field is not a way around `CALANDRIA_ALLOW_API_KEY_ENV`.

**Billing, and what the gauges can still tell you.** A turn against an override is
recorded with a cost of zero and tagged with the endpoint's host in
`task_usage.provider`, and the session header shows no dollar figure at all rather
than `$0.00` — there is no price, and the API-price equivalent would be the list
price of a model that didn't run. Token counts *are* recorded, since the local model
still filled a context window. The window itself is reported as **unknown**: the
override rewrites `ANTHROPIC_MODEL` and the `opus`/`sonnet`/`haiku` aliases, so a
task whose picker still reads *Sonnet* is not running Sonnet, and sizing it from the
catalog would draw a 4% gauge on a 32K window about to overflow. The rail shows the
token count without a percentage. Project-scoped one-shots (recaps, *Refresh with
AI*) run on the utility agent's own login, not the project's endpoint.

**Delegating from a cloud session.** A task can override its project on its own row, which is
what lets a frontier model hand routine work to a local one. `suggest_task` takes
`provider: "local"` plus a `model`: the task it files runs against the instance's local
endpoint whatever the project's setting, and `provider: "cloud"` does the reverse inside a
local project. The same field is `agent_env` on `PATCH /api/tasks/[id]`.

## Adding another agent

The app is agent-agnostic behind a small driver interface. A new driver supplies normalized
stream events and a capability descriptor; shared routing, transcripts, task state, and UI
controls consume that contract.

See [Architecture: the agent-driver seam](ARCHITECTURE.md#the-agent-driver-seam-libagents)
for the implementation guide. Proposals for another agent are welcome in
[GitHub Discussions](https://github.com/calandria-dev/calandria/discussions/categories/ideas).

A Google driver is in progress. The spike that chose its backend, the Antigravity CLI
(`agy`) rather than Gemini CLI, is recorded in
[design/gemini-driver.md](design/gemini-driver.md): why (Gemini CLI stopped serving Google
AI Pro, Ultra and free accounts on 2026-06-18), the measured headless surface of both CLIs,
the event mapping, the login flow and the open questions the driver has to settle.
