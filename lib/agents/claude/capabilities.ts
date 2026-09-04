// Claude Code's capability descriptor: what the agent can do, as data,
// rendered into the UI's pickers via GET /api/agents. It is split out of
// driver.ts so it can be read without importing the Agent SDK.
// serverExternalPackages makes the SDK an async external under Turbopack, and
// that async-ness propagates to every transitive importer (see
// lib/agents/capabilities.ts). A task row's null model/reasoning/permission
// means "inherit the driver default", so the lists carry only explicit
// choices.

import type { AgentCapabilities, AgentModelOption } from "../types";
import { BACKGROUND_LINGER_ENABLED } from "../../config";
import { configuredProvider, claudeDefaultModels } from "./provider";
import { resolvedModelIds } from "./modelIds";
import { gatewayBaseUrl, isGatewayEndpoint } from "../../agentEnv";
import { gatewayModelOptions, lastGatewayModelCatalog } from "../../gatewayModels";

// Every value below is a string `claude --model` accepts: a family alias
// ("opus" resolves to the current Opus), a `[1m]` variant (the 1M-context beta
// of that family), or a full model id for a pinned older version. The internal
// picker ids the CLI's own /model menu uses ("opus48", "sonnet46") are not
// accepted by --model, so pins are spelled as full ids.
//
// A pin's label names its version, because it pins one. An alias's label must
// not: an alias is resolved by the installed CLI at turn time, so a version in
// the label would be a guess about what that CLI picks, and the guess goes
// stale the next time a family moves. Aliases read "(latest)" instead, and
// `modelLabel()` parses the actual version out of the id a turn billed, so the
// picker offers "Fable (latest)" and the badge reports "Fable 5.1".
//
// The resolution is readable locally: ./modelProbe.ts asks the installed CLI
// once per CLI version, out of band, and leaves the answer in ./modelIds.ts for
// this synchronous descriptor to read via `subscriptionModels()` below. Until a
// probe has run, or when there is no `claude` on PATH or the probe is off, the
// rows below stand exactly as written, which is why the static subtitles are
// worth keeping.
//
// contextWindow is the window Claude Code actually runs, not the model's API
// maximum: a bare family alias runs the standard 200k window and the `[1m]`
// variant opts into the 1M beta. windowFor() reads the window off a resolved id
// rather than off this row once a resolution exists. Fable is the exception: it
// is 1M natively, so there is no variant to list. `fable[1m]` is accepted and
// resolves to the `[1m]` spelling of the same model, but changes nothing.
const K200 = 200_000;
const M1 = 1_000_000;

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [
    // Pinned ahead of the alias because the alias may not reach it: `fable`
    // resolves through the installed CLI's own catalog, so an older CLI can
    // resolve it to an earlier Fable version than this pin names. The pin says
    // which version you meant regardless of what the installed CLI knows. An id
    // the CLI doesn't recognize logs `[claude-code:unrecognized_model]` and
    // passes through unchanged, so the turn still runs and bills under that id;
    // a genuinely bogus id errors instead, which is what makes an unrecognized
    // pin a pass-through rather than a silent fallback.
    { value: "claude-fable-5-1", label: "Fable 5.1", sub: "newest Fable · 1M context", contextWindow: M1, group: "Latest" },
    { value: "fable", label: "Fable (latest)", sub: "most capable · 1M context", contextWindow: M1, group: "Latest" },
    { value: "opus", label: "Opus (latest)", sub: "everyday complex work", contextWindow: K200, group: "Latest" },
    { value: "sonnet", label: "Sonnet (latest)", sub: "efficient for routine tasks", contextWindow: K200, group: "Latest" },
    { value: "haiku", label: "Haiku (latest)", sub: "fastest, lowest cost", contextWindow: K200, group: "Latest" },
    { value: "opusplan", label: "Opus Plan Mode", sub: "Opus while planning, Sonnet after", contextWindow: K200, group: "Latest" },
    { value: "opus[1m]", label: "Opus (1M)", sub: "long sessions, large codebases", contextWindow: M1, group: "1M context" },
    { value: "sonnet[1m]", label: "Sonnet (1M)", sub: "long sessions, large codebases", contextWindow: M1, group: "1M context" },
    { value: "opusplan[1m]", label: "Opus Plan Mode (1M)", sub: "plan on Opus, run on Sonnet 1M", contextWindow: M1, group: "1M context" },
    { value: "claude-opus-4-8", label: "Opus 4.8", sub: "previous Opus", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", sub: "previous Opus, 1M context", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "previous Sonnet", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)", sub: "previous Sonnet, 1M context", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-opus-4-7", label: "Opus 4.7", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-opus-4-6", label: "Opus 4.6", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
  ],
  // Claude's own extended-thinking vocabulary: the think / think hard /
  // ultrathink keywords the CLI honors in a prompt, so these labels are already
  // provider-native. The values double as the cross-agent preset keys other
  // drivers map from (codex: EFFORT in codex/driver.ts), so they stay spelled
  // this way even where a driver's labels differ.
  reasoningOptions: [
    { value: "off", label: "Off", sub: "no extended thinking" },
    { value: "think", label: "Think", sub: "light reasoning" },
    { value: "think_hard", label: "Think hard", sub: "deeper reasoning" },
    { value: "ultrathink", label: "Ultrathink", sub: "maximum reasoning" },
  ],
  // Ordered most autonomous to least. Each value is passed through to the CLI's
  // `--permission-mode` verbatim (the SDK forwards the string unchanged), and
  // all five are accepted by CLI 2.1.x. This list is the single source of truth
  // for what the driver honors: permissionModeFor() in driver.ts is pinned
  // against it by tests/claudePermissionMode.test.ts, so a mode can never be
  // offered here and coerced to something else at run time.
  //
  // The subs describe what happens now that canUseTool is a real gate
  // (lib/permissions.ts): anything a mode doesn't auto-approve parks the turn on
  // a permission card. bypassPermissions is the one mode that never reaches the
  // gate.
  //
  // Labels are Anthropic's own spellings, the exact strings `--permission-mode`
  // takes and the docs use, rather than an app-invented vocabulary, so a Claude
  // Code user sees the modes they already know. The plain-English behavior lives
  // in the sub. Codex's descriptor does the same with OpenAI's sandbox/approval
  // terms; each driver speaks its provider's language. "auto" is the one entry
  // Anthropic's docs don't list: it's the CLI's classifier mode, spelled the way
  // the CLI accepts it.
  //
  // The SDK also defines "dontAsk" (deny anything not pre-approved, without
  // prompting). It stays off: dontAsk never calls canUseTool at all. Verified
  // against claude-cli 2.1.x: under dontAsk, `echo hello` ran and `rm -f …` was
  // refused with decision_reason_type "mode", and the callback was not invoked
  // either time. So the entire gate in lib/permissions.ts is inert under it: the
  // read-only allowlist, the project's remembered `permission_rules`, the card.
  // "Pre-approved" means the CLI's own allow rules in the user's ~/.claude
  // settings, which Calandria does not write.
  //
  // "Deny unless I have already allowed it" is already what "default" plus
  // remembered rules does, and that combination can also ask, records what it
  // grants where Settings can revoke it, and auto-denies when nobody is
  // watching. dontAsk offers strictly less control while reading like more.
  permissionModes: [
    { value: "bypassPermissions", label: "bypassPermissions", sub: "never asks, bypasses every permission check" },
    { value: "auto", label: "auto", sub: "a model screens each call; risky ones ask you (the app's default)" },
    { value: "acceptEdits", label: "acceptEdits", sub: "auto-accept file edits, ask before commands" },
    { value: "default", label: "default", sub: "Claude Code's standard prompting: ask before anything not already approved" },
    { value: "plan", label: "plan", sub: "propose a plan, don't edit" },
  ],
  supportsAsks: true,
  supportsMcpTools: true,
  // A task session loads the user's own ~/.claude configuration: settings, MCP
  // servers, plugins, skills, CLAUDE.md, because the driver pins settingSources
  // to ["user", "project"] (see SETTING_SOURCES in ./driver.ts). 'local' is
  // excluded because it's worktree-writable and gitignored, so it never surfaces
  // in the diff a task's changes get reviewed through.
  // Inherited tools are gated like any other: auto-approved under
  // bypassPermissions, classifier-screened under the "auto" default, a
  // permission card otherwise. They're reachable in every mode, which is what
  // differs from Codex, where an inherited tool call can never succeed.
  // lib/agents/CLAUDE.md compares them.
  inheritsUserMcpServers: true,
  userMcpServersNote: "A task can call the tools from your ~/.claude MCP servers, alongside Calandria's own.",
  // Mounted the same way Calandria's own MCP server is: no per-driver caveat.
  gatewayMcpNote: null,
  // The driver holds the session open past the result while run_in_background
  // work runs (streaming-input linger, see driver.ts). Off when the operator
  // disabled the feature (CALANDRIA_BACKGROUND_LINGER=off), in which case
  // buildProjectContext warns the model that backgrounded commands die at turn
  // end.
  backgroundTasksLinger: BACKGROUND_LINGER_ENABLED,
  // The Agent tool, with the user's own subagent types on top of the built-in
  // ones (settingSources pulls ~/.claude/agents in). buildProjectContext tells
  // the session to collect context through it.
  dispatchesSubagents: true,
  reportsCostUsd: true,
  costIsEstimated: false,
  // Every assistant message carries its API request's usage; the driver
  // forwards the input side of the latest main-session one as `context`.
  reportsContext: true,
  supportsResume: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
  loginCompletesOutOfBand: false,
  connectHint: null,
};

