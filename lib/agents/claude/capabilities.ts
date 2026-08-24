// Claude Code's capability descriptor — what the agent can do, as data
// (rendered into the UI's pickers via GET /api/agents). Split out of driver.ts
// so it can be read without importing the Agent SDK: serverExternalPackages
// make the SDK an async external under Turbopack, and that async-ness poisons
// every transitive importer (see lib/agents/capabilities.ts). A task row's
// null model/reasoning/permission means "inherit the driver default", so the
// lists carry only explicit choices.

import type { AgentCapabilities, AgentModelOption } from "../types";
import { BACKGROUND_LINGER_ENABLED } from "../../config";
import { configuredProvider, claudeDefaultModels } from "./provider";

// Every value below is a string `claude --model` accepts: a family alias
// ("opus" → the current Opus), a `[1m]` variant (the 1M-context beta of that
// family), or a full model id for a pinned older version. The internal picker
// ids the CLI's own /model menu uses ("opus48", "sonnet46") are NOT accepted by
// --model — it 404s on them — so pins are spelled as full ids. Labels carry the
// version number on purpose: "Opus" alone can't tell you whether a turn ran on
// Opus 5 or 4.8, which is the whole question when a family alias moves.
//
// contextWindow is the window Claude Code actually runs, not the model's API
// maximum: a bare family alias runs the standard 200k window and the `[1m]`
// variant opts into the 1M beta. Fable is the exception — it's 1M natively
// (`fable[1m]` resolves to plain claude-fable-5), so there's no variant to list.
const K200 = 200_000;
const M1 = 1_000_000;

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [
    { value: "fable", label: "Fable 5", sub: "most capable · 1M context", contextWindow: M1, group: "Latest" },
    { value: "opus", label: "Opus 5", sub: "everyday complex work", contextWindow: K200, group: "Latest" },
    { value: "sonnet", label: "Sonnet 5", sub: "efficient for routine tasks", contextWindow: K200, group: "Latest" },
    { value: "haiku", label: "Haiku 4.5", sub: "fastest, lowest cost", contextWindow: K200, group: "Latest" },
    { value: "opusplan", label: "Opus Plan Mode", sub: "Opus while planning, Sonnet after", contextWindow: K200, group: "Latest" },
    { value: "opus[1m]", label: "Opus 5 (1M)", sub: "long sessions, large codebases", contextWindow: M1, group: "1M context" },
    { value: "sonnet[1m]", label: "Sonnet 5 (1M)", sub: "long sessions, large codebases", contextWindow: M1, group: "1M context" },
    { value: "opusplan[1m]", label: "Opus Plan Mode (1M)", sub: "plan on Opus, run on Sonnet 1M", contextWindow: M1, group: "1M context" },
    { value: "claude-opus-4-8", label: "Opus 4.8", sub: "previous Opus", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", sub: "previous Opus, 1M context", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "previous Sonnet", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)", sub: "previous Sonnet, 1M context", contextWindow: M1, group: "Pinned versions" },
    { value: "claude-opus-4-7", label: "Opus 4.7", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
    { value: "claude-opus-4-6", label: "Opus 4.6", sub: "legacy", contextWindow: K200, group: "Pinned versions" },
  ],
  // Claude's own extended-thinking vocabulary — the think / think hard /
  // ultrathink keywords the CLI honors in a prompt — so these labels are already
  // provider-native. The values double as the cross-agent preset keys other
  // drivers map from (codex: EFFORT in codex/driver.ts), which is why they stay
  // spelled this way even where a driver's labels differ.
  reasoningOptions: [
    { value: "off", label: "Off", sub: "no extended thinking" },
    { value: "think", label: "Think", sub: "light reasoning" },
    { value: "think_hard", label: "Think hard", sub: "deeper reasoning" },
    { value: "ultrathink", label: "Ultrathink", sub: "maximum reasoning" },
  ],
  // Ordered most autonomous → least. Each value is passed through to the CLI's
  // `--permission-mode` verbatim (the SDK forwards the string unchanged), and
  // all five are accepted by CLI 2.1.x. The list is the single source of truth
  // for what the driver honors — permissionModeFor() in driver.ts is pinned
  // against it by tests/claudePermissionMode.test.ts, so a mode can never be
  // offered here and silently coerced to something else at run time.
  //
  // The subs describe what actually happens now that canUseTool is a real gate
  // (lib/permissions.ts): anything a mode doesn't auto-approve parks the turn on
  // a permission card. bypassPermissions is the one mode that never consults the
  // gate.
  //
  // Labels are Anthropic's own spellings — the exact strings `--permission-mode`
  // takes and the docs use — rather than an app-invented vocabulary, so a Claude
  // Code user sees the modes they already know. The plain-English behavior lives
  // in the sub. (Codex's descriptor does the same with OpenAI's sandbox/approval
  // terms; each driver speaks its provider's language, which is the point of the
  // labels living on the descriptor at all.) "auto" is the one entry Anthropic's
  // docs don't list — it's the CLI's classifier mode, spelled the way the CLI
  // accepts it.
  //
  // The SDK also defines "dontAsk" (deny anything not pre-approved, without
  // prompting). It stays OFF — decided again, against the live CLI, once
  // denials started rendering as real settled cards and the old objection
  // ("it denies without raising a card") stopped applying.
  //
  // The reason it stays off is bigger than the rendering: **dontAsk never calls
  // canUseTool at all.** Verified against claude-cli 2.1.x — under dontAsk,
  // `echo hello` ran and `rm -f …` was refused with decision_reason_type
  // "mode", and the callback was not invoked once either time. So the entire
  // gate in lib/permissions.ts is inert: the read-only allowlist, the project's
  // remembered `permission_rules`, the card. "Pre-approved" means the CLI's own
  // allow rules in the user's ~/.claude settings, which the orchestrator does
  // not write and should not start writing behind their back.
  //
  // Which leaves nothing for it to be. "Deny unless I have already allowed it"
  // is already "default" plus remembered rules — and that one can also
  // ask, records what it grants where Settings can revoke it, and auto-denies
  // when nobody is watching. dontAsk would offer strictly less control while
  // reading like more, which is the worst thing a permission mode can do.
  permissionModes: [
    { value: "bypassPermissions", label: "bypassPermissions", sub: "never asks — bypasses every permission check" },
    { value: "auto", label: "auto", sub: "a model screens each call; risky ones ask you (the app's default)" },
    { value: "acceptEdits", label: "acceptEdits", sub: "auto-accept file edits, ask before commands" },
    { value: "default", label: "default", sub: "Claude Code's standard prompting — ask before anything not already approved" },
    { value: "plan", label: "plan", sub: "propose a plan, don't edit" },
  ],
  supportsAsks: true,
  supportsMcpTools: true,
  // A task session loads the user's own ~/.claude configuration — settings, MCP
  // servers, plugins, skills, CLAUDE.md — because the driver pins settingSources
  // to ["user", "project"] (see SETTING_SOURCES in ./driver.ts; 'local' is
  // deliberately excluded — it's worktree-writable and gitignored, so it never
  // surfaces in the diff a task's changes get reviewed through).
  // Their tools are then gated like any other: auto-approved under
  // bypassPermissions, classifier-screened under the "auto" default, a
  // permission card otherwise —
  // reachable in every mode, which is what makes this differ from Codex, where
  // an inherited tool call can never succeed. CLAUDE.md has the comparison.
  inheritsUserMcpServers: true,
  userMcpServersNote: "A task can call the tools from your ~/.claude MCP servers, alongside Calandria's own.",
  // The driver holds the session open past the result while run_in_background
  // work runs (streaming-input linger — see driver.ts). Off when the operator
  // disabled the feature (ORCH_BACKGROUND_LINGER=off), and then
  // buildProjectContext re-warns the model that backgrounded commands die at
  // turn end.
  backgroundTasksLinger: BACKGROUND_LINGER_ENABLED,
  reportsCostUsd: true,
  costIsEstimated: false,
  // Every assistant message carries its API request's usage; the driver
  // forwards the input side of the latest main-session one as `context`.
  reportsContext: true,
  supportsResume: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};

