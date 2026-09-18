---
title: "Codex hook harness"
---

# Codex hook harness

A way to launch a real Codex session through Calandria that inherits no
credentials and reaches no live service, so hook interception can be exercised
instead of argued about.

Verified against codex-cli 0.153.0.

## Running it

```bash
CALANDRIA_CODEX_HOOK_HARNESS=1 npx vitest run tests/codexHookHarness.test.ts
```

The harness is off by default. Without the environment variable the file skips,
so it costs an ordinary `npm test` run nothing.

A task worktree has no `node_modules`. Install them first:

```bash
NODE_ENV=development npm ci --include=dev
```

## What it does

The entrypoint is `tests/codexHookHarness.test.ts`. It drives the real `codex`
binary through Calandria's own Codex driver, not through a bare CLI
invocation, because the point is to exercise the host integration: the provider
override, the MCP mount, the hook trust writes and the hook run notices on the
transcript all come from `lib/agents/codex/`.

One run does this, in order:

1. Wipes and re-seeds the harness root (`tests/fixtures/codex/hook-harness/seed.ts`):
   a private `CODEX_HOME`, a git workspace, and the evidence files.
2. Writes `<workspace>/.codex/hooks.json` with one `PreToolUse` hook, and a
   `config.toml` that trusts the workspace and mounts the MCP stub.
3. Starts the loopback model fixture on an ephemeral port and points
   `OPENAI_BASE_URL` at it.
4. Calls `codexDriver.listHooks()` and then `codexDriver.reviewHooks()` to trust
   the hook, the same two calls Settings makes.
5. Runs one turn through `codexDriver.runTurn()` and records the transcript.
6. Asserts against the ledger.

### The three pieces

**Private Codex state.** `CODEX_HOME` points at `<root>/codex-home`, written
fresh each run. No `auth.json` is written, so the CLI has no login to inherit,
and the provider override names no `env_key`, so the CLI never asks for a key.

The root defaults to `~/.calandria/codex-hook-harness` and is not under
the system temp directory. A `CODEX_HOME` under `/tmp` makes the CLI print
`Refusing to create helper binaries under temporary dir`. It proceeds anyway,
but the warning is noise in a harness whose whole output is evidence. Override
the location with `CALANDRIA_CODEX_HARNESS_DIR`, and keep it off `/tmp` unless
you want that warning.

**A harmless local MCP stub.** `tests/fixtures/codex/hook-harness/mcp-stub.mjs`
is a stdio MCP server exposing two inert tools, `ledger_note` and
`ledger_probe`. Neither does anything but append one JSON line to the ledger
holding the tool name and the arguments exactly as they arrived. It is mounted
through `CODEX_HOME/config.toml`, not through the driver. That is where a user's
own MCP servers live, so the harness exercises the inheritance path
(`CODEX_INHERIT_MCP`) as well.

**A loopback model fixture.**
`tests/fixtures/codex/hook-harness/model-server.mjs` serves the one endpoint the
CLI calls under `wire_api = "responses"`: `POST /v1/responses`, answered as a
Server-Sent Events stream. It is reached through the ordinary provider override
in `lib/agents/codex/provider.ts`, the same path a user pointing Codex at Ollama
or LM Studio takes, and `lib/agents/codex/providerCheck.ts` verifies the
override took effect before the turn starts. There is no second mechanism.

The fixture's behaviour is scripted by a plan file, one step per request the CLI
makes:

```json
{ "steps": [
  { "kind": "tool", "match": "ledger_note", "arguments": { "note": "allowed-call" } },
  { "kind": "text", "text": "harness turn complete." }
] }
```

`match` is resolved against the tool names the CLI advertised in that
request, so the plan does not hard-code how Codex namespaces an MCP tool. `name`
(with optional `namespace`) calls a literal name instead, without resolving it,
and `raw` emits a literal output item for probing a wire form the fixture does
not otherwise model. Requests past the end of the plan get a plain text answer,
so an unexpected extra round trip ends the turn instead of hanging it.

### How an MCP tool is called

An MCP server does not reach the model as top-level functions. It arrives as one
namespace tool holding the server's own tools:

```json
{ "type": "namespace", "name": "mcp__ledger", "description": "Tools in the mcp__ledger namespace.",
  "tools": [ { "type": "function", "name": "ledger_note", "parameters": { ... } } ] }
```

