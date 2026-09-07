---
title: "Supported agents"
---

# Supported agents

Calandria supports Claude Code, OpenAI Codex and Google's Antigravity as first-class task
agents. Connect one, two or all three, choose a default, and override the agent for an
individual task. With only one agent connected, the New-task and Edit-task dialogs skip the
agent picker. It reappears once a second agent is connected, or when a task already points at
an agent that isn't.

## Support matrix

| Agent | Authentication | Task support | Notes |
|-|-|-|-|
| Claude Code | Max/Pro login or optional API key | Full | Reference driver; supports interactive questions and reported cost data |
| OpenAI Codex | ChatGPT login or optional API key | Full | Supports interactive questions through Calandria's bridge; estimated cost data |
| Antigravity | Google login, or an API key (the only path in a container) | Full | Gemini models, plus Claude and GPT on the same subscription; estimated cost data |

Connecting any one of them completes first-run setup and makes it the initial default. An
instance with only Codex connected, or only Antigravity, is a supported configuration. Project
recaps, context drafts, and other utility jobs prefer a connected agent automatically.

## Choosing a model

Each driver publishes its own model catalog, offered in four places: the **New task** and
**Edit task** dialogs, the session rail's picker (which changes a running task's model for its
next turn), and **Settings → Run defaults → Default model**. The list comes from the agent, not
Calandria: a Vertex-routed instance sees the corrected context windows its aliases actually
resolve to.

A family alias such as **Opus (latest)** is resolved by the installed CLI at turn time, not by
Calandria, so the row's label never claims a version. The subtitle under the name reports the id
the alias currently resolves to. Calandria reads that by asking the CLI once per CLI version:
`claude -p --bare --model opus --output-format stream-json` prints the resolved id before any
request goes out. `--bare` never touches your login, and the process is killed as soon as the
line arrives. It spawns the CLI five times, so it runs in the background the first time you open
a picker and the ids appear on a later load.

Every picker leads with an **Inherit** entry, following the same fallback chain as reasoning
level and permission mode: the task's own pick wins; failing that, the agent's default from
Settings; failing that, nothing is sent and the CLI's own configured model runs. An instance that
has never opened Settings still honors a model set in `~/.claude/settings.json` or
`~/.codex/config.toml`.

The Settings default is per agent. There is no instance-wide default: a model id names one
provider's catalog and `opus` is not a value Codex can run. Switching an unstarted task's agent
drops its model back to Inherit instead of carrying over an id the new driver would silently
ignore.

### Models for Calandria's own jobs

The jobs Calandria runs for you have two pickers of their own, beside the default model and
scoped to the same agent: **Quick internal jobs** and **Repo-reading internal jobs**.

The quick tier is the `/clear` handoff note and the project recap: one turn, no tools, text in
and text out. The heavy tier is the "Refresh with AI" context draft and the "Refresh tag" plan
check, which both explore an unfamiliar repository read-only before deciding something durable: a
document prepended to every new session in that project, or which of a tag's tasks have gone
stale.

Both lead with **Inherit**, and that is the default: left alone, these jobs send no model and run
on whatever `~/.claude/settings.json` or `~/.codex/config.toml` names. Which model that turned
out to be is recorded per run: Insights names the models behind each job under "Calandria's own
usage", and Settings names them beside the utility-job run count.

Each tier is read off the agent that actually runs the job, which is not always the one you were
looking at. A `/clear` note follows its own task's agent so the cost lands on that login; recaps
and context drafts follow the utility agent. When a driver doesn't implement a job and falls
back, the fallback agent's setting is the one used.

## Authentication and billing

The recommended path is the subscription login offered by the first-run wizard or **Settings →
Agents**. Subscription turns consume plan quota and have no marginal API charge.

