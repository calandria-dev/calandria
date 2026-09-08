# Google driver: Antigravity CLI, not Gemini CLI

Spike record, 2026-09-01. Decides which Google CLI the third agent driver wraps. No product
code; the driver itself is the next task in the `gemini-driver` tag.

## Decision

Wrap the **Antigravity CLI** (`agy`). Do not build on Gemini CLI, and do not build on the
Antigravity Managed Agents API.

**Why, in one line:** the point of the driver is to spend the user's Google login the way
the Claude and Codex drivers spend theirs, and since 2026-06-18 only Antigravity CLI can.

## Evidence

### Gemini CLI no longer serves Google accounts

Google's maintainer announcement (Dmitry Lyalin, 2026-05-19, gemini-cli discussion #27274,
fetched verbatim through the GitHub GraphQL API):

> On June 18, 2026, Gemini CLI will stop serving requests for Google AI Pro and Ultra, as well
> as those using it free of charge. These tiers are now supported via Antigravity CLI. […]
> Gemini CLI will also remain accessible via paid Gemini and Gemini Enterprise Agent Platform
> API keys.

So Gemini CLI is now an enterprise-licence and API-key tool. Its npm README still advertises a
free tier of "60 requests/min and 1,000 requests/day", and its `oauth-personal` login still
prints a Google authorization URL, but the tier it authenticates into no longer exists. The
task brief's rate-limit numbers for Gemini CLI (1,000 / 1,500 / 2,000 per day) are pre-cutoff.

The only way a personal Google account reaches Gemini models from a terminal today is the
Antigravity CLI, which the same announcement calls the successor: "Built in Go, the new CLI
[…] retains our most critical features, including Agent Skills, Hooks, Subagents, and
Extensions." Its headless mode is documented for CI, and its changelog explicitly designs for
a driver ("`--input-format stream-json` […] so a driver can keep a session open"). This is
the official client, so it carries none of the terms-of-service exposure of the reverse-
engineered OAuth shims the tag brief warns about.

### Antigravity Managed Agents API is out

It is keyed by `GEMINI_API_KEY` and billed per token; there is no subscription path. It also
runs the agent in Google's sandbox, not in the task worktree, so it cannot host Calandria's
turn model at all.

### What was measured

Both CLIs were installed under a throwaway `HOME` (`/tmp/gemini-spike`), nothing global.
Every flag below comes from `--help` or a run, not memory; "docs" marks a claim taken from
the vendor documentation that could not be exercised without a login.

