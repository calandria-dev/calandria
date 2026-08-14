// Claude Code's capability descriptor — what the agent can do, as data
// (rendered into the UI's pickers via GET /api/agents). Split out of driver.ts
// so it can be read without importing the Agent SDK: serverExternalPackages
// make the SDK an async external under Turbopack, and that async-ness poisons
// every transitive importer (see lib/agents/capabilities.ts). A task row's
// null model/reasoning/permission means "inherit the driver default", so the
// lists carry only explicit choices.

import type { AgentCapabilities } from "../types";

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
  // a permission card. "Auto-run" is the one mode that never consults the gate.
  //
  // The SDK also defines "dontAsk" (deny anything not pre-approved, without
  // prompting). It is deliberately NOT offered: it denies through the
  // system/permission_denied path instead of the card, so a task would keep
  // losing tool calls with no way for the user to approve any of them.
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "never asks — bypasses every permission check" },
    { value: "auto", label: "Guarded auto", sub: "a model screens each call; risky ones ask you (default)" },
    { value: "acceptEdits", label: "Accept edits", sub: "auto-accept file edits, ask before commands" },
    { value: "default", label: "Ask when needed", sub: "ask before anything not already approved" },
    { value: "plan", label: "Plan mode", sub: "propose a plan, don't edit" },
  ],
  supportsAsks: true,
  supportsMcpTools: true,
  // A task session loads the user's own ~/.claude configuration — settings, MCP
  // servers, plugins, skills, CLAUDE.md — because the driver pins
  // settingSources to all three sources (see SETTING_SOURCES in ./driver.ts).
  // Their tools are then gated like any other: auto-approved under Auto-run,
  // classifier-screened under the "auto" default, a permission card otherwise —
  // reachable in every mode, which is what makes this differ from Codex, where
  // an inherited tool call can never succeed. CLAUDE.md has the comparison.
  inheritsUserMcpServers: true,
  reportsCostUsd: true,
  costIsEstimated: false,
  supportsResume: true,
  apiKeyHint: "sk-ant-…",
  loginStyle: "paste_code",
};
