# Supported agents

Operator supports Claude Code and OpenAI Codex as first-class task agents. You can connect
either one or both, choose a default, and override the agent for an individual task.

## Support matrix

| Agent | Authentication | Task support | Notes |
|-|-|-|-|
| Claude Code | Max/Pro login or optional API key | Full | Reference driver; supports interactive questions and reported cost data |
| OpenAI Codex | ChatGPT login or optional API key | Full | Supports interactive questions through Operator's bridge; estimated cost data |

Connecting either agent completes first-run setup and makes it the initial default. The
app never requires Claude when only Codex is connected, or vice versa. Project recaps,
context drafts, and other utility jobs prefer a connected agent automatically.

## Authentication and billing

The recommended path is the subscription login offered by the first-run wizard or
**Settings → Agents**. Subscription turns consume plan quota and have no marginal API
charge. Operator removes stray `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` values from its
launch environment by default so an inherited shell variable cannot silently switch a
session to API billing.

If you intentionally want API-key billing, connect a key in the app or set
`ORCH_ALLOW_API_KEY_ENV=1` for a deliberately configured headless environment.

## Claude Code

Claude Code is the reference driver and the first target for new agent-facing features.
It supports parallel tasks, resume and `/clear` lineage, interactive questions, project
context, diff workflows, and usage reporting.

Task sessions run unattended inside their isolated worktrees by default (Auto-run).
**Accept edits** and **Plan mode** are real gates: file edits auto-apply under Accept
edits, and everything else — commands, network fetches, subagents, leaving plan mode —
parks the turn on a permission card in the transcript. Read-only tools never prompt.
"Always allow" remembers a command for that project only, and every remembered approval is
listed and revocable in Settings → Run defaults. A prompt nobody answers declines itself,
so an auto-started task can't sit wedged waiting for someone who isn't there.

Operator is a control layer, not an additional security sandbox; review
[the security model](../SECURITY.md) before exposing an instance.

## OpenAI Codex

Codex supports parallel tasks, diff review and merge, `/clear` lineage, project context,
interactive questions, and usage tracking. Operator supplies interactive questions through
its MCP bridge because the upstream non-interactive CLI does not provide that hook itself.

Two upstream differences are visible:

- ChatGPT-plan authentication reports tokens but not dollar cost, so Operator estimates
  the API-price equivalent and marks it with `~`.
- The non-interactive CLI cannot pause an active turn for a command-approval prompt.
  Operator therefore offers Auto-run and read-only Plan modes for Codex rather than a
  mid-turn approval mode. Claude's permission cards have no Codex equivalent yet: the
  MCP bridge that carries `ask_user` could carry approvals the same way, but the CLI would
  first have to route an approval request to a tool call instead of a terminal prompt.

## Adding another agent

The app is agent-agnostic behind a small driver interface. A new driver supplies normalized
stream events and a capability descriptor; shared routing, transcripts, task state, and UI
controls consume that contract.

See [Architecture: the agent-driver seam](ARCHITECTURE.md#the-agent-driver-seam-libagents)
for the implementation guide. Proposals for another agent are welcome in
[GitHub Discussions](https://github.com/iishyfishyy/operator-oss/discussions/categories/ideas).
