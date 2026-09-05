// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Null model = inherit codex's
// built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import type { AgentCapabilities } from "../types";
import { CODEX_INHERIT_MCP, CODEX_TRANSPORT } from "../../config";
import { codexApiKey } from "./auth";
import { codexContextWindow, codexDefaultModel } from "./catalog";
import { DEFAULT_CODEX_MODEL } from "./pricing";

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

// Which entry the picker marks "(default)". The word used to be typed into one
// model's `sub`, which was only ever true for the account the line was written
// on: the default is per account, ranked by the catalog's `priority` and
// overridden outright by config.toml's top-level `model`, so an account whose
// catalog ranks a different model first was told Sol was the default while
// every model-less turn ran the other one. ./catalog.ts already resolves it —
// cached, fail-soft, and the same answer resolveCodexModel() gives a real turn.
//
// A slug outside this list marks NOTHING. config.toml can name any model and a
// catalog can rank one this picker doesn't offer; falling back to marking a
// listed entry would restate the bug in a slower way.
const markDefault = (models: AgentCapabilities["models"]): AgentCapabilities["models"] => {
  const resolved = codexDefaultModel(DEFAULT_CODEX_MODEL);
  return models.map((m) => (m.value === resolved ? { ...m, sub: `${m.sub} (default)` } : m));
};

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
    // The five cross-agent keys, each mapped to its nearest Codex analog in
    // ./policy.ts (the sandbox, the approval policy, who answers, and the
    // writable roots). Labels are Codex's own words for the sandbox and the
    // approval policy — a Codex user knows them from ~/.codex/config.toml —
    // and the values stay the keys tasks, runbooks and schedules persist.
    //
    // The asking modes are real on the app-server transport (CODEX_TRANSPORT,
    // the default): the server's approval requests come back over JSON-RPC and
    // park on the same permission card Claude's canUseTool gate uses. The old
    // exec transport auto-rejects them inside the CLI, so under it they run
    // like acceptEdits; ./policy.ts is where that is decided.
    permissionModes: [
      { value: "auto", label: "auto-review", sub: "workspace-write sandbox, escalations decided by Codex's own reviewer (default)", unattended: true },
      { value: "default", label: "on-request", sub: "workspace-write sandbox, escalations ask you on a permission card" },
      { value: "acceptEdits", label: "workspace-write", sub: "writable sandbox, never asks: what the sandbox refuses just fails" },
      { value: "bypassPermissions", label: "danger-full-access", sub: "no sandbox, never asks" },
      { value: "plan", label: "read-only", sub: "read-only sandbox: propose without editing" },
    ],
    // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
    // /answer route are shared with Claude's AskUserQuestion flow).
    supportsAsks: true,
    // Calandria's suggest_task / expose_service tools reach Codex through
    // the portable stdio MCP bridge (scripts/calandria-mcp.mjs), registered per turn
    // by the driver — the same tools the Claude driver mounts in-process.
    supportsMcpTools: true,
    // …and, by default, the MCP servers from the user's own ~/.codex/config.toml
    // as well, the way a Claude task gets ~/.claude's. CODEX_INHERIT_MCP=0
    // unmounts them per-server (lib/agents/codex/mcp.ts). This flag tracks the
    // env rather than being a flat `true`: Settings renders it verbatim, and a
    // hardcoded yes would tell the user who opted out the opposite of what
    // their own turns do.
    inheritsUserMcpServers: CODEX_INHERIT_MCP,
    userMcpServersNote: CODEX_INHERIT_MCP
      ? "The MCP servers in your ~/.codex/config.toml are mounted alongside Calandria's bridge. Set CODEX_INHERIT_MCP=0 to keep them off task sessions."
      : "Unmounted because CODEX_INHERIT_MCP is off: each server in your ~/.codex/config.toml is overridden with enabled = false for task sessions.",
    // The hosted-gateway selection (projects.gateway_mcp) is a separate mount
    // from the flag above, and needs its own caveat: MCP tool calls are gated
    // by Codex's own per-server approval mode, not by approval_policy, and the
    // mount auto-approves them. It's mounted under every mode but "plan", which
    // runs read-only and would offer tools that contradict it
    // (lib/agents/codex/driver.ts).
    gatewayMcpNote:
      "Hosted LiteLLM-gateway MCP servers mount under every permission mode but plan, " +
      "and every tool they offer is auto-approved for the task the moment it mounts.",
    // ChatGPT-plan auth reports tokens only — no billed dollar figure — so the
    // cost the driver emits is an estimate (tokens × published API prices for
    // the resolved model). The descriptor stays honest: reportsCostUsd=false,
    // Each turn is one codex process (app-server or exec) with no held-open
    // input channel and no task-notification wake, so backgrounded shell
    // commands die with it —
    // buildProjectContext warns Codex turns off them (lib/agents/shared.ts).
    backgroundTasksLinger: false,
    // A codex turn has no subagent verb we dispatch — a turn is one model loop — so the
    // delegation block buildProjectContext appends for Claude is omitted rather
    // than pointing a Codex turn at a tool that isn't there.
    dispatchesSubagents: false,
    // and costIsEstimated=true has the UI show the figure with an ~.
    reportsCostUsd: false,
    costIsEstimated: true,
    // The app-server transport reports the last request's prompt size on every
    // usage update (lib/agents/codex/appServerEvents.ts), so the gauge is real
    // there; exec's turn.completed reports the THREAD's running totals and
    // nothing per request, so under it the gauge is the usage heuristic,
    // labelled as such.
    reportsContext: CODEX_TRANSPORT === "app-server",
    supportsResume: true,
    apiKeyHint: codexApiKey.hint,
    loginStyle: "device_code",
    loginCompletesOutOfBand: false,
    connectHint: null,
  };
}