The model calls a nested tool by its own `name`, with the namespace carried on a
top-level `namespace` field of the call item:

```json
{ "type": "function_call", "name": "ledger_note", "namespace": "mcp__ledger",
  "arguments": "{\"note\":\"allowed-call\"}", "call_id": "call_0", "id": "fc_0" }
```

Every other spelling tried is answered `unsupported call`:
`mcp__ledger.ledger_note`, `mcp__ledger__ledger_note`, `mcp__ledger:ledger_note`,
`ledger.ledger_note`, `mcp__ledger/ledger_note`, a bare `ledger_note` with no
namespace, and a `custom_tool_call` against the namespace. Calling the namespace
itself with the nested tool in its arguments is also `unsupported call`.

This is not a switch that can be turned off. `code_mode`, `code_mode_host` and
`non_prefixed_mcp_tool_names` were each tried in `[features]`; none flattens the
namespace. `non_prefixed_mcp_tool_names = true` only drops the `mcp__` prefix,
so the namespace becomes `ledger` and the nested names are unchanged.

### The hook contract

What the CLI sends a `PreToolUse` command hook on stdin, captured live:

```json
{
  "session_id": "...", "turn_id": "...", "transcript_path": "...",
  "cwd": "/path/to/workspace",
  "hook_event_name": "PreToolUse",
  "model": "calandria-harness-model",
  "permission_mode": "bypassPermissions",
  "tool_name": "mcp__ledger__ledger_note",
  "tool_input": { "note": "allowed-call" },
  "tool_use_id": "call_0"
}
```

Note the `tool_name`: a hook sees the double-underscore form
`mcp__<server>__<tool>`, which is not the name the model calls. A `matcher`
targeting an MCP tool must be written against this spelling.

To deny, print this on stdout and exit 0:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
  "permissionDecision": "deny", "permissionDecisionReason": "why" } }
```

The reason is required and must be non-empty. To allow, print nothing. The
denied call comes back to the model as
`Tool call blocked by PreToolUse hook: <reason>. Tool: <tool_name>`, and
Calandria puts a notice on the transcript reading
`Codex hook preToolUse blocked the call (project): ...`.

## Where the evidence lands

Everything is under the harness root, `~/.calandria/codex-hook-harness` by
default. The whole directory is wiped at the start of every run, so copy
anything you want to keep.

|File|What it holds|
|-|-|
|`ledger.jsonl`|One line per MCP tool call that reached the stub: tool name and arguments. This is the evidence.|
|`hook-log.jsonl`|One line per hook invocation: the raw payload the CLI sent the hook on stdin, and its parse.|
|`model-requests.jsonl`|One line per request the CLI made to the model fixture: model, advertised tool names, input items.|
|`model-tools.json`|The full tool definitions from the first request, with schemas.|
|`hook-inventory.json`|What `codexDriver.listHooks()` returned for the workspace.|
|`transcript.json`|Every `StreamEvent` the turn produced.|
|`codex-home/`|The throwaway `CODEX_HOME`, including the `config.toml` the seed wrote and the trust entries `reviewHooks` added.|
|`workspace/`|The git repo the turn ran in, including `.codex/hooks.json`.|

The ledger is what the assertions read. An allowed call must appear in it with
its arguments unchanged. A call the hook denied must leave no line.

A passing run leaves a ledger holding exactly one line:

```
{"at":"...","tool":"ledger_note","args":{"note":"allowed-call"}}
```

and a hook log holding two, one per attempted call.

## What it does not isolate

Say this plainly, because the harness is a safety claim and an overclaimed one
is worse than none:

- **No credentials are inherited**, because `CODEX_HOME` is private and empty of
  auth, and the provider override names no API key variable.
- **No model traffic leaves the host.** Every request goes to `127.0.0.1`.
- **The process is not network-sandboxed.** Nothing stops the CLI or a hook from
  opening a socket. The claim is about what the harness configures, not about
  what the kernel enforces.
- **Skills still load from outside the harness root.** The CLI reports
  `~/.agents/skills` as a skill root in the request it sends the model. Skills
  are instructions, not code the CLI runs on its own, but they are not isolated.
- **The MCP stub and hook run as your user**, unsandboxed, with the harness
  environment. They are inert by construction, not by confinement.

## Two constraints to know

**Project trust gates hooks entirely.** A project-local hook is inert until the
project is trusted in `CODEX_HOME/config.toml`:

```toml
[projects."/path/to/workspace"]
trust_level = "trusted"
```

Without it, `hooks/list` returns an empty array with no warnings and no errors.
The only signal is a `configWarning` notification containing
`until the project is trusted`. The seed writes this entry, so the harness never
hits that case, but an empty inventory elsewhere is usually this.

Per-hook trust is separate and lives at
`hooks.state."<key>".trusted_hash`, holding `sha256:<hex>` matching the hook's
`currentHash`. The harness pins it by calling `codexDriver.reviewHooks()`, the
same path Settings uses, so it never passes `--dangerously-bypass-hook-trust`
and a turn here is configured exactly like an ordinary one.

**Only `danger-full-access` can run a command on this host.** Codex's
`workspace-write` and `read-only` sandboxes both need bwrap user namespaces,
which AppArmor denies here, so under either of them every command of every turn
fails. The harness therefore runs its task at `permission_mode:
"bypassPermissions"`, the only mode `lib/agents/codex/policy.ts` maps to
`danger-full-access`. On a host without that restriction any mode works, but the
harness does not depend on one.

## The hooks.json schema

Verified against codex-cli 0.153.0 by writing candidate shapes and reading back
what `hooks/list` reported:

```json
{
  "description": "optional",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": null,
        "hooks": [
          { "type": "command", "command": "/bin/true", "timeout_sec": 60, "status_message": "shown while it runs" }
        ]
      }
    ]
  }
}
```

The trap: the event name is PascalCase. `pre_tool_use`, `preToolUse` and
`pre-tool-use` are all dropped silently, with no warning and no error, so a
misspelled event name looks exactly like a project that has no hooks. A wrong
shape at any other level does produce a warning naming the line and column.

Event names the binary accepts: `PreToolUse`, `PostToolUse`,
`PermissionRequest`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`,
`SubagentStart`, `SubagentStop`, `Interrupt`.

