# Model providers and the model picker: design spike

Date: 2026-09-06
Revised: 2026-09-12, to Models v2. The anatomy here follows the handoff at
`/home/penmoid/repos/calandria-notes/design/models-v2-handoff/`
(`docs/MODELS_V2_HANDOFF.md`, then `ui/Models v2.html` and `ui/Models v2 - Providers.html`),
which supersedes the step 7 and step 8 handoffs.
Status: spike. The two design passes and the removal of Settings → Account have landed.
Nothing else in this document is implemented.
Plan tag: `model-providers`, integration branch `integration/model-providers`.

## The problem

Calandria forked from operator-oss with two providers, Anthropic and OpenAI, and one
setting screen per CLI. Since then it gained Antigravity (Gemini), local models (Ollama
and LM Studio), a LiteLLM gateway with per-task virtual keys, budgets and hosted MCP
servers, and a per-project endpoint override. The functionality landed, and the
configuration for it did not:

- Settings → Agents is still one connect card per CLI, plus a status line for the local
  endpoint and a health card for the gateway. Neither endpoint can be added, edited or
  removed there. They exist only when `CALANDRIA_LOCAL_MODEL_BASE_URL` and
  `CALANDRIA_LITELLM_BASE_URL` (with `CALANDRIA_LITELLM_KEY` and
  `CALANDRIA_LITELLM_ADMIN_KEY`) are set in the server's environment
  (`lib/config.ts:419-477`, `lib/agentEnv.ts:215-220`).
- The desktop app reads `~/.config/calandria/env` at startup (`desktop/env-file.js`) and
  has no UI for it. A desktop user cannot add a gateway or a local server without finding
  that file.
- Which endpoint a project or task uses is a raw env blob in `projects.agent_env` and
  `tasks.agent_env` (`lib/db.ts:831`, `:923`), written by three presets in
  `lib/agentEnv.ts` (`providerPresetEnv`, `gatewayPresetEnv`, `cloudOverrideEnv`) from a
  Model provider select in project settings (`app/shell/modals.tsx:1457-1568`). The
  select's help text still says the gateway is Claude Code only, which PR #215 made
  false.
- The model is picked six different ways: an agent grid and a model field in the New and
  Edit task dialogs (`AgentPicker` at `app/shell/modals.tsx:29`, used at `:235` and
  `:981`; `ModelField` at `app/shell/Modal.tsx:146` and `FreeFormModel` at `:212`), a
  dropdown in the session header that switches to endpoint models off the cloud
  (`app/shell/SessionView.tsx:976`), a free-form field in project settings, no model at
  all in Schedules and Runbooks, and a per-agent select in Settings → Run defaults
  (`app/shell/SettingsView.tsx:996-1011`).
- There is no way to hide a model from a picker, and no policy for models that appear in
  or vanish from a catalog. The gateway catalog is filtered per CLI by
  `fitsDriver()` (`lib/gatewayModels.ts:181-186`) and nothing else is.
- Settings → Account showed the Cloudflare Access session and a Log out button.
  Calandria has no users, so a section named Account promised something the product does
  not have. That section has since been removed; see Settings → Models below.

## Vocabulary

Three things are currently mixed together. The redesign names them and keeps them apart.

**Environment.** The coding CLI a turn runs in: Claude Code, Codex, Antigravity. This is
today's `agent` id (`tasks.agent`, `projects.default_agent`, `runbooks.agent`,
`schedules.agent`) and the `AgentDriver` behind it; the driver ids are `claude`, `codex`
and `gemini`. The column and the driver seam keep their names. Only the UI word changes,
because "agent" in the UI now has to mean the CLI and nothing else. An environment is
detected on the machine, and you either sign in to it or you do not. It is mostly fixed
per project.

**Provider.** A configured source of models: an endpoint, a credential, and a model
policy. A row in a new `model_providers` table. Nine types, in two groups.

Bundled types hold one row per environment. The row is created when that CLI signs in and
removed when it signs out. You never add one by hand.

