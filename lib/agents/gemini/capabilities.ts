// The Antigravity (Gemini) capability descriptor — what the agent can do, as
// data, rendered into the UI's pickers via GET /api/agents. Split out of
// driver.ts so it can be read without importing anything that spawns a CLI,
// the same separation lib/agents/capabilities.ts requires of every driver.

import type { AgentCapabilities } from "../types";

// The key-shape placeholder, owned HERE rather than read off ./auth, so this
// module stays a leaf. auth.ts pulls in lib/store, which reaches back to
// lib/agents/capabilities.ts, so a descriptor that imported auth could only be
// evaluated in one import order — and any module that reached auth.ts first
// (the plan-usage reader, a test) got `undefined` off a half-built module.
export const GEMINI_API_KEY_HINT = "AIza…";

// Gemini's published limits: 1,048,576 input tokens, 65,536 output, uniform
// across every 3.x and 2.5 model in Google's catalog (ai.google.dev, 2026-09-01).
const GEMINI_CTX = 1_048_576;
// The non-Gemini models the Antigravity catalog also serves. These are their
// vendors' published windows, not something measured through `agy`, and they
// only feed the context gauge.
const CLAUDE_CTX = 200_000;
const OSS_CTX = 128_000;

/**
 * The model list, taken verbatim from `agy models` on a signed-in host
 * (2026-09-02). Two things about it drive the rest of this file:
 *
 *  - REASONING EFFORT IS PART OF THE SLUG. There is no bare `gemini-3.8-flash`;
 *    the catalog ships `-high` / `-medium` / `-low` variants, and `gemini-3.1-pro`
 *    has only `-high` and `-low` (no medium). So this driver offers no separate
 *    reasoning picker — see reasoningOptions below.
 *  - THE CATALOG IS NOT GEMINI-ONLY. An Antigravity subscription also serves
 *    Anthropic and open-weights models. They are listed because they genuinely
 *    run; their cost is estimated the same way everything else here is.
 *
 * Re-check with `agy models` when bumping the pinned CLI; a slug that has been
 * retired upstream fails the whole turn.
 */