// ---------- Vertex ----------
//
// Unlike the Bedrock case, the catalog above is very nearly RIGHT on Vertex, so
// this is a set of corrections rather than a replacement list. That's a finding,
// not an assumption: every entry was probed with a one-shot `claude -p --model
// <value>` against Vertex project example-vertex-project (region global,
// CLI 2.1.228), reading the resolved id back out of the run's `modelUsage`.
// 13 of the 14 ran. Two things came out of it, and only two things change here.
//
// 1. THE "PINNED VERSIONS" GROUP IS FINE. The suspicion going in was that
//    Vertex needs an `@version` suffix (ANTHROPIC_DEFAULT_HAIKU_MODEL on this
//    machine is `claude-haiku-4-5@20251001`), so bare ids like
//    `claude-opus-4-8` would 404. They don't. All four bare pins and both
//    `[1m]` pins ran, and a direct rawPredict to the Vertex REST endpoint
//    returns 200 for bare `claude-opus-4-8`/`claude-sonnet-4-6`/
//    `claude-opus-4-7`/`claude-opus-4-6`. `@version` is an optional pin on
//    Vertex, not the required spelling — so the pinned group is left alone.
//
// 2. THE FAMILY ALIASES CARRY THE WRONG CONTEXT WINDOW. A bare alias resolves
//    through ANTHROPIC_DEFAULT_*_MODEL, and on this instance those mappings
//    carry `[1m]`: `opus` → `claude-opus-5[1m]`, a 1M window where the catalog
//    says 200k. contextWindow is not cosmetic — modelContextWindow() feeds the
//    context gauge and the overflow notice, so a task on plain `opus` was being
//    measured against a fifth of its real window. The aliases below take their
//    window and their subtitle from the id the mapping actually resolves to.
//
// The one entry that does NOT run is `fable`: HTTP 403, "Access to this model
// requires data sharing to be enabled for publisher 'anthropic'". It's dropped
// rather than labeled with that reason, because on this fork the answer isn't
// "flip a GCP setting" — Fable arrives when the direct-platform arrangement with
// Anthropic is finalized, and until then an entry that 403s every turn is just a
// trap. Restoring it is deleting one line from the filter below.

