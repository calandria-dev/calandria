// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Null model = inherit codex's
// built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import type { AgentCapabilities } from "../types";
import { CODEX_INHERIT_MCP } from "../../config";
import { codexApiKey } from "./auth";
import { codexContextWindow } from "./catalog";

// The window when ~/.codex can't answer: no catalog on disk (a fresh install, a
// container with nothing mounted) or a shape we don't recognise. It is the
// SERVED default every 0.153.0 entry carries, so it's also what the CLI's own
// embedded fallback would give.
const CTX_FALLBACK = 272_000;

// Per model, because the window is per model in the file even though every
// current entry reports the same number. ./catalog.ts does the whole
// resolution — catalog window, config.toml's `model_context_window` override,
// the `max_context_window` ceiling, and the compaction percentage that makes
// the usable window ~5% smaller than the nominal one.
//
// A descriptor that reads the disk is why this is a FUNCTION rather than the
// const it used to be: the window is per account and per config, so a value
// frozen at module load would be the same hardcoded number under a new name.
// claudeCapabilities() is the same shape for the same reason.
const ctx = (slug: string) => codexContextWindow(slug, CTX_FALLBACK);

export function codexCapabilities(): AgentCapabilities {
  return {
    // Tracks the codex CLI's model line, ordered newest-first. "Previous
    // versions" are still-live older models — selectable for the same reason
    // Claude pins older versions, but not what a new task should default to.
    // Groups must stay contiguous: the picker opens a new section whenever
    // `group` changes (SessionView.tsx).
    //
    // Re-check this list when bumping @openai/codex-sdk; the codex model line
    // moves faster than Claude's, and a stale entry here is a model that 400s the
    // whole turn. Two traps when you do:
    //   - The `{"models":[…]}` catalog embedded in the CLI binary is a stale
    //     FALLBACK, not the truth. The live catalog is fetched at startup and can
    //     both drop models the embedded one lists and keep ones it marks retired.
    //   - Availability is per auth mode. We run on ChatGPT-plan login, and that
    //     account type refuses models the API tier still serves.
    // So verify empirically, on a ChatGPT login:
    //   codex exec --model <slug> "reply with the single word ok"
    // Checked that way against codex-cli 0.146.0: gpt-5.2 and gpt-5.3-codex now
    // 400 with "not supported when using Codex with a ChatGPT account" (both were
    // listed here before), while gpt-5.4 / gpt-5.4-mini still run despite the
    // embedded catalog flagging them for migration to Terra / Luna.
    //
    // gpt-6-astra (released 2026-09-03) was verified that way on codex-cli
    // 0.153.0 before being listed here: it answers on a ChatGPT-plan login, while
    // the bare `gpt-6` alias 400s with the familiar "not supported when using
    // Codex with a ChatGPT account" — so only the full slug belongs in this list.
    // Astra also sets a CLI FLOOR, which is why the @openai/codex-sdk pin moved
    // with this entry. The reasonable-sounding guess — that the embedded catalog
    // is only a stale fallback, so an older CLI would still fetch Astra's real
    // metadata per account — was tested and is wrong. On 0.146.0 an Astra turn
    // warns "Defaulting to fallback metadata; this can degrade performance and
    // cause issues" AND then fails outright with "model requires a newer version
    // of codex". So the model line is not purely server-side: a new model can
    // need CLI support, and offering one the pinned binary can't run is the
    // stale-entry failure from the other direction. When adding a model here,
    // verify on the version this repo PINS, not just on whatever is installed
    // locally — and if it needs a newer one, move `@openai/codex-sdk` in
    // package.json and CODEX_VERSION in the Dockerfile together, since the SDK
    // exact-pins the CLI it speaks JSONL to.
    models: [
      { value: "gpt-6-astra", label: "GPT-6 Astra", sub: "most capable model for complex, demanding work", contextWindow: ctx("gpt-6-astra"), group: "Latest" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", sub: "latest frontier agentic coding model (default)", contextWindow: ctx("gpt-5.6-sol"), group: "Latest" },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", sub: "balanced agentic coding for everyday work", contextWindow: ctx("gpt-5.6-terra"), group: "Latest" },
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", sub: "fast and affordable agentic coding", contextWindow: ctx("gpt-5.6-luna"), group: "Latest" },
      { value: "gpt-5.5", label: "GPT-5.5", sub: "previous frontier coding and research model", contextWindow: ctx("gpt-5.5"), group: "Previous versions" },
      { value: "gpt-5.4", label: "GPT-5.4", sub: "strong model for everyday coding", contextWindow: ctx("gpt-5.4"), group: "Previous versions" },
      { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", sub: "small, fast, and cost-efficient", contextWindow: ctx("gpt-5.4-mini"), group: "Previous versions" },
    ],
    // Labeled with codex's own model_reasoning_effort scale (low/medium/high/
    // xhigh — exactly what EFFORT in ./driver.ts sends), not Claude's think/
    // think hard/ultrathink vocabulary: a Codex user knows these names from
    // ~/.codex/config.toml and the CLI's /model picker. The VALUES stay the
    // cross-agent preset keys ("off"/"think"/…) because that's what tasks,
    // schedules and app defaults persist — only the words shown are OpenAI's.
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
    // offered — both fall back to bypassPermissions.
    //
    // Claude's prompted modes now park on a real permission card (lib/permissions.ts,
    // reached through canUseTool). Codex has no equivalent hook: `codex exec` decides
    // approvals inside the CLI process and the SDK gives the host no callback to
    // intercept them with, so raising CODEX_APPROVAL_POLICY above "never" would
    // stall turns invisibly. The ask_user MCP bridge is the plausible route if that
    // changes — it already carries an interactive question out to the same card UI
    // and /answer route, and a permission prompt is the same park-and-resume shape.
    // What's missing is the CLI side: something that routes an approval request to
    // an MCP tool call instead of a terminal prompt. Until then, leave this alone.
    //
    // Labels are codex's own sandbox-mode names (sandbox_mode in
    // ~/.codex/config.toml): what distinguishes the two offered modes IS the
    // sandbox, and the approval-policy half is named in the sub with OpenAI's
    // spelling ("never" — on-request/on-failure/untrusted are the unreachable
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
    // the portable stdio MCP bridge (scripts/calandria-mcp.mjs), registered per turn
    // by the driver — the same tools the Claude driver mounts in-process.
    supportsMcpTools: true,
    // …but ONLY those. Unlike a Claude task, a Codex task does not get the MCP
    // servers from the user's own ~/.codex/config.toml: `codex exec` has no
    // approver, so their tools are offered to the model and every call comes
    // straight back as "user cancelled MCP tool call". The driver unmounts them
    // rather than dangle tools that can't work (lib/agents/codex/mcp.ts, and
    // CODEX_INHERIT_MCP in lib/config.ts to opt back in). This flag exists so the
    // asymmetry is visible as data instead of buried in a driver.
    //
    // It tracks the escape hatch rather than being a flat `false`: with the env
    // var set the driver really does mount the user's servers, and Settings
    // renders this flag verbatim — a hardcoded false would tell that user the
    // opposite of what their own turns do.
    inheritsUserMcpServers: CODEX_INHERIT_MCP,
    userMcpServersNote: CODEX_INHERIT_MCP
      ? "Mounted because CODEX_INHERIT_MCP is set. Their tools only work on servers where you've set default_tools_approval_mode = \"approve\". codex exec has nobody to ask."
      : "The MCP servers in your ~/.codex/config.toml are unmounted: codex exec can't approve their tool calls, so every one comes back cancelled. Set CODEX_INHERIT_MCP=1 to mount them anyway.",
    // ChatGPT-plan auth reports tokens only — no billed dollar figure — so the
    // cost the driver emits is an estimate (tokens × published API prices for
    // the resolved model). The descriptor stays honest: reportsCostUsd=false,
    // Each turn is a `codex exec` process with no held-open input channel and no
    // task-notification wake, so backgrounded shell commands die with it —
    // buildProjectContext warns Codex turns off them (lib/agents/shared.ts).
    backgroundTasksLinger: false,
    // `codex exec` has no subagent verb — a turn is one model loop — so the
    // delegation block buildProjectContext appends for Claude is omitted rather
    // than pointing a Codex turn at a tool that isn't there.
    dispatchesSubagents: false,
    // and costIsEstimated=true has the UI show the figure with an ~.
    reportsCostUsd: false,
    costIsEstimated: true,
    // turn.completed reports the THREAD's running totals and nothing per
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