// ---------- Vertex ----------
//
// The catalog above is nearly correct on Vertex, so this is a set of
// corrections rather than a replacement list. Two things differ:
//
// 1. The "Pinned versions" group is unchanged. Bare ids like `claude-opus-4-8`
//    resolve fine on Vertex; `@version` is an optional pin there, not a
//    required spelling.
// 2. The family aliases carry the wrong context window. A bare alias resolves
//    through ANTHROPIC_DEFAULT_*_MODEL, and a mapping can carry `[1m]` (a 1M
//    window where the static catalog says 200k). contextWindow feeds the
//    context gauge and the overflow notice, so the aliases below take their
//    window and subtitle from the id the mapping actually resolves to.
//
// Fable rows are dropped rather than corrected: the Fable family 403s on
// Vertex ("data sharing... for publisher 'anthropic'") until the direct
// platform arrangement with Anthropic is in place, and an entry that 403s
// every turn is a trap. The filter matches the whole family rather than the
// single value `fable`, since the gate is per publisher and any pinned Fable
// id fails the same way. Restoring them is deleting one line from the filter
// below.

/** Whether a picker value or resolved id names the Fable family: the alias
 *  `fable` or any pinned `claude-fable-*`, with or without a `[1m]` suffix. */
const isFable = (id: string): boolean => /fable/i.test(id);

