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

### Tool results the CLI answers on its own behalf

`lib/agentToolGuard.mjs` wraps every Calandria tool handler so a throw, an over-long call or a
blank result comes back as a sentence naming the tool. One failure sits above that seam and the
guard cannot reach it: the CLI answers the call itself and no handler runs.

Measured 2026-09-02 (task `CrDHcuyuDt1PmLu0PDd1K`, Claude Code 2.1.257, server pid unchanged across
the window). Five in-process `mcp__calandria__*` calls came back to the model as "The tool call was
interrupted before a result was received." Each returned in the same second as the call, only
Calandria tools were hit, and `Bash` calls in the same assistant turns were fine. The sentence is
the CLI's own. `callMCPTool` returns it when the MCP client rejects with an `AbortError`, so the
tool-call signal was already aborted when the request went out. Calandria never saw the call.
`linkSignals` is not involved: only `canUseTool` uses it, and every turn gets a fresh controller
from `claimTurn`/`handoffTurn`.

Nothing landed in that session. `tasks.pr_url` stayed empty and no branch was pushed for three
`create_pr` calls, and the task the model reported filing was created 23 seconds later by its own
`POST /api/tasks` fallback, with `suggested=0`. The abort can still fire after the request is sent,
so `toolInterruptedMessage()` says the call may or may not have taken effect rather than promising
it did nothing.

It does not reproduce from `resume` alone. Four spikes (fresh, two resumes, and a mid-turn
injection, with and without the real `settingSources`) all returned their results. So the driver
does the only thing available to it. The stream pump classifies the CLI's sentence for calls it
recorded as Calandria's, replaces it with one that names the tool and says whose answer it is, and
logs `agent tool call cut off before Calandria answered`. Without that line a turn whose Calandria
calls all failed still logs `turn ok`, with nothing in the journal to find it by. The stdio bridge
cannot do the same, being a separate process that never learns its answer was discarded.

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

**The resolution is readable without an API call, and the subtitle now reports it.**
`claude -p --bare --model <alias> --output-format stream-json --verbose --no-session-persistence`
prints the resolved id and the `claude_code_version` that resolved it on the `init` line, before
any request goes out — it still appears with `ANTHROPIC_BASE_URL` pointed at a dead port.
`lib/agents/claude/modelProbe.ts` reads it there and `subscriptionModels()` puts it in the alias
row's subtitle, the same place `vertexModels()` puts the mapped id, so the two paths render
identically. The label is untouched: "(latest)" stays true however the alias resolves.

Three constraints shape that probe, and the file states each:

- **It cannot spend anything.** `--bare` reads Anthropic auth strictly from `ANTHROPIC_API_KEY`
  or an `apiKeyHelper` passed via `--settings`, so the user's OAuth login is not in the process;
  the base URL points at a dead loopback port; and the child is killed the moment the line is
  read. `--bare` also skips hooks, which the probe must not fire — measured before the flag went
  in, a `SessionStart` hook blocked past two minutes and the init line never arrived.
- **It cannot be on a request path.** `claudeCapabilities()` is synchronous and read per request
  (`GET /api/agents`, and `modelContextWindow()` from inside `getTaskContext()`), while the sweep
  is five CLI spawns run one at a time — ~17s cold against the developer's real config dir. So it
  runs detached, kicked off by `GET /api/agents` and awaited by nobody, and leaves its answer in
  `lib/agents/claude/modelIds.ts` for the descriptor to read. That file imports nothing on
  purpose: the prober reaches `lib/store.ts` to persist, and `lib/store.ts` imports
  `lib/agents/capabilities.ts` back, so a descriptor that read the prober directly would close a
  cycle through an async external.
- **Absent is a supported state.** No cache yet, no `claude` on PATH, a probe that timed out,
  `CALANDRIA_CLAUDE_MODEL_PROBE=off`, a Codex-only instance — every one of them returns the
  static catalog untouched, which `tests/claudeModelProbe.test.ts` asserts row by row.

