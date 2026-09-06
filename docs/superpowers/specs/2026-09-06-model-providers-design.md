# Model providers and the model picker: design spike

Date: 2026-09-06
Status: spike. A proposal with a task plan. Nothing in this document is implemented.
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
  Model provider select in project settings (`app/shell/modals.tsx:1489-1568`). The
  select's help text still says the gateway is Claude Code only, which PR #215 made
  false.
- The model is picked six different ways: a button grid and a select in the New and Edit
  task dialogs (`app/shell/modals.tsx:39-66`, `:253`), a dropdown in the session header
  that switches to endpoint models off the cloud (`app/shell/SessionView.tsx:588-596`),
  a free-form field in project settings, no model at all in Schedules and Runbooks, and
  a per-agent select in Settings → Run defaults (`app/shell/SettingsView.tsx:994-1110`).
- There is no way to hide a model from a picker, and no policy for models that appear in
  or vanish from a catalog. The gateway catalog is filtered per CLI by
  `fitsDriver()` (`lib/gatewayModels.ts:181-186`) and nothing else is.
- Settings → Account (`app/shell/SettingsView.tsx:30-94`) shows the Cloudflare Access
  session and a Log out button. Calandria has no users, so a section named Account
  promises something the product does not have.

## Vocabulary

Three things are currently mixed together. The redesign names them and keeps them apart.

**Environment.** The coding CLI a turn runs in: Claude Code, Codex, Antigravity. This is
today's `agent` id (`tasks.agent`, `projects.default_agent`, `runbooks.agent`,
`schedules.agent`) and the `AgentDriver` behind it. The column and the driver seam keep
their names. Only the UI word changes, because "agent" in the UI now has to mean the CLI
and nothing else. An environment declares which provider types it can talk to and how
the endpoint reaches it (env var, config.toml provider entry, API key).

**Provider.** A configured source of models: an endpoint, a credential, and a model
policy. A row in a new `model_providers` table. Six types in v1:

| Type | What it is | Environments | Credential | Catalog |
|-|-|-|-|-|
| `anthropic` | Claude Code's own login. Anthropic, Vertex or Bedrock, detected from the CLI's config (`lib/agents/claude/provider.ts:51-61`) | claude | CLI login or API key | static list corrected by the CLI probe (`lib/agents/claude/modelProbe.ts`) |
| `openai` | Codex's own login | codex | CLI login or API key | `~/.codex/models_cache.json` (`lib/agents/codex/catalog.ts`) |
| `google` | Antigravity's own login | agy | CLI login or `GEMINI_API_KEY` | static list (`lib/agents/gemini/capabilities.ts:39-54`) |
| `litellm` | A LiteLLM gateway | claude, codex, agy | instance key, optional admin key, billing mode | `GET /model/info`, filtered per environment (`lib/gatewayModels.ts`) |
| `local` | Ollama or LM Studio | claude, codex | token (required by the server, value ignored) | endpoint probe (`lib/modelEndpoint.ts`) |
| `custom` | Any Anthropic- or OpenAI-compatible base URL | claude, codex | token | endpoint probe, or typed |

`anthropic`, `openai` and `google` are singletons: one row each, created when the CLI is
connected, removed when it is disconnected. They exist as rows so the list, the model
policy and the picker treat every provider the same way. `litellm`, `local` and `custom`
can have any number of rows.

Antigravity is listed only for `google` and `litellm`. The driver passes
`GOOGLE_GEMINI_BASE_URL` through to the CLI (`lib/agentEnv.ts:93-94`) and nothing
verifies that a local server answers the Gemini API. A `local` or `custom` row offers
Antigravity once someone has shown it working, by adding `agy` to that type's
environment list.

**Model.** An id inside one provider's catalog, valid for one environment. The picker's
value is the triple `{ agent, provider_id, model }`.

## Data model

