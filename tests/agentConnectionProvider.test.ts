import { describe, expect, it, beforeEach, afterEach } from "vitest";

// Pins that a Claude connection is verified against one backend (Anthropic,
// Vertex, Bedrock), and that a record no longer matching the CLI's current
// backend reads as not connected, is dropped, and raises the same
// instance-wide flag a dead login raises (lib/agents/connections.ts). Issue
// #38. tests/setup.ts pins CLAUDE_CONFIG_DIR to an empty dir and unsets the
// provider flags, so the process env alone decides what configuredProvider()
// reports here.

import { setSetting, getSetting } from "../lib/store";
import {
  setAgentConnection,
  getAgentConnection,
  isAgentConnected,
  getAgentAuthBroken,
  clearAgentAuthBroken,
  currentConnectionProvider,
} from "../lib/agents/connections";
import { subscribeGlobal } from "../lib/events";
import type { AgentAuthEvent } from "../lib/types";

function resetSettings() {
  for (const key of ["agent_conn_claude", "agent_conn_codex", "onboarding_method", "onboarding_account"]) {
    setSetting(key, null);
  }
  clearAgentAuthBroken("claude");
  clearAgentAuthBroken("codex");
}

const FLAGS = ["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE"] as const;
function useProvider(p: "anthropic" | "vertex" | "bedrock") {
  for (const f of FLAGS) delete process.env[f];
  if (p === "vertex") process.env.CLAUDE_CODE_USE_VERTEX = "1";
  if (p === "bedrock") process.env.CLAUDE_CODE_USE_BEDROCK = "1";
}

const connect = (id: string) => setAgentConnection(id, { method: "subscription", email: "a@b.c", plan: "Max" });

/** Collect every agent_auth event the bus fans out while `fn` runs. */
function captureAuthEvents(fn: () => void): AgentAuthEvent[] {
  const seen: AgentAuthEvent[] = [];
  const unsub = subscribeGlobal((_taskId, ev) => {
    if (ev.type === "agent_auth") seen.push(ev);
  });
  try {
    fn();
  } finally {
    unsub();
  }
  return seen;
}

describe("agent connection provider (issue #38)", () => {
  beforeEach(() => {
    resetSettings();
    useProvider("anthropic");
  });
  afterEach(() => useProvider("anthropic"));

  it("stamps the CLI's current provider on a fresh record and reads it back", () => {
    useProvider("vertex");
    expect(currentConnectionProvider("claude")).toBe("vertex");
    connect("claude");
    expect(getSetting("agent_conn_claude")).toBe("subscription|a@b.c|Max|vertex");
    expect(getAgentConnection("claude")).toEqual({ method: "subscription", email: "a@b.c", plan: "Max", provider: "vertex" });
    // Same provider on the next read: the record is left alone.
    expect(isAgentConnected("claude")).toBe(true);
    expect(getAgentAuthBroken("claude")).toBeNull();
  });

  it("reads a row written before the field existed as an Anthropic connection", () => {
    setSetting("agent_conn_claude", "subscription|a@b.c|Max");
    expect(getAgentConnection("claude")).toEqual({ method: "subscription", email: "a@b.c", plan: "Max", provider: "anthropic" });
    expect(isAgentConnected("claude")).toBe(true);
    // Still intact and unflagged: an instance that never left Anthropic is untouched.
    expect(getSetting("agent_conn_claude")).toBe("subscription|a@b.c|Max");
    expect(getAgentAuthBroken("claude")).toBeNull();
  });

  it("drops a record verified against a provider the CLI no longer routes through, and tells every tab once", () => {
    connect("claude");
    expect(isAgentConnected("claude")).toBe(true);

    useProvider("vertex");
    const events = captureAuthEvents(() => {
      expect(isAgentConnected("claude")).toBe(false);
    });

    // The record is gone, since it proves nothing about Vertex, and the
    // dead-login flag names both backends so the banner and the connect card
    // say why.
    expect(getSetting("agent_conn_claude")).toBeNull();
    const broken = getAgentAuthBroken("claude");
    expect(broken).not.toBeNull();
    expect(broken!.reason).toMatch(/verified against Anthropic/);
    expect(broken!.reason).toMatch(/configured for Vertex AI/);

    // Exactly the event the runner publishes for a dead login.
    expect(events).toEqual([{ type: "agent_auth", agent: "claude", broken: true, reason: broken!.reason }]);

    // Re-reads (every GET /api/agents) raise no second announcement.
    const again = captureAuthEvents(() => {
      expect(isAgentConnected("claude")).toBe(false);
      expect(getAgentConnection("claude")).toBeNull();
    });
    expect(again).toEqual([]);
  });

  it("treats a pre-field row as Anthropic, so a later switch to Bedrock invalidates it", () => {
    setSetting("agent_conn_claude", "api_key||API");
    useProvider("bedrock");
    expect(isAgentConnected("claude")).toBe(false);
    expect(getSetting("agent_conn_claude")).toBeNull();
    expect(getAgentAuthBroken("claude")?.reason).toMatch(/configured for Amazon Bedrock/);
  });

  it("invalidates a legacy onboarding-only record the same way, without re-announcing on every read", () => {
    setSetting("onboarding_method", "subscription");
    setSetting("onboarding_account", "a@b.c|Max");
    expect(isAgentConnected("claude")).toBe(true);

    useProvider("vertex");
    const first = captureAuthEvents(() => expect(isAgentConnected("claude")).toBe(false));
    expect(first).toHaveLength(1);
    // Nothing to delete on this path, so the flag is what keeps it idempotent.
    const second = captureAuthEvents(() => expect(isAgentConnected("claude")).toBe(false));
    expect(second).toEqual([]);
    expect(getAgentAuthBroken("claude")).not.toBeNull();
    // The wizard's own record is not ours to touch.
    expect(getSetting("onboarding_method")).toBe("subscription");
  });

  it("reconnecting under the new provider heals the flag and stamps the new provider", () => {
    connect("claude");
    useProvider("vertex");
    expect(isAgentConnected("claude")).toBe(false);
    expect(getAgentAuthBroken("claude")).not.toBeNull();

    connect("claude");
    expect(getAgentConnection("claude")?.provider).toBe("vertex");
    expect(isAgentConnected("claude")).toBe(true);
    expect(getAgentAuthBroken("claude")).toBeNull();
  });

  it("an agent with no provider concept stores none and never mismatches", () => {
    connect("codex");
    expect(getSetting("agent_conn_codex")).toBe("subscription|a@b.c|Max|");
    expect(getAgentConnection("codex")?.provider).toBeNull();
    useProvider("vertex");
    expect(isAgentConnected("codex")).toBe(true);
    expect(getAgentAuthBroken("codex")).toBeNull();
  });
});