| Type | What it is | Environments | Credential | Catalog |
|-|-|-|-|-|
| `anthropic` | Claude Code's own login. Anthropic, Vertex or Bedrock, detected from the CLI's config (`lib/agents/claude/provider.ts:51-61`) | claude | the CLI login | static list corrected by the CLI probe (`lib/agents/claude/modelProbe.ts`) |
| `openai` | Codex's own login | codex | the CLI login | `~/.codex/models_cache.json` (`lib/agents/codex/catalog.ts`) |
| `google` | Antigravity's own login | gemini | the CLI login | static list (`lib/agents/gemini/capabilities.ts:39-54`) |

User-added types can have any number of rows each.

| Type | What it is | Environments | Credential | Catalog |
|-|-|-|-|-|
| `openai_key` | OpenAI directly, with your own key, separate from the Codex login | codex | API key | vendor model list |
| `gemini_key` | Google directly, with your own key, separate from Antigravity | gemini | API key | vendor model list |
| `litellm` | A LiteLLM gateway | claude, codex, gemini | instance key, optional admin key, billing mode | `GET /model/info`, filtered per environment (`lib/gatewayModels.ts`) |
| `ollama` | Ollama, on this machine or your network | claude, codex | none | endpoint probe (`lib/modelEndpoint.ts`) |
| `lmstudio` | LM Studio's OpenAI-compatible server | claude, codex | none | endpoint probe |
| `custom` | Any other Anthropic- or OpenAI-compatible base URL | claude, codex | token | endpoint probe, or typed |

Which environments a provider serves is decided by Calandria from the type. You never
choose it, and both the add form and the detail modal show the list read-only.
`lib/providers/types.ts` is the one table those lists come from, and the environment
registry's `providerTypes` is derived from it, so the two cannot drift.

Antigravity appears only for `google`, `gemini_key` and `litellm`. The driver passes
`GOOGLE_GEMINI_BASE_URL` through to the CLI (`lib/agentEnv.ts:93-94`) and nothing
verifies that a local server answers the Gemini API. An `ollama`, `lmstudio` or `custom`
row offers Antigravity once someone has shown it working, by adding `gemini` to that
type's environment list.

**Model.** Organized as family, then version, then source. A family is a product line:
Opus, Sonnet, GPT, Gemini, Qwen. A version is one release inside it: Opus 5, GPT-5.6
Sol. A source is a (provider, model id) pair. The same version reachable from two
providers is two sources, listed as two rows, so Opus 5 on the Anthropic login and Opus 5
as `anthropic/claude-opus-5` on a gateway stay distinguishable. The picker's value is
still the triple `{ agent, provider_id, model }`. Only the order you choose in changes.

## Data model

```
model_providers
  id            TEXT PRIMARY KEY
  type          TEXT NOT NULL            -- anthropic | openai | google | openai_key
                                         -- | gemini_key | litellm | ollama | lmstudio | custom
  label         TEXT NOT NULL            -- "Work gateway", "Mac mini Ollama"
  config        TEXT NOT NULL            -- JSON, type-specific, no secrets
  model_policy  TEXT NOT NULL            -- JSON, see below
  created_at, updated_at
  last_test_at  INTEGER
  last_test     TEXT                     -- JSON result of the last probe

tasks.provider_id        TEXT REFERENCES model_providers(id) ON DELETE SET NULL
projects.default_provider_id  same
schedules.provider_id, schedules.model
runbooks.provider_id,  runbooks.model
```

`config` per type:

- `litellm`: `base_url`, `billing` (`key` | `subscription`), `mcp` (bool), `key_timeout_ms`.
- `ollama`, `lmstudio`: `base_url`.
- `custom`: `base_url`, `api` (`anthropic` | `openai`).
- `openai_key`, `gemini_key`: empty. The vendor's own base URL is built in.
- `anthropic`, `openai`, `google`: empty. The credential is the CLI's own login.

Any type may also carry `default_model` in its config.