Keyed by CLI version because that is what moves the answer (`claude --version` is ~15ms warm),
and persisted in `settings` under `claude_model_ids` so a restart costs that one spawn rather than
the sweep. The `[1m]` rows are derived rather than probed: `opus[1m]` resolves to the `[1m]`
spelling of whatever `opus` resolves to (measured `claude-opus-5[1m]`), the same derivation
`vertexModels()` makes. `contextWindow` follows the resolved id too — inert on today's
subscription resolutions, and the fix for the day a bare alias starts resolving to a `[1m]`
spelling, which is exactly what had happened on Vertex.

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

**Plan usage is an ACTIVE read here, unlike Claude's.** The titlebar meter is fed for free on
the Claude side by the `rate_limit_event` messages every turn's stream carries. Codex's turn
stream carries no equivalent, and this was verified against the shipped CLI rather than
assumed, because the failure mode is a meter that silently reports nothing: the SDK's
`ThreadEvent` union is closed at eight members, `turn.completed.usage` is token counts only,
and the exec JSONL serializer's own field table in the 0.146.0 binary lists no `token_count`
and no `rate_limits` (older codex builds did emit one; the dotted exec protocol doesn't). Nor
is it cached on disk — the rollout transcripts under `$CODEX_HOME/sessions` hold no
rate-limit entry. So `codex/planUsage.ts` reads `account/rateLimits/read` from a throwaway
`codex app-server` (`codex/appServer.ts`, where the verified JSON-RPC handshake is
transcribed), behind the same `PLAN_USAGE_MIN_FETCH_MS` floor. Field names come from the
CLI's own `codex app-server generate-json-schema` and are camelCase (`usedPercent`,
`windowDurationMins`, `resetsAt` in seconds) with windows named by RANK — `primary` /
`secondary`, not by duration — which is why `PlanUsagePill` matches two id vocabularies.

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

### …and `codex/providerCheck.ts` proves the mapping took

That mapping is three assumptions about another tool's config schema — `model_providers.<name>`,
`model_provider`, `wire_api = "responses"` — none of them a public contract, against a CLI the
SDK resolves off PATH and the user's package manager updates on its own schedule. What makes it
worth a subprocess rather than a comment is the failure mode: an override codex no longer
recognises is **inert, not an error**, so a renamed key silently reinstates the built-in `openai`
provider — the user's paid ChatGPT login — while the header still shows the `local` chip and the
ledger records the endpoint. Same silent-wrong-backend class as the connection/provider mismatch
above, same answer: refuse.

`codex doctor --json` accepts the same `-c` overrides the SDK passes and reports what it resolved
under `checks["config.load"].details["model provider"]`. The driver asks before building the Codex
client and yields an `error` instead of running when the answer isn't `calandria-local`.
Load-bearing details:

- **Only that one field is read.** `overallStatus` is `fail` whenever the local server happens to
  be down, which says nothing about whether the mapping took; gating on it would refuse turns for
  the wrong reason.
- **Fail-closed.** A missing `doctor`, a non-JSON report or a report without that field all refuse.
  "Can't prove it" is not "probably fine" when being wrong spends the user's money.
  `CALANDRIA_CODEX_PROVIDER_CHECK=off` is the escape hatch, named in the error.
- **The verdict is cached against the CLI version that earned it** (`codex_provider_ok:<baseUrl>`),
  since the binary is what moves. `codex --version` is ~30ms warm and guards the ~1.1s probe; the
  cloud path does neither, having no mapping to prove.
- **One documented exception, and only one: a win32 batch shim.** Every override carries embedded
  quotes (`model_provider="…"`), which `cmd.exe /d /s /c` can't be trusted to deliver intact —
  unlike the fixed tokens `bin.ts` was written for. So a "wrong provider" answer there would
  indict our own quoting rather than the mapping, and refusing on it would break every Windows
  instance whose codex is an npm `.cmd` shim. That path degrades to the pre-check behaviour with a
  warning; pointing `CODEX_CLI_PATH` at the real executable spawns it directly and restores the
  check.
