# lib/agents — the driver seam

This file loads when you open anything under `lib/agents/`. The root `CLAUDE.md` covers the
seam itself (the `AgentDriver` contract, `getDriver()`, the stdio tool bridge, which one-shot
runs on which agent). What follows is the per-driver detail.

## Claude driver (`claude/`)

`driver.ts` runs a turn through the Agent SDK, resuming the task's session or starting a fresh
one, with project context appended to the Claude Code system prompt by `buildProjectContext()`.
It also hosts the Calandria MCP tools (`suggest_task`, `list_tasks`, `get_task`, `update_task`,
`withdraw_suggestion`, `set_base_branch`, `create_pr`, `list_projects`, `expose_service`),
`summarizeTranscript()` for `/clear` and `draftProjectContext()`, a read-only repo-exploring
agent. Auth delegates to
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

### What auto mode tells the model, and the one thing we say back

A task session's prompt is not only ours, and the CLI's half of it points away from delegating.
Under `auto` the CLI adds a meta message — *"Do your work through the Bash tool wherever it can
accomplish the job: read files with cat, head, or sed -n, search with grep and find … Fall back to
a dedicated tool only when Bash genuinely cannot do the job"* — and on an Opus 5 prompt bundle the
system prompt additionally carries *"Do not call the AgentTool unless the user requested it"*.
Both are sensible defaults for a session nobody has told otherwise, both come from the CLI rather
than from here, and together they are the measured reason a first turn spends 79% of its tool
calls on Bash and none on `Agent` (`docs/DELEGATION.md`).

`buildProjectContext()` therefore ends with the block that answers them: bulk collection goes to a
synchronous subagent past two read-only commands in a row. Three things about it are load-bearing
and pinned by `tests/delegateCollection.test.ts`. It is **last** in the appended text, and the
append lands after every CLI section — which is the difference between this and the same rule in
`CLAUDE.md`, which dispatched only after a median of two read-only commands and opened a turn with
one in 1 of 9 runs, against 5 of 9 here. Its trigger is a **count**, because the
`CLAUDE.md` version's "a third read-only command against the same question" let a model rule each
command a different question. And it is gated on `dispatchesSubagents`, so a Codex turn isn't
pointed at a tool it doesn't have. `CALANDRIA_DELEGATE_COLLECTION=off` removes it.

One thing to watch on a CLI upgrade: 2.1.240 also carries a `## Delegating to subagents` section
arguing the other way ("subagents multiply cost and time … do not fan out"), gated behind an
experiment (`CLAUDE_CODE_THISTLE_GREBE`, values `default` / `no_nudges` / `counter_steer`) that is
not on for us today. If a release ever floors Opus to `counter_steer`, this block is arguing with a
whole section instead of two lines, and the dispatch rate in `docs/DELEGATION.md` is what to
re-measure.

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

The catalog itself is a hardcoded array, not a list fetched from anywhere. Nothing queries the
Anthropic API for it on the subscription path, and nothing reads GCP config for it on Vertex — a
new model shows up only by being added here. Half the entries are Claude Code's family *aliases*
(`fable`, `opus`, `sonnet`, `haiku`, `opusplan`), so what they resolve to is the installed CLI's
decision at turn time; the rest are literal ids handed to `--model`. That split is why a new
version can need a pinned row even when its family alias already exists: `fable` resolves through
the CLI's own catalog, so an instance whose CLI predates the version — likely wherever
`DISABLE_AUTOUPDATER` is set — never reaches it. Measured on 2.1.252, `--model fable` billed
`claude-fable-5` after 5.1 shipped, which is what `claude-fable-5-1` is pinned for; measured
again on 2.1.257, the same alias resolves `claude-fable-5-1`. Both are correct for their CLI,
which is the point: the alias is a moving target and only the pin is a promise.

Pinning an id the installed CLI doesn't know is safe, and the failure mode is legible: the CLI
logs `[claude-code:unrecognized_model]` and passes the string through unchanged, so the turn runs
and bills as the id asked for. It is a pass-through and not a silent fallback — probing a bogus
`claude-fable-6` alongside it errored out rather than quietly running something else, which is the
control that makes the `claude-fable-5-1` result mean anything.

**No alias label names a version, on either catalog.** A pin may, because it pins one; an alias
is resolved by the installed CLI (or by `ANTHROPIC_DEFAULT_*_MODEL` under Vertex) at turn time,
so a version in the label is a guess about what that resolver will pick — the very thing the
pinned row above exists because you can't rely on. Measured wrong: on 2.1.257 `--model fable`
runs `claude-fable-5-1` while the row read "Fable 5". Default-catalog aliases therefore read
"(latest)" and Vertex's read "(provider default)" — each naming its resolver — and the version is
stated only where it's known, by `modelLabel()` parsing the id a turn actually billed. Picker
says "Fable (latest)", badge says "Fable 5.1"; that split is what `tests/modelLabel.test.ts` and
`tests/claudeVertexModels.test.ts` pin from both ends.