Secrets live in one 0600 JSON file beside the database, keyed by provider id and field
name: the `litellm` key and admin key, the `openai_key`, `gemini_key` and `custom` keys,
and the Gemini API key that `lib/agents/gemini/auth.ts:371` stores in `settings` today.
`lib/providerSecrets.ts` generalizes `lib/litellm-key.ts`. `ollama` and `lmstudio` have
no secret field. `GET /api/providers` serves `has_key: true` and never the value, for the
reason `gatewayPresetEnv` gives at `lib/agentEnv.ts:427-436`: `agent_env` is served to
the browser, so anything in it is readable by anyone with the app open. The key field's
help text says "Stored on this instance. Never written to a task's environment as plain
text."

`model_policy`:

```
{
  "mode": "deny",     // allow | deny, taken from the type
  "ids": [],          // in allow mode the models turned on; in deny mode the models turned off
  "known": [],        // the catalog as of the last read, for diffing
  "unavailable": []   // pinned ids that have left the catalog
}
```

`mode` comes from the type and the user never sets it. `litellm` is `allow`, since a
gateway can advertise a hundred models and most of them have no business in a picker.
Every other type is `deny`, since a bundled login and a local server list what they
actually have. There is no `auto_add` switch and no `auto_remove` switch; the mode covers
both cases.

In `allow` mode a fresh row starts with `ids` set to the chat models that placed into a
known family, minus duplicates. That set is what the add page shows you after a
successful test. A model the gateway adds later stays off until you turn it on. In `deny`
mode everything listed is on, and `ids` are the models you turned off.

An id that has left the catalog and is pinned by a task, project, schedule or runbook
moves to `unavailable`. It is served flagged, the picker strikes it through and will not
select it, and a turn that still names it fails with the provider's own error. An
unpinned id that left the catalog is dropped. `known` is refreshed on every read and
persisted when it differs.

### Family placement

Placement is automatic and there is no user override, so one model id lands in the same
place on every instance.

`lib/providers/families.ts` holds a built-in family table: Fable, Opus, Sonnet and Haiku
under the Anthropic vendor, GPT under OpenAI, Gemini under Google, and Qwen, DeepSeek,
GLM, Kimi, Gemma, Llama, Mistral and Devstral under open weights.
`placeModel(id, providerType)` returns `{family, version, label, ctx, duplicate_of, chat}`
after four normalizations:

- Gateway prefixes come off (`anthropic/`, `openai/`, `together/`, `moonshot/`, `zai/`),
  so a gateway id and a direct id place into the same version.
- An Ollama size tag stays, as part of the version label: `qwen3-coder:30b` reads as
  Qwen3 Coder 30B.
- Dated suffixes come off (`-20260212`). The dated id is flagged `duplicate_of` the
  undated one, kept in the provider's Models tab with a duplicate tag, and hidden from
  the picker.
- Claude Code's aliases (`opus`, `sonnet`, `fable`, `haiku`, `opusplan`) become a latest
  version row in their family. A `[1m]` id is a version row of its own, labelled with
  "(1M)".

Embedding, audio, image, moderation and rerank ids come back `chat: false` and never
reach a picker. Anything the table cannot place lands in a family called `other`, with
the raw id as its version label, sorted last. The provider's Models tab counts them
("N in Other"), so a gateway with an unfamiliar catalog is still configurable.

### Recents

The picker keeps up to four recent combos. They are client-side, in `localStorage`, per
browser and keyed per instance. Nothing about them is stored on the server or shared
between browsers. A recent drops out of the list when the version it names has gone, or
when the provider it names no longer serves the current environment, so a recent never
offers a combo that cannot run.

### Resolution at turn time

`agentTurnEnv()` (`lib/agentEnv.ts:273-306`) stops reading the stored `agent_env` blob
and derives the same env from the provider row: `task.provider_id`, else
`project.default_provider_id`, else the environment's own bundled row, else nothing. The
existing preset functions produce the env shape, so the driver side (`applyProviderEnv`,
`applyGatewayEnv`, `codexProviderConfig`, `verifyCodexProvider`) does not change:
`gatewayPresetEnv` serves `litellm`, `providerPresetEnv` serves `ollama`, `lmstudio` and
`custom`, `openai_key` goes through the same Codex config override with the vendor's own
base URL, `gemini_key` sets `GEMINI_API_KEY` in the turn's environment, and a bundled row
contributes an empty override. The model comes from `task.model`, else
`default_model:<agent>`, else the provider's `default_model` in its config, else the
CLI's own default. That is the chain the drivers already follow
(`lib/agents/claude/driver.ts:752`, `codex/driver.ts:217`, `gemini/driver.ts:94`), with
the provider row in the slot the preset's `*_MODEL` env occupied.