| Setting | Default | Effect |
|-|-|-|
| `CALANDRIA_ALLOW_API_KEY_ENV` | unset | Set to `1` to keep an inherited `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in a turn's environment. Unset, Calandria strips both from its launch environment so an inherited shell variable can't switch a session to API billing. |

To use API-key billing without that env var, connect a key in the app instead.

## Claude Code

Claude Code is the reference driver: parallel tasks, resume and `/clear` lineage, interactive
questions, project context, diff workflows, and usage reporting.

**Prerequisites.** A Claude Max or Pro subscription, or an Anthropic API key.

**Connect.** Settings → Agents → Claude Code → sign in. The subscription login is recommended;
see [Authentication and billing](#authentication-and-billing) for the API-key path.

**Settings.**

| Setting or env var | Default | Effect |
|-|-|-|
| `CALANDRIA_CLAUDE_MODEL_PROBE` | on | Resolves each model alias to a concrete id via the CLI, shown in the picker subtitle. Set to `off` to show the built-in catalog labels with no resolved ids. |

**Permission modes.** Task sessions run inside isolated worktrees under one of five permission
modes, listed here from most autonomous to least. The names match what Claude Code itself calls
them, the same strings `--permission-mode` takes:

| Mode | What it does |
|-|-|
| **bypassPermissions** | Never asks; bypasses every permission check. The only mode that skips the gate entirely. |
| **auto** | *(the default)* A model classifier screens each call, approving what it judges safe and escalating the rest to a permission card. |
| **acceptEdits** | File edits auto-apply; commands and everything else prompt. |
| **default** | Claude Code's standard prompting; anything not already approved asks. |
| **plan** | Proposes a plan without editing; leaving the plan asks. |

Every mode except bypassPermissions gates calls for real: whatever it doesn't auto-approve parks
the turn on a permission card in the transcript. Read-only tools never prompt. "Always allow"
remembers a command for that project only, listed and revocable in Settings → Run defaults, where
you can also add a rule up front instead of waiting for a prompt. A typed-in rule goes through the
same check as the card: Bash commands only, and "and its arguments" stores only the command and
its subcommand (`git push origin main` becomes `git push …`), refusing outright when no honest
prefix describes the line, for example a `sudo` wrapper, an env assignment, or anything the shell
could reinterpret. A prompt nobody answers is declined automatically, so an auto-started task
can't sit wedged waiting on someone who isn't there: unattended work that trips the classifier
stops and reports why instead of pressing on. Set the app default to bypassPermissions for fleets
that must never stop.

Claude Code can also refuse a call on its own, without asking Calandria first: the auto classifier
vetoing something, or a deny rule in your own `~/.claude` settings. That shows up in the
transcript as a permission card that arrives already decided, attached to the call it stopped,
showing what the agent tried to run, who refused it, and why, with no buttons. If it should have
been allowed, change the task's permission mode.

A task session's settings can change between turns, so those are gated too. Claude Code re-reads
`<worktree>/.claude/settings.json` at the start of every turn: its `hooks` run shell commands on
tool and session events without reaching the permission gate, `permissions.allow` approves calls
without a prompt, and `env` reaches every subprocess a tool spawns. Calandria hashes the file
before each turn and compares it with the version that task last ran under. Unchanged, nothing
happens. Changed, the turn is held before the agent starts, on a card showing the diff: approve it
and the turn runs and that version becomes the new baseline; decline and the turn ends without the
agent ever loading it. The first turn of a task takes whatever the repository ships as its
baseline, silently. Scheduled and unattended runs never approve a changed file: they refuse and
the run is recorded as failed.

Calandria is a control layer, not an additional security sandbox. Review
[the security model](../SECURITY.md) before exposing an instance.

A task session also loads your own Claude Code configuration: `~/.claude` settings, MCP servers,
plugins and skills, plus the repository's `CLAUDE.md`, so it behaves like the `claude` CLI you
already use, with Calandria's own tools added on top. Your MCP servers' tools go through the
permission modes above like everything else.

Skills follow the same inheritance: a Claude session sees `~/.claude/skills` and the repository's
`.claude/skills`; a Codex session sees `~/.agents/skills` and the repository's `.agents/skills`.
Antigravity reads the repository's `.agents/` customization roots too: skills, rules and hooks,
with MCP config the one thing it does not take from there. No agent reads another's directory, and
none reads another's instruction file: Claude Code reads `CLAUDE.md`, Codex and Antigravity read
`AGENTS.md`. A project you might open with more than one of them needs both files present, even
if one is a stub pointing at the other. Calandria ships a skill for preparing a repo to be worked
on in many worktrees at once; `skills/README.md` covers installing it for both directories.

Calandria's own background jobs are isolated according to the agent that runs them. Claude
one-shots (`/clear` handoff notes, project recaps, "Refresh with AI" context drafts and "Refresh
tag" plan checks) run with MCP servers, plugins, skills, and hooks switched off. Otherwise every
four-bullet recap would start your entire MCP fleet to offer tools it can never call. They still
read `~/.claude/settings.json`, because that's also where a Bedrock/Vertex/proxy setup keeps its
`env` block and `apiKeyHelper`, so they authenticate the same way ordinary turns do. The two
repo-reading jobs additionally load the repository's `CLAUDE.md`, since judging the repo is their
job, and can read, search, and list files, but not run commands or write anything.

Codex one-shots always omit Calandria's bridge and run read-only with network disabled, but their
external MCP servers follow `CODEX_INHERIT_MCP` just like task turns: mounted by default, inertly
disabled when the instance opts out. Which model each background job runs on is the two-tier
setting described under [Choosing a model](#choosing-a-model) above.

**What is not supported.**

- The SDK's `dontAsk` mode ("deny anything not pre-approved, don't prompt") is not offered. Under
  `dontAsk` the CLI decides everything itself and never asks Calandria, so none of the gate above
  would apply: not the read-only allowlist, not your remembered approvals, not the cards.
  "Pre-approved" would mean allow rules in your own Claude Code settings file. `default` plus
  **Always allow** gives the same deny-unless-allowed behavior, with a prompt when you want one
  and a revocable record of everything you granted.

## OpenAI Codex

Codex supports parallel tasks, diff review and merge, `/clear` lineage, project context,
interactive questions, and usage tracking. Calandria supplies interactive questions through its
MCP bridge because the upstream non-interactive CLI has no such hook of its own.

**Prerequisites.** A ChatGPT Plus/Pro/Team login, or an OpenAI API key. The `codex` CLI.

**Connect.** Settings → Agents → Codex → sign in.

**Settings.**

| Setting or env var | Default | Effect |
|-|-|-|
| `CODEX_TRANSPORT` | `app-server` | Transport for task turns. `app-server` is the CLI's IDE JSON-RPC protocol; `exec` is the older non-interactive path, kept as a fallback where its asking modes behave like `acceptEdits`. |
| `CODEX_APPROVAL_POLICY` | `never` | Approval policy Calandria asks Codex to run with. If an enterprise-managed configuration disallows `never`, Calandria detects the CLI's downgrade warning on the first affected turn and switches to `on-request` automatically; the failed turn gets a one-click Retry. |
| `CODEX_INHERIT_MCP` | `1` (on) | Mounts the MCP servers from your own `~/.codex/config.toml` on task sessions. Set to `0` to keep them off; Calandria then overrides each one with an inert transport of its own kind, since Codex rejects an override with no transport. |
| `CODEX_WRITABLE_ROOTS` | unset | Extra paths a sandboxed turn can write to, beyond the worktree's own git plumbing. |
| `CODEX_EXTERNAL_SANDBOX` | unset | In a container, set to `1` to run `workspace-write` turns unconfined and rely on the container as the boundary. |

**Permission modes.** Task turns run on `codex app-server` by default. Its approval requests
come back to Calandria over JSON-RPC and park on the same permission card a Claude prompt uses,
with Allow once / Always allow / Decline and the same remembered rules per project. The five
modes map onto Codex's own sandbox and approval policy (`lib/agents/codex/policy.ts`):

| Mode | Codex label | Sandbox | Approvals |
|-|-|-|-|
| **auto** *(default)* | auto-review | workspace-write | on request, decided by Codex's own reviewer (`approvals_reviewer=auto_review`) |
| **default** | on-request | workspace-write | on request, decided by you on a permission card |
| **acceptEdits** | workspace-write | workspace-write | never: what the sandbox refuses fails and the model works around it |
| **bypassPermissions** | danger-full-access | none | never |
| **plan** | read-only | read-only | never |

A workspace-write turn can commit from its worktree. Codex protects a checkout's `.git` and, for
a linked worktree, the real gitdir the `.git` file points at, while the repo's common `.git` sits
outside every writable root, so `git add` and `git commit` would fail in every sandboxed mode.
Calandria grants what a commit writes, the task's private gitdir plus the repo's
`.git/objects`, `refs` and `logs`, and nothing else: `hooks/`, `config` and `info/` keep Codex's
protection. `CODEX_WRITABLE_ROOTS` adds more directories.

**What is not supported.**

- No equivalent of Claude's permission cards for a refusal Codex makes entirely on its own.
- MCP servers from `~/.codex/config.toml` mount by default (`CODEX_INHERIT_MCP` above); their
  tools go through the same permission gate as Calandria's own. Codex app-connector plugins
  exposed through the separate `codex_apps` server are not entries in `codex mcp list` and are
  outside this flag.

Two other upstream differences show up in the UI:

- ChatGPT-plan authentication reports tokens but not dollar cost, so Calandria estimates the
  API-price equivalent and marks it with `~`.
- The context-window gauge reads the last request's prompt size on the default transport
  (`codex app-server` reports it on every usage update), the same figure Claude's gauge shows. On
  the `exec` transport the CLI reports only the thread's running totals on `turn.completed`, so
  the gauge is derived from the last turn's usage report, marked `≈`.

Each agent's card in **Settings → Agents** states whether inherited external MCP servers are
mounted, so you can check before picking an agent for a task.

### Linux sandbox

Codex confines `workspace-write` and `read-only` turns with bubblewrap, which needs to
create an unprivileged user namespace. Ubuntu 24.04 blocks that by default
(`kernel.apparmor_restrict_unprivileged_userns=1`), and on such a host every command in
every workspace-write or read-only turn fails. The only signal is a startup warning from
`codex app-server`: "Codex's Linux sandbox uses bubblewrap and needs access to create user
namespaces."

Calandria detects that warning and flags the Codex card in **Settings → Agents** with the
fix and a "Check again" button. While the flag is set, Calandria refuses to start a
workspace-write or read-only turn and fails it with an explanation instead of running one
where every command fails. `bypassPermissions` (danger-full-access) uses no sandbox and is
never refused.

Fix it one of these ways:

- Run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` and persist it under
  `/etc/sysctl.d/`.
