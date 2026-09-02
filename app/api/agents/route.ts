import { NextResponse } from "next/server";
import { listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { getSetting } from "@/lib/store";
import { getAgentConnection, getAgentAuthBroken } from "@/lib/agents/connections";
import { resolveUtilityAgent } from "@/lib/agents/oneshots";
import { LOCAL_MODEL_BASE_URL } from "@/lib/config";
import { endpointModels, summarizeEndpoint } from "@/lib/modelEndpoint";

export const dynamic = "force-dynamic";

// Every registered agent driver's capability descriptor + its persisted
// connection state, so the client can render the model/reasoning/permission
// pickers, gate per-agent features (asks, cost display), and gray out / show a
// "Connect" CTA for agents that aren't wired up yet — all from data, with no
// hardcoded per-agent lists in the UI. Connection state is read from the
// settings record (lib/agents/connections.ts), written on a successful login /
// verify / api-key save, rather than shelling out to every agent's CLI on each
// page load. `authenticated` mirrors `connected` for the run-control pickers.
export async function GET() {
  // Is anything actually listening at the instance's local endpoint, and how
  // many models does it have? An agent's `connected` above is its CLI LOGIN,
  // which says nothing about a local server: a project on Ollama runs fine with
  // a "connected" Claude whose login is irrelevant, and fails with a perfectly
  // healthy login when Ollama isn't up. So the two states are reported
  // separately. Cached (lib/modelEndpoint.ts) and time-boxed, because every tab
  // loads this route.
  const local = summarizeEndpoint(await endpointModels(LOCAL_MODEL_BASE_URL));
  return NextResponse.json({
    // The app-level default agent (Settings → Run defaults) is the client's
    // ultimate fallback when a project hasn't set its own; unset → the built-in.
    default: getSetting("default_agent") || DEFAULT_AGENT,
    // The agent that will actually run project-scoped internal jobs (recaps,
    // "Refresh with AI"), resolved connected-first server-side so Settings can
    // show the EFFECTIVE choice — and flag it as a fallback when the configured
    // agent isn't connected. `id: null` means nothing is connected at all.
    utility: resolveUtilityAgent(),
    // Where the "Local model" preset in a project's settings points by default
    // (CALANDRIA_LOCAL_MODEL_BASE_URL). The client can't read the env, and the
    // preset must write the instance's answer, not the form's guess.
    local_base_url: LOCAL_MODEL_BASE_URL,
    // …and whether that endpoint answered just now.
    local_endpoint: local,
    agents: listDrivers().map((d) => {
      const conn = getAgentConnection(d.id);
      // Effective-credential overlay (issue #4): the settings record says how
      // the user CONNECTED, but a live API key (persisted 0600 file, or env via
      // the CALANDRIA_ALLOW_API_KEY_ENV opt-in) is what turns actually bill — it
      // outranks a stored subscription login, so report it, not the record.
      const keyed = !!d.apiKey?.has();
      return {
        id: d.id,
        label: d.label,
        capabilities: d.capabilities,
        connected: keyed || !!conn,
        authenticated: keyed || !!conn,
        account: keyed
          ? { email: null, plan: "API", method: "api_key" as const }
          : conn
            ? { email: conn.email, plan: conn.plan, method: conn.method }
            : null,
        // Connected on record, but its credentials died in flight (expired OAuth
        // session, revoked key) — set by the runner when a turn fails on auth
        // (lib/authFailure.ts) and cleared by the next successful turn or
        // reconnect. Drives the titlebar reconnect banner; a tab that missed the
        // live event picks it up here on load / SSE reconnect.
        authBroken: getAgentAuthBroken(d.id),
      };
    }),
  });
}