## Nested code-mode calls

`tests/codexCodeModeMatrix.test.ts` builds on this harness and runs the same
allow/deny pair down three call paths, plus four skip controls:

```bash
CALANDRIA_CODEX_HOOK_HARNESS=1 npx vitest run tests/codexCodeModeMatrix.test.ts
```

Codex's `code_mode` feature adds a tool named `exec` that runs JavaScript in a
V8 isolate and hangs every other tool off a global `tools` object, reached as
`tools.mcp__<server>__<tool>`. It is off by default; `seedHarness({ features: {
code_mode: true } })` writes it into the private `config.toml`. Enabling it adds
`exec` alongside the ordinary tools, so both call paths are reachable in one
session. `exec` is advertised as a `custom` tool with a lark grammar, so the
call item is a `custom_tool_call` whose `input` is raw source text. The fixture
does not model that shape; the matrix emits it with a `raw` step.

What the matrix measured against codex-cli 0.153.0:

- A `PreToolUse` hook fires once per nested call, sequential or concurrent,
  with the same payload a direct call produces: canonical
  `tool_name: "mcp__<server>__<tool>"` and the real `tool_input`.
- Denying a nested call stops it. The MCP stub records nothing for it and the
  call rejects inside the isolate with
  `Tool call blocked by PreToolUse hook: <reason>. Tool: <tool_name>`.
- The gate is per call. Two calls in flight under `Promise.allSettled`, one
  denied and one not, produce one stub invocation and one denial.
- A nested call's `tool_use_id` is `exec-<uuid>`, minted by the code-mode host,
  and matches the id of the `tool` StreamEvent on the transcript. A direct
  call's is the model's own `call_id`.
- The outer `exec` call fires no hook. A `matcher` written against `exec` sees
  nothing; interception happens one level down.
- The trusted hash does not cover the hooks file's top-level `description`.
  Editing it leaves the hook `trusted` and running. The edit has to touch the
  handler entry to drop the hook to `modified`.

Full evidence, including the controls and what was not measured, is in the notes
repo: `measurements/2026-09-17-codex-nested-code-mode-hook-interception.md` at
https://github.com/calandria-dev/calandria-notes.

## Relationship to the fake app-server

`tests/fixtures/codex/fake-app-server.mjs` has `hooks`,
`hooksUntrustedProject` and `hooksManaged` scenarios, which cover the protocol
shape against a fake binary and run in the ordinary suite. This harness drives
the real binary. They complement each other; neither replaces the other.
