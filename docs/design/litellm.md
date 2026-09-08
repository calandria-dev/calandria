# LiteLLM integration: spike

Spike record, 2026-09-02. Decides what a first-class LiteLLM integration looks like, including
LiteLLM's hosted MCP servers, and splits it into orderable tasks. No product code. Every claim
marked *measured* was reproduced on this host against a real LiteLLM proxy; everything else cites
the source it came from.

## Decision

Build LiteLLM as a **fourth provider preset, "Gateway", on the existing `agent_env` seam**
(`lib/agentEnv.ts`). Do not write a new agent driver. All three CLIs already accept a base URL
and a credential from the environment or a config override, and Calandria already sets those per
turn for the *Local model* and *Custom base URL* presets. LiteLLM differs from those presets in
four ways, and each one is a feature the preset grows rather than a reason for a driver:

| LiteLLM has | Local / Custom preset has | What the Gateway preset adds |
|-|-|-|
| A model catalog with context windows, prices and capability flags per model (`/model/info`) | A name probe (`/api/tags`, `/v1/models`) and a free-text model box | Real picker options, a working context gauge, per-model price estimates |
| Spend it can attribute per key, tag and session | Nothing: turns are `$0` or unpriced | A `gateway` pricing kind, tags on every request, optional per-task virtual keys |
| Budgets and a `budget_exceeded` failure | Nothing | A recoverable-failure classifier and a budget readout in Settings |
| An MCP gateway with per-key server access | Nothing | Hosted MCP servers mounted per project on all three drivers |

**Why one line:** every integration point below is a header, an env var or a JSON blob a driver
already passes, so the work is plumbing plus UI, and the risk sits in LiteLLM's translation layer
rather than in Calandria.

## What was measured

Host: Claude Code 2.1.257 (claude.ai subscription login), codex-cli 0.146.0 (not logged in),
Antigravity CLI 1.1.24, LiteLLM `ghcr.io/berriai/litellm:main-latest` reporting
`x-litellm-version: 1.101.0`, run with `--network host` in front of a request-logging sink on
`127.0.0.1:4599`. Config used is in the appendix.

### Claude Code

- With only `ANTHROPIC_BASE_URL` set, the CLI keeps its subscription login and sends
  `Authorization: Bearer sk-ant-…` (the OAuth token), `x-claude-code-session-id`, and an
  `anthropic-beta` list of eight values including `oauth-2025-04-20`. It also sends
  `HEAD /api/hello` to the base URL once at startup.
- `ANTHROPIC_CUSTOM_HEADERS` with two newline-separated headers landed both on every request.
  This is the only knob Claude Code has for `x-litellm-api-key` and `x-litellm-tags`.
- Through LiteLLM's unified `/v1/messages` route with
  `general_settings.forward_client_headers_to_llm_api: true`, a full turn completed: `result: "OK"`,
  `total_cost_usd: 0.006255`, `modelUsage[…].costBasis: "list"`. The upstream request carried the
  OAuth `Authorization` header, `x-claude-code-session-id`, the three `system` blocks with their
  three `cache_control` markers, `metadata.user_id`, `context_management`, and the custom
  `x-calandria-task` header.
- **The unified route rebuilt `anthropic-beta` and dropped three of the eight values the CLI
  sent**: `claude-code-20250219`, `thinking-token-count-2026-05-13` and
  `extended-cache-ttl-2025-04-11` did not reach upstream. LiteLLM assembles the header from a
  `set()` of betas it recognises plus its own additions
  (`litellm/llms/anthropic/common_utils.py`, `get_anthropic_headers`). Claude Code's gateway
  protocol page says a gateway must forward this header as an open list. The cache TTL one is a
  billing regression: a 1-hour cache request silently becomes a 5-minute one. File this upstream
  before shipping the preset; the repro is one `claude -p` against the config below.