`describeProvider()` and `ProviderKind` stay for the session badge and the usage ledger.
They read the env the row produced, so a `litellm` row still describes as `gateway` and
an `ollama` row as `local`.

### Migration and env seeding

One migration converts what exists:

- A project or task whose `agent_env` is a local preset becomes an `ollama`, `lmstudio`
  or `custom` row, the type chosen by the port (11434 is Ollama, 1234 is LM Studio,
  anything else is custom), labelled after its host, deduplicated by base URL, and
  `default_provider_id` or `provider_id` points at it.
- A gateway preset points at the `litellm` row seeded from the env (below); the
  project's `gateway_max_budget`, `gateway_key_duration` and `gateway_mcp` columns stay
  where they are, since they are per-project caps on one gateway, and the project
  settings form keeps them under the picker.
- A custom preset becomes a `custom` row.
- `cloudOverrideEnv` rows (a task pinned back to the cloud in a local project) become
  `provider_id` = the environment's bundled row.

The `agent_env` columns stop being written and read. Dropping them is a follow-up once
the release that reads the rows has shipped.

Env vars keep working for self-hosters: on boot, `CALANDRIA_LITELLM_BASE_URL` with its
`_KEY`, `_ADMIN_KEY` and `_MCP` seeds one `litellm` row, and an explicitly set
`CALANDRIA_LOCAL_MODEL_BASE_URL` seeds one local row whose type comes from the same port
mapping. Seeding happens only when no row of that type exists. Once a row exists the DB
wins and the env is ignored, with one log line on boot saying so. The default local URL
(`http://localhost:11434`) seeds nothing, since a row for a server most instances do not
run would be an unreachable provider on every fresh install. `.env.example` and
`docs/SELF_HOSTING.md` describe the vars as first-boot seeds.

This is a change to the "every knob is env-driven" rule in `CLAUDE.md`: provider
configuration is per instance and user-editable, so the source of truth moves to the
database with env as the seed. The rule stays for everything else.

## The environment registry

`AgentCapabilities` (`lib/agents/types.ts:48`) gains three fields:

```
providerTypes: ProviderType[]     // which provider types this environment can use
bundledProvider: ProviderType     // the type of the row signing in creates
endpointTransport: string         // one sentence: how an endpoint reaches the CLI
```

Claude Code declares `anthropic, litellm, ollama, lmstudio, custom`, bundled `anthropic`,
and "ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the turn's environment". Codex
declares `openai, openai_key, litellm, ollama, lmstudio, custom`, bundled `openai`, and a
`model_providers` entry written through the SDK's config overrides. Antigravity declares
`google, gemini_key, litellm`, bundled `google`, and "GOOGLE_GEMINI_BASE_URL and
GEMINI_API_KEY in the turn's environment". The mock driver declares the Claude Code set so
e2e can exercise every list. A test derives each list from `lib/providers/types.ts` and
fails on drift.

`lib/agents/capabilities.ts` stays SDK-free and is where a fourth environment is
declared.

Installed detection is new. An environment is `connected` when it is authenticated,
`installed` when its CLI binary resolves on PATH or its config directory exists
(`~/.claude`, `~/.codex`, the Antigravity equivalent) and no connection exists, and
`absent` otherwise. `GET /api/agents` serves that `status`, the `bundledProvider` and the
providers the environment can use. Only environments that have a driver are listed, so
the registry has nothing to say about a CLI Calandria cannot run.

