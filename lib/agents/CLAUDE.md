# lib/agents — the driver seam

This file loads when you open anything under `lib/agents/`. The root `CLAUDE.md` covers the
seam itself (the `AgentDriver` contract, `getDriver()`, the stdio tool bridge, which one-shot
runs on which agent). What follows is the per-driver detail.

## Claude driver (`claude/`)

`driver.ts` runs a turn through the Agent SDK, resuming the task's session or starting a fresh
one, with project context appended to the Claude Code system prompt by `buildProjectContext()`.
It also hosts the Calandria MCP tools (`suggest_task`, `list_tasks`, `get_task`, `update_task`,
`withdraw_suggestion`, `list_projects`, `expose_service`), `summarizeTranscript()` for `/clear`
and `draftProjectContext()`, a read-only repo-exploring agent. Auth delegates to
`lib/claude-auth.ts`.

### Permission modes

`capabilities.ts` is the single source of truth for what the driver honors. The picker offers
`auto` (the app default: the CLI's classifier screens each call and escalates what it won't
vouch for), `bypassPermissions`, `acceptEdits`, `default` and `plan`.
`tests/claudePermissionMode.test.ts` pins that list against `permissionModeFor()`, so a picker
entry can't quietly resolve to something else.

`dontAsk` is left off, re-decided against the live CLI rather than kept off by inertia: it
never invokes `canUseTool`. Verified on claude-cli 2.1.x, `echo hello` ran and `rm -f …` was
refused with `decision_reason_type: "mode"`, and the callback fired for neither. The whole gate
in `lib/permissions.ts` is therefore inert under it, and "pre-approved" would mean allow rules
in the user's own `~/.claude` settings, which Calandria doesn't write. `default` plus remembered
rules is already deny-unless-allowed, with a prompt and a revocable record.

### Refusals that skip the callback

The `auto` classifier and deny rules refuse without consulting `canUseTool`. Those arrive as a
`system`/`permission_denied` message with no card to answer, but they carry the `tool_use_id`,
so the driver yields a `permission_denied` StreamEvent and the runner settles an already-decided
permission card onto the transcript row that call created. It's the same component, read-only,
showing the tool, its input, who refused and why, sitting with the call rather than as a notice
beside it. Three denials produce three cards. `awaiting_input` stays untouched, since there is
nothing to answer, and Calandria's own `canUseTool` denials don't emit this message, so the two
paths can't double-render.