- LiteLLM's native pass-through (`ANTHROPIC_BASE_URL=<gateway>/anthropic`) also completed a turn,
  but it **ignored `model_list` and sent the request to api.anthropic.com** with the forwarded
  OAuth token (`total_cost_usd: 0.859575` for the one uncached call, on the subscription). The
  pass-through is byte-faithful and would keep every beta, but it bypasses routing, fallbacks and
  per-model pricing. The preset should use the unified route.
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` cannot help: `GET /v1/models` on LiteLLM returns
  OpenAI-shaped JSON (`object: "list"`, `created`) and Claude Code expects Anthropic-shaped
  (`type: "model"`, `has_more`). Tracked as BerriAI/litellm#27180. Calandria does its own
  discovery from `/model/info`.
- `total_cost_usd` is computed by the CLI from list prices (`costBasis: "list"`). It matched
  LiteLLM's `x-litellm-response-cost` only because the test config priced the model at list.
  LiteLLM's figure is the billing truth; the CLI's is an estimate.

### Codex

- `-c model_providers.<id>.{base_url,env_key,wire_api="responses",http_headers}` produced
  `POST /v1/responses` with `Authorization: Bearer <env_key value>`, the configured
  `x-litellm-tags` header, plus Codex's own `session-id`, `thread-id`, `x-codex-turn-metadata`
  and `originator: codex_exec`. The body carries `store: false`,
  `include: ["reasoning.encrypted_content"]`, `reasoning: {summary: "auto"}`, `prompt_cache_key`
  and `client_metadata`.
- LiteLLM forwarded `store`, `include`, `reasoning`, `prompt_cache_key` and
  `x-codex-turn-metadata` upstream and dropped `client_metadata`. `x-litellm-tags` was consumed
  at the proxy, as intended.
- **One upstream 401 put the deployment in cooldown and every Codex retry got 429
  `No deployments available for selected model`** until Codex gave up ("exceeded retry limit").
  With many parallel sessions on one deployment, a transient upstream error cools it for
  everyone. `router_settings.allowed_fails` and `cooldown_time` need documenting with the preset.
- `requires_openai_auth = true` (the documented way to keep ChatGPT billing through a custom
  provider) sent **no** `Authorization` header on this host, which has no ChatGPT login. Whether
  LiteLLM accepts a forwarded ChatGPT token is unverified; the preset ships API-key billing for
  Codex only.
- Codex prints `Model metadata for gpt-5-codex not found. Defaulting to fallback metadata` for a
  custom provider. Behind a gateway its rate-limit snapshot is empty (community reports, matched
  by the CLI's `rate_limits: None` in issue logs), so the Codex plan-usage card has nothing to show.

### Antigravity CLI

- With `{"modelProvider":"gemini"}` in `$HOME/.gemini/antigravity-cli/settings.json`,
  `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:…`, `agy` sent
  `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` with `x-goog-api-key`, via the Go
  GenAI SDK. One turn made two calls: `gemini-3.1-flash-lite-preview` (a side call) and
  `gemini-3.1-pro-preview`.
- LiteLLM 1.101.0 serves that Gemini-native path at its root and routed both calls through the
  `gemini/` provider to the configured `api_base`. A `model_list` entry (or a `gemini/*` wildcard)
  must exist for every model name the CLI uses, side calls included.
- Plain HTTP was accepted for loopback. Gemini CLI source enforces HTTPS for anything else, and
  Antigravity's docs describe the same rule. This ends the "Antigravity does not take part"
  exception in `docs/AGENTS.md`, for the Gateway preset only.

### LiteLLM surface

- `GET /model/info` (per entry): `model_name`, `litellm_params.model`, `model_info` with
  `max_input_tokens`, `max_output_tokens`, `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost`, `mode`, `litellm_provider`, `supports_function_calling`,
  `supports_prompt_caching`, `supports_vision`. `GET /model_group/info` adds
  `supports_reasoning`, `supported_openai_params`, `tpm`/`rpm`. Both are filtered to the calling
  key's allowed models (docs; not measurable without a database).
- Response headers on a successful call: `x-litellm-response-cost` with `-input`, `-output`,
  `-cache-read`, `-cache-creation` components, `x-litellm-key-spend`, `x-litellm-model-group`,
  `x-litellm-model-id`, `x-litellm-call-id`, `x-litellm-version`, `x-litellm-attempted-fallbacks`.
  None of the three CLIs exposes response headers to Calandria.
- `/health/liveliness` and `/health/readiness` need no key. `/key/info` and `/key/generate`
  return 500 `Database not connected` without Postgres; every key, budget and spend feature needs
  LiteLLM's database, and the health card must say so rather than show blanks.
- MCP gateway, measured without a database: `GET /v1/mcp/server` lists servers with
  `server_name`, `alias`, `description`, `transport`, `auth_type`, `mcp_access_groups`,
  `allowed_tools`. `GET /mcp-rest/tools/list` lists tools with their `mcp_info.server_name`.
  JSON-RPC `initialize`, `notifications/initialized`, `tools/list` and `tools/call` on
  `/<alias>/mcp` with `x-litellm-api-key: Bearer …` all worked; `tools/list` also worked with no
  `mcp-session-id`. Tool names come back prefixed `<alias>-<tool>` (`demo-lookup_ticket`), with a
  per-server outcome map under `_meta["litellm.ai/server_outcomes"]`. A wrong key returns **400**,
  not 401.
- With `forward_client_headers_to_llm_api` on, LiteLLM forwards *every* client header upstream,
  including `x-calandria-task`. Anthropic ignores it, but any attribution header Calandria adds
  reaches the vendor; use `x-litellm-*` names where one exists.

## How it fits the code today

`agent_env` (`projects.agent_env`, `tasks.agent_env`) is a JSON object over the allowlist
`AGENT_ENV_KEYS`. `agentTurnEnv()` copies the server env, lays the override on top under three
credential rules, and every driver passes the result to its CLI: Claude through the SDK's `env`,
Codex through `codexProviderConfig()` which turns `OPENAI_BASE_URL` into a
`model_providers.calandria-local` config override on the Responses wire API, Antigravity through
its per-task `HOME` (`lib/agents/gemini/home.ts`). `describeProvider()` classifies the merged
override as `cloud`, `local` or `custom`, and that kind drives the session-header chip, the
`task_usage.provider` column and the pricing rule (`vendor`, `free`, `unknown`). The project
settings form (`ContextModal` in `app/shell/modals.tsx`) writes the preset through
`providerPresetEnv()`, and `GET /api/projects/[id]/models` probes the endpoint for names
(`lib/modelEndpoint.ts`). `tests/agentEnv.test.ts`, `tests/agentEnvStore.test.ts`,
`tests/codexProvider.test.ts` and `tests/projectModels.test.ts` pin it.

A LiteLLM URL typed into the *Custom base URL* preset with a virtual key as the token already
runs Claude Code through the gateway on API-key billing. That is the zero-code baseline. It
records the turns as unpriced, shows no models, gives Codex no key and Antigravity nothing.

## Design

### Instance configuration

Env-driven, documented in `.env.example`, read in `lib/config.ts`:

| Variable | Default | Purpose |
|-|-|-|
| `CALANDRIA_LITELLM_BASE_URL` | unset | The gateway's origin. Unset means the Gateway preset is hidden. |
| `CALANDRIA_LITELLM_KEY` | unset | The instance's virtual key. Sent as `x-litellm-api-key` (Claude), `env_key` (Codex), `GEMINI_API_KEY` (Antigravity). Also settable from Settings, persisted the way `lib/anthropic-key.ts` persists a key. |
| `CALANDRIA_LITELLM_ADMIN_KEY` | unset | Optional. A key allowed to call `/key/generate` (a master key, or a key granted that route). Turns on per-task virtual keys. |
| `CALANDRIA_LITELLM_MCP` | `on` | Whether hosted MCP servers may be mounted at all. |

The key never enters `agent_env`, and `GET /api/projects` never returns it. The *Custom* preset
stores its token in `agent_env` today; the Gateway preset stores only the base URLs and a marker,
and the drivers resolve the credential at turn time from config. That keeps a project row from
being a way to read the key.

### The `gateway` provider kind

`describeProvider()` returns `kind: "gateway"` when the override's first base URL has the same
origin as `CALANDRIA_LITELLM_BASE_URL`. The preset writes:

```json
{
  "ANTHROPIC_BASE_URL": "<gateway>",
  "OPENAI_BASE_URL": "<gateway>/v1",
  "GOOGLE_GEMINI_BASE_URL": "<gateway>",
  "CALANDRIA_GATEWAY_BILLING": "key" | "subscription",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "...", "ANTHROPIC_DEFAULT_SONNET_MODEL": "...", "ANTHROPIC_DEFAULT_HAIKU_MODEL": "...",
  "CODEX_MODEL": "...", "GEMINI_MODEL": "..."
}
```

Three keys join `AGENT_ENV_KEYS`: `GOOGLE_GEMINI_BASE_URL`, `GEMINI_MODEL` and the marker
`CALANDRIA_GATEWAY_BILLING`. `ANTHROPIC_CUSTOM_HEADERS` does **not** join the allowlist. It is
composed per turn by `agentTurnEnv()` for the gateway kind, so a project field can never inject
an arbitrary header, and so task and project ids are always current:

```
x-litellm-api-key: Bearer <CALANDRIA_LITELLM_KEY or the task's minted key>
x-litellm-tags: calandria,project:<project_id>,task:<task_id>,agent:claude
```

`applyProviderEnv()`'s rules hold unchanged. The gateway host is a redirect away from Anthropic,
so the inherited `ANTHROPIC_API_KEY` is dropped and a token is honoured. Under
`billing: "key"` the env gets `ANTHROPIC_AUTH_TOKEN=<key>` (API billing on the key's account).
Under `billing: "subscription"` no credential variable is set, the CLI keeps its `/login`, and
the gateway needs `forward_client_headers_to_llm_api: true` (measured working) plus an `oauth`
beta it will not strip (LiteLLM adds it itself when the token starts with `sk-ant-oat`). The
project form explains that the second mode bills the user's Claude plan and the first bills the
key.

The `pricing` for `gateway` is a new value, `gateway`: an estimate computed by Calandria from the
gateway's own price table (below), stored in `cost_usd`, and marked in Insights with `≈` the way
`custom` turns are marked `+`. It is more honest than the CLI's list price and less exact than
LiteLLM's ledger; the reconciliation step later replaces it where a per-task key exists.

### Claude driver

No driver code changes for a turn: the env does it. Two adjacent changes:

- `claudeCapabilities(env)` gains a gateway branch beside the Vertex one. Under the gateway kind
  the picker options come from the catalog probe (below), each with `contextWindow` from
  `max_input_tokens`, and the `[1m]` variants are offered only when the catalog entry says
  `max_input_tokens >= 1000000`. The picked id is written to `ANTHROPIC_MODEL` and the three
  alias variables, as the local preset does, because Claude Code's own `/model` list cannot see
  a LiteLLM catalog.
- One-shots (`lib/agents/oneshots.ts`) keep running on the utility agent's own login, as
  `docs/AGENTS.md` states for local models. A later toggle could route them through the gateway;
  it is out of scope here.

`x-claude-code-session-id` is free attribution: LiteLLM records it as the spend log's session id
with no configuration. Calandria already stores that id in `sessions.claude_session_id`, so a
turn can be joined to LiteLLM's ledger without a tag.

### Codex driver

`codexProviderConfig()` grows a second provider entry, `calandria-gateway`, chosen when the
override kind is `gateway`:

```toml
[model_providers.calandria-gateway]
name = "Calandria gateway"
base_url = "<gateway>/v1"
env_key = "CALANDRIA_GATEWAY_KEY"
wire_api = "responses"
http_headers = { "x-litellm-tags" = "calandria,project:<id>,task:<id>,agent:codex" }
```

`agentTurnEnv()` sets `CALANDRIA_GATEWAY_KEY` in the env for the gateway kind. `env_key` names
the variable, not the value, which is the documented Codex footgun. `verifyCodexProvider()`
(`codex doctor --json`) runs unchanged against the new provider id, and the cached verdict key
already includes the base URL. Two facts go in the docs rather than the code: the deployment
cooldown that turns one upstream error into 429s for every session, and LiteLLM's habit of adding
`reasoning.summary` for reasoning-effort requests, which OpenAI rejects for unverified
organisations (BerriAI/litellm#16032). `gpt-5-codex` through LiteLLM has a history of silent empty
completions when MCP servers are attached (BerriAI/litellm#14846, closed); the gateway MCP work
below must test that combination on the pinned versions before enabling it for Codex.

`requires_openai_auth` stays out until someone with a ChatGPT login measures it through LiteLLM.

### Antigravity driver

`prepareTaskHome()` already writes a per-task `HOME`. For the gateway kind it also writes
`$HOME/.gemini/antigravity-cli/settings.json` with `{"modelProvider": "gemini"}`, and the turn
env carries `GOOGLE_GEMINI_BASE_URL=<gateway>` and `GEMINI_API_KEY=<key>`. The driver's
`applyStoredApiKey()` must not overwrite that key. Two consequences to surface:

- The base URL must be HTTPS unless it is loopback. The project form refuses an `http://` gateway
  for Antigravity tasks with that sentence, rather than letting the turn fail inside `agy`.
- The CLI makes side calls to a flash-lite model on every turn. The health card lists the models
  the CLI uses (`agy models`) against the gateway catalog and names any that are missing, since a
  missing side model fails the turn with an unhelpful `Agent execution terminated due to error`.

`agy -p "/usage"` reports Google plan windows, which do not apply; the plan-usage card hides for
gateway tasks and the budget readout below takes its place.

### Model catalog, context windows and prices

`GET /api/projects/[id]/models` gains a gateway branch ahead of the Ollama and OpenAI probes:
`GET <gateway>/model/info` with the instance key, cached for `CALANDRIA_MODEL_PROBE_MS`-bounded
calls and re-read when the form opens. Each entry becomes an `AgentModelOption` with `value` =
`model_name`, `sub` = `litellm_provider` and price, `contextWindow` = `max_input_tokens`, and a
`group` per provider. The wildcard entries (`anthropic/*`) are listed as a single "any Anthropic
model id" row. Per driver the list is filtered by fit rather than by vendor: Claude shows every
`mode: chat` entry but marks non-Anthropic providers *translated*, Codex shows entries whose
provider supports the Responses API, Antigravity shows `gemini`/`vertex_ai` entries. The
context-window gauge, reported as unknown for every override today, works again for the gateway
kind because the catalog states the window.

The same response feeds pricing. `lib/gatewayPricing.ts` keeps the per-model rates from the last
probe and `estimateCostUsd()` for the gateway kind computes
`input × input_cost + cache_read × cache_read_cost + cache_creation × cache_creation_cost + output × output_cost`
from the driver's token counts, the way `lib/agents/codex/pricing.ts` does from its static table.
A model missing from the last probe records `NULL` and is counted as unpriced, as today.

### Attribution, budgets and failures

Every request already carries `x-litellm-tags` (composed above) and, for Claude, the session id.
That gives per-project and per-task rows in LiteLLM's own spend views with no database work on
Calandria's side. Three additions:

- **Budget failure classifier**, `lib/budgetFailure.ts`, beside `authFailure.ts` and
  `approvalFailure.ts`. It matches `"type":"budget_exceeded"` (seen at HTTP 400 and 429 depending
  on the budget level) and `ExceededBudget:` (the end-user shape), appends a durable notice to the
  transcript line, parks the pending queue like a dead login, and raises the instance banner
  through the existing `agent_auth` relay with a `budget` reason. The Retry button re-runs the
  turn; the budget resets on LiteLLM's clock, which the readout below shows.
- **Budget readout.** `GET /key/info` on the instance key returns `spend`, `max_budget`,
  `budget_reset_at` and the key's models. Settings → Agents shows them on the gateway card, and
  `PlanUsageWindow.kind` gains `gateway_budget` so the session header's plan gauge can show the key
  budget for gateway tasks instead of a vendor window that does not apply. Without a LiteLLM
  database the card says "keys, budgets and spend need LiteLLM's database" and shows only
  liveness, version and model count.
- **Insights** groups gateway turns by `task_usage.provider` (the gateway host) as it does now
  and labels the estimate.

### Per-task virtual keys (opt-in)

When `CALANDRIA_LITELLM_ADMIN_KEY` is set, `startTurn()`'s first-turn path calls
`POST /key/generate` with `key_alias: calandria-task-<id>`, `metadata` and `tags` naming the
project and task, `models` from the project's picker choice, `max_budget` and `duration` from
project settings, and `object_permission.mcp_servers` from the project's hosted-MCP selection.
The key is stored on the task row (`tasks.gateway_key`, encrypted at rest is out of scope; the DB
file already holds session transcripts and lives under the user's home) and used in place of the
instance key for that task's turns. `POST /key/delete` runs when the task reaches a terminal
status and again from the retention prune, so a forgotten task cannot keep a live key.

With a per-task key, `GET /key/info` after each turn gives the exact spend delta, and
`task_usage.cost_usd` is written from it instead of the estimate, with `pricing` recorded as
`gateway_exact`. This is the only path to exact per-task cost, because no CLI exposes
`x-litellm-response-cost` and `/spend/logs` has no tag filter and no pagination (docs;
BerriAI/litellm#14218).

JWT auth, org roles and key-minting delegation to teams are LiteLLM Enterprise features. The
design needs none of them: the admin key stays on the server, the tasks hold scoped keys, and an
instance without an admin key still gets tags and estimates.

### Hosted MCP servers

**Catalog.** `GET <gateway>/v1/mcp/server` with the instance key lists what this key may see
(measured without a database; with one, the list is the key's `object_permission`). Each row's
`alias || server_name`, `description`, `transport`, `auth_type` and `mcp_access_groups` feed a
picker in the project settings. `GET /mcp-rest/tools/list` gives the tool names for a preview.
The selection is stored as `projects.gateway_mcp` (JSON array of aliases), with an optional
`tasks.gateway_mcp` override, and published on `task_edited` like other project fields.

**Mounting, per driver.** The URL form is `<gateway>/<alias>/mcp` and the credential goes on
`x-litellm-api-key`, never on `Authorization`, which LiteLLM reserves for the upstream server's
own OAuth (the documented collision, and the single most common failure in its troubleshooting
page).

- Claude: `mcpServers[alias] = { type: "http", url, headers: { "x-litellm-api-key": "Bearer …" } }`
  next to the in-process `calandria` server in `query()` options. No file is written, so
  `settingsDrift` does not fire and one-shots (which pass `strictMcpConfig: true`) are untouched.
- Codex: `config.mcp_servers.<alias> = { url, http_headers: { "x-litellm-api-key": "Bearer …" } }`
  in the same `config` object the bridge uses. `codex exec` has no approver, so a mounted server
  must also set `default_tools_approval_mode: "approve"`, which makes every gateway tool
  auto-approved for Codex tasks. Mount on Codex only when the task's permission mode is the
  bypass-equivalent one, and say so on the card, the way `inheritsUserMcpServers` is stated today.
- Antigravity: an entry in the per-task `mcp_config.json` with `httpUrl` and `headers`. Gemini
  CLI's policy engine splits tool names on the first underscore after `mcp_`, so an alias with an
  underscore breaks wildcard rules; the mount slugifies aliases to hyphens for this driver.

**Names and permissions.** LiteLLM returns tools as `<alias>-<tool>`, so Claude sees
`mcp__<alias>__<alias>-<tool>`. Those calls go through `canUseTool` like any inherited MCP tool:
a card under the default mode, classifier-screened under `auto`, auto-approved under bypass. The
read-only allowlist in `lib/permissions.ts` is not extended. A "trust this server" toggle on the
project picker mints a remembered rule for `mcp__<alias>__*`, through the same `permission_rules`
path a Bash prefix uses, so it shows in Settings → Run defaults and can be revoked there.

**Auth types.** Servers with `auth_type` `none`, `api_key`, `bearer_token`, `basic`,
`oauth2` + `client_credentials`, `oauth2_token_exchange` and `aws_sigv4` work headless. Servers
with `oauth2` + `authorization_code` need a browser sign-in that a detached session cannot
perform (no `/mcp` panel in SDK mode); the picker marks them *sign in at the gateway first* and
mounts them anyway, since LiteLLM holds the token once the user has authorised it in LiteLLM's UI.
A wrong key on the MCP endpoint returns 400, so the mount health probe reads the body, not the
status.

**Cost.** LiteLLM logs MCP calls to its spend logs and prices them from
`mcp_info.mcp_server_cost_info`. Those rows share the task's key or tags, so per-task key spend
already includes tool cost; the estimate path does not, and says so.

### What Calandria cannot fix

- The `anthropic-beta` pruning on the unified route (measured above). File upstream with the
  repro; until fixed, document that 1-hour cache TTL is unavailable through the gateway.
- `/v1/models` shape versus Claude Code's discovery (BerriAI/litellm#27180). Calandria's own
  catalog probe sidesteps it.
- Codex through LiteLLM: `reasoning.summary` injection (#16032), the `gpt-5-codex` tool-call
  history (#14846), and an empty rate-limit snapshot. `wire_api = "chat"` is no fallback: Codex
  removed Chat Completions support in early 2026 (openai/codex discussion #7782).
- Prompt caching fails silently when `cache_control` does not survive translation. The only
  signal Calandria has is `cache_read_input_tokens` staying at zero across a task's turns; the
  Insights provider table should show a cache-hit column for gateway hosts so the failure is
  visible.
- Multi-deployment LiteLLM setups need `router_settings.optional_pre_call_checks: ["prompt_caching"]`
  or repeat calls land on a deployment with no cache. Docs, not code.

### Tests

- A fake gateway in `tests/helpers` serving `/health/readiness`, `/model/info`,
  `/model_group/info`, `/key/info`, `/key/generate`, `/key/delete`, `/v1/mcp/server`,
  `/mcp-rest/tools/list` and JSON-RPC on `/<alias>/mcp`, with the measured response shapes from
  the appendix. Unit tests cover `describeProvider` for the gateway kind, the composed
  `ANTHROPIC_CUSTOM_HEADERS`, the Codex provider entry (`tests/codexProvider.test.ts` pattern),
  the Antigravity settings write, catalog-to-picker mapping, the estimate, the classifier and key
  lifecycle.
- The mock driver e2e asserts only that the env and MCP mount reach the driver.
- A manual recipe in `docs/SELF_HOSTING.md` reproduces this spike's live run (appendix) so the
  pinned LiteLLM version can be re-measured on upgrade.

## Plan

Filed as the `litellm` tag. Steps 2 to 5 and 7 need step 1; step 6 needs step 5; step 8 needs
steps 3, 4 and 7. Step 9 is independent.

1. Gateway preset, instance config, Claude routing in both billing modes, gateway health card,
   docs. Claude only.
2. Model catalog from `/model/info`: picker options, context windows, gateway price estimate.
3. Codex through the gateway: `calandria-gateway` provider entry, key injection, tags header,
   provider check, cooldown and `reasoning.summary` notes.
4. Antigravity through the gateway: settings write, base URL rule, side-model check.
5. Attribution and budgets: `budgetFailure.ts`, `/key/info` readout, `gateway_budget` plan window,
   Insights labelling and cache-hit column.
6. Per-task virtual keys behind `CALANDRIA_LITELLM_ADMIN_KEY`, exact spend reconciliation, key
   deletion on terminal status and prune.
7. Hosted MCP on Claude: catalog, project picker, mount, per-server trust rule.
8. Hosted MCP on Codex and Antigravity, with the Codex approval-mode gate and the alias slug.
9. Upstream: file the `anthropic-beta` pruning repro against LiteLLM, watch #27180 and #16032.

## Appendix: reproduction

LiteLLM config used for the measurements (`--network host`, sink on 4599 answering a canned
Anthropic response, demo MCP server is a 12-line FastMCP stdio script):

```yaml
model_list:
  - model_name: "anthropic/*"
    litellm_params: { model: "anthropic/*", api_base: "http://127.0.0.1:4599", api_key: "sk-upstream" }
  - model_name: "claude-sonnet-4-5"
    litellm_params: { model: "anthropic/claude-sonnet-4-5", api_base: "http://127.0.0.1:4599", api_key: "sk-upstream" }
    model_info: { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, cache_read_input_token_cost: 0.0000003, cache_creation_input_token_cost: 0.00000375 }
  - model_name: "gpt-5-codex"
    litellm_params: { model: "openai/gpt-5-codex", api_base: "http://127.0.0.1:4599/v1", api_key: "sk-upstream" }
  - model_name: "gemini-3.1-pro-preview"
    litellm_params: { model: "gemini/gemini-3.1-pro-preview", api_base: "http://127.0.0.1:4599", api_key: "sk-upstream" }
  - model_name: "gemini-3.1-flash-lite-preview"
    litellm_params: { model: "gemini/gemini-3.1-flash-lite-preview", api_base: "http://127.0.0.1:4599", api_key: "sk-upstream" }
general_settings:
  master_key: "sk-master-test"
  forward_client_headers_to_llm_api: true
litellm_settings:
  extra_spend_tag_headers: ["x-calandria-task"]
mcp_servers:
  demo:
    transport: "stdio"
    command: "python"
    args: ["/cfg/demo_mcp.py"]
```

Commands:

```bash
docker run -d --name llspike --network host -v /tmp/llsink:/cfg:ro \
  ghcr.io/berriai/litellm:main-latest --config /cfg/litellm.yaml --port 4017

ANTHROPIC_BASE_URL=http://127.0.0.1:4017 \
ANTHROPIC_CUSTOM_HEADERS=$'x-litellm-api-key: Bearer sk-master-test\nx-litellm-tags: calandria,task:abc' \
  claude -p "Reply with OK" --model claude-sonnet-4-5 --max-turns 1 --output-format json < /dev/null

LITELLM_KEY=sk-master-test codex exec --skip-git-repo-check \
  -c model_provider=litellm -c model_providers.litellm.name=LiteLLM \
  -c model_providers.litellm.base_url=http://127.0.0.1:4017/v1 \
  -c model_providers.litellm.env_key=LITELLM_KEY -c model_providers.litellm.wire_api=responses \
  -c 'model_providers.litellm.http_headers={"x-litellm-tags"="calandria,task:abc"}' \
  -m gpt-5-codex "Reply with OK" < /dev/null

mkdir -p "$H/.gemini/antigravity-cli" && echo '{"modelProvider":"gemini"}' > "$H/.gemini/antigravity-cli/settings.json"
HOME=$H GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4017 GEMINI_API_KEY=sk-master-test \
  agy -p "Reply with OK" --output-format json < /dev/null

curl -s -X POST http://127.0.0.1:4017/demo/mcp -H 'x-litellm-api-key: Bearer sk-master-test' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Two cautions from running this. Do not point `ANTHROPIC_BASE_URL` at `<gateway>/anthropic` with
a subscription login unless you mean to call api.anthropic.com: the pass-through ignores
`model_list` and the OAuth token is forwarded. And `codex exec` and `claude -p` both wait on
stdin when it is a pipe; redirect from `/dev/null`.

## Sources

- Claude Code gateway protocol and configuration: code.claude.com/docs/en/llm-gateway-protocol,
  /llm-gateway, /gateways, /authentication, /mcp
- LiteLLM: docs.litellm.ai/docs/anthropic_unified, /pass_through/anthropic_completion,
  /claude_code_compatibility, /tutorials/claude_code_max_subscription, /proxy/request_headers,
  /proxy/response_headers, /proxy/cost_tracking, /proxy/request_tags, /proxy/virtual_keys,
  /proxy/service_accounts, /proxy/users, /proxy/token_auth, /proxy/model_discovery, /mcp,
  /mcp_control, /mcp_oauth, /mcp_oauth_passthrough, /mcp_cost, /mcp_troubleshoot, /enterprise,
  /response_api, /tutorials/litellm_gemini_cli
- Codex: developers.openai.com/codex/config-reference, /codex/auth, /codex/mcp;
  github.com/openai/codex discussion #7782, issue #4136
- Gemini CLI: github.com/google-gemini/gemini-cli `packages/core/src/core/contentGenerator.ts`,
  `docs/tools/mcp-server.md`; antigravity.google/docs/cli/install
- LiteLLM issues: #27180, #22398, #16032, #14846, #14218, #18950, #15299, #15622
- Prior art: docs.roocode.com/providers/litellm (model discovery from `/model/info`),
  docs.openhands.dev/sdk/arch/llm