`app/icons.tsx` gains two mark sets, and they are drawn from different sources on
purpose. `EnvMark` (keys `claude`, `codex`, `gemini`) uses the products' own marks,
monochrome in `currentColor`: `assets/logo-claudecode.svg`, `assets/logo-codex.svg` and
`assets/logo-google-antigravity-flat.svg` in the handoff. `ProviderMark` (keys
`anthropic`, `openai`, `google`, `litellm`, `ollama`, `lmstudio`, `custom`) uses the
vendor marks, with the Gemini spark for `google`, since Google's models are Gemini.
`openai_key` renders the OpenAI mark and `gemini_key` the Gemini spark. The existing
`AgentMark` keys are the vendor logos and become `ProviderMark`, with `AgentMark` kept as
an alias so nothing else moves.

## API

| Route | Purpose |
|-|-|
| `GET /api/providers` | every row, secrets replaced by `has_*` booleans, plus `bundled`, the environments the type serves, `last_test`, a status (`connected`, `reachable`, `unreachable`, `untested`) and the count of models currently on |
| `POST /api/providers` | create. The body carries `type`, `label`, `config`, the secret fields and the initial `model_policy` the add page built from its test. A bundled type is a 400, since those rows come from signing in to the environment |
| `GET`, `PATCH /api/providers/[id]` | read one; edit label, config, policy and secrets. An empty-string secret leaves the stored value, a `null` clears it |
| `DELETE /api/providers/[id]` | remove a user-added row and return the usage it detached. A bundled row is refused with 409, since you sign out of the environment instead. `ON DELETE SET NULL` on the referencing columns |
| `GET /api/providers/[id]/usage` | the projects, tasks, schedules and runbooks that point at the row, for the sentence on the Remove tab |
| `POST /api/providers/test` | probe an unsaved config, for the add page |
| `POST /api/providers/[id]/test` | probe a saved row and store `last_test` and `last_test_at` |
| `GET /api/providers/detect` | probe `http://localhost:11434` and `http://localhost:1234` and report the servers that answered and have no row yet, with type, base URL and model count |
| `GET /api/models?agent=` | the family, version and source tree for one environment, merged across every provider that serves it |
| `GET /api/providers/[id]/models` | the flat per-provider list for the Models tab, with placement and on/off per model |
| `PUT /api/providers/[id]/models` | write the policy as `{ids}` |
| `POST /api/providers/[id]/models/refresh` | re-read the source and return the fresh list |

Both test routes return
`{reachable, api, version, latency_ms, error, key: {spend, max_budget}, models: [{id, context_window, family, version, duplicate_of, chat}]}`,
each field where it is known. The model list is there so the add page can render its
Models section before the row exists, which is what the one-page add flow needs.
`family`, `version`, `duplicate_of` and `chat` come from `placeModel()`. The probe reuses
`probeGateway()` (`lib/gatewayHealth.ts`) for `litellm` and `endpointModels()`
(`lib/modelEndpoint.ts`) for `ollama`, `lmstudio` and `custom`, lists models from the
vendor API for `openai_key` and `gemini_key`, and reports the CLI connection from
`lib/agents/connections.ts` for the bundled types. Every probe is bounded by
`CALANDRIA_MODEL_PROBE_MS`.

`GET /api/models?agent=` serves
`{families: [{id, label, vendor, versions: [{id, label, ctx, sub, sources: [{provider_id, model, price, unavailable}]}]}]}`.
The bundled provider sorts first inside a version, there is one source per (provider,
model id), families and versions sort newest first, and `other` sorts last. `price` is
`plan` for a bundled row, `metered` for `litellm`, `free` for `ollama` and `lmstudio`,
and blank otherwise.

`GET /api/providers/[id]/models` serves
`{mode, refreshed_at, models: [{id, ctx, family, version, on, duplicate_of, chat}]}`,
including the non-chat and duplicate rows flagged so the Models tab can hide or tag them.

`GET /api/agents` keeps every field it has and adds `status`
(`connected` | `installed` | `absent`), `bundledProvider`, `providerTypes`,
`endpointTransport` and `providers: [{ id, label, type, status }]` per environment, so
the settings page and the picker each build their lists from one fetch.
`GET /api/projects/[id]/models` and `app/shell/modelEndpoint.ts` are replaced by the
models tree route.

## The model picker