- **Which binary gets probed.** With `CODEX_CLI_PATH` set, the probe and the SDK drive the same
  file. With it empty they resolve separately — the SDK to the binary vendored in
  `@openai/codex`, the probe to `codex` on PATH via `bin.ts` — which are the same install in
  every shipped configuration and the same equivalence `auth.ts` and `mcp.ts` already lean on.
  Pinning `CODEX_CLI_PATH` is what removes the "in every shipped configuration", which is one
  more reason the refusal message recommends it.
- **`serializeCodexConfigOverrides` restates the SDK's own `--config` flattener**, because the
  probe has to send byte-identical arguments or it certifies a shape no turn uses. That's a
  duplicate, so `tests/codexProviderCheck.test.ts` pins it against the argv the real SDK spawns a
  fake binary with, and separately drives the real `codex` to show it still answers
  `calandria-local` for the mapping and something else without it.

The Claude side was checked rather than assumed: pointed at a sink on `ANTHROPIC_BASE_URL`,
claude-cli 2.1.257 under a subscription login sent all six `/v1/messages` attempts to the sink and
never fell back to `api.anthropic.com`. No mapping, no fallback, nothing to verify.

## Antigravity / Gemini driver (`gemini/`)

Registered unconditionally in both `registry.ts` and `capabilities.ts`, like the other two — the
`CALANDRIA_EXPERIMENTAL_GEMINI` gate is gone. An instance with no `agy` on PATH sees what it sees
for a missing `codex`: an agent it can pick and cannot connect, which is a state the connect card
explains, where an agent hidden behind an env var is not. Google's `agy` CLI has no SDK, so this
driver owns the process: `spawn`, NDJSON off stdout, `gemini/events.ts` to normalize. Every CLI
invocation in this directory carries `AGY_CLI_DISABLE_AUTO_UPDATE=true`, so a self-update can't
swap the binary out mid-turn — or, worse, mid-login, where the code the user is holding is bound
to the running child. Everything in it is pinned to a recorded capture (`tests/fixtures/gemini/`),
because the CLI's own documentation describes a different wire format than it emits — the
corrections are catalogued in `docs/design/gemini-driver.md` under "Settled by the driver".

**Each task runs under its own `HOME`.** `agy` reads MCP servers from exactly one user-global
file, `~/.gemini/config/mcp_config.json`, and the bridge takes its identity from that entry's env
— so a shared file means whichever task wrote last owns every other task's `suggest_task` and
`ask_user` calls. The workspace customization roots the CLI documents (`.agents/` and friends) are
real for skills, rules and hooks but **not** for MCP; a config placed in all seven candidate
locations at once was still invisible. A per-task `HOME` is what works, with two wrinkles
`gemini/home.ts` handles: a bare override loses the login (so `~/.gemini/antigravity-cli` is
symlinked back), and `HOME` reaches every shell command the agent runs (so the rest of the real
home is symlinked across, or the agent has no git identity). `scripts/calandria-mcp.mjs` is
untouched.

**Usage is cumulative per conversation**, like Codex and unlike the design doc's claim, so a turn's
spend is a delta against a baseline in `sessions.usage_cum`. Cost is estimated from Google's
published prices (`gemini/pricing.ts`); the CLI reports no dollar figure at all.

**A denied tool is nearly silent.** Headless mode cannot prompt, so it auto-denies, and that
changes neither the exit code (0) nor reliably the status — the same denial was seen ending a run
both `CANCELED` and `SUCCESS`. So `CANCELED` must NOT be read as "the user stopped it" unless our
own abort fired, and the driver additionally reads stderr for the denial line. For the same reason
the descriptor offers no ask-style permission mode: the CLI's default mode cannot complete a
single tool call headlessly, so offering it would offer a mode guaranteed to do nothing.

