// Codex's capability descriptor: what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack, see lib/agents/capabilities.ts). A null model means inherit
// codex's built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import type { AgentCapabilities } from "../types";
import { CODEX_INHERIT_MCP } from "../../config";
import { codexApiKey } from "./auth";
import { codexContextWindow, codexDefaultModel } from "./catalog";
import { DEFAULT_CODEX_MODEL } from "./pricing";

// The window when ~/.codex can't answer: no catalog on disk (a fresh install,
// a container with nothing mounted) or a shape this doesn't recognise. It is
// the served default every current catalog entry carries, so it's also what
// the CLI's own embedded fallback would give.
const CTX_FALLBACK = 272_000;

// Per model, because the window is per model in the file even though every
// current entry reports the same number. ./catalog.ts does the whole
// resolution: catalog window, config.toml's `model_context_window` override,
// the `max_context_window` ceiling, and the compaction percentage that makes
// the usable window smaller than the nominal one.
//
// This is a function rather than a constant because the window is per account
// and per config: a value frozen at module load would be the same hardcoded
// number under a new name. claudeCapabilities() is the same shape for the
// same reason.
const ctx = (slug: string) => codexContextWindow(slug, CTX_FALLBACK);

// Which entry the picker marks "(default)". The default is per account,
// ranked by the catalog's `priority` and overridden outright by config.toml's
// top-level `model`, so an account whose catalog ranks a different model
// first must not be told a fixed model is the default while every model-less
// turn actually runs the other one. ./catalog.ts resolves it: cached,
// fail-soft, and the same answer resolveCodexModel() gives a real turn.
//
// A slug outside this list marks nothing. config.toml can name any model and
// a catalog can rank one this picker doesn't offer; falling back to marking a
// listed entry would restate the bug in a slower way.
const markDefault = (models: AgentCapabilities["models"]): AgentCapabilities["models"] => {
  const resolved = codexDefaultModel(DEFAULT_CODEX_MODEL);
  return models.map((m) => (m.value === resolved ? { ...m, sub: `${m.sub} (default)` } : m));
};

