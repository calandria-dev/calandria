// Codex's capability descriptor — what the agent can do, as data (rendered
// into the UI's pickers via GET /api/agents). Split out of driver.ts so it can
// be read without importing @openai/codex-sdk (an async external under
// Turbopack — see lib/agents/capabilities.ts). Null model = inherit codex's
// built-in default (see DEFAULT_CODEX_MODEL in ./pricing).

import type { AgentCapabilities } from "../types";
import { codexApiKey } from "./auth";

// Every current preset runs the same 272k window, so unlike Claude there's no
// per-model variation here — but keep it per-entry anyway: this descriptor is
// what drives the context gauge, and a future preset may differ.
const CTX = 272_000;

export const CODEX_CAPABILITIES: AgentCapabilities = {
  // Mirrors the codex CLI's own model preset table (what its `/model` menu
  // lists), NOT a hand-picked subset: values are the presets' `slug`s, ordered
  // by their `priority`. "Previous versions" are the presets the CLI tags with
  // an `upgrade` target — still selectable, and worth offering for the same
  // reason Claude pins older versions, but not what a new task should default
  // to. Groups must stay contiguous: the picker opens a new section whenever
  // `group` changes (SessionView.tsx). Re-check this list when bumping
  // @openai/codex — the codex model line moves faster than Claude's, and a
  // stale entry here is a model the CLI no longer accepts.
  models: [
    { value: "gpt-5.5", label: "GPT-5.5", sub: "frontier coding, research, and real-world work", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.4", label: "GPT-5.4", sub: "strong model for everyday coding", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", sub: "small, fast, and cost-efficient", contextWindow: CTX, group: "Latest" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", sub: "previous coding-optimized model", contextWindow: CTX, group: "Previous versions" },
    { value: "gpt-5.2", label: "GPT-5.2", sub: "previous model for long-running agents", contextWindow: CTX, group: "Previous versions" },
  ],
  // Off/Think/Think hard/Ultrathink → codex's model_reasoning_effort scale
  // (low/medium/high/xhigh — see EFFORT in ./driver.ts). Codex can't disable
  // reasoning ("minimal" 400s the turn), so "Off" is its floor, "low"; the
  // subs name the actual effort each preset sends so the picker stays honest.
  reasoningOptions: [
    { value: "off", label: "Off", sub: "low effort — codex's minimum" },
    { value: "think", label: "Think", sub: "medium effort (codex default)" },
    { value: "think_hard", label: "Think hard", sub: "high effort" },
    { value: "ultrathink", label: "Ultrathink", sub: "extra-high effort" },
  ],
  // Only the modes with a real codex analog are declared. bypassPermissions maps
  // to workspace-write + approvals-never (auto-run); plan maps to a read-only
  // sandbox. acceptEdits has no distinct codex analog (writes already auto-apply)
  // and on-request approvals can't be answered non-interactively, so neither is
  // offered — both fall back to bypassPermissions.
  permissionModes: [
    { value: "bypassPermissions", label: "Auto-run", sub: "workspace write, no approvals (default)" },
    { value: "plan", label: "Plan mode", sub: "read-only, propose without editing" },
  ],
  // Interactive asks arrive via the MCP bridge's ask_user tool (the card UI and
  // /answer route are shared with Claude's AskUserQuestion flow).
  supportsAsks: true,
  // The orchestrator's suggest_task / expose_service tools reach Codex through
  // the portable stdio MCP bridge (scripts/orch-mcp.mjs), registered per turn
  // by the driver — the same tools the Claude driver mounts in-process.
  supportsMcpTools: true,
  // ChatGPT-plan auth reports tokens only — no billed dollar figure — so the
  // cost the driver emits is an estimate (tokens × published API prices for
  // the resolved model). The descriptor stays honest: reportsCostUsd=false,
  // and costIsEstimated=true has the UI show the figure with an ~.
  reportsCostUsd: false,
  costIsEstimated: true,
  supportsResume: true,
  apiKeyHint: codexApiKey.hint,
  loginStyle: "device_code",
};