- Add an AppArmor profile that allows `bwrap` to create user namespaces.
- Run the task in `bypassPermissions` mode.
- In a container, set `CODEX_EXTERNAL_SANDBOX=1`. It sends `workspace-write` turns Codex's
  `externalSandbox` policy, which runs commands unconfined and relies on the container as
  the boundary. It covers `workspace-write` only: `read-only` (plan mode) stays sandboxed,
  because its guarantee is that nothing is writable and a container does not provide that.
  It has no effect under `CODEX_TRANSPORT=exec`, which cannot express the policy.

## Antigravity (Gemini)

Antigravity is Google's coding agent and Gemini is what it runs. There is no JavaScript SDK for
it, so Calandria drives the `agy` CLI directly, spawning the binary and normalizing its NDJSON
stream (`lib/agents/gemini/`). Tasks get parallel worktrees, diff review and merge, `/clear`
lineage, project context, interactive questions through Calandria's MCP bridge, and usage
tracking, the same as the other two.

**Prerequisites.** A Google account with Antigravity access, or a Gemini API key (required in a
container; see below). The `agy` CLI.

**Connect.** Sign in with your Google account from **Settings → Agents**. Two things about that
login differ from Claude's and Codex's, and the card handles both:

- **The authorize link is short-lived.** The CLI waits 60 seconds for the callback and that window
  is not configurable, so **Start again** stays on the card throughout. It is not a retry: the
  code is bound to the process that printed the link, so a new attempt means a new link.
- **The code box is one of two ways this finishes.** Google's callback page completes the sign-in
  for the CLI waiting on it, so a user who never copies anything is nonetheless signed in. The
  card polls for that as well, and closes itself when the CLI reports it is connected.

**In a container, use an API key.** `agy` keeps its OAuth token in the OS keyring over the D-Bus
Secret Service and has no file fallback, and the published image runs no keyring daemon, so the
subscription sign-in cannot complete there. A desktop install with a running keyring uses the
subscription login as normal.