export function codexCapabilities(): AgentCapabilities {
  return {
    // Tracks the codex CLI's model line, newest first. "Previous versions" are
    // still-live older models: selectable, but not what a new task should
    // default to. Groups must stay contiguous: the picker opens a new section
    // whenever `group` changes (SessionView.tsx).
    //
    // Re-check this list when bumping @openai/codex-sdk: a stale entry here is
    // a model that 400s the whole turn. The catalog embedded in the CLI binary
    // is a stale fallback, not the truth; the live catalog fetched at startup
    // can both drop models it lists and keep ones it marks retired, and
    // availability is per auth mode (a ChatGPT-plan login refuses some models
    // the API tier still serves). Verify empirically, on a ChatGPT login:
    //   codex exec --model <slug> "reply with the single word ok"
    // A new model can also need CLI support beyond what the catalog implies:
    // an unsupported slug can warn "Defaulting to fallback metadata" and then
    // fail with "model requires a newer version of codex", setting a CLI
    // floor. Verify on the version this repo pins rather than whatever is
    // installed locally, and if it needs a newer one, bump
    // `@openai/codex-sdk` in package.json and CODEX_VERSION in the Dockerfile
    // together, since the SDK exact-pins the CLI it speaks JSONL to.
    models: markDefault([
      { value: "gpt-6-astra", label: "GPT-6 Astra", sub: "most capable model for complex, demanding work", contextWindow: ctx("gpt-6-astra"), group: "Latest" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", sub: "latest frontier agentic coding model", contextWindow: ctx("gpt-5.6-sol"), group: "Latest" },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", sub: "balanced agentic coding for everyday work", contextWindow: ctx("gpt-5.6-terra"), group: "Latest" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", sub: "fast and affordable agentic coding", contextWindow: ctx("gpt-5.6-luna"), group: "Latest" },
      { value: "gpt-5.5", label: "GPT-5.5", sub: "previous frontier coding and research model", contextWindow: ctx("gpt-5.5"), group: "Previous versions" },
      { value: "gpt-5.4", label: "GPT-5.4", sub: "strong model for everyday coding", contextWindow: ctx("gpt-5.4"), group: "Previous versions" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", sub: "small, fast, and cost-efficient", contextWindow: ctx("gpt-5.4-mini"), group: "Previous versions" },
    ]),
    // Labeled with codex's own model_reasoning_effort scale (low/medium/high/
    // xhigh, exactly what EFFORT in ./driver.ts sends), not Claude's think/
    // think hard/ultrathink vocabulary: a Codex user knows these names from
    // ~/.codex/config.toml and the CLI's /model picker. The values stay the
    // cross-agent preset keys ("off"/"think"/…) because that's what tasks,
    // schedules and app defaults persist; only the words shown are OpenAI's.
    // Codex can't disable reasoning ("minimal" 400s an agentic turn), so "low"
    // is its floor and there is no off entry to fake. The 5.6 family also
    // accepts "max" and "ultra" above xhigh; the shared preset vocabulary tops
    // out at ultrathink, so those aren't reachable yet.
    reasoningOptions: [
      { value: "off", label: "low", sub: "codex's minimum, reasoning can't be turned off" },
      { value: "think", label: "medium", sub: "codex's default effort" },
      { value: "think_hard", label: "high", sub: "deeper reasoning" },
      { value: "ultrathink", label: "xhigh", sub: "extra-high, the most this picker can send" },
    ],
    // Only the modes with a real codex analog are declared. bypassPermissions maps
    // to workspace-write + approvals-never (auto-run); plan maps to a read-only
    // sandbox. acceptEdits has no distinct codex analog (writes already auto-apply)
    // and on-request approvals can't be answered non-interactively, so neither is
    // offered; both fall back to bypassPermissions.
    //
    // Claude's prompted modes park on a real permission card (lib/permissions.ts,
    // reached through canUseTool). Codex has no equivalent hook: `codex exec`
    // decides approvals inside the CLI process and the SDK gives the host no
    // callback to intercept them with, so raising CODEX_APPROVAL_POLICY above
    // "never" would stall turns invisibly. The ask_user MCP bridge is the
    // plausible route if that changes: it already carries an interactive
    // question out to the same card UI and /answer route, and a permission
    // prompt is the same park-and-resume shape. What's missing is the CLI
    // side: something that routes an approval request to an MCP tool call
    // instead of a terminal prompt.
    //
    // Labels are codex's own sandbox-mode names (sandbox_mode in
    // ~/.codex/config.toml): the sandbox is what distinguishes the two offered
    // modes, and the approval-policy half is named in the sub with OpenAI's
    // spelling ("never"; on-request/on-failure/untrusted are the unreachable
    // ones per the note above). The values stay the cross-agent keys tasks and
    // schedules persist.
    permissionModes: [
      { value: "bypassPermissions", label: "workspace-write", sub: "writable sandbox, approval policy never: runs without asking (default)" },
      { value: "plan", label: "read-only", sub: "read-only sandbox: propose without editing" },
    ],
    // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
    // /answer route are shared with Claude's AskUserQuestion flow).
    supportsAsks: true,
    // Calandria's suggest_task / expose_service tools reach Codex through
    // the portable stdio MCP bridge (scripts/calandria-mcp.mjs), registered per
    // turn by the driver: the same tools the Claude driver mounts in-process.
    supportsMcpTools: true,
    // Only those, though. Unlike a Claude task, a Codex task does not get the
    // MCP servers from the user's own ~/.codex/config.toml: `codex exec` has
    // no approver, so their tools are offered to the model and every call
    // comes back as "user cancelled MCP tool call". The driver unmounts them
    // rather than dangle tools that can't work (lib/agents/codex/mcp.ts, and
    // CODEX_INHERIT_MCP in lib/config.ts to opt back in). This flag exists so
    // the asymmetry is visible as data instead of buried in a driver.
    //
    // It tracks the escape hatch rather than being a flat `false`: with the env
    // var set the driver really does mount the user's servers, and Settings
    // renders this flag verbatim; a hardcoded false would tell that user the
    // opposite of what their own turns do.
    inheritsUserMcpServers: CODEX_INHERIT_MCP,
    userMcpServersNote: CODEX_INHERIT_MCP
      ? "Mounted because CODEX_INHERIT_MCP is set. Their tools only work on servers where you've set default_tools_approval_mode = \"approve\". codex exec has nobody to ask."
      : "The MCP servers in your ~/.codex/config.toml are unmounted: codex exec can't approve their tool calls, so every one comes back cancelled. Set CODEX_INHERIT_MCP=1 to mount them anyway.",
    // The hosted-gateway selection (projects.gateway_mcp) is a separate mount
    // from the flag above, and needs its own caveat for the same reason: codex
    // exec has no approver. It's mounted, with every one of its tools
    // auto-approved for the task, only under the bypass-equivalent permission
    // mode; "plan" runs read-only and would offer tools no approver can grant
    // (lib/agents/codex/driver.ts).
    gatewayMcpNote:
      "Hosted LiteLLM-gateway MCP servers mount only under the workspace-write permission mode, " +
      "never plan, and every tool they offer is auto-approved for the task the moment it mounts — " +
      "codex exec has nobody to ask.",
    // ChatGPT-plan auth reports tokens only, with no billed dollar figure, so
    // the cost the driver emits is an estimate (tokens × published API prices
    // for the resolved model). The descriptor stays honest: reportsCostUsd is
    // false, and costIsEstimated true has the UI show the figure with a ~.
    // Each turn is a `codex exec` process with no held-open input channel and no
    // task-notification wake, so backgrounded shell commands die with it;
    // buildProjectContext warns Codex turns off them (lib/agents/shared.ts).
    backgroundTasksLinger: false,
    // `codex exec` has no subagent verb: a turn is one model loop, so the
    // delegation block buildProjectContext appends for Claude is omitted
    // instead of pointing a Codex turn at a tool that isn't there.
    dispatchesSubagents: false,
    reportsCostUsd: false,
    costIsEstimated: true,
    // turn.completed reports the thread's running totals and nothing per
    // request (see lib/agents/types.ts), so the context gauge is the usage
    // heuristic, labelled as such.
    reportsContext: false,
    supportsResume: true,
    apiKeyHint: codexApiKey.hint,
    loginStyle: "device_code",
    loginCompletesOutOfBand: false,
    connectHint: null,
  };
}