One component, `app/shell/ModelPicker.tsx`, used everywhere a model is chosen. Value
`{ agent, provider_id, model }`, all three nullable for "inherit". Data comes from
`GET /api/models?agent=<env>` through one cached hook, so seven surfaces do not refetch
on every open.

The control is model first. You pick a model, and the environment is a project setting
the picker shows you and lets you change.

1. **Root pane.** A filter field, then the head row (the inherited value and what it
   resolves to), then Recent, then All models as family rows. A family row shows the
   family name, how many versions it holds, the stacked source marks of every provider
   feeding it, and a chevron.
2. **Family pane.** The versions in that family, newest first, each with its label, a
   one-line note and its context window. A version with one source shows that source's
   mark and selects when you tap it. A version with several shows stacked marks, a count
   and a chevron, and drills one level further. A version flagged unavailable is struck
   through and cannot be selected.
3. **Source pane.** One row per provider that serves the version: the provider mark, its
   label, its host, the model id in mono and the price.

The picker grows with the setup. When one environment is connected and every version has
exactly one source from one provider, there is nothing to choose between, so the picker
renders one flat list grouped by family, with no filter field, no Recent section and no
drill-in. Any setup past that gets the full three-pane control, with Recent first and All
models beneath. The two section headings read "Recent" and "All models".

The environment lives in the footer. It reads "Runs in Claude Code" with a Change
affordance when more than one environment is connected, and without Change when only one
is. Change opens an environment pane. Switching keeps the selected model when the same
provider serves the same model id in the new environment. When it does not, the value
falls back to the head row and a note under the list names the model that could not run
there. The environment pane carries one standing line: only models that can run in the
chosen environment are listed, and the project default is set in project settings.

New task and Edit task do not use the footer. There the environment is its own field,
labelled Environment, beside a field-width Model select of the same width, and changing
the environment re-scopes the Model select directly.

Keyboard: Esc and Left go back one pane, Right drills into a family or selects a
single-source version, Up and Down move within the pane and skip struck-through rows,
Enter selects the focused row, and typing in the filter field matches across family,
version and source at once and shows flat results.

Reasoning level and permission mode stay beside the picker in the dialogs that have them.
They are not the picker's concern.

Measurements from the handoff: popover 380px, pane height 352px, rows 36px with family
rows at 40px and the head row at 44px, filter field 30px. The sheet variant uses 48px
rows with the subtitle wrapped under the label, a 40px filter field and 12px footer text.

Surfaces the picker replaces:

| Surface | Today | After | Head row |
|-|-|-|-|
| New task, Edit task | `AgentPicker` (`modals.tsx:29`, used at `:235` and `:981`), `ModelField` (`Modal.tsx:146`), `FreeFormModel` (`Modal.tsx:212`) | an Environment field beside a field-width `ModelPicker`, footer hidden | Project default |
| Session header | model dropdown (`SessionView.tsx:976`), `useEndpointModels` (`:24`, called at `:726`) | `ModelPicker` in a popover, a bottom sheet at the mobile breakpoint | Project default |
| Project settings | Model provider select plus free-form model (`modals.tsx:1457-1568`) | `ModelPicker` setting `default_provider_id` and the default model; the gateway caps stay beneath it and show only for a `litellm` provider | App default |
| Schedules, Runbooks | agent select only (`Schedules.tsx:411`, `Runbooks.tsx:169`) | `ModelPicker`; `model` and `provider_id` stored on the row and carried by `lib/dispatch.ts` | Project default |
| Settings → Run defaults | per-agent selects (`SettingsView.tsx:996-1011`) | one pinned `ModelPicker` per connected environment, no footer and no environment pane, plus the two job-model pickers | Environment default |
| Settings → Background jobs | agent select | a pinned `ModelPicker` for the utility agent | Environment default |
| `suggest_task`, `create_runbook`, dispatch | `provider: "local" \| "cloud"` | `provider` takes a provider id or label; `local` and `cloud` stay as aliases for the first local row and the environment's bundled row | n/a |

## Settings → Models

