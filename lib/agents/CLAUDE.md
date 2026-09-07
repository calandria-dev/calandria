# lib/agents: the driver seam

This file loads when you open anything under `lib/agents/`. The root `CLAUDE.md` covers the seam
itself (the `AgentDriver` contract, `getDriver()`, the stdio tool bridge, which one-shot runs on
which agent). What follows is per-driver detail.

## Claude driver (`claude/`)

`driver.ts` runs a turn through the Agent SDK, resuming the task's session or starting fresh, with
`buildProjectContext()` appended to the Claude Code system prompt. It hosts the Calandria MCP
tools (`suggest_task`, `list_tasks`, `get_task`, `update_task`, `withdraw_suggestion`,
`set_base_branch`, `create_pr`, `list_projects`, `expose_service`), `summarizeTranscript()` for
`/clear`, and `draftProjectContext()`, a read-only repo-exploring agent. Auth delegates to
`lib/claude-auth.ts`.

### Permission modes

`capabilities.ts` is the source of truth for what the driver honors. The picker offers `auto` (app
default: the CLI's own classifier screens each call and escalates what it won't vouch for),
`bypassPermissions`, `acceptEdits`, `default` and `plan`. `tests/claudePermissionMode.test.ts` pins
the list against `permissionModeFor()`.

`dontAsk` is excluded: it never invokes `canUseTool`, so `lib/permissions.ts`'s gate is inert
under it. That doesn't mean unrestricted, though: the CLI's own classifier can still self-refuse a
command under `dontAsk` with the callback firing for neither the run nor the refusal (`echo hello`
ran while `rm -f …` was refused with `decision_reason_type: "mode"`). "Pre-approved" under this
mode would mean allow-rules in the user's own `~/.claude` settings, which Calandria doesn't write
there itself. `default` plus remembered rules already gives deny-unless-allowed with a revocable
record.

### Auto mode and delegation

Under `auto` the CLI's own system prompt pushes the model toward doing everything via Bash and,
on some prompt bundles, against calling a subagent at all. The CLI's meta message reads, byte for
byte: *"Do your work through the Bash tool wherever it can accomplish the job: read files with
cat, head, or sed -n, search with grep and find … Fall back to a dedicated tool only when Bash
genuinely cannot do the job."* On an Opus prompt bundle the system prompt additionally carries:
*"Do not call the AgentTool unless the user requested it."* `buildProjectContext()` counters with a
block, **last** in the appended text: past two consecutive read-only Bash calls, the third goes to
a synchronous collection subagent. Pinned by `tests/delegateCollection.test.ts`:

- The trigger is a **count** of consecutive read-only calls, not "a different question"; judging
  by topic let a model rule each call a distinct question and never trip the rule.
- Gated on the capability descriptor's `dispatchesSubagents`, so a Codex turn isn't pointed at a
  tool it doesn't have.
- `CALANDRIA_DELEGATE_COLLECTION=off` removes it.

