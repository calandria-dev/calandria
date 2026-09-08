// Client-side helpers over the agents capability bundle (GET /api/agents).
// Every run control and label the UI shows is derived from this data instead
// of hardcoded per agent, so adding a driver server-side surfaces in the UI
// with no client edits. Pure functions (no React) so any module can import them.
import type { AgentsBundle, AgentInfo, AgentCapabilities } from "./types";

export function findAgent(bundle: AgentsBundle, id: string | null | undefined): AgentInfo | undefined {
  return bundle.agents.find((a) => a.id === id);
}

// The human name for an agent id, e.g. "Claude Code" / "Codex". Falls back to
// the raw id (or a generic "Agent") so a task carrying an unknown/legacy id
// still labels sensibly.
export function agentLabel(bundle: AgentsBundle, id: string | null | undefined): string {
  return findAgent(bundle, id)?.label || id || "Agent";
}

// The capability descriptor for a task's agent: drives its model/reasoning/
// permission pickers and feature gates (asks, cost display). Undefined until
// the bundle loads or for an unknown id; callers treat undefined as "no data yet".
export function capsFor(bundle: AgentsBundle, id: string | null | undefined): AgentCapabilities | undefined {
  return findAgent(bundle, id)?.capabilities;
}

// The agent a new task should default to: the project's default, else the app
// default, but only when that agent is actually connected. Otherwise falls to
// the first connected agent (a Codex-only instance must not default new tasks
// to an unconnected Claude), and only when nothing is connected falls back to
// mere existence so the picker still renders, with its connect CTA.
export function defaultAgentFor(bundle: AgentsBundle, projectDefault: string | null | undefined): string {
  const want = findAgent(bundle, projectDefault || bundle.default);
  if (want?.authenticated) return want.id;
  const connected = bundle.agents.find((a) => a.authenticated);
  return connected?.id ?? want?.id ?? bundle.agents[0]?.id ?? bundle.default;
}

// Which agents an agent picker may offer: the connected ones, since a button
// that can't run a session is a dead end. Two exceptions, both about not
// stranding the user:
//   - `value` itself, when it names an agent that isn't connected: an old
//     Codex task in Edit, a project default that was since signed out. Hiding
//     it would leave the picker with nothing selected and no Connect CTA.
//   - nothing connected at all, where every entry is dead and filtering would
//     empty the picker; the CTA needs the picker rendered to show it.
// The selected-but-unconnected entry sorts last, after the runnable ones.
export function pickerAgents(bundle: AgentsBundle, value: string | null | undefined): AgentInfo[] {
  const connected = bundle.agents.filter((a) => a.authenticated);
  if (connected.length === 0) return bundle.agents;
  const sel = findAgent(bundle, value);
  return sel && !sel.authenticated ? [...connected, sel] : connected;
}

// Whether an agent picker has a choice to offer, over the entries it would
// actually render. False when only one agent is registered, or when the offer
// is a single agent that `value` already names. True whenever `value` is not
// that lone connected agent (the user needs the picker to move off it, or its
// Connect CTA), and when nothing is connected at all.
//
// Reads pickerAgents() instead of counting the bundle directly, so the two
// stay in sync as more drivers ship.
export function agentPickerNeeded(bundle: AgentsBundle, value: string | null | undefined): boolean {
  if (bundle.agents.length <= 1) return false;
  const offered = pickerAgents(bundle, value);
  if (offered.length <= 1 && offered[0]?.id === value) return false;
  return true;
}
