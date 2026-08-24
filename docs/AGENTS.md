# Supported agents

Calandria supports Claude Code and OpenAI Codex as first-class task agents. You can connect
either one or both, choose a default, and override the agent for an individual task. With
only one agent connected the New-task and Edit-task dialogs skip the agent picker — there is
nothing to choose — and it reappears the moment a second agent is connected (or when a task
already points at an agent that isn't).

## Support matrix

| Agent | Authentication | Task support | Notes |
|-|-|-|-|
| Claude Code | Max/Pro login or optional API key | Full | Reference driver; supports interactive questions and reported cost data |
| OpenAI Codex | ChatGPT login or optional API key | Full | Supports interactive questions through Calandria's bridge; estimated cost data |

Connecting either agent completes first-run setup and makes it the initial default. The
app never requires Claude when only Codex is connected, or vice versa. Project recaps,
context drafts, and other utility jobs prefer a connected agent automatically.

## Authentication and billing

The recommended path is the subscription login offered by the first-run wizard or
**Settings → Agents**. Subscription turns consume plan quota and have no marginal API
charge. Calandria removes stray `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` values from its
launch environment by default so an inherited shell variable cannot silently switch a
session to API billing.

If you intentionally want API-key billing, connect a key in the app or set
`ORCH_ALLOW_API_KEY_ENV=1` for a deliberately configured headless environment.

## Claude Code

Claude Code is the reference driver and the first target for new agent-facing features.
It supports parallel tasks, resume and `/clear` lineage, interactive questions, project
context, diff workflows, and usage reporting.

Task sessions run inside isolated worktrees under one of five permission modes, ordered
here from most autonomous to least:

The modes are named exactly what Claude Code calls them — the same strings
`--permission-mode` takes — so nothing has to be translated between Calandria and the
agent's own docs:

| Mode | What it does |
|-|-|
| **bypassPermissions** | Never asks — bypasses every permission check. The only mode that never consults the gate. |
| **auto** | *(the default)* A model classifier screens each call, silently approving what it judges safe and escalating the rest to a permission card. |
| **acceptEdits** | File edits auto-apply; commands and everything else prompt. |
| **default** | Claude Code's standard prompting — anything not already approved asks. |
| **plan** | Propose a plan without editing; leaving the plan asks. |

Every mode except bypassPermissions is a real gate: whatever it doesn't auto-approve parks the turn
on a permission card in the transcript. Read-only tools never prompt. "Always allow"
remembers a command for that project only, and every remembered approval is listed and
revocable in Settings → Run defaults — where you can also add one up front, without
waiting for a prompt to happen. A typed-in rule goes through the same policy as the card:
Bash commands only, and "and its arguments" stores just the command and its subcommand
(`git push origin main` → `git push …`), refusing outright when the line is one no honest
prefix describes — a wrapper like `sudo`, an env assignment, or anything the shell could
reinterpret. A prompt nobody answers declines itself, so an
auto-started task can't sit wedged waiting for someone who isn't there — which is the
trade-off of the default: unattended work that trips the classifier stops and says so
rather than pressing on. Set the app default to bypassPermissions for fleets that must never stop.

Claude Code can also refuse a call by itself, without asking Calandria first — the auto
classifier vetoing something, or a deny rule in your own `~/.claude` settings. That
shows up in the transcript as a permission card that arrives already decided, sitting on
the call it stopped: what the agent was about to run, who refused it, and why. There are no
buttons, because the decision is already made; if it should have been allowed, change the
task's permission mode.

The SDK also has a `dontAsk` mode ("deny anything not pre-approved, don't prompt"); Calandria
doesn't offer it. Under `dontAsk` the CLI decides everything itself and never asks Calandria
at all, so none of the above applies: not the read-only allowlist, not your remembered
approvals, not the cards. "Pre-approved" would mean allow rules in your own Claude Code
settings file. `default` plus **Always allow** already gives you deny-unless-allowed,
with a prompt when you want one and a revocable record of everything you granted.

Calandria is a control layer, not an additional security sandbox; review
[the security model](../SECURITY.md) before exposing an instance.

A task session also loads your own Claude Code configuration — `~/.claude` settings, MCP
servers, plugins and skills, plus the repository's `CLAUDE.md` — so it behaves like the
`claude` CLI you already use, with Calandria's own tools added on top. Your MCP servers'
tools go through the permission modes above like everything else.

Calandria's own background jobs deliberately do not. A `/clear` handoff note, a project
recap and a "Refresh with AI" context draft are internal transformations, not sessions you
are sitting in, so they run with your MCP servers, plugins, skills and hooks switched off —
otherwise every four-bullet recap would start your entire MCP fleet to offer tools it can
never call. They still read `~/.claude/settings.json`, because that is also where a
Bedrock/Vertex/proxy setup keeps its `env` block and `apiKeyHelper`, so they authenticate
exactly the way your ordinary turns do. The context draft additionally loads the
repository's `CLAUDE.md` — describing the repo is its job — and can read, search and list
files, but not run commands or write anything.

## OpenAI Codex

Codex supports parallel tasks, diff review and merge, `/clear` lineage, project context,
interactive questions, and usage tracking. Calandria supplies interactive questions through
its MCP bridge because the upstream non-interactive CLI does not provide that hook itself.

Three upstream differences are visible:

- ChatGPT-plan authentication reports tokens but not dollar cost, so Calandria estimates
  the API-price equivalent and marks it with `~`.
- The non-interactive CLI cannot pause an active turn for a command-approval prompt.
  Calandria therefore offers Codex's own **workspace-write** (writable sandbox, never
  asks) and **read-only** (plan) modes rather than a
  mid-turn approval mode, and asks Codex not to require approvals
  (`approval_policy=never`). If an enterprise-managed Codex configuration disallows
  that, Calandria detects the CLI's downgrade warning on the first affected turn and
  switches itself to the compatible `on-request` policy automatically — the failed
  turn gets a one-click Retry. `CODEX_APPROVAL_POLICY` remains the manual override.
  Claude's permission cards have no Codex equivalent yet: the
  MCP bridge that carries `ask_user` could carry approvals the same way, but the CLI would
  first have to route an approval request to a tool call instead of a terminal prompt.
- Codex tasks get Calandria's own tools but **not** the MCP servers from your
  `~/.codex/config.toml`, where a Claude task does get yours. Same missing approver as
  the point above: an inherited server's tools are offered to the model and every call
  returns `user cancelled MCP tool call`. Calandria unmounts them rather than dangle tools
  that cannot work. Set `CODEX_INHERIT_MCP=1` to mount them anyway — worthwhile if you
  have set `default_tools_approval_mode = "approve"` on your own servers. Each agent's
  card in **Settings → Agents** says which side of this it is on, so you can see it
  before picking an agent for a task.

## Adding another agent

The app is agent-agnostic behind a small driver interface. A new driver supplies normalized
stream events and a capability descriptor; shared routing, transcripts, task state, and UI
controls consume that contract.

See [Architecture: the agent-driver seam](ARCHITECTURE.md#the-agent-driver-seam-libagents)
for the implementation guide. Proposals for another agent are welcome in
[GitHub Discussions](https://github.com/calandria-dev/calandria/discussions/categories/ideas).
