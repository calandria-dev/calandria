// The mock agent's capability descriptor, split out from driver.ts for the same
// reason claude/ and codex/ split theirs: lib/agents/capabilities.ts must be
// able to enumerate this agent's id WITHOUT importing a driver module (see the
// header there and tests/importGraph.test.ts). The driver imports this back, so
// there is still exactly one definition.
//
// Registered only when CALANDRIA_E2E_MOCK_AGENT=1, matching registry.ts.

import type { AgentCapabilities } from "../types";

export const MOCK_CAPABILITIES: AgentCapabilities = {
  models: [{ value: "mock-1", label: "Mock 1", sub: "deterministic", contextWindow: 200_000 }],
  reasoningOptions: [],
  permissionModes: [],
  supportsAsks: false,
  supportsMcpTools: true,
  // Hermetic by construction: the mock agent reads no user configuration at all.
  inheritsUserMcpServers: false,
  userMcpServersNote: null,
  gatewayMcpNote: null,
  backgroundTasksLinger: false,
  dispatchesSubagents: false,
  reportsCostUsd: false,
  costIsEstimated: false,
  reportsContext: true,
  supportsResume: true,
  apiKeyHint: null,
  loginStyle: "paste_code",
  loginCompletesOutOfBand: false,
  connectHint: null,
};