```
model_providers
  id            TEXT PRIMARY KEY
  type          TEXT NOT NULL            -- anthropic | openai | google | litellm | local | custom
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
- `local`: `base_url`, `api` (`ollama` | `openai`, from the probe).
- `custom`: `base_url`, `api` (`anthropic` | `openai`).
- `anthropic`, `openai`, `google`: empty. The credential is the CLI's own login.

Secrets (`litellm` key and admin key, `local` and `custom` tokens, the Gemini API key
`lib/agents/gemini/auth.ts:371` stores in `settings` today) live in one 0600 JSON file
beside the database, keyed by provider id. `lib/providerSecrets.ts` generalizes
`lib/litellm-key.ts`. `GET /api/providers` serves `has_key: true` and never the value,
for the reason `gatewayPresetEnv` gives at `lib/agentEnv.ts:427-436`: `agent_env` is
served to the browser, so anything in it is readable by anyone with the app open.

`model_policy`:

```
{
  "auto_add": true,        // a model new to the catalog is selectable (default on)
  "auto_remove": true,     // a model gone from the catalog disappears (default on)
  "excluded": [],          // ids the user has unticked
  "known": [],             // the catalog as of the last read, for diffing
  "unavailable": []        // ids kept selectable after they left the catalog (auto_remove off)
}
```

With `auto_add` off, a model that appears in the catalog lands in `excluded` and the
provider row shows a "N new models" badge until the user reviews them. With
`auto_remove` off, a model that leaves the catalog moves to `unavailable`, stays in the
picker marked as such, and a turn that names it fails with the provider's own error.
Both defaults are on, as the brief asks.

### Resolution at turn time

`agentTurnEnv()` (`lib/agentEnv.ts:273-306`) stops reading the stored `agent_env` blob
and derives the same env from the provider row: `task.provider_id`, else
`project.default_provider_id`, else the environment's own singleton. The existing
preset functions produce the env shape, so the driver side (`applyProviderEnv`,
`applyGatewayEnv`, `codexProviderConfig`, `verifyCodexProvider`) does not change. The
model comes from `task.model`, else `default_model:<agent>`, else the provider's
`default_model` in its config, else the CLI's own default. That is the chain the drivers
already follow (`lib/agents/claude/driver.ts:752`, `codex/driver.ts:217`,
`gemini/driver.ts:94`), with the provider row in the slot the preset's `*_MODEL` env
occupied.

`describeProvider()` and `ProviderKind` stay for the session badge and the usage ledger.
They read the env the row produced, so a `litellm` row still describes as `gateway` and
a `local` row as `local`.

### Migration and env seeding

One migration converts what exists:

- A project or task whose `agent_env` is a local preset becomes a `local` row labelled
  after its host, deduplicated by base URL, and `default_provider_id` or `provider_id`
  points at it.
- A gateway preset points at the `litellm` row seeded from the env (below); the
  project's `gateway_max_budget`, `gateway_key_duration` and `gateway_mcp` columns stay
  where they are, since they are per-project caps on one gateway, and the project
  settings form keeps them under the picker.
- A custom preset becomes a `custom` row.
- `cloudOverrideEnv` rows (a task pinned back to the cloud in a local project) become
  `provider_id` = the environment's singleton.

The `agent_env` columns stop being written and read. Dropping them is a follow-up once
the release that reads the rows has shipped.

Env vars keep working for self-hosters: on boot, `CALANDRIA_LITELLM_BASE_URL` with its
`_KEY`, `_ADMIN_KEY` and `_MCP` seeds one `litellm` row, and an explicitly set
`CALANDRIA_LOCAL_MODEL_BASE_URL` seeds one `local` row. Seeding happens only when no row
of that type exists. Once a row exists the DB wins and the env is ignored, with one log
line on boot saying so. The default local URL (`http://localhost:11434`) seeds nothing,
since a row for a server most instances do not run would be an unreachable provider on
every fresh install. `.env.example` and `docs/SELF_HOSTING.md` describe the vars as
first-boot seeds.

This is a change to the "every knob is env-driven" rule in `CLAUDE.md`: provider
configuration is per instance and user-editable, so the source of truth moves to the
database with env as the seed. The rule stays for everything else.

## The environment registry