**Settings.**

| Setting or env var | Default | Effect |
|-|-|-|
| `GEMINI_API_KEY` | unset | Set (or paste a key on the agent's card) for API-key billing, billed against Google's API, not the Antigravity subscription. |
| `AGY_CLI_PATH` | unset (uses `agy` on PATH) | Pins a specific binary when PATH is trimmed. The published image installs a version the `Dockerfile` records and reviews the checksum of. |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | always set to `true` | Always applied by Calandria; a self-update can never swap the binary out mid-turn or mid-login. |

**Permission modes.**

| Mode | What it does |
|-|-|
| **skip permissions** | *(the default)* Auto-approves every tool call (`agy --dangerously-skip-permissions`). |
| **acceptEdits** | File edits auto-apply; other calls prompt (`agy --mode accept-edits`). |
| **plan** | Proposes without editing (`agy --mode plan`). |

This driver also watches `<worktree>/.agents/hooks.json` for changes between turns, the same way
Claude Code's driver watches `<worktree>/.claude/settings.json` (see
[Claude Code](#claude-code) above). Calandria hashes it before each turn and holds the turn on a
card when it moved. It is not confirmed that the `agy` CLI actually loads hooks from that worktree
path; Calandria watches it as a precaution.

**What is not supported.**

- The CLI's own default mode, which asks a human about each tool call, is not offered: a headless
  run has nobody to ask, so every tool is auto-denied and the turn ends having done nothing.
- MCP servers from your `~/.gemini/config/mcp_config.json` are not inherited. The CLI reads MCP
  config from that one user-global file, so each task is handed its own copy containing only
  Calandria's bridge, which is what lets tasks run in parallel without stealing each other's tool
  identity. Each agent's card in **Settings → Agents** states this.
- No dollar cost is reported by the CLI. The usage report carries token counts only, so Calandria
  prices those tokens at Google's published API rates and marks the result `~`, the same
  convention as Codex's estimate.
- No per-request context gauge: the CLI reports no figure for a single request, only usage totals
  that accumulate over the whole conversation, so the context gauge is a heuristic the same way
  Codex's is.
- No separate reasoning-effort picker: the catalog sells effort in the model slug
  (`gemini-3.8-flash-high`), so choosing the model is choosing the effort. That catalog also
  serves Claude and open-weights models through the same Antigravity subscription.
- A denied tool's own exit status is only partly informative: the auto-denial changes neither the
  exit code (0) nor reliably the run status, so the driver reads the denial line off stderr and
  does not treat a `CANCELED` status alone as confirmation the user stopped it.

Plan usage works here the way it does for Claude: the CLI's own `/usage` reports the weekly and
5-hour quota remaining without spending any, so the titlebar meter works on this agent too. It
lists two pairs of windows, because an Antigravity subscription meters the Gemini models and the
Claude/GPT models it also serves against separate limits; the pill itself shows the Gemini pair.

## Local models

A project, or a single task, can run its turns against a local model server instead of the
agent's cloud login. There is no separate driver: the Claude and Codex CLIs both accept a
different endpoint, and Calandria sets it per turn.

**Antigravity does not take part in the Local model preset.** Its CLI exposes no endpoint
override, so a local-model project runs an Antigravity task against Google as usual; point such a
task at Claude or Codex instead. It does take part in the [Gateway](#litellm-gateway) preset
below, which is a different endpoint knob the CLI does honor.

**Prerequisites.**

- **Ollama** 0.14 or later for Claude Code, 0.13 or later for Codex. Pull a model with at least a
  32K context window, for example `ollama pull qwen3-coder`.
- **LM Studio**, any version with a local server: start it and load a model.
- **Codex 0.146.0 or newer** if pointing a Codex task at a local server (see the provider check
  below).

**Connect.** Open the project's settings and set **Model provider** to *Local model*. Set the base
URL and name a model the server has pulled, then save. From then on every task in the project
runs there, and its session header carries a `local` chip beside the agent mark.

- **Ollama**: base URL `http://localhost:11434`, model `qwen3-coder` (or whatever you pulled).
  Ollama's Anthropic endpoint requires an auth token and ignores its value; the preset sends
  `ollama`.
- **LM Studio**: base URL `http://localhost:1234`, and the model's identifier as LM Studio shows
  it.

**Settings.**

| Setting or env var | Default | Effect |
|-|-|-|
| `CALANDRIA_LOCAL_MODEL_BASE_URL` | `http://localhost:11434` | Base URL prefilled for a project's Local-model preset. In Docker, set it to `http://host.docker.internal:11434`. |
| `CALANDRIA_MODEL_PROBE_MS` | `2500` | Timeout for probing the server's model list: `GET /api/tags` for Ollama, `GET /v1/models` for LM Studio and anything else OpenAI-compatible. The probe runs server-side, since the endpoint is loopback on the machine Calandria runs on. |
| `CALANDRIA_CODEX_PROVIDER_CHECK` | on | Before a Codex turn runs against an override, Calandria confirms via `codex doctor --json` that `model_provider` really resolved to `calandria-local` (or `calandria-gateway`), refusing the turn otherwise. Set to `off` to skip the check and accept the risk. The answer is remembered per CLI version and re-earned whenever that version moves. |
| `CODEX_CLI_PATH` | unset (uses `codex` on PATH) | Pins a known-good Codex binary. Also the fix when your `codex` is the npm `.cmd` shim: the shim's command line can't carry the provider settings faithfully enough to check them, so the provider check stands down and says so in the log unless this points at the real executable. |

Codex reads its provider from `~/.codex/config.toml`; Calandria passes a provider entry of its own
as a config override (`model_provider = "calandria-local"`, on the Responses wire API) and leaves
your `config.toml` alone. Claude Code reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
directly from its environment and needs no such check: it sends every request to the configured
base URL under a subscription login and does not silently fall back to Anthropic. Everything
else, worktrees, diff review, merge, tools, asks, works as it does in the cloud.

**Picking a model.** Once a project is on an endpoint, the model field stops being the driver's
catalog and becomes a text box: Calandria suggests what the server itself reports (Ollama's
`GET /api/tags` first, its names are the ids the Anthropic endpoint wants, tag included, then
`GET /v1/models` for LM Studio and anything else OpenAI-compatible), but anything can still be
typed, so a model pulled a minute ago works before any probe has seen it. The probe is always
server-side (`GET /api/projects/[id]/models`): the endpoint is loopback on the machine Calandria
runs on, which the browser usually can't reach at all.

Settings → Agents reports the instance's default endpoint the same way, separately from the
agents above it, since an agent's *connected* is its CLI login and says nothing about whether a
local server is reachable, for example *Ollama at localhost:11434: reachable, 4 models*. A
project on Ollama runs through a Claude login it never uses, and fails with a perfectly good one
when Ollama is down.

**What the override can and can't carry.** The stored form is `projects.agent_env`, a JSON object
over a fixed allowlist (`AGENT_ENV_KEYS` in `lib/agentEnv.ts`): `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and the `ANTHROPIC_DEFAULT_OPUS_MODEL` /
`ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`
aliases, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `OPENAI_BASE_URL` and `CODEX_MODEL` (plus
`CODEX_OSS_BASE_URL` and `OLLAMA_HOST` for Codex's Ollama-compatible mode), `GOOGLE_GEMINI_BASE_URL`
and `GEMINI_MODEL` for the Gateway preset's Antigravity turns, and `CALANDRIA_GATEWAY_BILLING`.
Nothing else gets through, so the field can't set `PATH` or `NODE_OPTIONS` for the spawned CLI.
The model you name is written to every alias, so a task whose picker says `sonnet` still lands on
the local model.

**What a turn against an override costs.** Whatever the driver reports isn't measuring this
endpoint: Claude Code prices the model id it was told and Codex prices an unknown id at the
CLI-default family, both against a catalog the endpoint doesn't bill from. The ledger distinguishes
two presets:

- **Local model**: an endpoint on this machine or your own network. Recorded at **$0**, which is
  a measurement, not a placeholder.
- **Custom base URL**: free text, and just as likely to be OpenRouter, Together, Fireworks or a
  Bedrock/Vertex proxy as anything free. Recorded as **unpriced** (`task_usage.cost_usd` is NULL,
  distinct from a zero). Those turns are left out of every cost total, and each place a total is
  shown marks it: the session header's usage chip prints `—` when a task has nothing else to count
  and `$x.xx+` when it does, and Insights suffixes the Spend KPI and the project, tag and provider
  tables with a `+` whose tooltip names the count. Tokens are kept either way.

**Credentials.** Redirecting the base URL drops the instance's own Anthropic and OpenAI keys from
that turn's environment: a custom endpoint gets only the token you typed for it. A project-level
`ANTHROPIC_AUTH_TOKEN` is honored only when the same override points the base URL somewhere other
than Anthropic, so the field is not a way around `CALANDRIA_ALLOW_API_KEY_ENV`.

**What the usage gauges can still tell you.** A turn against an override is recorded with a cost
of zero and tagged with the endpoint's host in `task_usage.provider`, and the session header
shows no dollar figure at all, not `$0.00`. Token counts are recorded, since the local
model still filled a context window, but the window itself is reported as **unknown**: the
override rewrites `ANTHROPIC_MODEL` and the `opus`/`sonnet`/`haiku` aliases, so a task whose
picker still reads *Sonnet* is not running Sonnet, and sizing it from the catalog would draw a 4%
gauge on a 32K window about to overflow. The rail shows the token count without a percentage.
Project-scoped one-shots (recaps, *Refresh with AI*, *Refresh tag*) run on the utility agent's own
login, not the project's endpoint.

**Delegating from a cloud session.** A task can override its project on its own row, which is what
lets a frontier model hand routine work to a local one. `suggest_task` takes `provider: "local"`
plus a `model`: the task it files runs against the instance's local endpoint whatever the
project's setting, and `provider: "cloud"` does the reverse inside a local project. The same field
is `agent_env` on `PATCH /api/tasks/[id]`.

**Permission modes.** The override changes only the endpoint; permission modes are unchanged from
the [Claude Code](#claude-code) or [OpenAI Codex](#openai-codex) section for whichever driver the
task uses.

## LiteLLM gateway

A [LiteLLM](https://docs.litellm.ai) proxy is the fourth **Model provider**, beside *Local model*
and *Custom base URL* and on the same seam. It is not a driver: LiteLLM speaks the Anthropic
Messages API, so Claude Code reaches it through `ANTHROPIC_BASE_URL` exactly as it reaches Ollama.
What the gateway adds over a custom base URL is a catalog it will tell you about, spend it can
attribute per key and tag, and budgets it enforces.

**Scope today: Claude Code, Codex and Antigravity.**

**Prerequisites.** A running LiteLLM proxy with a `model_list` configured for the models you want
to expose.

**Connect.** Set `CALANDRIA_LITELLM_BASE_URL` to the proxy's origin, then open a project's
settings, set **Model provider** to *Gateway*, name a model your `model_list` serves, and choose
who pays:

- **Billed to the gateway's key**: the instance's virtual key goes out as the turn's Anthropic
  auth token, so the turn draws on that key's account.
- **Billed to your own plan**: no credential variable is set, the CLI keeps its own `/login`, and
  the gateway forwards it upstream. This needs `general_settings.forward_client_headers_to_llm_api:
  true` on the proxy.

**Settings.**

| Setting or env var | Default | Effect |
|-|-|-|
| `CALANDRIA_LITELLM_BASE_URL` | unset | Proxy origin. Unset is the off switch: with no address, the Gateway preset is absent from the settings form and Settings → Agents shows no card. |
| `CALANDRIA_LITELLM_KEY` | unset | Instance-wide virtual key sent as `x-litellm-api-key` for "Billed to the gateway's key" turns. Can also be set in Settings → Agents. |
| `CALANDRIA_LITELLM_ADMIN_KEY` | unset | Admin/master key for LiteLLM's key-management calls: minting and deleting per-task virtual keys, and reading budgets. Sent on a plain `Authorization` header, never on `x-litellm-api-key`, which is reserved for the virtual keys turns actually bill against. |
| `CALANDRIA_LITELLM_MCP` | on | Set to `0` to turn off hosted MCP server mounting (see [Hosted MCP servers](#hosted-mcp-servers) below) entirely. |
| Project: `gateway_max_budget` | unset | Caps a per-task virtual key's budget. Needs `CALANDRIA_LITELLM_ADMIN_KEY`. |
| Project: `gateway_key_duration` | unset (no expiry) | Per-task virtual key duration. Needs `CALANDRIA_LITELLM_ADMIN_KEY`. |
| Proxy: `router_settings.allowed_fails` / `cooldown_time` | LiteLLM's own defaults | A single upstream failure can put a deployment in cooldown, returning `429 No deployments available for selected model` to every request until the window expires. Raise `allowed_fails` and shorten `cooldown_time` before running several tasks against one deployment in parallel. |

```yaml
router_settings:
  allowed_fails: 8
  cooldown_time: 30
```

Every gateway turn also carries `x-litellm-api-key` and a tag list naming the project, task and
agent, so LiteLLM's own spend views break down by task with nothing written on Calandria's side.
Those headers are composed per turn, not stored: `ANTHROPIC_CUSTOM_HEADERS` is deliberately
absent from the `agent_env` allowlist, and the key is absent from the project row entirely; it
lives in a 0600 file beside the database and is resolved at turn time. Claude Code also sends
`x-claude-code-session-id` on its own, so LiteLLM records the task's session as the spend log's
session id with no configuration needed.

**Budget failures.** When a key's, user's or team's LiteLLM budget is spent, every request against
it is rejected the same way until the budget resets or is raised: the response carries `"type":
"budget_exceeded"` (HTTP 400 or 429) or the exception text `ExceededBudget:`. Calandria treats
this like a dead login: the turn ends with a notice, the session and its worktree are untouched,
the pending queue is parked so it doesn't run every follow-up into the same rejection, and the
agent is flagged instance-wide so every open tab shows the banner. Retry re-sends the same message
once the budget resets or is raised. The gateway card in Settings → Agents shows the timing
(`spend`, `max_budget`, `budget_reset_at` from `/key/info`) next to the models that key covers.

**The health card.** Settings → Agents reports the gateway separately from the agents above it. It
reads `/health/readiness` (which takes no key, so an instance with the address and no key still
gets an answer), the `x-litellm-version` header that rides on every response, and a model count
from `/model/info`. `/key/info` answers `500 Database not connected` on a proxy with no Postgres
behind it, and the card says **keys, budgets and spend need LiteLLM's database** instead of
showing blanks where those would go.

**What a gateway turn costs.** No CLI exposes the `x-litellm-response-cost` header the gateway
answers every request with. Calandria computes the figure itself from the gateway's own
`/model/info` rates (input, cache-read, cache-creation and output cost per token) and the turn's
token counts, and records it as `task_usage.cost_usd`. It is marked `≈` in Insights, the same
convention a `~` marks a Local-model or Codex estimate with, and it is included in every total. A
per-task virtual key's spend (below) later replaces this estimate with LiteLLM's own exact figure.
The session header shows a `gateway` chip.

**Per-task virtual keys.** Set `CALANDRIA_LITELLM_ADMIN_KEY` to mint a separate LiteLLM virtual
key for every task. The first gateway turn a task runs mints its key (`POST /key/generate`), and
later turns reuse it. The key is scoped to the project's model pick, to the project's
`gateway_max_budget` and `gateway_key_duration` when set, and to exactly the hosted MCP servers
this task resolved (`object_permission.mcp_servers`), so a per-task key can only reach the servers
this task was actually given. The key is deleted when the task reaches a terminal status, and
again by the retention sweep as a backstop for any task that went terminal without that delete
running. After every turn, Calandria reads the key's own `GET /key/info` in the background and
records the difference between LiteLLM's cumulative `spend` and the running per-token estimate as
a correcting entry, so the task's total ends up exactly what LiteLLM's own ledger says. This is
the only exact per-task spend path: no CLI exposes `x-litellm-response-cost`, and `/spend/logs` has
no tag filter or pagination. Minting fails silently: with no admin key, no gateway, or a proxy
with no database behind it, every task falls back to the shared instance key.

**The model picker.** A project's **Model provider → Gateway** model field lists `GET
<gateway>/model/info`, filtered to what the task's driver can actually run: Claude Code shows
every `mode: "chat"` entry, marking anything not served by the `anthropic` provider
**translated**; Codex shows only providers LiteLLM can reach over the Responses API (`openai`,
`azure`); Antigravity shows `gemini` and `vertex_ai` providers. A wildcard route (`anthropic/*`) is
listed once, as "Any anthropic model id"; it is not expanded into every model it matches. For
Claude Code, a model whose catalog entry states a context window of at least 1,000,000 tokens also
gets a synthesized `[1m]` row alongside the plain one. Each entry's price (input/output per 1M
tokens, from the same catalog) is shown beside it when the gateway states one.

**Permission modes.** The gateway changes only the endpoint and billing; permission modes are
unchanged from the section for whichever driver the task uses, with the exception of the
Codex-mounted-MCP case noted under [Hosted MCP servers](#hosted-mcp-servers) below.

**What is not supported.**

- 1-hour Anthropic prompt caching. LiteLLM's rebuilt `anthropic-beta` header drops
  `extended-cache-ttl-2025-04-11` (along with `claude-code-20250219` and
  `thinking-token-count-2026-05-13`), so a 1-hour cache request downgrades silently to 5 minutes.
- Pointing `ANTHROPIC_BASE_URL` directly at `<gateway>/anthropic`. That pass-through is
  byte-faithful but ignores `model_list` and calls api.anthropic.com directly with your forwarded
  token.

### Codex through the gateway

Codex reads its provider from `~/.codex/config.toml`, not from the environment, so the
gateway reaches it as a provider entry the driver passes on the command line, the same mapping a
local endpoint gets ([Local models](#local-models) above), with a second entry named
`calandria-gateway`:

```toml
[model_providers.calandria-gateway]
name = "Calandria gateway"
base_url = "<gateway>/v1"
env_key = "CALANDRIA_GATEWAY_KEY"
wire_api = "responses"
http_headers = { "x-litellm-tags" = "calandria,project:<id>,task:<id>,agent:codex" }
```

`env_key` names a variable the CLI reads, not the key itself: the value goes in the turn's
environment as `CALANDRIA_GATEWAY_KEY`, set from the same instance key Claude Code sends as
`x-litellm-api-key`. The tag list is identical, so LiteLLM's spend views break down a Codex task
the same way. `codex doctor --json` proves the entry took before the turn spends anything, and
remembers its verdict against this base URL separately from the local endpoint's.

**What is not supported.**

- Billing to your own ChatGPT plan through the gateway. Codex is billed to the gateway's key under
  both billing modes; the ChatGPT-forwarding equivalent (`requires_openai_auth = true`) is not
  available yet.
- A plan-usage meter. Codex's rate-limit snapshot is empty behind a gateway, and the key's spend is
  not a plan window, so a gateway Codex task offers no "resume when your window resets". The
  titlebar meter still reports the ChatGPT login for whatever cloud Codex tasks the instance runs.

Codex retries a failed request several times on its own, so the cooldown behavior above hits it
hardest: one upstream error can turn every retry into `429 No deployments available` until the CLI
gives up with "exceeded retry limit". Codex also prints `Model metadata for gpt-5-codex not found.
Defaulting to fallback metadata` for any custom provider; it is noise, not a failure.

### Antigravity through the gateway

`agy` speaks the Gemini-native API, not the OpenAI or Anthropic shape, so the gateway reaches it
through `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY`, not a config override like Codex's:
with `{"modelProvider":"gemini"}` in `~/.gemini/antigravity-cli/settings.json` and those two
variables set, `agy` sends `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` with
`x-goog-api-key`, which LiteLLM serves at its root, so a `model_list` entry (or a `gemini/*`
wildcard) has to exist for every model name the CLI uses. Calandria writes that settings file
itself for a gateway task; there is nothing to set up beyond picking the Gateway preset.

**What is not supported.**

- Billing to your own plan. `agy` has no equivalent of Claude Code's own-plan forwarding, so the
  *Billed to your own plan* choice above has no effect on Antigravity tasks; they draw on the
  gateway's key either way.
- An `http://` gateway address on anything other than loopback. This is `agy`'s own rule, not a
  Calandria restriction, so an insecure gateway on any other address would fail every Antigravity
  turn deep inside the CLI. Calandria refuses the combination in the task dialog instead: "Start
  session immediately" is disabled and the reason is stated.
- A plan-usage meter. `agy -p "/usage"` reports Google's own plan windows, which a gateway turn
  never spends, so a gateway Antigravity task offers no "resume when your window resets". The
  titlebar meter still reports the Google account for whatever cloud Antigravity tasks the
  instance runs.

**The health card names a missing side model.** `agy` calls a flash-lite side model on every turn
in addition to whichever model the task picked, and a turn whose side model is absent from the
gateway's catalog fails with an unhelpful `Agent execution terminated due to error`. Settings →
Agents runs `agy models` against the gateway's `/model/info` catalog and names anything the CLI
would ask for that the catalog doesn't serve, so the gap shows up before a task hits it.

### Hosted MCP servers

**Claude Code only for now.** A project's settings picker lists the gateway's own hosted MCP
servers (`GET <gateway>/v1/mcp/server`, with a tool-name preview from `GET
<gateway>/mcp-rest/tools/list`) and lets you check off which ones every task mounts. The picker
needs no database: LiteLLM answers both routes off the calling key's own `object_permission`. Turn
the feature off entirely with `CALANDRIA_LITELLM_MCP=0`.

Mounting is independent of the *Model provider* choice above: a project on the *Cloud* preset can
still mount hosted MCP servers, since the mount is a separate HTTP call to `<gateway>/<alias>/mcp`
and never touches `ANTHROPIC_BASE_URL`. The `calandria` alias is reserved for Calandria's own
tools and is always dropped from the picker's selection even if checked, so it can't shadow them.
A selected alias becomes `mcpServers[alias]` in the session, next to Calandria's own tools:

```json
{ "type": "http", "url": "<gateway>/<alias>/mcp", "headers": { "x-litellm-api-key": "Bearer <key>" } }
```

The credential goes on `x-litellm-api-key`, never `Authorization`; LiteLLM reserves that header for
the upstream server's own OAuth. A task with a per-task virtual key (see
[Per-task virtual keys](#litellm-gateway) above) uses that key here too, so its
`object_permission.mcp_servers` scopes exactly which of the project's selected servers the task
can actually reach; without one, every mount shares the instance key.

**Tool names and permissions.** LiteLLM returns tools prefixed `<alias>-<tool>`, so Claude sees
`mcp__<alias>__<alias>-<tool>`, an ordinary MCP tool as far as `canUseTool` is concerned: a card
under the default permission mode, classifier-screened under `auto`, auto-approved under
`bypassPermissions`. The picker's **Trust this server** button mints a remembered rule covering
the whole alias (`mcp__<alias>__*`) through the same `permission_rules` table a Bash "Always allow"
uses, so it shows up, and can be revoked, in Settings → Run defaults next to your remembered
commands.

**Auth types.** A server whose `auth_type` needs no browser (no auth, an API key, a bearer token,
basic auth, OAuth2 client-credentials or token-exchange, or AWS SigV4) mounts silently. One using
OAuth2 authorization-code needs a human to sign in at the gateway's own UI first, since a detached
task has no browser to do it in, so the picker marks it **sign in at the gateway first** and
mounts it anyway, since LiteLLM holds the token for every later call once that's done. A wrong key
against the mount endpoint itself answers **HTTP 400, not 401**, so the picker's connection check
reads the response body for the real reason instead of trusting the status code.

**Codex and Antigravity mount the same selection too**, each with a driver-specific wrinkle
(the private notes repo's
[litellm.md](https://github.com/calandria-dev/calandria-notes/blob/main/design/litellm.md),
"Hosted MCP servers").

Codex gates MCP calls with its own per-server approval mode, which the turn's approval policy
doesn't reach, so every mounted hosted server also carries `default_tools_approval_mode: "approve"`,
which auto-approves every one of its tools for the task the moment it mounts. Hosted servers are
offered under every permission mode but `plan`, which runs read-only and mounts none of them.
User-configured and plugin-provided external servers follow `CODEX_INHERIT_MCP` independently of
the permission mode. Settings → Agents states the hosted-server gate on Codex's card. Before
relying on this in production, test `gpt-5-codex` plus a mounted
MCP server on your pinned LiteLLM and codex versions — BerriAI/litellm#14846 recorded silent empty
completions for exactly that combination.

Antigravity mounts every selected alias into the task's own `mcp_config.json`, slugified to
hyphens: the CLI's policy engine splits a tool name on the first underscore after `mcp_`, so an
alias with one would break a wildcard permission rule for it. The URL still addresses the real
(unslugged) alias LiteLLM hosts.

### Known issues

- LiteLLM's `/spend/logs` has no tag filter or pagination:
  [BerriAI/litellm#14218](https://github.com/BerriAI/litellm/issues/14218)
- LiteLLM adds `reasoning.summary` to reasoning-effort requests, which OpenAI rejects for
  organizations that have not completed verification:
  [BerriAI/litellm#16032](https://github.com/BerriAI/litellm/issues/16032)
- `gpt-5-codex` through LiteLLM has a history of silent empty completions when MCP servers are
  attached (closed):
  [BerriAI/litellm#14846](https://github.com/BerriAI/litellm/issues/14846)
- LiteLLM's `/v1/models` is OpenAI-shaped, so `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` cannot
  help Claude Code, which expects the Anthropic shape; Calandria does its own discovery from
  `/model/info` instead:
  [BerriAI/litellm#27180](https://github.com/BerriAI/litellm/issues/27180)

See the private notes repo's
[litellm.md](https://github.com/calandria-dev/calandria-notes/blob/main/design/litellm.md) for
more detail, including the reproduction recipe and request shapes behind these notes.

## Adding another agent

The app is agent-agnostic behind a small driver interface. A new driver supplies normalized
stream events and a capability descriptor; shared routing, transcripts, task state, and UI
controls consume that contract.

See [Architecture: the agent-driver seam](ARCHITECTURE.md#the-agent-driver-seam-libagents) for the
implementation guide. Proposals for another agent are welcome in
[GitHub Discussions](https://github.com/calandria-dev/calandria/discussions/categories/ideas).

`lib/agents/gemini/` is the worked example for a CLI with no SDK. The choice of the Antigravity
CLI (`agy`) over Gemini CLI is recorded in the private notes repo's
[gemini-driver.md](https://github.com/calandria-dev/calandria-notes/blob/main/design/gemini-driver.md):
Gemini CLI stopped serving Google AI Pro, Ultra and free accounts on 2026-06-18, the headless
surface of both CLIs, the event mapping, the login flow, and which of its assumptions the driver
had to correct against a real capture.
