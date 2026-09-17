// SDK-free capability lookup, the piece of the driver registry that low-level
// modules may import.
//
// The agent SDKs (@anthropic-ai/claude-agent-sdk, @openai/codex-sdk) are
// serverExternalPackages, which Turbopack emits as async externals, and
// async-ness propagates to every transitive importer. A module compiled async
// but imported from a non-async route entry gets a Promise instead of its
// namespace, and every export reads back undefined at runtime. lib/store.ts
// only needs the drivers' capability data (context windows), so that data
// lives here, importable without dragging a single SDK into the graph.
//
// Nothing in this file's import graph may reach a driver module or an agent
// SDK. tests/importGraph.test.ts pins this.

import type { AgentCapabilities } from "./types";
import { contextWindowFor } from "@/lib/contextWindow";
import { claudeCapabilities } from "./claude/capabilities";
import { codexCapabilities } from "./codex/capabilities";
import { GEMINI_CAPABILITIES } from "./gemini/capabilities";
import { MOCK_CAPABILITIES } from "./mock/capabilities";

export const DEFAULT_AGENT = "claude";

// These are thunks, not constants. Claude's descriptor depends on which
// backend the instance routes through (lib/agents/claude/provider.ts), and
// Codex's on the account catalog and config.toml under ~/.codex; both are read
// from disk at run time. Agents whose descriptor is static just return theirs.
const CAPABILITIES: Record<string, () => AgentCapabilities> = {
  claude: () => claudeCapabilities(),
  codex: () => codexCapabilities(),
  gemini: () => GEMINI_CAPABILITIES,
};

// The deterministic e2e agent, under the same env gate registry.ts uses. This
// file backs listAgentIds()/isAgentId(), so a driver registered only in
// registry.ts would be connectable but invisible to every id-level lookup:
// firstConnectedAgent() would skip it, and completeOnboarding() would find
// nothing to adopt on a mock-only first run. Read at import time like the rest
// of this module; the env is set before the server boots (e2e/env.ts).
if (process.env.CALANDRIA_E2E_MOCK_AGENT === "1") CAPABILITIES.mock = () => MOCK_CAPABILITIES;

/** Every registered agent id, in registry order. The SDK-free half of
 * listDrivers(), for callers that only need to enumerate or validate ids
 * (connection state, connected-first resolution) rather than drive an agent. */
export function listAgentIds(): string[] {
  return Object.keys(CAPABILITIES);
}

/** Whether `id` is a registered agent. The SDK-free getDriverStrict() null check. */
export function isAgentId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/** Capability descriptor by agent id. Unknown or null ids fall back to the
 * default agent, the same forgiving resolution as getDriver: a hand-edited
 * tasks.agent row should still resolve to something. */
export function getCapabilities(id: string | null | undefined): AgentCapabilities {
  const read = (id && CAPABILITIES[id]) || CAPABILITIES[DEFAULT_AGENT];
  return read();
}

// Context window for an (agent, model) pair, read from the capability
// descriptor (models[].contextWindow), so each agent's models report their own
// window with no per-agent table here. The miss policy (widest for an
// inherited model, narrowest for an unknown id) lives in lib/contextWindow.ts,
// shared with app/shell/format.ts (contextWindowOf) so the live SSE update
// matches the server.
export function modelContextWindow(agent: string | null | undefined, model: string | null | undefined): number {
  return contextWindowFor(getCapabilities(agent).models, model);
}