`AgentCapabilities` (`lib/agents/types.ts:48`) gains two fields:

```
providerTypes: ProviderType[]     // which provider types this environment can use
endpointTransport: string         // one sentence: how an endpoint reaches the CLI
```

`lib/agents/capabilities.ts` stays SDK-free and is where a fourth environment (opencode,
hermes) is declared. `GET /api/agents` exposes the fields. `app/icons.tsx` gains
`EnvMark` (Claude Code, Codex, Antigravity) and `ProviderMark` (Anthropic, OpenAI,
Google, LiteLLM, Ollama, LM Studio, custom). The existing `AgentMark` keys are the
vendor logos and become `ProviderMark`; the CLIs get their own marks.

## API

| Route | Purpose |
|-|-|
| `GET /api/providers` | every row, secrets replaced by `has_key`, plus the environments each supports, last test result, model counts and the new-models badge count |
| `POST /api/providers` | create; singleton types refuse a second row |
| `PATCH /api/providers/[id]` | edit config, label, policy |
| `DELETE /api/providers/[id]` | remove. `ON DELETE SET NULL` on the referencing columns. The response of `GET /api/providers/[id]/usage` names the projects, tasks, schedules and runbooks that point at it so the confirmation dialog can list them |
| `POST /api/providers/test` | probe an UNSAVED config, for the onboarding wizard |
| `POST /api/providers/[id]/test` | probe a saved row and store `last_test` |
| `GET /api/providers/[id]/models?agent=` | the catalog for one environment with `excluded`, `unavailable` and `new` flags |
| `PUT /api/providers/[id]/models` | write the policy |

The probe reuses `probeGateway()` (`lib/gatewayHealth.ts`) for `litellm` and
`endpointModels()` (`lib/modelEndpoint.ts`) for `local` and `custom`. Cloud singletons
report the CLI connection from `lib/agents/connections.ts`.

`GET /api/agents` keeps its shape and adds `providers: [{ id, label, type }]` per agent,
so the picker can build its list from one fetch. `GET /api/projects/[id]/models` and
`app/shell/modelEndpoint.ts` are replaced by the provider models route.

## The model picker

One component, `app/shell/ModelPicker.tsx`, used everywhere a model is chosen. Value
`{ agent, provider_id, model }`, all three nullable for "inherit".

1. An environment row: segmented control with `EnvMark` icons. Only connected
   environments, plus whichever the current value names. Hidden when one environment is
   connected. Switching clears the model unless the new environment can run it.
2. A model list filtered to providers that support the chosen environment, grouped
   under provider headers with `ProviderMark`. The singleton for the environment's own
   login is first. Each row shows the model label, the context window and the
   provider's pricing note where known. Excluded models are absent; unavailable ones are
   struck through. A search field appears above the list past twelve rows.
3. Reasoning level and permission mode stay beside the picker in the dialogs that have
   them; they are not the picker's concern.

Surfaces the picker replaces:

| Surface | Today | After |
|-|-|-|
| New task, Edit task | `AgentPicker` + `ModelField` (`modals.tsx:39-66`, `:253`, `:1009`) | `ModelPicker` |
| Session header | model dropdown (`SessionView.tsx:830-855`) | `ModelPicker` in a popover |
| Project settings | Model provider select + free-form model (`modals.tsx:1489-1568`) | `ModelPicker` for the project default; the gateway caps stay beneath it |
| Schedules, Runbooks | agent select only (`Schedules.tsx:418`, `Runbooks.tsx:169`) | `ModelPicker`; `model` and `provider_id` stored on the row and carried by `lib/dispatch.ts` |
| Settings → Run defaults | per-agent selects (`SettingsView.tsx:994-1110`) | one `ModelPicker` per connected environment for the default, plus the two job-model pickers |
| Settings → Background jobs | agent select | `ModelPicker` for the utility agent |
| `suggest_task`, `create_runbook`, dispatch | `provider: "local" \| "cloud"` | `provider` takes a provider id or label; `local` and `cloud` stay as aliases for the first local row and the singleton |

## Settings → Providers