| | Antigravity CLI 1.1.23 (`agy`) | Gemini CLI 0.58.0 (`gemini`) |
|-|-|-|
| One-shot prompt | `-p` / `--print` / `--prompt <text>` | `-p` / `--prompt <text>`; stdin is appended |
| Output | `--output-format text\|json\|stream-json` | `--output-format text\|json\|stream-json` |
| Multi-turn on stdin | `--input-format stream-json` (one NDJSON `{"event":"user","message":{"content":…}}` per turn, same conversation) | none; one prompt per process |
| Resume | `--conversation <ID>`, `-c` / `--continue` | `--resume <uuid\|index\|latest>`, `--session-id <uuid>` to mint one, `--list-sessions` |
| Session id source | `result.conversation_id` | `init.session_id` |
| Approval | `--dangerously-skip-permissions`; `--mode accept-edits\|plan`; `--sandbox`; settings `toolPermission` (`request-review`, `proceed-in-sandbox`, `always-proceed`, `strict`) and `permissions.allow` patterns (docs) | `--approval-mode default\|auto_edit\|yolo\|plan`, `-y`; TOML policy engine (user tier only; the workspace tier is documented as non-functional) |
| Unapproved tool in headless mode | soft-denied, run continues, exit 0 (docs, changelog) | turn errors: "requires user confirmation, which is not supported in non-interactive mode" (bundle string) |
| MCP config | `agy mcp add [-e K=V]… <name> <cmd> [args]` writes `~/.gemini/config/mcp_config.json` (`mcpServers.<name>.{command,args,env,disabled}`); user-level only, no project scope | `mcpServers` in `~/.gemini/settings.json`, `.gemini/settings.json`, or the file named by `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (highest precedence, `shallow_merge`); `--allowed-mcp-server-names` |
| Model | `--model <slug>`, `--effort low\|medium\|high`; `agy models [--output-format json]` (needs login) | `-m <model>`, `GEMINI_MODEL` |
| Structured output | `--json-schema <inline\|path>` → `result.structured_output` | none |
| Timeout | `--print-timeout` (default 5m) | none |
| Exit codes | 0 success, 1 failure (measured: 1 when unauthenticated); `result.status` is `SUCCESS\|ERROR\|CANCELED\|INTERRUPTED` | 0, 1 general, **41 auth (measured)**, 42 input, 52 config, 53 turn limit, 130 cancel |
| Login storage | OS keyring via `zalando/go-keyring` Secret Service (D-Bus); no file fallback found in the binary; docs: "ensure that a D-Bus session is active and that your keyring daemon is running" | `~/.gemini/oauth_creds.json` (`GEMINI_CLI_HOME` relocates it) |
| Headless login | print mode prints the URL, then "Waiting for authentication (timeout 60s)… Or, paste the authorization code here and press Enter:" (measured) | `NO_BROWSER=1` in a TTY prints the URL and "Enter the authorization code:" (measured); without a TTY exits 41 |
| API key | `GEMINI_API_KEY` + `{"modelProvider":"gemini"}` in `~/.gemini/antigravity-cli/settings.json` (docs); `AGY_ADC_AUTH` for Application Default Credentials | `GEMINI_API_KEY`, Vertex |
| Repo files it executes or reads | `GEMINI.md` / `AGENTS.md` walking up from cwd; `hooks.json` with command hooks (`PreToolUse`, `PostToolUse`, `Stop`) — location to confirm | `.gemini/settings.json` (hooks run shell commands), `GEMINI.md`; project `.gemini/` blocked entirely in headless mode unless `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true` |
| Auto-update | self-updates in the background; `AGY_CLI_DISABLE_AUTO_UPDATE=true` | npm |
| Usage accounting | `result.usage.{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`; the binary also declares `context_window`, `used_percentage`, `remaining_percentage`, `plan_tier`, `total_usd` JSON fields (surface unconfirmed, see open questions) | `result.stats.{input_tokens,output_tokens,cached,total_tokens,…}` per model; no cost |

Raw artifacts: `agy --help`, the unauthenticated print-mode runs, the `NO_BROWSER=1` login
capture, `agy changelog`, and a `strings` dump of the binary are under
`/tmp/gemini-spike/` on the host that ran the spike.

Install notes for the Dockerfile: the vendor script (`https://antigravity.google/cli/install.sh`)
only reads a per-platform manifest from
`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<linux_amd64|linux_arm64|linux_amd64_musl>.json`
(`{version, url, sha512}`), downloads the `.tar.gz` it names, checks the SHA-512, and
installs the single `antigravity` binary as `agy`. The image should do those steps itself
against a pinned version rather than pipe the script, and set
`AGY_CLI_DISABLE_AUTO_UPDATE=true` so the pin holds.

### What was NOT captured

The brief asked for a real `stream-json` transcript of a turn that calls a tool from
`scripts/calandria-mcp.mjs`, plus a resume of that session. Neither CLI could be run
authenticated in this session: the host has no cached Google login for either tool and no
Gemini API key, and completing an OAuth flow needs a person at a browser. The recipe is
below so the driver task's first step is to run it once, on a machine where the user has
signed in interactively with `agy`:

```sh
agy mcp add -e CALANDRIA_TASK_ID=<id> -e CALANDRIA_PROJECT_ID=<pid> \
  -e CALANDRIA_LANDING_MODE=pr -e CALANDRIA_BASE_URL=http://127.0.0.1:3000 \
  -e SERVICE_TOKEN=<token> calandria node /path/to/scripts/calandria-mcp.mjs
cd <worktree>
agy -p "Call the calandria get_task tool and reply with the task title" \
  --output-format stream-json --dangerously-skip-permissions | tee turn1.jsonl
CONV=$(tail -1 turn1.jsonl | jq -r .result.conversation_id)
agy -p "What did the tool return?" --conversation "$CONV" --output-format stream-json | tee turn2.jsonl
agy mcp remove calandria
```

Everything in the event mapping marked *(confirm)* is what that run pins down.

## Event mapping

Antigravity's `stream-json` is documented as a closed vocabulary: `init`, `step_update`,
`result`. The `step_type` discriminator has 118 values in the binary; the coding-relevant
subset is listed. Mapping onto `StreamEvent` (`lib/types.ts`):

| `agy` event | Fields | `StreamEvent` |
|-|-|-|
| `init` | `cwd`, `tools`, `permission_mode` | `model` (from the resolved `--model`); nothing else. The conversation id is not documented on `init` *(confirm; if present, emit `session` here)* |
| `step_update` `step_type=PLANNER_RESPONSE`, `state=ACTIVE`, `text_delta` | assistant prose, streamed | accumulate; emit `assistant` on `state=DONE` |
| `step_update` with `tool_info` (`RUN_COMMAND`, `SHELL_EXEC`, `VIEW_FILE`, `VIEW_CODE_ITEM`, `LIST_DIRECTORY`, `GREP_SEARCH`, `FIND`, `CODE_ACTION`, `PROPOSE_CODE`, `FILE_CHANGE`, `SEARCH_WEB`, `READ_URL_CONTENT`, `GIT_COMMIT`, …) | `tool_info.{name,parameters,output,error}`, `step_index`, `duration_seconds` | `tool{id: step_index, name, title, detail}` on `ACTIVE`; `tool_result{id, content: output, isError: !!error}` on `DONE`. Title/peek/diff through `lib/agents/shared.ts` the way Codex does |
| `step_update` `step_type=MCP_TOOL` | `tool_info.name` *(confirm the spelling: bare tool name or `<server>_<tool>`)* | `tool` / `tool_result` with `name` carrying the bridge tool name so `lib/suggestionCard.ts` can match `suggest_task`; suppress `ask_user` entirely, as Codex does |
| `step_update` `step_type=INVOKE_SUBAGENT` | `subagent_info.{conversation_id, log_uri}` | `tool` "Subagent" (`dispatchesSubagents: true`) |
| `step_update` `step_type=CHECKPOINT` / `TASK_BOUNDARY` / `BRAIN_UPDATE` / `EPHEMERAL_MESSAGE` | housekeeping | drop |
| `step_update` `step_type=ASK_QUESTION` | native question | never arrives in print mode (the CLI "settles a choice itself"); interactive asks come from the bridge's `ask_user` instead |
| `step_update` `step_type=ERROR_MESSAGE` | text | `error` |
| `step_update` with `usage` | per-step tokens | ignore; take the total from `result` |
| `result` `status=SUCCESS` | `conversation_id`, `usage`, `num_turns` | `usage` then `done{sessionId: conversation_id}` |
| `result` `status=ERROR` | `error` | `error` then `done`; classify through `lib/authFailure.ts` ("authentication failed or timed out", "You are not logged into Antigravity") |
| `result` `status=CANCELED\|INTERRUPTED` | | swallow when our own abort fired, else `error` |

Usage is per print-mode run, which is per turn, so unlike Codex there is no cumulative
baseline to diff against *(confirm under `--input-format stream-json`, where several turns
share one process)*. Cost is not reported; quota is "drawn down as per API pricing", so a
pricing table in the shape of `lib/agents/codex/pricing.ts` with `costIsEstimated: true`
is the honest option.

## Login flow for the connect UI

`loginStyle: "paste_code"`, the same shape the generic connect card already renders.

- **`authStatus()`**: `agy models --output-format json`; an unauthenticated CLI answers
  "Please sign in to view available models" (measured) and a signed-in one answers the
  model list. No quota is spent.
- **`startLogin()`**: spawn `agy -p "/help" --output-format json` in a scratch cwd with
  stdin held open. It prints the `https://accounts.google.com/o/oauth2/auth?…` URL on
  stdout followed by "Waiting for authentication (timeout 60s)…" and "Or, paste the
  authorization code here and press Enter:". `getLogin()` returns that URL.
- **`submitLoginCode(code)`**: write the code plus newline to the child's stdin. The
  callback route also completes on its own if the user finishes inside the 60 s window,
  because the redirect goes to Google's `antigravity.google/oauth-callback` page rather
  than a localhost port, so the UI must poll `authStatus()` as well as accept a code.
- **The 60 s wait is not configurable** (no flag or env var in `--help`, the docs or the
  binary's strings), so after the child exits with `authentication failed or timed out`
  the connect card must offer "Start again", which spawns a fresh child and a fresh URL.
- **`verify()`**: `agy -p "Reply with exactly: OK" --output-format json`, expect
  `status: "SUCCESS"` and `response` containing `OK`. It spends one request.
- **API key path**: `apiKeyHint` for `GEMINI_API_KEY`; the driver writes
  `{"modelProvider":"gemini"}` into the CLI's settings when a key is configured. This is
  the only route that works with no keyring, so it doubles as the container fallback until
  the keyring question below is settled.
- Set `AGY_CLI_DISABLE_AUTO_UPDATE=true` on every spawn, so a turn never runs on a binary
  that replaced itself mid-session and the Dockerfile's pinned version stays pinned.

## What Calandria cannot get from this CLI

- **No `canUseTool` gate.** Like Codex, permission modes map onto CLI flags
  (`bypassPermissions` → `--dangerously-skip-permissions`, `plan` → `--mode plan`,
  `acceptEdits` → `--mode accept-edits`, everything else → default `request-review` with
  the bridge server allow-listed). Calandria's permission cards do not apply;
  `supportsAsks` is true only through the bridge's `ask_user`.
- **Unapproved tools are soft-denied silently in print mode**, and that denial does not
  change the exit code. The driver has to read `tool_info.error` to surface it.
- **Cost** is estimated, never reported. **Plan usage** may be readable through
  `-p "/usage"` or `-p "/quota"` under `--output-format json` (changelog: structured payload,
  no quota spent), which is where the binary's `plan_tier`, `used_percentage` and
  `remaining_percentage` fields most likely live; unconfirmed without a login.
- **Context window** likewise: `context_window` is a declared JSON field, surface unknown.
  Note the measured overhead of "23k–25k tokens out of the box per request" for the
  CLI's own system prompt and tools (gemini-cli discussion #27307, acknowledged by Google
  2026-07-05), which any gauge must account for.
- **`watchedSettingsFiles`** cannot be named yet: the CLI executes command hooks from
  `hooks.json` and reads `GEMINI.md` / `AGENTS.md` up the tree, but whether `hooks.json`
  is read from the worktree or only from `~/.gemini/antigravity-cli/` is unresolved.
  `agy -p "/hooks" --output-format json` lists loaded hooks with their sources.
- **Slash-command discovery**: `-p "/help"` answers in print mode without spending quota,
  so `listCommands` is feasible; format to confirm.

## Settled by the driver, 2026-09-02

The driver (`lib/agents/gemini/`) was built against a signed-in `agy` 1.1.22 and a recorded
`stream-json` capture, now committed as `tests/fixtures/gemini/*.jsonl`. Several claims above
came from the vendor's documentation and the binary's embedded prose, and the CLI does not
behave the way either describes. **Where this section disagrees with the tables above, this
section is what was measured.**

### The event mapping above is wrong in four places

- **`step_type` is lowercase snake_case**: `user_input`, `agent_response`, `tool`,
  `system_message`. The uppercase `CORTEX_STEP_TYPE_*` names in the binary are an internal
  enum that never reaches the wire. There is no `PLANNER_RESPONSE` step and no `MCP_TOOL` step.
- **An MCP call is an ordinary `tool` step** whose `tool_name` is the CLI's own dispatcher,
  `call_mcp_tool`. The server and tool the model actually asked for are in
  `tool_info.parameters.ServerName` / `.ToolName`. Reading `tool_info.name` would label every
  Calandria call "call_mcp_tool", and `lib/suggestionCard.ts` would never match a `suggest_task`.
- **`result.usage` is cumulative over the whole conversation**, not per turn. A two-turn
  conversation reported 61357 input tokens, exactly the sum of its four steps
  (14765 + 15287 + 15494 + 15811). The driver keeps a persisted baseline and subtracts it,
  the same machinery Codex needs.
- **The conversation id rides `init`**, at the top level of the envelope rather than inside it.
  Each line is `{"event":"<name>", "<name>":{…}}` — tag and payload key both.

Also: assistant prose arrives as `text_delta` on `agent_response` steps, but most such steps
carry no text at all (they are the model's tool-planning turns), and a reply the CLI never
streamed still appears in `result.response`.

### `CANCELED` does not mean the user stopped it

The table above says to swallow `CANCELED`/`INTERRUPTED` when our own abort fired. That is
necessary but not sufficient: `CANCELED` is *also* what a turn reports when the CLI auto-denies
a tool it has nobody to prompt about. Swallowing it unconditionally renders a turn that did
nothing as a silent success. Worse, the status is not even consistent — the same class of
denial was observed ending a run both `CANCELED` and `SUCCESS`, in both cases with exit code 0
and the only honest signal on stderr (`no output produced — a tool required the "command"
permission that headless mode cannot prompt for, so it was auto-denied`). The driver reads
stderr for it.

This is why the capability descriptor offers no "default"/ask permission mode. In the CLI's own
default mode (`request-review`) a headless turn cannot run a single tool, so offering it would
be offering a mode that is guaranteed to do nothing.

### Question 1 (per-task MCP): solved by a per-task `HOME`, not by a workspace root

The CLI's embedded documentation describes workspace "customization roots" (`.agents/`,
`.agent/`, `_agents/`, `_agent/`) that may carry `mcp_config.json`. **That is not true of MCP
servers.** With the config placed in all four of those, plus `.gemini/`, `.gemini/config/`,
`.antigravity/` and the repository root simultaneously, the model still answered "NO MCP". Only
the global `~/.gemini/config/mcp_config.json` is read. (The roots are real for skills, rules and
hooks; MCP is the exception.)

What works is pointing `HOME` at a per-task directory, so the CLI reads *our* copy of that one
global file. Two things the spike did not anticipate:

- **A bare per-task `HOME` loses the login.** The CLI re-prompts for OAuth, so the token is not
  purely in the D-Bus keyring as concluded above — something under `~/.gemini/antigravity-cli`
  gates it. Symlinking that one directory back to the real home restores authentication while
  keeping `config/` private.
- **`HOME` is inherited by every shell command the agent runs**, so a naive override takes away
  `~/.gitconfig` and `~/.ssh` — an agent that cannot set a committer identity or reach a remote.
  `lib/agents/gemini/home.ts` symlinks every entry of the real home across and substitutes only
  `.gemini`.

Verified end to end: a turn under a per-task home called `get_task` through the bridge and got
back that task's own `CALANDRIA_TASK_ID`. `scripts/calandria-mcp.mjs` is unchanged.

### Question 2 (keyring in the container): documented, not solved

The container path is `GEMINI_API_KEY`, as `.env.example` now states. No D-Bus is added to the
image. A container user therefore bills Google's API rather than drawing on a subscription;
a desktop install with a running keyring gets the subscription login.

### Corrections to the login flow

`agy models` takes **no** `--output-format` flag — passing one is a usage error — and it exits
**0 whether or not you are signed in**, so `authStatus` parses its TSV output rather than a
status code.

The print-mode login (`agy -p` with stdin open) is unusable for the connect card: it dies after
exactly 61 seconds with "authentication timed out", the window is not configurable, and because
the code is bound to that child's PKCE verifier, respawning to get a fresh window invalidates
whatever code the user is holding. The **interactive** CLI has no such timeout — measured alive
and accepting a pasted code many minutes later — so `lib/agents/gemini/auth.ts` drives the real
CLI under a pty, answers its one menu prompt, and writes the code when the user submits it.

### The model catalog

`agy models` on a signed-in host returns reasoning effort **baked into the slug**
(`gemini-3.8-flash-high` / `-medium` / `-low`; `gemini-3.1-pro` has only `-high` and `-low`),
so the driver offers no separate reasoning picker — choosing the model is choosing the effort.
The default is `gemini-3.8-flash-high`. The catalog is also **not Gemini-only**: it serves
`claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`. Note that
`gemini-3.1-pro` (the bare slug this document guessed at) does not exist in Google's public API
catalog either — there it is `gemini-3.1-pro-preview`, still Preview — and Google has published
no prices for the 3.8 line, so those turns are estimated at the 3.5 Flash rate.

## Open questions the driver task must settle first

1. **Per-task MCP configuration.** `agy mcp add` writes one user-global
   `~/.gemini/config/mcp_config.json`, and the bridge takes its task identity from the
   server process's env (`CALANDRIA_TASK_ID`). Parallel tasks therefore cannot share that
   file. Candidates, in order of preference: an env-var or flag override for the config
   path (none found in `--help` or the binary's strings; `HOME` is the only lever, and it
   also moves the CLI's own state); a markdown-defined agent under `--agent` that carries
   its own MCP servers (the changelog says agents can opt out of inheriting the user's MCP
   servers through `inheritCustomizations`); a plugin directory in the worktree. If none
   works, teach the bridge to take the task id from argv and let the single global entry
   spawn per-task processes, since the CLI spawns the server per session in the task's cwd.
2. **Keyring in the container.** Login tokens live in the D-Bus Secret Service, and the
   CLI "falls back to empty storage" when the keyring is unreachable (changelog). The
   published image has no D-Bus. Options: start `dbus-launch` and a keyring daemon in
   `docker/entrypoint.sh`; or document that the Google agent in a container needs
   `GEMINI_API_KEY`, or `AGY_ADC_AUTH` with a mounted ADC file if Google confirms it draws
   on the subscription quota rather than a Cloud project.
3. Everything marked *(confirm)* in the event mapping, from one authenticated run.

## Gemini CLI, for the record

It stays a reasonable target for an API-key-only or enterprise-licence driver: file-based
credentials, a system-settings override that solves the per-task MCP problem cleanly
(`GEMINI_CLI_SYSTEM_SETTINGS_PATH` plus `--allowed-mcp-server-names calandria`), a
`--session-id` we could mint ourselves, and distinct exit codes for auth (41) and input
(42). None of that outweighs the product goal, and `agy` accepts `GEMINI_API_KEY` too, so
one driver covers both audiences.