Watch CLI upgrades for a `## Delegating to subagents` system-prompt section arguing the opposite:
*"subagents multiply cost and time … do not fan out"*, gated behind an experiment flag
(`CLAUDE_CODE_THISTLE_GREBE`, values `default` / `no_nudges` / `counter_steer`). Check on each
upgrade whether that flag has moved to `counter_steer` by default: that would mean the CLI is
arguing against delegation in a whole section. Today it's two lines, worth re-measuring against
real sessions (method in the private notes repo's
[DELEGATION.md](https://github.com/calandria-dev/calandria-notes/blob/main/measurements/DELEGATION.md)).

### Refusals that skip `canUseTool`

The `auto` classifier and deny rules refuse without calling `canUseTool`. These arrive as a
`system`/`permission_denied` message carrying `tool_use_id`, so the driver yields a
`permission_denied` StreamEvent and the runner settles an already-decided permission card onto the
transcript row that call created (the same component as an ordinary card, read-only). Each refused call
gets its own transcript card (three denials produce three cards). `awaiting_input`
stays untouched (nothing to answer), and Calandria's own `canUseTool` denials never emit this
message, so the two paths can't double-render.

`blockedReason()` (`lib/permissions.ts`) picks what a human sees. The live CLI leaves
`decision_reason` unset and fills `message`, written for the model (~700 characters of "IMPORTANT:
You *may* attempt to accomplish this action using other tools…"), so that tail is cut;
`decision_reason_type` (including CLI-minted values like `subcommandResults`) is phrased separately
in `Transcript.tsx`. Both the refusal message and the `decision_reason_type` values are captured
verbatim in `tests/claudePermissionMode.test.ts`.

### The in-process tool-call cutoff

`lib/agentToolGuard.mjs` wraps every Calandria tool handler so a throw, an over-long call or a
blank result comes back as a sentence naming the tool. An empty result would be a quiet failure the
model can't notice. Applied to the whole tools array (Claude driver) and to `registerTool` (stdio bridge), so
a new tool can't opt out. Timeout is `CALANDRIA_AGENT_TOOL_TIMEOUT_MS`
(`DEFAULT_AGENT_TOOL_TIMEOUT_MS`, 10 min; 0 for `ask_user`).

One failure sits above that seam: on a **resumed** session, an in-process `mcp__calandria__*` call
can come back to the model as "The tool call was interrupted before a result was received"
(`CLI_INTERRUPTED_TOOL_RESULT`, `lib/agentToolGuard.mjs`) with no Calandria handler ever running.
The CLI's own MCP client aborted the request before it reached us. The CLI's own transcript tags
this `toolDenialKind: "interrupted"`, the same tag its `aFn()` gives an `AbortError` thrown while
the turn's own controller is NOT aborted, so the abort signal the call was given isn't the turn's.
Once a session fails one call this way, every later Calandria call in it fails identically,
including across a resume into a new CLI process. `/clear` recovers it; the driver posts a
transcript notice saying so on the first occurrence in a turn, worded to say the call MAY OR MAY
NOT have taken effect (`toolInterruptedMessage()`), since the abort can fire after the request was
already sent, so the driver can't claim the call definitely didn't happen. The event is flagged `cutOff`
(`tool_result.cutOff`), the runner logs it onto the `turn ok` line as `tool_cutoffs`, and
`[agent-tools] agent tool call received` / `… settled` mark every call that actually reached
Calandria: a `cut off` line with no matching `received` line is the CLI answering on its own
behalf. `CALANDRIA_CLAUDE_DEBUG_DIR` makes the CLI write its own per-turn MCP debug log, and the
CLI's stderr is captured alongside the task. The stdio bridge is a separate process and cannot see
any of this: it never learns its own answer was discarded.

`create_pr` has a repair: a session that hits the cutoff there falls back to `git push` + `gh pr
create`, leaving the PR invisible to the task row. `adoptExistingPr` (`lib/prTools.ts`) runs at
the end of every turn on a `pr` project and links it, gated on the row showing a branch with no
`pr_url` and `refs/remotes/origin/<branch>` existing locally. Once adopted, the header chip,
`lib/prState.ts` polling and auto-reclaim work as if `create_pr` had run.

### Escape hatch: Claude's tools over the stdio bridge

`CALANDRIA_CLAUDE_TOOL_TRANSPORT` picks the transport. `in-process` (default) is
`createSdkMcpServer`, above; `stdio` mounts `scripts/calandria-mcp.mjs` instead (the same bridge
Codex and Antigravity use, POSTing to `/api/internal/agent-tools/*`). `./mcp.ts` is the entry,
built field-for-field as the Codex driver's env block. **Default stays `in-process`**: the cutoff
above hasn't reproduced in targeted synthetic runs, so switching would trade an unconfirmed
failure for a subprocess per turn on the strength of one upstream SDK issue report. The knob
exists for an instance actually hitting it.

Seam differences under `stdio` (Codex has run on these since the bridge shipped):

- **Suggestion-queue correlation.** In-process settles the `suggest_task` card by `tool_use_id` on
  the turn's stream. The bridge, reached out of band with no such id, patches the newest unclaimed
  `suggest_task` row instead (`lib/suggestionCard.ts`).
- **No bridge counterpart for the `notice` callback.** In-process, `expose_service` posts a
  standalone transcript line with the live URL. Bridged, the URL only reaches the model as the
  tool's own result; the standalone line is lost.
- **Auto-start callback.** In-process hands a cleared blocker back via `TurnHooks` (this file must
  not import `lib/autoStart.ts`). The bridge endpoint has no such constraint and calls
  `maybeAutoStartDependents()` directly. `onPrOpened`/`lib/prState.ts` is the same shape.
- **`ask_user` is withheld from Claude only** (`CALANDRIA_MCP_ASK_USER=0` on the Codex-shaped env
  block `./mcp.ts` builds). Claude's own AskUserQuestion already routes to the same permission
  card via the `PreToolUse` hook.

`[agent-tools] agent tool call received` reports `transport: "bridge"` on stdio, so logs identify
which transport ran. The stdio entry also sets `timeout` 30s above the bridge's own guard deadline
(so the guard always answers first; in-process gives no way to set the CLI's per-server cap) and
`alwaysLoad` (keeps the tools out of tool-search deferral).

### Model catalog and Vertex corrections

The model half of the capability descriptor is computed per read, not held constant: which models
exist and what an alias resolves to is instance config. `provider.ts` (SDK-free: fs and env only)
reads the same surfaces Claude Code reads; `claudeCapabilities()` corrects the catalog when
`configuredProvider()` reports Vertex. Both the driver's `capabilities` getter and
`lib/agents/capabilities.ts`'s thunks go through it.

The catalog is a hardcoded array, not fetched: a new model appears only by being added in code.
Two kinds of entry:

- **Family aliases** (`fable`, `opus`, `sonnet`, `haiku`, `opusplan`, and `[1m]` variants): what
  they resolve to is the installed CLI's decision at turn time (or, on Vertex,
  `ANTHROPIC_DEFAULT_*_MODEL`). A CLI upgrade can silently move what an alias bills, so a new
  release can need a pinned row even when the alias already exists.
- **Pinned ids** (e.g. `claude-opus-4-8`): a literal id handed to `--model`, immune to that drift.

An id the installed CLI doesn't recognize is a pass-through, not a silent fallback: the CLI logs
`[claude-code:unrecognized_model]` and runs the string unchanged, billing as asked.

**No alias label names a version, on either catalog.** A version in an alias's label would be a
guess about what the CLI's resolver picks. Default-catalog aliases read "(latest)"; Vertex's read
"(provider default)". The version is stated only once known, by `modelLabel()` parsing the id a
turn actually billed: picker says "Fable (latest)", badge says "Fable 5.1" once a turn has run.
`tests/modelLabel.test.ts` and `tests/claudeVertexModels.test.ts` pin both ends.

**`lib/agents/claude/modelProbe.ts` reads the resolution with no API call.**
`claude -p --bare --model <alias> --output-format stream-json --verbose --no-session-persistence`
prints the resolved id and `claude_code_version` on the `init` line before any request goes out,
even against a dead `ANTHROPIC_BASE_URL`; `subscriptionModels()` puts the result in the alias
row's subtitle, the same place `vertexModels()` puts its mapped id, so the two paths (subscription
alias resolution and Vertex mapping) render identically in the picker. Three constraints:

- **Cannot spend anything.** `--bare` reads Anthropic auth strictly from `ANTHROPIC_API_KEY` or an
  `apiKeyHelper`, never the user's OAuth login; the base URL points at a dead loopback port; the
  child is killed the moment `init` is read; `--bare` skips hooks (a `SessionStart` hook could
  otherwise block it indefinitely).
- **Cannot be on a request path.** `claudeCapabilities()` is sync and read per request
  (`GET /api/agents`, `modelContextWindow()`), while the sweep is five CLI spawns run serially. It
  runs detached off `GET /api/agents`, awaited by nobody, leaving its answer in
  `lib/agents/claude/modelIds.ts`. That file imports nothing else on purpose: the prober reaches
  `lib/store.ts` to persist, and `lib/store.ts` imports `lib/agents/capabilities.ts` back, so a
  descriptor reading the prober directly would close a cycle through an async external.
- **Absent is a supported state.** No cache yet, no `claude` on PATH, a timed-out probe,
  `CALANDRIA_CLAUDE_MODEL_PROBE=off`, or a Codex-only instance all fall back to the static catalog,
  asserted row by row in `tests/claudeModelProbe.test.ts`.

Keyed by CLI version (`claude --version` is cheap), persisted in `settings` under
`claude_model_ids`, so a restart costs one version spawn, not the sweep. `[1m]` rows derive from
whatever the base alias resolves to (`opus[1m]` follows `opus`), matching `vertexModels()`'s own
derivation; `contextWindow` follows the resolved id too.

**Vertex corrections** (full probed table in `tests/claudeVertexModels.test.ts`):

- Bare Anthropic ids resolve fine on Vertex, so "Pinned versions" is unchanged; `@version` suffixes
  are optional there.
- `contextWindow` on family aliases was wrong: aliases resolve through
  `ANTHROPIC_DEFAULT_*_MODEL`, so a mapping to a `[1m]` id makes plain `opus` a 1M-context session
  the old catalog reported as 200k. Aliases now take window and subtitle from the id they resolve
  to.
- `settings.json`'s `env` block beats the process env for these variables.
- `fable` 403s on Vertex (no `anthropic` publisher data sharing on the GCP project) and is dropped
  from the Vertex catalog with its whole family (`claude-fable-5-1` included; the filter is per
  publisher, not per version). It stays on the default catalog, where it works.

Bedrock stays on the default catalog; no Bedrock instance exists to correct against.

### Connection records are provider-scoped

A verify proves a login works against one backend, which can change under a running app.
`lib/agents/connections.ts` stamps `configuredProvider()` into `agent_conn_claude`
(`method|email|plan|provider`) on every login/verify/api-key save. A read whose stored provider
differs from the current one counts as no connection: the record is dropped and the agent flagged
the same way a dead login is (`agent_auth_broken_claude` plus an `agent_auth` event keyed `""`),
so the titlebar banner and the Settings card state which backend the login was verified against
and which the CLI now routes through. Reconnecting writes a fresh record and clears the flag. Rows
written before this field existed read as `anthropic`, so an instance that never left Anthropic is
untouched, while one that moved to Vertex is asked to reconnect once. Codex stores no provider and
never mismatches. `tests/agentConnectionProvider.test.ts`
pins the mismatch, the legacy read, and that the announcement fires once per outage: it stays quiet
on every later re-read of the same outage.

## Codex driver (`codex/`)

`@openai/codex-sdk` spawns `codex` and talks JSONL over stdio; `codex/events.ts` normalizes its
`ThreadEvent` stream. One-shot helpers are `codex exec` runs in a read-only sandbox.

**Usage is cumulative per thread**, not per turn: `turn.completed` is a delta against a baseline
in `sessions.usage_cum`, written the moment usage maps (not at run end) so a crash or Stop can't
re-bill the thread on the next turn, and never clamped to zero (a counter going backwards means it
isn't really cumulative). Cache reads/writes are netted into `input_tokens`, matching the
three-bucket `StreamEvent` shape and avoiding double-counting in the context gauge.

**Context window and default model come off the CLI's own account state** (`codex/catalog.ts`),
since both are per-account: `models_cache.json` under `CODEX_HOME` (default `~/.codex`) and only
the **top-level** keys of `config.toml` (never `[profiles.x]`, which would apply an occasional
profile's settings to every turn). Window = slug's `context_window`, overridden by
`model_context_window`, clamped to `max_context_window`, scaled by
`effective_context_window_percent` (the CLI's own compaction point). Default model = `config.toml`'s
`model`, else the lowest-`priority` catalog entry with `visibility: "list"`. Account catalogs
reorder and reprice models the binary's compiled-in catalog has never heard of, so getting this
wrong misprices every turn that picks no model.

Reads are synchronous behind a 60s cache (`getCapabilities()` sits on the request path) and fail
soft on any bad input (absent file, bad JSON, unrecognized shape, wrong field type), falling back
to `CTX_FALLBACK` (272,000, `lib/agents/codex/capabilities.ts`) and `DEFAULT_CODEX_MODEL`
(`"gpt-5.6-sol"`, `lib/agents/codex/pricing.ts`), what the CLI itself falls back to uncatalogued.

**Plan usage is fed two ways.** The app-server transport gets a passive feed for free: while a
turn runs, the server pushes `account/rateLimits/updated` carrying the same `RateLimitSnapshot`
an active read returns, and `codex/appServerTurn.ts`'s notification handler feeds it to
`ingestRateLimits()` in `codex/planUsage.ts`, which writes the same cache an active fetch would.
`PLAN_USAGE_MIN_FETCH_MS` then skips a redundant active read whenever a snapshot already arrived,
so an instance running turns back to back never spawns a process for this at all. The active
read still covers an idle instance and the exec transport, whose stream carries no token/rate-limit
field and caches nothing under `$CODEX_HOME/sessions`: `codex/planUsage.ts` reads
`account/rateLimits/read` from a throwaway `codex app-server` (`codex/appServer.ts`), behind that
same floor. Field names come from `codex app-server generate-json-schema` and are camelCase
(`usedPercent`, `windowDurationMins`, `resetsAt` in seconds), with windows named by rank
(`primary`/`secondary`), which is why `PlanUsagePill` matches two id vocabularies.

### Transport, permission modes and writable roots

`codex app-server`, the CLI's IDE JSON-RPC protocol, is the default transport (`CODEX_TRANSPORT`);
`exec` is the SDK-path fallback. `codex exec` answers every approval request with a rejection
before the host sees it, so under it no permission mode can ask anyone anything. On app-server,
approval arrives as a JSON-RPC request (`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`) answered by
`promptPermission()` (`lib/permissionPrompt.ts`), the same function Claude's `canUseTool` calls:
the Bash-only `permission_rules`, the attended/unattended deadlines and the scheduled-run
`interactionPolicy: "deny"` all apply unchanged. `item/tool/requestUserInput`, Codex's native
question tool, lands on the ask card.

Three files carry the transport: `codex/appServerClient.ts` (framing, id correlation, the SDK's
own `--config` flattening), `codex/appServerTurn.ts` (one turn: handshake, `thread/start` or
`thread/resume` with a fresh-thread fallback, `turn/start`, the request handlers,
`turn/interrupt` on Stop), and `codex/appServerEvents.ts` (respells v2 items as the exec
protocol's so `codex/events.ts` maps both transports identically, and reads
`thread/tokenUsage/updated` for a real context gauge and the cumulative usage counter that
carries across transports). `tests/codexAppServer.test.ts` drives all of it against a fake binary
(`tests/fixtures/codex/fake-app-server.mjs`).

`codex/policy.ts` maps a permission mode to Codex's own policy, shared by both transports:

| Mode | Codex policy |
|-|-|
| `auto` (default) | workspace-write, `on-request` approvals decided by Codex's own reviewer (`approvals_reviewer: "auto_review"`) |
| `default` | workspace-write, escalations go to the card |
| `acceptEdits` | workspace-write that never asks |
| `bypassPermissions` | `danger-full-access` |
| `plan` | read-only |

A migration moved every Codex row stored as `bypassPermissions` onto `acceptEdits`, preserving
prior behavior. Only `turn/start` (not `thread/start`) can carry the full `SandboxPolicy` object
with `writableRoots`.

Under workspace-write, Codex marks a linked worktree's `.git` gitdir pointer and its resolved
real gitdir read-only, and the repo's common `.git` sits outside every writable root, so a
sandboxed commit fails there by default. `gitWritableRoots()` grants exactly what a commit needs:
the task's private gitdir, plus the common dir's `objects/`, `refs/` and `logs/`, never the whole
common dir (a writable `config` there would let a sandboxed turn plant a `core.fsmonitor` or
`hooksPath` that runs unsandboxed on the user's next `git status`). `CODEX_WRITABLE_ROOTS` adds
more roots.

### Sandbox health

On a host that blocks unprivileged user namespaces (e.g. Ubuntu AppArmor
`kernel.apparmor_restrict_unprivileged_userns=1`), Codex's bubblewrap sandbox can't start, so
every `workspace-write`/`read-only` turn runs, looks normal, and fails every command.
`lib/agents/codex/sandbox.ts` classifies the app-server's startup `configWarning` and promotes it
to instance state (`agent_sandbox_broken_codex`, a flag separate from the dead-login flag, since
reconnecting a working login does not fix a broken sandbox). Three writers, one reader:
`probeCodexSandbox()` runs at connect time and from the connect card's Check again button
(`POST /api/agents/[id]/sandbox`, via the optional `AgentDriver.sandboxHealth()`); the driver's
`onWarning` records it mid-turn. It clears on a clean probe or on any app-server turn that reached
a session and saw no such warning (the `sawSession` gate: a fresh server's silence is proof, a
turn that died before the server spoke is not). The driver refuses to start a `workspace-write`
or `read-only` turn while the flag is set, naming the sysctl, an AppArmor profile for bwrap,
`bypassPermissions` and `CODEX_EXTERNAL_SANDBOX`; `danger-full-access` is never refused, having no
sandbox to fail. The classifier does not treat "could not find bubblewrap on PATH" as fatal, since
that warning names its own bundled fallback. `CODEX_EXTERNAL_SANDBOX` sends `workspace-write` out
as the app-server's `externalSandbox` policy, so Codex confines nothing and the container image is
the boundary; it covers only that one mode, since `read-only` assumes a read-only filesystem a
container does not provide.

Enterprise-managed approval requirements can disallow `approval_policy=never`. The driver detects
the CLI's downgrade warning and sends `on-request` for the never-asking modes from then on,
recording `codex_approval_downgraded` (a card on app-server, a quiet self-heal on exec).

### Provider override wiring

A provider override (`lib/agentEnv.ts`, `docs/AGENTS.md` "Local models") reaches Codex as config,
not env: the CLI reads its provider from `config.toml` and a ChatGPT login ignores
`OPENAI_BASE_URL`. `codex/provider.ts` maps the merged turn env's `OPENAI_BASE_URL` onto a
`model_providers.calandria-local` entry (Responses wire API), selected via `model_provider`. The
override's `CODEX_MODEL` sits below the task's own pick and the Settings default in the fallback
order. Claude Code needs no mapping: the override value IS its environment.

A LiteLLM gateway gets a second entry, `calandria-gateway`, not a conditional inside the local one:
the id is what `codex doctor` reports back, and one id for both would let a gateway-earned verdict
certify a local endpoint. It carries `env_key` (naming `CALANDRIA_GATEWAY_KEY`, populated by
`applyGatewayEnv`) and `http_headers` with the same `x-litellm-tags` list Claude Code sends, built
by one shared function. Codex bills the key in both billing modes; `requires_openai_auth`
(ChatGPT-forwarding) sends no `Authorization` header through a gateway and stays disabled until
verified otherwise. `planWindowApplies()` is where that reaches the UI: a gateway Codex task offers
no queue-at-reset, since its rate-limit snapshot is empty behind a gateway. `docs/AGENTS.md` has
the three operational hazards (deployment cooldown, LiteLLM's `reasoning.summary` injection,
`gpt-5-codex` with MCP servers attached).

### `codex/providerCheck.ts` proves the mapping took

The mapping rests on config keys (`model_providers.<name>`, `model_provider`,
`wire_api = "responses"`) that aren't a public contract. If codex stops recognizing an override
key, the failure is **inert, not an error**: it silently falls back to the built-in `openai`
provider (the user's paid ChatGPT login) while the header still shows the `local` chip. `codex
doctor --json` accepts the same `-c` overrides the SDK passes and reports what it resolved under
`checks["config.load"].details["model provider"]`; the driver checks this before building the
client and refuses the turn if the answer isn't the expected id (`calandria-local` or
`calandria-gateway`).

- **Only that one field is read.** `overallStatus` also fails when the local server is merely
  down, unrelated to whether the mapping took.
- **Fail-closed.** Missing `doctor`, non-JSON, or a report missing the field all refuse.
  `CALANDRIA_CODEX_PROVIDER_CHECK=off` is the escape hatch, named in the refusal message.
- **Cached against the CLI version that earned it** (`codex_provider_ok:<baseUrl>`).
- **One exception: a win32 batch shim.** Embedded quotes in the override
  (`model_provider="…"`) can be corrupted by `cmd.exe /d /s /c`; that path degrades to pre-check
  behavior with a warning. Pointing `CODEX_CLI_PATH` at the real executable restores the check.
- **Which binary gets probed.** With `CODEX_CLI_PATH` set, probe and SDK drive the same file;
  empty, they resolve separately (SDK to the vendored `@openai/codex` binary, probe to `codex` on
  PATH); same binary in every shipped configuration, but pinning removes that assumption.
- **`serializeCodexConfigOverrides` restates the SDK's own `--config` flattener**, since the probe
  must send byte-identical arguments to certify a shape any turn actually uses.
  `tests/codexProviderCheck.test.ts` pins it against the SDK's real argv and drives the real
  `codex` binary to confirm it.

The Claude side needs no equivalent: pointed at a sink on `ANTHROPIC_BASE_URL`, claude-cli under a
subscription login sends every request to the sink with no fallback to `api.anthropic.com`.

## Antigravity / Gemini driver (`gemini/`)

Registered unconditionally in `registry.ts` and `capabilities.ts`, like the other two: an
instance with no `agy` on PATH sees an agent it can pick and cannot connect, same as a missing
`codex`. Google's `agy` CLI has no SDK, so this driver owns the process: `spawn`, NDJSON off
stdout, `gemini/events.ts` to normalize. Every invocation carries `AGY_CLI_DISABLE_AUTO_UPDATE=true`
so a self-update can't swap the binary mid-turn or mid-login. Everything is pinned to recorded
fixtures (`tests/fixtures/gemini/`): the CLI's own documentation describes a different wire format
than it emits, so fixtures are the only reliable source (corrections in the private notes repo's
[gemini-driver.md](https://github.com/calandria-dev/calandria-notes/blob/main/design/gemini-driver.md)).

**Each task runs under its own `HOME`** (`gemini/home.ts`). `agy` reads MCP servers from one
user-global file, `~/.gemini/config/mcp_config.json`, and the bridge takes its identity from that
entry's env, so a shared file means whichever task wrote last owns every other task's
`suggest_task`/`ask_user` calls. Two wrinkles: a bare per-task `HOME` loses the login
(`~/.gemini/antigravity-cli` is symlinked back in), and `HOME` reaches every shell command the
agent runs (the rest of the real home is symlinked across too, or the agent has no git identity).
`scripts/calandria-mcp.mjs` itself is untouched.

**Usage is cumulative per conversation**, like Codex: a turn's spend is a delta against a baseline
in `sessions.usage_cum`. Cost is estimated from Google's published prices (`gemini/pricing.ts`);
the CLI reports no dollar figure.

**A denied tool is nearly silent.** Headless mode auto-denies without reliably changing the exit
code (0) or run status (the same denial has ended a run both `CANCELED` and `SUCCESS`).
`CANCELED` must not be read as "the user stopped it" unless our own abort fired; the driver also
reads stderr for the denial line. The descriptor offers no ask-style permission mode for the same
reason: the CLI's default mode can't complete a single tool call headlessly.

**Reasoning effort is part of the model slug** (e.g. `gemini-3.8-flash-high`), so
`reasoningOptions` is empty and `--effort` is never sent. The catalog also serves Anthropic and
open-weights models.

**Login drives a pty.** The headless flow hard-times out at 61s, and the authorization code is
bound to that child's PKCE verifier, so respawning invalidates the code the user is holding.
`gemini/auth.ts` runs the interactive CLI under node-pty instead (lazily imported). `agy models` is
the connection-status probe: no `--output-format` flag, exits 0 either way, so its text is the only
signal.

Two capability-descriptor fields the connect card branches on (`app/shell/AgentConnect.tsx`) let it
react to any agent with the same quirk, with no id check hardcoded into the card:

- `loginCompletesOutOfBand: true`: the OAuth redirect lands on Google's own callback page and
  completes the exchange there, so a user who never copies the code back is still signed in. The
  card polls `authStatus()` alongside the login pty and kills the pty once it lands.
- `connectHint`, states the container caveat where the button is: `agy` keeps its token in the OS
  keyring over D-Bus with no file fallback, so a container with no keyring daemon can only use the
  API-key tab.

A refused or expired login code is watched for via `/authentication (?:failed|timed out)/i`
(`AUTH_FAILED`, `lib/agents/gemini/auth.ts`), since the CLI prints that and returns to its own prompt. It does not exit, so without the match the
card would sit on a dead paste box until the reaper.

**Plan quota is readable and free.** `agy -p "/usage" --output-format json` returns
`command.data.groups[]` (a weekly and a 5-hour bucket per model group, as `remaining_fraction`)
and spends nothing (`num_turns: 0`, zero tokens). `gemini/planUsage.ts` implements the optional
`planUsage()` hook on that basis, converting two differences from the Claude reader: the CLI
reports what's LEFT where the snapshot wants percent SPENT, and there is no passive half (no
rate-limit telemetry in the turn stream), so `status` stays null and data is only as fresh as the
last poll. Each poll is a process spawn, so it shares `PLAN_USAGE_MIN_FETCH_MS` and single-flights
with the Claude reader; the constraint here is a CPU cost this instance controls, unlike a provider
rate limit.

## Agent MCP inheritance

A **Claude** task session is meant to feel like the user's own `claude` terminal.
`SETTING_SOURCES` in `claude/driver.ts` is `["user", "project"]`: a session gets `~/.claude`
settings, MCP servers, plugins, skills, plus the repo's CLAUDE.md. The list is written out
explicitly. The SDK loads every on-disk source when `settingSources` is absent, so leaving it
implicit would make the choice invisible and CLI-version-dependent. `local`
(`<worktree>/.claude/settings.local.json`) is dropped: agent-writable and gitignored by
convention, so anything planted there never appears in a human's diff review yet still runs next
turn with no `canUseTool` check in between. `project` is kept (tracked, visible in a diff), and
the runner hashes it before every turn, holding the turn on a card if it moved
(`lib/settingsDrift.ts`). That watch list (`WATCHED_SETTINGS_FILES`) derives from
`SETTING_SOURCES` via `WORKTREE_SETTINGS_FILE`, so adding a worktree-resolved source to
`SETTING_SOURCES` extends the drift gate in the same edit. `tests/claudeSettingSources.test.ts`
pins all of it.

Inheritance grants nothing on its own: inherited servers' tools still go through `canUseTool` like
any other call (auto-approved under `bypassPermissions`, classifier-screened under `auto`, a
permission card otherwise), reachable in every mode.

A **Codex** task gets the Calandria bridge plus the external MCP servers Codex reports from the
user's config and enabled plugins, by a different route. The SDK flattens our `config` into
leaf-level `--config mcp_servers.calandria.…` overrides, which the CLI merges into its existing
MCP configuration, so those servers arrive whether we ask or not, and `CODEX_INHERIT_MCP`
(default on) leaves them mounted. App-connector tools exposed through Codex's separate
`codex_apps` server are not entries in `codex mcp list` and are not what this flag controls. The
driver used to unmount reported external servers by default, on the belief that `codex exec` had
no approver and every inherited tool call returned `user cancelled MCP tool call` (observed once
on codex-cli 0.146.0); Codex tasks do call inherited tools, so that default was wrong.
`CODEX_INHERIT_MCP=0` is the opt-out: `codex/mcp.ts` enumerates the servers (`codex mcp list
--json`, ~30ms, best-effort), keeping only each one's name and transport type, and overrides each
with `enabled = false` plus an inert transport of the same kind (`command =
"calandria-disabled-mcp-server"` for stdio, `url = "https://mcp-disabled.invalid"` for streamable
HTTP), since Codex validates every `mcp_servers` entry before merging plugin-provided definitions
and a bare `{ enabled = false }` failed that validation and broke startup for anyone with a
plugin server (`cua_repl`). The real command, args, env, URL, headers and bearer-token variable
are dropped at parse time and never reach an override. `default_tools_approval_mode: "approve"`
stays scoped to our own first-party bridge instead of becoming a global.

Both halves are capability-descriptor data (`inheritsUserMcpServers`, `userMcpServersNote`), so
`GET /api/agents` carries the difference and Settings → Agents states it on each agent's card
(`McpInheritance` in `SettingsView.tsx`).

## One-shots isolate capability and inherit config

A Claude one-shot (handoff note, recap) gets the opposite policy from a Claude turn: no Calandria
bridge, no UI to answer a prompt, so inheriting the full MCP fleet would only spend time and
context on tools the job can never call. Four levers:

- **`tools`, not `allowedTools`.** `allowedTools` only pre-approves (under `bypassPermissions`
  that's everything), so it isn't a restriction. `tools: []` (plus `skills: []` against the
  discovery pass) is what removes built-ins.
- **`strictMcpConfig: true`** drops MCP from settings, `.mcp.json` and plugins; `tools` alone only
  governs built-ins.
- **Inline `settings: { disableAllHooks: true, autoMemoryEnabled: false }`** closes hooks, which
  fire whether or not a tool exists to hook. `managedSettings` doesn't work here (the SDK filters
  that tier restrictive-only) and shouldn't be used anyway: it impersonates the IT-policy tier.
- **`settingSources: ["user"]`, not `[]`.** `~/.claude/settings.json` also carries a user's `env`
  block, `apiKeyHelper` and model aliases, load-bearing for auth/provider routing on
  Vertex/Bedrock/proxy setups. `[]` fails such a run outright ("Not logged in"); `["user"]`
  succeeds with 0 tools and 0 MCP servers.

Codex's `oneShot()` has a different boundary: it uses a read-only sandbox with network disabled
and mounts no Calandria bridge, but it follows the same `CODEX_INHERIT_MCP` choice as a task turn.
External MCP servers therefore remain mounted by default and receive the inert disabled overrides
only when the instance opts out. Live verification on codex-cli 0.153.4 confirmed both modes start
and complete; the default one-shot initialized inherited stdio and streamable-HTTP servers, while
the opt-out one-shot started neither.

`summarizeTranscript`/`summarizeProjectRecap` run as `TEXT_ONE_SHOT`: no tools, `maxTurns: 1`,
`["user"]` only. `draftProjectContext` keeps `project` (describing the repo IS the job) but drops
`local`, runs `maxTurns: 40`, trades Bash for `tools: ["Read", "Grep", "Glob"]`.
`planTagRefresh` (`lib/tagRefresh.ts`) reuses that exact configuration (same kind of run, reading
a repo to judge a plan); only the output differs (a JSON plan the server applies, not prose). All
four set `persistSession: false`, since nothing resumes a one-shot's session. `tests/claudeSettingSources.test.ts`
pins both policies.

## Which model a one-shot runs

`oneShotModel()` in `lib/agents/oneshots.ts` resolves the model. Settings are **agent-scoped**
(`default_model` per agent, since a model id names one provider's catalog); unset means "pass
nothing, inherit the driver's own default".

Two tiers, not one knob per job, since the jobs split cleanly and the drivers already encode it:
LIGHT (`summarizeTranscript`, `summarizeProjectRecap`) is text in/out, `tools: []`, `maxTurns: 1` /
`ONESHOT_MAX_ITEMS_TEXT`; HEAVY (`draftProjectContext`, `planTagRefresh`) reads an unfamiliar
codebase over `maxTurns: 40` / `ONESHOT_MAX_ITEMS_EXPLORE`.

The lookup keys off the **resolved** driver, not the requested one: a Codex task whose `/clear`
note falls back to Claude reads `job_model_light:claude`, never a `gpt-*` id Claude's catalog can't
run (`tests/oneshotModel.test.ts`). `OneShotOptions` is trailing-optional on every helper
signature, so a driver that ignores it still satisfies `AgentDriver`.

### Recording which model actually ran

The setting only says what was asked for, and it can be null (tier unset = "inherit the CLI's own
default", which no setting can name). `OneShotResult` carries `model` beside `usage`;
`internal_usage.model` stores what the driver reported, falling back to the requested id and then
to null: never a guess.

Claude reads the `init` message's resolved model (the field a turn badges as `resolved_model`),
falling back to the result message's `modelUsage` keys when the stream never announced one
(`claudeMessageModel()` in `claude/usage.ts`). Codex and Antigravity have nothing in their event
streams to read, so each reports the `resolve*Model()` value it already computes for pricing.
`verifyTurn()` passes no `--model` at all, so its recorded value is the only record of what the
CLI picked on its own. Insights names models under "Calandria's own usage"; Settings names them
beside the utility-job run count. A run with no recorded model still counts toward the run total
and cost.

## Slash-command discovery

`AgentDriver.listCommands?(task, project)` is optional (Codex omits it; the menu falls back to
Calandria's own commands). `claude/commands.ts` implements it through the SDK's control channel: a
`query()` whose prompt generator never yields, `supportedCommands()`, then `abort()`/`close()`. No
model request is sent, but session startup is still real, so it uses the one-shot isolation policy
(`strictMcpConfig`, `mcpServers: {}`, `disableAllHooks`, `persistSession: false`) and inherits only
`settingSources`, the input that decides which commands exist. Results are cached per cwd+sources
(60s TTL, in-flight deduped, 64-entry cap): cwd decides which project-level `.claude/commands` are
in scope, sources decide whether project settings load at all. Re-measured with and without
`strictMcpConfig`, the same command list comes back apart from MCP prompt commands: ordinary
plugin *commands* are unaffected by `strictMcpConfig` either way, only MCP prompt commands don't
travel with plugin MCP config.

`lib/schedule/commands.ts` shares the same `listClaudeCommands()` call, so the composer's `/` menu
and the schedule validator read from one source and can't disagree. Two contract details this
depends on: the probe returns **`null`, not `[]`, when it couldn't find out** (the caller coerces
`?? []`; reading a dead login as an empty registry would wrongly fail a scheduled run for a command
that exists), and `refresh` bypasses both the TTL and the stale-entry fallback.

**MCP prompt commands** (`/mcp__<server>__<prompt>`) are structurally invisible to the probe above:
it initializes with no MCP config, and even a probe that inherited the fleet would only see
servers that connected inside the ~700ms startup window. Instead, every turn's
`init.slash_commands` is handed to `recordMcpPrompts()` under the same cache key, and
`listClaudeCommands()` merges those `mcp__` entries in at read time with no TTL and newest-wins, so
a removed server stops being offered. A task offers no MCP prompts until its first turn has run.
The schedule validator, which probes the project's repo where no turn runs, treats an absent
`mcp__` command as **unchecked**, not unknown.

`lib/agentCommands.ts` holds the visibility policy (SDK-free, pinned by `tests/importGraph.test.ts`).
Default is SHOW, minus the CLI's own internal sentinels and `CONFLICTS`: `clear` (Calandria's
`/clear` is a different behavior behind the same name) and `model`/`effort`/`fast` (the task's own
pickers own those). Aliases are carried, so `/writing-plans` resolves `superpowers:writing-plans`.

A `/clear` typed in full **mid-turn** is refused outright by the composer. Queuing it as an
ordinary follow-up would let it reach the CLI's own `/clear` and wipe the session's context behind
Calandria's back, with no handoff note and no new generation.

## Adding another agent

Implement `AgentDriver` in `lib/agents/<id>/driver.ts` (only `runTurn()` required), register it in
`registry.ts` **and** `capabilities.ts` (the second is what `listAgentIds()`/`isAgentId()` read; a
driver registered only in the first is connectable but invisible to id-level lookups), and ship
its CLI in the `Dockerfile`. Nothing else changes: the runner, routes, recap/refresh jobs and UI
data flow are all seam-generic. Pin it with `tests/agentDriver.test.ts`, which mocks a driver's CLI
at the SDK boundary and runs it through the real runner.

`gemini/` is the worked example for a CLI with no SDK: mock `node:child_process.spawn`
(`tests/geminiDriver.test.ts`) and replay recorded NDJSON. Ship a new driver behind an env gate
while unproven, and remove the gate in the change that makes it first class, so no flag is left
for nobody to set.

Promoting `gemini/` out of its gate touched little outside the driver: a brand mark in
`app/icons.tsx`, a chart hue, two capability fields for the connect card, and one generalization
each in `lib/usageReset.ts` and `app/shell/PlanUsage.tsx` (both had hardcoded the 5-hour window to
Claude's own id; `PlanUsageWindow.kind` now names the two windows every metered plan has). Nothing
in the runner, the routes or the task model needed to change.

**Capture the CLI's real output before writing the event-shape mapping.** Vendor documentation and
a binary's own embedded prose are not reliable sources for step-type spelling, how MCP calls are
named, whether usage is per-turn or cumulative, or where the session id lives; get a recorded
transcript first.