**Reasoning effort is part of the model slug** (`gemini-3.8-flash-high`), so `reasoningOptions` is
empty and `--effort` is never sent. The catalog also serves Anthropic and open-weights models.

**Login drives a pty.** The headless flow dies after a hard 61 seconds, and the authorization code
is bound to that child's PKCE verifier, so respawning for a fresh window invalidates the code the
user is holding. The interactive CLI has no timeout, so `gemini/auth.ts` runs it under node-pty
(lazily imported — it is needed by this one flow, not by every turn). `agy models` is the status
probe: no `--output-format` flag exists, and it exits 0 either way, so its text is the only signal.

**And the login has two ends the connect card had to grow for**, both declared as capability
data rather than branched on by agent id, since the card serves every agent
(`app/shell/AgentConnect.tsx`):

- `loginCompletesOutOfBand: true` — the OAuth redirect lands on Google's own callback page, not a
  localhost port, and that page completes the exchange for the CLI waiting on it. So a user who
  never copies the code is nonetheless signed in, and nothing is written to the pty to say so. The
  card polls `authStatus()` alongside the login session while the code box shows, and kills the
  login's pty once it lands. It is opt-in per driver because each poll is a real CLI spawn.
- `connectHint` — the container caveat, stated where the button is rather than only in the docs:
  `agy` keeps its token in the OS keyring over D-Bus with no file fallback, and the image ships no
  keyring daemon, so in a container the API-key tab is the only path.

A refused or expired code is also watched for in the CLI's output (`AUTH_FAILED`), because the CLI
prints it and RETURNS TO ITS PROMPT rather than exiting — without that the card would sit on a
dead paste box until the 30-minute reaper.

**Plan quota is readable and free.** `agy -p "/usage" --output-format json` returns a structured
`command.data.groups[]` payload — a weekly and a 5-hour bucket per model group, as
`remaining_fraction` — and spends nothing doing it (measured: `num_turns: 0`, zero tokens). So
`gemini/planUsage.ts` implements the optional `planUsage()` hook and the titlebar meter works here
as it does for Claude, with two differences it converts away: the CLI reports what is LEFT where
the snapshot wants percent SPENT, and there is no passive half at all (nothing in the turn stream
carries rate-limit telemetry), so `status` stays null and the data is only as fresh as the last
poll. Each poll is a process spawn, hence the same `PLAN_USAGE_MIN_FETCH_MS` floor and
single-flight the Claude reader uses, for CPU rather than for a provider's rate limit.

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
  `bypassPermissions` pre-approves everything anyway. Every helper used to pass
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
produce a paragraph of prose, whose git half already arrives in `digest`. `planTagRefresh`
("Refresh tag", lib/tagRefresh.ts) reuses that exact configuration — same tools, same
`settingSources`, same `maxTurns` — because it is the same kind of run, reading a repo to judge
a plan; the difference is only that its output is a JSON plan the server applies rather than
prose. All four set
`persistSession: false`, since nothing records a one-shot's session id and they were only filling
the user's own `~/.claude/projects` with unresumable recap turns.
`tests/claudeSettingSources.test.ts` pins both policies.

## Which model a one-shot runs

Nothing used to say. Both drivers passed no model at all, so a handoff note ran on whatever the
user's `~/.claude/settings.json` or `~/.codex/config.toml` happened to name — invisible from
Calandria, and on a machine pinned to an expensive alias it was the expensive one summarizing
four bullets. Codex was worse than invisible: `oneShot()` resolved `resolveCodexModel(null)` for
its *reporting* state, so the pricing estimate claimed the CLI default while the thread actually
ran whatever `config.toml` said.

`oneShotModel()` in `lib/agents/oneshots.ts` is now the one resolver, and the settings are
**agent-scoped** for `default_model`'s reason — a model id names one provider's catalog. Unset
stays the default and still means "pass nothing, inherit the driver's own", so an instance that
never opens Settings behaves exactly as before.