Replaces Settings → Agents. A list, one row per provider: `ProviderMark`, label, type,
the `EnvMark`s it supports, status (connected, reachable, broken, untested), model
count, the new-models badge, and the plan-usage meter toggle for the cloud singletons
(today at `SettingsView.tsx:166`). Each row has Edit and Remove. Remove opens a
confirmation naming what points at the provider and what happens to it (they fall back
to the project default or the environment's own login).

An Add provider button opens the onboarding wizard, a modal with steps:

1. **Type.** Cards for the six types, each with a one-line description and the
   `EnvMark`s of the environments it serves. Singleton types already present are shown
   disabled with "connected".
2. **Configure.** The type's form. Cloud singletons show the existing `AgentConnect`
   login flow (`app/shell/AgentConnect.tsx`) unchanged. `litellm`: label, base URL, key,
   admin key, billing mode, hosted MCP toggle. `local`: label, base URL, token. `custom`:
   label, base URL, API shape, token.
3. **Test.** Runs `POST /api/providers/test` on the unsaved config and shows the result:
   reachable, version, API shape, model count, key spend and budget for a gateway. A
   failed test does not block saving, since a server can be down while its config is
   right, but the row is created with status untested and the list says so.
4. **Models.** The catalog as a checklist, all ticked by default, grouped per
   environment where the catalog differs (a gateway's Codex-capable models are a subset
   of its Claude-capable ones). Two switches at the top: "Add new models automatically"
   and "Remove models that disappear", both on.
5. **Done.** A summary and a link to set the provider as a project default.

Edit opens the same wizard with the steps as tabs. The first-run `OnboardingWizard`'s
connect step becomes step 2 of this wizard for a cloud type, so the two flows share one
component.

Settings → Account is removed. The Log out button, needed only under Cloudflare Access,
moves to the foot of the settings section nav and renders only when
`GET /api/auth/whoami` reports a session. The routes stay; the desktop app's sign-in
uses them.

## What this does not do

- No fourth environment. The registry makes opencode or hermes a driver, a capabilities
  entry and an icon; none of that is built here.
- No per-project Vertex or Bedrock switch. The Anthropic backend stays an instance-wide
  fact of the CLI's config.
- No provider-level pricing beyond what the gateway already reports.
- The `agent_env` columns are left in place unread. A follow-up drops them.
- No users. The removal of the Account section is the whole of that item.

## Task plan

Filed under the tag `model-providers`, based on `integration/model-providers`. The
model each task should run on is in its brief.

Phase 1, server. These block everything else.

1. Provider type registry, `model_providers` table, store, secrets file, env seeding.
   Opus.
2. Provider REST routes with test, models and usage endpoints. Sonnet. Blocked by 1.
3. Model catalog per provider with the exclusion and auto-add/auto-remove policy.
   Sonnet. Blocked by 1.
4. Resolve a task's endpoint from its provider row and migrate `agent_env`. Opus.
   Blocked by 1.
5. Environment registry fields and `GET /api/agents` provider lists. Sonnet. Blocked
   by 1.

Phase 2, design. Independent of phase 1; each produces mockups and an icon set in
`docs/design/handoff/`.

6. Design pass: Settings → Providers and the add-provider wizard. Opus.
7. Design pass: the model picker. Opus.

Phase 3, UI.

8. Settings → Providers pane and the add-provider wizard. Opus. Blocked by 2, 3, 5, 6.
9. `ModelPicker` component and its adoption in every surface. Opus. Blocked by 3, 4,
   5, 7.
10. Agent tools and dispatch take a provider id. Sonnet. Blocked by 4.
11. Remove Settings → Account; move Log out to the nav foot. Sonnet. Independent.

Phase 4, verification and landing.

12. End-to-end coverage: add, edit and remove a provider; pick a model through the
    picker. Sonnet. Blocked by 8, 9.
13. Docs and `.env.example`: providers are configured in Settings, env vars seed them.
    Sonnet. Blocked by 8, 9, 10.
14. Land `integration/model-providers` on main. Sonnet. Blocked by 11, 12, 13.