/** The window Claude Code runs for a resolved model id: `[1m]` opts into the 1M
 *  beta, everything else gets the standard window. Fable is 1M natively. */
const windowFor = (id: string): number => (/\[1m\]/i.test(id) || isFable(id) ? M1 : K200);

function vertexModels(env: Record<string, string | undefined>): AgentModelOption[] {
  const mapped = claudeDefaultModels(env);
  // Which family mapping each alias reads. opusplan plans on Opus and runs on
  // Sonnet afterwards, so the mapping that governs the session, and its window,
  // is Sonnet's.
  const family: Record<string, string | null> = {
    opus: mapped.opus,
    "opus[1m]": mapped.opus,
    sonnet: mapped.sonnet,
    "sonnet[1m]": mapped.sonnet,
    haiku: mapped.haiku,
    opusplan: mapped.sonnet,
    "opusplan[1m]": mapped.sonnet,
  };
  // An alias's label must not claim a version, the same rule the default
  // catalog above follows, since a subscription alias is resolved by the
  // installed CLI for the same reason a Vertex one is resolved by
  // ANTHROPIC_DEFAULT_*_MODEL. Here the resolution can be named directly: it's
  // an env mapping this process can read, so "(provider default)" replaces
  // "(latest)" and the resolved id goes in the subtitle. Only the rows Vertex
  // spells differently are listed; the `[1m]` ones already read "Opus (1M)" /
  // "Sonnet (1M)" in the default catalog, and restating them here would be a
  // second copy free to drift.
  const alias: Record<string, string> = {
    opus: "Opus (provider default)",
    sonnet: "Sonnet (provider default)",
    haiku: "Haiku (provider default)",
  };
  return CLAUDE_CAPABILITIES.models.filter((m) => !isFable(m.value)).map((m) => {
    const base = family[m.value];
    if (!base) return m; // a pinned id, or a family this instance doesn't map

    // A `[1m]` picker value asks for the 1M variant of the mapped id, so it
    // stays 1M whatever the mapping is: `opus[1m]` against a plain
    // `claude-opus-4-8` mapping resolves to `claude-opus-4-8[1m]`, a real
    // Vertex model. Only the bare alias inherits the mapping's own window: a
    // mapping carrying `[1m]` makes plain `opus` a 1M session even though the
    // static catalog calls it 200k.
    const wants1m = /\[1m\]$/i.test(m.value);
    const resolved = wants1m && !/\[1m\]/i.test(base) ? `${base}[1m]` : base;
    // When the mapping already carries `[1m]`, the variant and the bare alias
    // are the same model string. Say so rather than presenting the same thing
    // twice under a group heading that implies they differ.
    const duplicate = wants1m && resolved === base;
    return {
      ...m,
      label: alias[m.value] ?? m.label,
      sub: duplicate ? `${resolved}, same as ${m.value.replace(/\[1m\]$/i, "")}` : resolved,
      contextWindow: wants1m ? M1 : windowFor(resolved),
    };
  });
}