/** The window Claude Code runs for a resolved model id: `[1m]` opts into the 1M
 *  beta, everything else gets the standard window. Fable is 1M natively. */
const windowFor = (id: string): number => (/\[1m\]/i.test(id) || /fable/i.test(id) ? M1 : K200);

function vertexModels(env: Record<string, string | undefined>): AgentModelOption[] {
  const mapped = claudeDefaultModels(env);
  // Which family mapping each alias reads. opusplan plans on Opus and runs on
  // Sonnet afterwards, so the mapping that governs the session — and its window
  // — is Sonnet's: probing `opusplan` resolved `claude-sonnet-5[1m]`, not the
  // opus mapping.
  const family: Record<string, string | null> = {
    opus: mapped.opus,
    "opus[1m]": mapped.opus,
    sonnet: mapped.sonnet,
    "sonnet[1m]": mapped.sonnet,
    haiku: mapped.haiku,
    opusplan: mapped.sonnet,
    "opusplan[1m]": mapped.sonnet,
  };
  // An alias's label must not claim a version. "Opus 5" is a guess about where
  // ANTHROPIC_DEFAULT_OPUS_MODEL points, and it's wrong the moment an instance
  // maps opus at 4.8; the version now lives in the subtitle, which is measured.
  // (This is f82f66d's relabel, applied only here — the pinned rows below DO
  // name a version, correctly, because they pin one.)
  const alias: Record<string, string> = {
    opus: "Opus (provider default)",
    sonnet: "Sonnet (provider default)",
    haiku: "Haiku (provider default)",
    "opus[1m]": "Opus (1M)",
    "sonnet[1m]": "Sonnet (1M)",
  };
  return CLAUDE_CAPABILITIES.models.filter((m) => m.value !== "fable").map((m) => {
    const base = family[m.value];
    if (!base) return m; // a pinned id, or a family this instance doesn't map

    // A `[1m]` picker value asks for the 1M variant OF the mapped id, so it
    // stays 1M whatever the mapping is — `opus[1m]` against a plain
    // `claude-opus-4-8` mapping is `claude-opus-4-8[1m]`, which is a real
    // Vertex model (probed, 1M). Only the BARE alias inherits the mapping's own
    // window, which is the case that was wrong: a mapping carrying `[1m]` makes
    // plain `opus` a 1M session while the catalog called it 200k.
    const wants1m = /\[1m\]$/i.test(m.value);
    const resolved = wants1m && !/\[1m\]/i.test(base) ? `${base}[1m]` : base;
    // When the mapping ALREADY carries `[1m]`, the variant and the bare alias
    // are the same model string — say so rather than presenting the same thing
    // twice under a group heading that implies they differ.
    const duplicate = wants1m && resolved === base;
    return {
      ...m,
      label: alias[m.value] ?? m.label,
      sub: duplicate ? `${resolved} — same as ${m.value.replace(/\[1m\]$/i, "")}` : resolved,
      contextWindow: wants1m ? M1 : windowFor(resolved),
    };
  });
}

/** The live capability descriptor: the Anthropic-hosted catalog normally, and a
 *  corrected one when the instance routes Claude through Vertex. Computed per
 *  read because the provider and its model mappings are instance config, not
 *  code — the plain Anthropic-login path returns the constant untouched. */
export function claudeCapabilities(env: Record<string, string | undefined> = process.env): AgentCapabilities {
  // Bedrock deliberately gets no special-casing here: this fork runs Vertex and
  // has no Bedrock instance to measure against, and upstream's Bedrock list
  // (b5d995f) drops the `[1m]` variants — which demonstrably DO work on Vertex,
  // so it is not a list to rename and reuse.
  if (configuredProvider(env) !== "vertex") return CLAUDE_CAPABILITIES;
  return { ...CLAUDE_CAPABILITIES, models: vertexModels(env) };
}