The resolution IS readable without an API call — `claude --model <alias> --output-format
stream-json` prints it on the `init` line, which still appears with `ANTHROPIC_BASE_URL` pointed
at a dead port — but it costs a ~4s CLI spawn per value, and this descriptor is read
synchronously per request (`modelContextWindow()` runs inside `getTaskContext()`). Putting the
resolved id in an alias's subtitle the way Vertex does wants a cached, CLI-version-keyed
background probe, which is not built.

The Vertex list is a set of measured corrections, not a second catalog. Every entry the catalog
held at the time was probed with a one-shot `claude -p --model <value>` and 13 of 14 ran;
`tests/claudeVertexModels.test.ts` records the table. `claude-fable-5-1` postdates that sweep and
was not probed on Vertex — it is dropped with the rest of its family below, on the alias's
measured 403, rather than credited with a result of its own. What the probe found:

- Bare Anthropic ids do resolve on Vertex, so the "Pinned versions" group is unchanged.
  `@version` (`claude-haiku-4-5@20251001`) is an optional pin there rather than the required
  spelling. That's why this isn't upstream's Bedrock picker (`b5d995f`) renamed: that list drops
  the `[1m]` variants, and those work here.
- `contextWindow` on the family aliases was wrong. Aliases resolve through
  `ANTHROPIC_DEFAULT_*_MODEL`, so a mapping carrying `[1m]` makes plain `opus` a 1M session that
  the catalog called 200k, a fifth of the real window on the context gauge. Aliases now take
  their window and subtitle from the id they resolve to and drop the version claim from their
  label (`f82f66d`'s relabel; a pinned row still names its version, correctly).
- `settings.json`'s `env` block beats the process env. Measured, not assumed: exporting a
  different `ANTHROPIC_DEFAULT_OPUS_MODEL` while settings.json said otherwise still ran
  settings.json's choice.
- `fable` is the one probed entry that fails (403, because the GCP project has no `anthropic`
  publisher data sharing) and is dropped from the Vertex list. On this fork Fable arrives through
  the direct arrangement with Anthropic rather than by flipping a GCP setting, so until then it
  would 403 every turn it was picked for. It stays on the default catalog, where it works. The
  filter matches the whole family rather than the single value `fable`, so `claude-fable-5-1`
  goes with it — that gate is per publisher, not per version, so the pinned row is dropped for
  the alias's measured reason rather than claiming a probe of its own.

Bedrock stays on the default catalog. There's no Bedrock instance here to measure.

**The connection record carries the provider it was verified against** (issue #38). A verify
proves a login works against ONE backend, and the backend is instance config the user can flip
under a running app, so `lib/agents/connections.ts` stamps `configuredProvider()` into
`agent_conn_claude` (`method|email|plan|provider`) on every login / verify / api-key save, and a
read whose stored provider differs from the current one is NOT a connection: the record is
dropped and the agent is flagged exactly as a dead login flags it (`agent_auth_broken_claude`
plus one `agent_auth` event on the bus, keyed `""` since no task detected it), so the titlebar
banner and the Settings card say which backend the login was for and which the CLI now routes
through. Reconnecting writes a record against the new provider and clears the flag. Rows written
before the field existed read as `anthropic`, the only backend that path verified, so an instance
that never left Anthropic is untouched, while one that had already moved to Vertex asks for one
reconnect. Codex stores no provider and never mismatches. `tests/agentConnectionProvider.test.ts`
pins the mismatch, the legacy read and the once-per-outage announcement.

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

A provider override (`lib/agentEnv.ts`, docs/AGENTS.md "Local models") reaches Codex as
config, not env: `codex/provider.ts` maps the merged turn env's `OPENAI_BASE_URL` onto a
`model_providers.calandria-local` entry on the Responses wire API and selects it with
`model_provider`, because the CLI reads its provider from config.toml and under a ChatGPT
login ignores `OPENAI_BASE_URL`. The override's `CODEX_MODEL` sits below the task's pick and
the Settings default in the model fallback. Claude Code needs no mapping: the same override
IS its environment.

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
because it's tracked and shows up in that same diff — and, since nothing forces that review to
happen before the NEXT TURN, because the runner hashes it before every turn and holds the turn on
a card when it moved (`lib/settingsDrift.ts`, issue #43). That watch list is DERIVED from
`SETTING_SOURCES` via `WORKTREE_SETTINGS_FILE`, a total map over the SDK's union, so re-adding a
worktree-resolved source extends the gate to it in the same edit rather than re-opening the hole
under a name nothing is watching. `tests/claudeSettingSources.test.ts` pins all of it.

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