`blockedReason()` picks what a human sees. The SDK documents `decision_reason` as the
human-readable field, but the live CLI leaves it unset and fills `message`, which is written for
the model (~700 characters of "IMPORTANT: You *may* attempt to accomplish this action using
other tools…"), so that tail is cut. `decision_reason_type` is persisted raw and phrased in
`Transcript.tsx`, because the CLI mints values the SDK's docs don't list (`subcommandResults`).
Both real messages are captured verbatim in `tests/claudePermissionMode.test.ts`.

### Model catalog and Vertex corrections

The model half of the capability descriptor is computed per read rather than held constant,
because which models exist and what an alias resolves to is instance config. `provider.ts`
(SDK-free: fs and env only) reads the same surfaces Claude Code reads, and `claudeCapabilities()`
corrects the catalog when `configuredProvider()` reports Vertex. The driver's `capabilities`
getter and the thunks in `lib/agents/capabilities.ts` both go through it, so `GET /api/agents`
and `modelContextWindow()` agree with the CLI and pick up a settings edit without a restart.

The Vertex list is a set of measured corrections, not a second catalog. Every entry was probed
with a one-shot `claude -p --model <value>` and 13 of 14 ran;
`tests/claudeVertexModels.test.ts` records the table. What the probe found:

- Bare Anthropic ids do resolve on Vertex, so the "Pinned versions" group is unchanged.
  `@version` (`claude-haiku-4-5@20251001`) is an optional pin there rather than the required
  spelling. That's why this isn't upstream's Bedrock picker (`b5d995f`) renamed: that list drops
  the `[1m]` variants, and those work here.
- `contextWindow` on the family aliases was wrong. Aliases resolve through
  `ANTHROPIC_DEFAULT_*_MODEL`, so a mapping carrying `[1m]` makes plain `opus` a 1M session that
  the catalog called 200k, a fifth of the real window on the context gauge. Aliases now take
  their window and subtitle from the id they resolve to and drop the version claim from their
  label (`f82f66d`'s relabel, applied only under Vertex; a pinned row still names its version,
  correctly).
- `settings.json`'s `env` block beats the process env. Measured, not assumed: exporting a
  different `ANTHROPIC_DEFAULT_OPUS_MODEL` while settings.json said otherwise still ran
  settings.json's choice.
- `fable` is the one entry that fails (403, because the GCP project has no `anthropic` publisher
  data sharing) and is dropped from the Vertex list. On this fork Fable arrives through the
  direct arrangement with Anthropic rather than by flipping a GCP setting, so until then it would
  403 every turn it was picked for. It stays on the default catalog, where it works.

Bedrock stays on the default catalog. There's no Bedrock instance here to measure.

## Codex driver (`codex/`)

`@openai/codex-sdk` spawns the `codex` CLI and talks JSONL over stdio; `codex/events.ts`
normalizes its `ThreadEvent` stream. The one-shot helpers are `codex exec` runs in a read-only
sandbox.

Codex reports usage cumulatively per thread while the `StreamEvent` contract is per turn, so
`turn.completed` is a delta against a baseline the previous turn stored in `sessions.usage_cum`.
That baseline is in the DB because it has to survive a restart, and it's written the moment the
usage maps rather than at run end, so a crash or a Stop can't make the next turn re-bill the
thread. Counters going backwards mean the report isn't cumulative after all, so the value is
taken at face value rather than clamped to zero. The three token buckets are also netted into
the disjoint shape the contract expects: codex folds cache reads and cache writes into
`input_tokens`, which would otherwise double-count them in the task total and the context gauge.

Enterprise-managed approval requirements can disallow the driver's `approval_policy=never`,
which the exec transport can't survive. The driver spots the CLI's downgrade warning and
self-heals to `on-request`, recording the `codex_approval_downgraded` setting.

## Agent MCP inheritance is asymmetric

A **Claude** task session is meant to feel like the user's own `claude` terminal.
`SETTING_SOURCES` in `claude/driver.ts` is `["user", "project"]`, which gives a session their
`~/.claude` settings, MCP servers, plugins and skills, plus the repo's CLAUDE.md. The list is
written out rather than omitted: the SDK loads every on-disk source when `settingSources` is
absent, so relying on that both makes a product decision invisible and lets an SDK change alter
what a task trusts. `local` (`<worktree>/.claude/settings.local.json`) is dropped from the
default set, because it's agent-writable and gitignored by convention, so a hook, permission-allow
rule or env var planted there never appears in the diff a human reviews and still runs next turn
with no `canUseTool` check in between. `project` is kept despite also being worktree-writable,
since it's tracked and shows up in that same diff. `tests/claudeSettingSources.test.ts` pins both
halves.

Inheritance grants nothing on its own. Those servers' tools go through `canUseTool` like any
other call: auto-approved under `bypassPermissions`, classifier-screened under `auto`, a
permission card otherwise. They're reachable in every mode, which is the substantive difference
from Codex.

A **Codex** task gets the Calandria bridge and nothing else, and that isn't free to change. The
SDK flattens our `config` into leaf-level `--config mcp_servers.calandria.…` overrides, which
the CLI merges into `~/.codex/config.toml`, so the user's servers arrive whether we ask or not.
But `codex exec` has no approver, so their tools are offered to the model and every call returns
`user cancelled MCP tool call` (verified live on codex-cli 0.146.0). Dangling uncallable tools
cost context and turns, so `codex/mcp.ts` enumerates them (`codex mcp list --json`, ~30ms,
best-effort) and unmounts each with `enabled = false`. `default_tools_approval_mode: "approve"`
stays scoped to our own first-party bridge instead of becoming a global. `CODEX_INHERIT_MCP=1`
opts back in.

Both halves are declared as data on the capability descriptor (`inheritsUserMcpServers`, plus
the driver's one-line `userMcpServersNote`), so `GET /api/agents` carries the difference instead
of the UI hardcoding it, and **Settings → Agents states it on each agent's card**
(`McpInheritance` in `SettingsView.tsx`). "Can this task call my MCP tools" is a reason to pick
one agent over the other, and it used to be visible only in the API response. Codex's flag is
`CODEX_INHERIT_MCP` rather than a literal `false` for the same reason: the card renders the
descriptor verbatim, so a hardcoded no would tell anyone who set the escape hatch the opposite
of what their turns do.

## One-shots isolate capability and inherit config

A Claude one-shot gets the opposite policy from a Claude turn. A handoff note or a four-bullet
recap is an internal transformation with no Calandria bridge and no UI to answer a prompt, so
inheriting the session config only spawned the user's whole MCP fleet to offer tools the job can
never call (measured on one machine: 10 servers, 146 tools, ~8s added to a ~5s job). Four levers
do the work, none of which was set before:

- **`tools`** is the real restriction. `allowedTools` is not: it only pre-approves, and
  `bypassPermissions` pre-approves everything anyway. All three helpers used to pass
  `allowedTools` and get the full toolset (verified on CLI 2.1.228: `allowedTools: []` ran Read,
  and the "read-only" draft agent ran Write). `skills: []` backs it up against the discovery pass.
- **`strictMcpConfig: true`** drops MCP from settings, `.mcp.json` and plugins. `tools` alone
  governs built-ins only, so the fleet survives it.
- **`settings: { disableAllHooks: true, autoMemoryEnabled: false }`** closes the surface tools
  don't cover: hooks fire whether or not a tool exists to hook, and a SessionStart hook injects
  context into a four-bullet recap. Inline `settings` is the lever that works. `managedSettings`
  does not (the SDK filters that tier restrictive-only and the key doesn't survive) and shouldn't
  be reached for anyway, since it impersonates the IT policy tier.
- **`settingSources` stays `["user"]`, not `[]`.** `~/.claude/settings.json` is also where a
  user's `env` block, `apiKeyHelper` and model aliases live, so it's load-bearing for auth and
  provider routing. On a Vertex-configured machine with those vars absent from the server's own
  environment, `[]` fails the run with "Not logged in" while `["user"]` succeeds with 0 tools and
  0 MCP servers. Isolating there would break recap and `/clear` for every Bedrock, Vertex or
  proxy user while their ordinary turns kept working.

This is the same split Codex's `oneShot()` already makes: read-only sandbox, no network, MCP
unmounted, `~/.codex/config.toml` still read.

So `summarizeTranscript` and `summarizeProjectRecap` get `TEXT_ONE_SHOT`: no tools, `maxTurns: 1`,
`["user"]` only, since `project`'s only remaining contribution is the repo's CLAUDE.md and a text
transform can only be skewed by it. `draftProjectContext` keeps `project` (describing this repo
is its whole job, and that's what loads CLAUDE.md) but not `local` (gitignored personal overrides
in a document written for everyone), runs with `maxTurns: 40`, and trades Bash for
`tools: ["Read", "Grep", "Glob"]`: unreviewed arbitrary execution in the user's checkout to
produce a paragraph of prose, whose git half already arrives in `digest`. All three set
`persistSession: false`, since nothing records a one-shot's session id and they were only filling
the user's own `~/.claude/projects` with unresumable recap turns.
`tests/claudeSettingSources.test.ts` pins both policies.

## Slash-command discovery

The composer's `/` menu is discovered, not hardcoded. It used to be a one-element array holding
`/clear`, so the other ~58 commands a Claude session really expands (skills, plugin commands, the
worktree's `.claude/commands`) were invisible. They worked if you typed one in full, which is what
made it read as "slash commands are only partially working".

`AgentDriver.listCommands?(task, project)` is the seam. It's optional like the one-shots; Codex
omits it and the menu falls back to Calandria's own commands. `claude/commands.ts` implements it
through the SDK's control channel: a `query()` whose prompt generator never yields,
`supportedCommands()`, then `abort()` and `close()`. No model request is sent, but initialization
is still a real session startup, so it takes the one-shot policy (`strictMcpConfig`,
`mcpServers: {}`, `disableAllHooks`, `persistSession: false`) and inherits only `settingSources`,
which is the input that decides the answer. Otherwise a SessionStart hook would fire on every
keystroke. Measured at ~290ms against CLI 2.1.228; the isolation costs the answer nothing except
the MCP prompt rows below. Re-measured on 2.1.240, the same list comes back with and without
`strictMcpConfig` apart from those, so plugin *commands* still don't travel with plugin MCP
config. Results are cached per cwd and sources (60s TTL, in-flight deduped, 64-entry cap),
because those two are what change the answer: the cwd decides which project-level
`.claude/commands` are in scope, and the sources decide whether project settings load at all.

**This is the app's only command enumeration.** `lib/schedule/commands.ts` had a second one (send
`"noop"`, read `slash_commands` off the `init` message) which answered the same question with none
of the isolation above: it ran the user's SessionStart hooks unattended inside the ticker's sweep
on every save and every fire, left an unresumable session behind each time, and re-spawned per
keystroke because it had no cache. It now calls `listClaudeCommands()`, so the menu and the
schedule validator can't disagree about what a session expands. Two contract details that
consolidation forced, both load-bearing for the validator and invisible to the menu: the probe
returns **`null`, not `[]`, when it could not find out** (the driver coerces `?? []`; a dead login
read as an empty registry would settle a scheduled run `failed` for a command that exists), and
`refresh` bypasses both the TTL and the stale-entry fallback, since "absent from a list from a
minute ago" is not grounds to refuse a command installed thirty seconds ago.

**MCP prompt commands** (`/mcp__<server>__<prompt>`) are what the probe structurally can't see,
and loosening it isn't the fix. A probe that inherits the fleet does report them, but under a
display label (`stash:analyze-performer (MCP)`) that no session expands, since
`/stash:discover-performers` answers "Unknown command". It also spawns the user's whole fleet on
a keystroke and still answers with a race: the command list is frozen at initialization, so only
servers connected inside the ~700ms startup window contribute prompts (three of fifteen here;
still 82 commands at 4s, 9s and 20s while eleven more connected). The names come instead from the
sessions that already paid for that fleet. The driver hands every turn's `init.slash_commands` to
`recordMcpPrompts()` under the same cache key, and `listClaudeCommands()` merges the `mcp__`
entries in at read time, with no TTL (nothing but another turn can refresh them) and newest-wins,
so a removed server stops being offered. A task therefore offers no MCP prompts until its first
turn has run, and a `(MCP)`-labelled row is dropped rather than inserted. The validator probes the
project's repo, where no turn runs, so it treats an absent `mcp__` command as **unchecked rather
than unknown**.

`lib/agentCommands.ts` holds the visibility policy, SDK-free and pinned by
`tests/importGraph.test.ts`. The default is SHOW, because re-growing a denylist is how this bug
comes back, minus the CLI's internal sentinels, its own `clear` (Calandria's is a different
behavior behind the same name), and `model`/`effort`/`fast` (the task's own pickers own those).
Aliases are carried, so `/writing-plans` finds `superpowers:writing-plans`.

A related fix in the same path: a `/clear` typed in full **mid-turn** used to be queued as an
ordinary follow-up and reach the CLI's own `/clear`, wiping the session's context behind
Calandria's back with no handoff note and no new generation. The composer now refuses it outright.

## Adding a third agent

Implement `AgentDriver` in `lib/agents/<id>/driver.ts` (only `runTurn()` is required), register
it in `registry.ts`, and ship its CLI in the `Dockerfile`. Nothing else changes: the runner,
routes, recap and refresh jobs, and UI data flow are all seam-generic. Pin it with the
driver-contract test `tests/agentDriver.test.ts`, which mocks a driver's CLI at the SDK boundary
and runs it through the real runner.