// ---------- Subscription ----------
//
// The same correction as the Vertex one above, from a different source. Vertex
// resolves an alias through an env mapping this process can read directly; the
// subscription path resolves it inside the CLI's own catalog, so
// ./modelProbe.ts has to ask: one `claude -p --bare --model <alias>` per
// family, killed at the `init` line, out of band, cached against the CLI
// version that answered.
//
// What lands here is only ever an overlay. A row whose family was not probed,
// or was probed and did not answer, is returned untouched, so a machine with no
// CLI, a probe that timed out, and a Codex-only instance all render today's
// static catalog. The label is left alone in every case: "(latest)" stays
// correct however the alias resolves, and it is the id that changes.
//
// Which family mapping each row reads is the same table vertexModels() keeps,
// for the same reasons. `opusplan` plans on Opus and runs on Sonnet, and the
// probe reports the session model, so it is its own entry rather than an alias
// of `opus`.
const PROBED_FAMILY: Record<string, string> = {
  fable: "fable",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  opusplan: "opusplan",
  "opus[1m]": "opus",
  "sonnet[1m]": "sonnet",
  "opusplan[1m]": "opusplan",
};

/** The catalog with each probed alias's resolved id in its subtitle, the same
 *  place and the same spelling vertexModels() uses, so the two paths render
 *  identically. Exported for the suite, which supplies the map directly rather
 *  than spawning five CLIs. */
export function subscriptionModels(ids: Record<string, string>): AgentModelOption[] {
  return CLAUDE_CAPABILITIES.models.map((m) => {
    const family = PROBED_FAMILY[m.value];
    const base = family ? ids[family] : undefined;
    if (!base) return m; // a pinned id, or a family that didn't answer

    // A `[1m]` picker value asks for the 1M variant of the resolved id, exactly
    // as on Vertex, which is why only the five bare aliases are spawned and the
    // variants are derived from them.
    const wants1m = /\[1m\]$/i.test(m.value);
    const resolved = wants1m && !/\[1m\]/i.test(base) ? `${base}[1m]` : base;
    // The window comes off the resolved id rather than the row's static guess.
    // On today's subscription resolutions that changes nothing, since every
    // bare alias resolves to a bare id and Fable is 1M either way, but it
    // matters the day a family alias starts resolving to a `[1m]` spelling, as
    // already happened on Vertex.
    return { ...m, sub: resolved, contextWindow: wants1m ? M1 : windowFor(resolved) };
  });
}

/** The live capability descriptor: the Anthropic-hosted catalog normally, and a
 *  corrected one when the instance routes Claude through Vertex. Computed per
 *  read because the provider and its model mappings are instance config, not
 *  code, and because on the subscription path the alias resolution is a
 *  background probe's answer that may land at any point after boot. */
export function claudeCapabilities(env: Record<string, string | undefined> = process.env): AgentCapabilities {
  // The gateway check comes first and reads ANTHROPIC_BASE_URL directly rather
  // than going through configuredProvider(env): a gateway override is a
  // Calandria-level redirect (lib/agentEnv.ts), invisible to the CLI's own
  // backend-selection env vars, so configuredProvider(env) would read it as a
  // bare "anthropic" login and miss it entirely.
  const gateway = gatewayBaseUrl();
  if (gateway && isGatewayEndpoint(env.ANTHROPIC_BASE_URL, gateway)) {
    const catalog = lastGatewayModelCatalog(gateway);
    // No probe yet (or the last one failed) is a supported state, same as
    // every other branch below: the static catalog stands until one lands.
    if (catalog && catalog.length) return { ...CLAUDE_CAPABILITIES, models: gatewayModelOptions(catalog, "claude") };
    return CLAUDE_CAPABILITIES;
  }
  // Bedrock gets no special-casing here: this fork runs Vertex and has no
  // Bedrock instance to measure against, and upstream's Bedrock list drops the
  // `[1m]` variants, which do work on Vertex, so it is not a list to rename and
  // reuse. It gets no probe overlay either: ensureClaudeModelIds() only asks on
  // the subscription path, so the cache a Bedrock instance reads here is empty
  // by construction.
  const provider = configuredProvider(env);
  if (provider === "vertex") return { ...CLAUDE_CAPABILITIES, models: vertexModels(env) };
  if (provider !== "anthropic") return CLAUDE_CAPABILITIES;
  const probed = resolvedModelIds();
  if (!probed) return CLAUDE_CAPABILITIES;
  return { ...CLAUDE_CAPABILITIES, models: subscriptionModels(probed.ids) };
}