Two tiers, not one knob per job, because the jobs really do split and the drivers already
encode the split: the LIGHT ones (`summarizeTranscript`, `summarizeProjectRecap`) are text in →
text out with `tools: []` and `maxTurns: 1` / `ONESHOT_MAX_ITEMS_TEXT`, while the HEAVY ones
(`draftProjectContext`, `planTagRefresh`) read an unfamiliar codebase over `maxTurns: 40` /
`ONESHOT_MAX_ITEMS_EXPLORE` — one to write a document prepended to every later session in the
project, the other to judge whether a tag's tasks still describe work the code needs.
A per-job knob would be a setting per job almost everyone sets to two values.

The lookup keys off the **resolved** driver, not the requested one. A Codex task whose `/clear`
note falls back to Claude (the utility backstop above) reads `job_model_light:claude`, because
handing Claude a `gpt-*` id would be a model the catalog can't run. That case is
`tests/oneshotModel.test.ts`.

`OneShotOptions` is trailing-optional on every helper signature, so a driver that ignores it
still satisfies `AgentDriver` — the same tolerance the interface already extends to a driver that
implements none of them.

### …and which model it DID run

The setting only says what was ASKED for, and it is null exactly when the answer is interesting:
tier unset means the job inherited the CLI's own default, which no setting can name. So
`OneShotResult` carries `model` beside `usage`, and `internal_usage.model` stores what the DRIVER
reported, falling back to the requested id and then to NULL rather than to a guess.

Each driver answers from what it can see. Claude reads the `init` message's resolved model — the
same field a turn badges as `resolved_model` — with the result message's `modelUsage` keys as the
fallback for a stream that never announced one, since `SDKResultSuccess` has no scalar model
field and that per-model rollup is the only place the id appears (`claudeMessageModel()` in
`claude/usage.ts`; one-shots mount no Task tool, so it holds a single key). Codex and Antigravity
have nothing in their event streams to read, so each reports the `resolve*Model()` value it
already computes for pricing. `verifyTurn()` records one too, and is the purest case: it passes no
`--model` at all, so the row is the only record of what the CLI picked.

Insights names the models under "Calandria's own usage" and Settings names them beside the
utility-job run count. A run with no recorded model still counts in the run total and the cost —
it happened, we just can't say on what.

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

## Adding another agent

Implement `AgentDriver` in `lib/agents/<id>/driver.ts` (only `runTurn()` is required), register
it in `registry.ts` **and** `capabilities.ts` (the second one is what `listAgentIds()`/`isAgentId()`
read, so a driver registered only in the first is connectable but invisible to every id-level
lookup), and ship its CLI in the `Dockerfile`. Nothing else changes: the runner, routes, recap and
refresh jobs, and UI data flow are all seam-generic. Pin it with the driver-contract test
`tests/agentDriver.test.ts`, which mocks a driver's CLI at the SDK boundary and runs it through the
real runner.

`gemini/` is the worked example for a CLI with **no SDK**: mock `node:child_process.spawn` instead
(`tests/geminiDriver.test.ts`) and replay recorded NDJSON. Ship it behind an env gate while it is
unproven — that one was, in `registry.ts` and `capabilities.ts` together — and take the gate off
in the change that makes it first class, rather than leaving a flag nobody sets.

What that promotion cost outside the driver is the measure of the seam: a brand mark in
`app/icons.tsx`, a pinned chart hue, two capability fields for the connect card, and one
generalization each in `lib/usageReset.ts` and `app/shell/PlanUsage.tsx` (both had picked the
5-hour window by Claude's own id for it, so `PlanUsageWindow.kind` now names the two windows every
metered plan has). Nothing in the runner, the routes or the task model.

The lesson from building it, worth repeating for the next one: **capture the CLI's real output
before writing the mapping.** Every one of that driver's event-shape assumptions taken from vendor
documentation and the binary's own embedded prose turned out wrong — step-type spelling, how MCP
calls are named, whether usage is per-turn, where the session id lives — and each would have been
a plausible-looking bug rather than a crash.