Replaces Settings → Agents. The nav entry is renamed and `AgentsSection`
(`app/shell/SettingsView.tsx:79`) becomes `ModelsSection`. The page carries two lists,
under a lede that says what each one is: Environments are the coding CLIs a task can run
in, and signing in to one brings its own models along; Providers are every place models
come from, including the ones an environment brought; Calandria works out which providers
each environment can use.

**Environments.** One row per registered environment: `EnvMark`, name, a status chip, a
subtitle and one action.

| Status | Chip | Subtitle | Action |
|-|-|-|-|
| connected | Connected | signed in as, plan, config path | Disconnect |
| installed, not signed in | Installed, not signed in | the binary, then "sign in to use its models" | Sign in |
| not installed | Not installed | the binary Calandria looked for | Install first, disabled |

A connected row also carries the line "Brings Anthropic models · listed under Providers"
with the provider's mark, which is how a user gets from one list to the other. Sign in
opens the existing `AgentConnect` flow (`app/shell/AgentConnect.tsx`) in a modal, shared
with the first-run wizard. The list refetches on the `agent_auth` global event, as the
old section did.

**Providers.** One row per row of `GET /api/providers`: `ProviderMark`, label, a status
chip (Connected, Reachable, Untested), a type line ("Bundled with Claude Code · via
Claude Max", "LiteLLM gateway · gw.home.arpa", "Local server · localhost:11434"), the
three `EnvMark`s lit where the provider serves that environment and the environment is
connected, the count of models on, and a chevron. The whole row is one action: it opens
the detail modal. A row has no Edit, Remove or Models button. An Add provider button sits
in the section header. The plan-usage meter toggle for a bundled row (today at
`SettingsView.tsx:140`, key `plan_usage:<agent>`) moves into that row's detail modal.

Beneath the list, one dashed row per result of `GET /api/providers/detect`: "Ollama is
running at localhost:11434 · 3 models found · works with Claude Code and Codex", with Not
now and Add as provider. Not now dismisses it for the session. Add as provider creates
the row with the type's default policy and opens its detail modal. Detection asks once
and adds nothing by itself.

### Add provider

One modal page.

1. A type grid of the six user-added types (`litellm`, `ollama`, `lmstudio`,
   `openai_key`, `gemini_key`, `custom`), each with its mark, its label, a one-line
   description and the `EnvMark`s it will serve. The three bundled logins are absent from
   the grid. A line under it says they are added under Environments and their models
   arrive on their own.
2. Picking a type reveals the Connection form: Name, Endpoint, an API key field for the
   types that have one (a password input with a reveal button, omitted for `ollama` and
   `lmstudio`), an API shape control for `custom`, and a "Will serve" row showing the
   environments read-only with the note that the type decides them.
3. Test connection is the gate. It posts the unsaved config to `POST /api/providers/test`
   and renders the result in place: reached in N ms, N models listed, auth OK, or the
   failure with the response body in a mono block.
4. On a successful test the Models section renders beneath, from the list the test
   returned, using the same policy block as the detail modal. You see and adjust what the
   provider will contribute before the row exists.

The primary button stays disabled until a test has passed. Pressing it posts the config,
the secrets and the policy the toggles built, then the modal switches to detail mode for
the new row.

### Provider detail

A modal with three tabs: Connection, Models and Remove. A bundled row gets a read-only
Connection tab and no Remove tab.

**Connection.** For a user-added row this is the add form with the last test result shown
in place, and a Done button; changes save when you close. For a bundled row it is
read-only: managed by, account, config path, the one environment it serves, the
plan-usage meter switch, and a line saying the endpoint and the credential belong to the
CLI, so signing out there takes the provider with it.

**Models.** The policy block, in one of two shapes chosen by the type. A `litellm` row
reads "Allowlist", says how many chat models the gateway lists and how many non-chat ones
are hidden, says that only the models turned on reach the picker and that models the
gateway adds later stay off, and offers Turn on all and Turn off all. Every other type
reads "Everything listed is available", and says that local servers and bundled logins
expose every model they have and that turning one off hides it from the picker. Beneath
that sits a header line ("N of M on", "N in Other", the refresh time, a Refresh button)
and one row per model: a switch, the id in mono, a duplicate tag where the id is dated,
the context size, and the family and version it placed into, or Other. Non-chat rows are
hidden.

**Remove.** A bordered block at the far end of the tab row. It says that tasks already
running keep their model until they finish, and that defaults which pointed here fall
back to the project default. It carries the one-sentence usage summary from
`GET /api/providers/[id]/usage`, then a Remove provider button.

Settings → Account has already been removed, and Log out now renders at the foot of the
settings section nav when `GET /api/auth/whoami` reports a session. The routes stay; the
desktop app's sign-in uses them.

Measurements from the handoff: modal 720px, tabs 40px, model rows 44px, switches 32×18,
chips 11px at weight 600 with a 6px dot. At 390px the modal fills the screen, the type
grid drops to two columns and every target is at least 44px.

## What this does not do

- No fourth environment, and no OpenCode row until a driver exists. The mock shows one as
  "Not installed" so all three environment states render in the design, and the registry
  lists only environments that have a driver, so nothing appears in the product.
- No per-project Vertex or Bedrock switch. The Anthropic backend stays an instance-wide
  fact of the CLI's config.
- No provider-level pricing beyond what the gateway already reports.
- No user override of family placement. The built-in table decides, and anything it
  cannot place goes to `other`.
- No secrets store beyond the 0600 file beside the database. The mock's "system keychain"
  line becomes "Stored on this instance. Never written to a task's environment as plain
  text."
- The `agent_env` columns are left in place unread. A follow-up drops them.
- No users. The removal of the Account section is the whole of that item, and it has
  landed.

## Task plan

Filed under the tag `model-providers`, based on `integration/model-providers`. The model
each task should run on is in its brief and repeated here.

Landed before this revision: the spike, the design pass on Settings → Providers, the
design pass on the model picker (both superseded in their anatomy by the Models v2
handoff), and the removal of Settings → Account. This revision of the spec is itself a
step, and the provider registry waits on it.

Phase 1, server. These block everything else.

1. Provider registry, `model_providers` table, store, secrets file and env seeding. Opus.
   Blocked by the spec revision.
2. Provider REST routes: CRUD, test an unsaved or saved config, usage. Sonnet. Blocked
   by 1.
3. Model catalog: family placement, per-type policy and the models tree route. Opus.
   Blocked by 1.
4. Resolve a task's endpoint from its provider row and migrate `agent_env` into rows.
   Opus. Blocked by 1.
5. Environment registry: declare provider support per CLI and expose it on
   `GET /api/agents`. Sonnet. Blocked by 1.

Phase 2, UI.

6. Settings → Models: environments list, providers list, provider detail modal and
   one-page Add provider. Opus. Blocked by 2, 3, 5 and the Settings → Providers design
   pass.
7. `ModelPicker` component, adopted in every surface that picks a model. Opus. Blocked
   by 3, 4, 5 and the model-picker design pass.
8. Agent tools and dispatch take a provider id instead of `local | cloud`. Sonnet.
   Blocked by 4.

Phase 3, verification and landing.

9. End-to-end coverage: add, edit and remove a provider, and pick a model through the
   picker. Sonnet. Blocked by 6, 7.
10. Docs and `.env.example`: providers are configured in Settings, env vars seed them.
    Sonnet. Blocked by 6, 7, 8.
11. Land `integration/model-providers` on main. Sonnet. Blocked by 9, 10 and the
    Settings → Account removal.

Rules every task on the tag follows:

1. The brief names the model to run on, and the plan was written with that model in mind.
2. A worktree has no `node_modules`, so `NODE_ENV=development npm ci --include=dev` comes
   first, then `npm run typecheck` and `npm test`, plus `npm run test:e2e` when a spec or
   a UI surface changed.
3. Open the PR with the `create_pr` tool against `integration/model-providers` with a
   Conventional Commit title. CI runs on PRs into `integration/**` and must be green. The
   user merges.
4. Secrets never reach a row that `GET /api/providers` or `GET /api/projects` serves.
5. Docs and UI copy are plain technical prose: no em dashes, second person, one idea per
   sentence.
6. Where the spec and the landed code differ, the code wins. Say so in the PR body and
   fix the spec in the same PR.