const MODELS: AgentCapabilities["models"] = [
  { value: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", sub: "newest flash model, deepest reasoning (default)", contextWindow: GEMINI_CTX, group: "Gemini 3.8" },
  { value: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", sub: "balanced reasoning", contextWindow: GEMINI_CTX, group: "Gemini 3.8" },
  { value: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", sub: "fastest, least reasoning", contextWindow: GEMINI_CTX, group: "Gemini 3.8" },
  { value: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", sub: "previous flash generation", contextWindow: GEMINI_CTX, group: "Gemini 3.7" },
  { value: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)", sub: "balanced reasoning", contextWindow: GEMINI_CTX, group: "Gemini 3.7" },
  { value: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)", sub: "fastest, least reasoning", contextWindow: GEMINI_CTX, group: "Gemini 3.7" },
  { value: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)", sub: "older flash generation", contextWindow: GEMINI_CTX, group: "Gemini 3.6" },
  { value: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)", sub: "balanced reasoning", contextWindow: GEMINI_CTX, group: "Gemini 3.6" },
  { value: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)", sub: "fastest, least reasoning", contextWindow: GEMINI_CTX, group: "Gemini 3.6" },
  { value: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)", sub: "the pro model, deepest reasoning", contextWindow: GEMINI_CTX, group: "Gemini Pro" },
  { value: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", sub: "the pro model, faster", contextWindow: GEMINI_CTX, group: "Gemini Pro" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", sub: "served through your Antigravity subscription", contextWindow: CLAUDE_CTX, group: "Other providers" },
  { value: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", sub: "served through your Antigravity subscription", contextWindow: CLAUDE_CTX, group: "Other providers" },
  { value: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", sub: "open-weights model", contextWindow: OSS_CTX, group: "Other providers" },
];

export const GEMINI_CAPABILITIES: AgentCapabilities = {
  models: MODELS,
  // Empty on purpose, and not an oversight. `agy` does have an `--effort` flag,
  // but its catalog already sells effort as part of the model id
  // ("gemini-3.8-flash-high"), so a second picker would either contradict the
  // model the user chose or silently do nothing. Choosing the model IS choosing
  // the effort on this agent.
  reasoningOptions: [],
  // Only the modes with a real `agy` analog, and only the ones that can actually
  // complete work. In the CLI's DEFAULT mode ("request-review") a headless run
  // has nobody to prompt, so every tool is auto-denied and the turn ends having
  // done nothing — measured: a run asking for one shell command produced
  // "no output produced — a tool required the "command" permission that headless
  // mode cannot prompt for, so it was auto-denied". That mode is therefore not
  // offered rather than offered-and-broken; the same judgement the Codex
  // descriptor makes about its unreachable approval policies.
  permissionModes: [
    { value: "bypassPermissions", label: "skip permissions", sub: "auto-approve every tool: runs without asking (default)" },
    { value: "acceptEdits", label: "accept-edits", sub: "auto-approve file edits, still ask for other tools" },
    { value: "plan", label: "plan", sub: "propose without editing" },
  ],
  // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
  // /answer route are shared with Claude's AskUserQuestion flow).
  supportsAsks: true,
  // Calandria's suggest_task / expose_service tools reach the agent through the
  // portable stdio MCP bridge (scripts/calandria-mcp.mjs), mounted per task via
  // a private HOME — see lib/agents/gemini/home.ts.
  supportsMcpTools: true,
  // ...and ONLY those. The CLI reads MCP servers from exactly one user-global
  // file, and the driver replaces that file per task to give the bridge its own
  // CALANDRIA_TASK_ID. That substitution is what makes parallel tasks possible,
  // and it necessarily hides whatever the user configured globally.
  inheritsUserMcpServers: false,
  userMcpServersNote:
    "The MCP servers in your ~/.gemini/config/mcp_config.json are not mounted. " +
    "Antigravity reads MCP config from that one global file, so each task is given its own copy " +
    "containing only Calandria's bridge — that is what lets tasks run in parallel without " +
    "stealing each other's identity.",
  // The hosted-gateway selection (projects.gateway_mcp) is a separate mount
  // from the note above, with its own caveat: the CLI's policy engine splits a
  // tool name on the first underscore after `mcp_`, so an alias with an
  // underscore would break a wildcard rule for it (lib/gatewayMcp.ts,
  // slugifyGatewayAliasForGemini).
  gatewayMcpNote:
    "Hosted LiteLLM-gateway MCP server aliases are mounted with underscores turned to hyphens: " +
    "Antigravity's policy engine splits a tool name on the first underscore after \"mcp_\", so an " +
    "alias with one would break a wildcard permission rule for it.",
  // Each turn is one `agy -p` process with no held-open input channel and no
  // task-notification wake, so backgrounded shell commands die with it.
  backgroundTasksLinger: false,
  // The CLI ships invoke_subagent / define_subagent and reports delegated work
  // as subagent_info with its own conversation_id (./events.ts renders it).
  dispatchesSubagents: true,
  // `result.usage` reports token counts only — no dollar figure of any kind —
  // so the cost the driver emits is an estimate (tokens × Google's published
  // API prices for the resolved model, ./pricing.ts) and the UI labels it ~.
  reportsCostUsd: false,
  costIsEstimated: true,
  // The CLI emits no per-request context figure, so the gauge is the usage
  // heuristic, labelled as such. (`result.usage` accumulates over the whole
  // conversation, which is spend, not occupancy — see ./events.ts.)
  reportsContext: false,
  supportsResume: true,
  apiKeyHint: GEMINI_API_KEY_HINT,
  loginStyle: "paste_code",
  // Google's redirect lands on antigravity.google/oauth-callback rather than a
  // localhost port, and that page completes the sign-in for the CLI waiting on
  // it. So the code box is one of two ways this login can finish, and the card
  // has to watch for the other (see AgentCapabilities.loginCompletesOutOfBand).
  loginCompletesOutOfBand: true,
  // The container caveat, stated where the sign-in is offered rather than only
  // in the docs: `agy` stores its OAuth token in the OS keyring over D-Bus and
  // has no file fallback, and the published image ships no D-Bus session, so
  // this button cannot work there.
  connectHint:
    "In a container, the subscription sign-in can't complete: the Antigravity CLI keeps its " +
    "token in the OS keyring (D-Bus Secret Service) and the published image runs no keyring " +
    "daemon. Use an API key there (GEMINI_API_KEY, or the tab above), which bills Google's API " +
    "rather than your subscription.",
};
