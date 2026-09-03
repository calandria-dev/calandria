import { NextResponse } from "next/server";
import { listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { getSetting } from "@/lib/store";
import { getAgentConnection, getAgentAuthBroken } from "@/lib/agents/connections";
import { resolveUtilityAgent } from "@/lib/agents/oneshots";
import { LITELLM_BASE_URL, LOCAL_MODEL_BASE_URL } from "@/lib/config";
import { endpointModels, summarizeEndpoint } from "@/lib/modelEndpoint";
import { gatewayHealth } from "@/lib/gatewayHealth";
import { gatewayKey } from "@/lib/litellm-key";
import { ensureClaudeModelIds } from "@/lib/agents/claude/modelProbe";
import { gatewayModelCatalog } from "@/lib/gatewayModels";
import { geminiGatewayModelCheck, lastGeminiGatewayModelCheck } from "@/lib/agents/gemini/gatewayCheck";

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
  // The same question for the LiteLLM gateway, and only when one is configured:
  // an instance with no CALANDRIA_LITELLM_BASE_URL has no gateway preset, no
  // health card and nothing to probe, so it pays nothing for this route.
  const gateway = LITELLM_BASE_URL ? await gatewayHealth(LITELLM_BASE_URL, gatewayKey()) : null;
  // What Claude's family aliases resolve to, for the picker's subtitles. NOT
  // awaited and deliberately not on the boot path: the sweep is five CLI spawns
  // at ~3.4s each, so it runs detached and lands in the descriptor for a later
  // read of this same route. Cheap after the first time — one `claude --version`
  // per minute at most, and nothing at all once this CLI's answer is cached.
  ensureClaudeModelIds();
  // The gateway's own model catalog, same reason: not awaited, so a slow proxy
  // never slows this route down, and it's what claudeCapabilities()'s gateway
  // branch and lib/gatewayPricing.ts's rate table read on their next call.
  // gatewayHealth() above already hits /model/info too, but only for a count —
  // this is the full parse, cached separately (lib/gatewayModels.ts).
  if (LITELLM_BASE_URL) void gatewayModelCatalog(LITELLM_BASE_URL, gatewayKey());
  // Whether the gateway's catalog covers what `agy` needs — a real CLI spawn,
  // so it's fired the same way and read from whatever the last one found
  // (lib/agents/gemini/gatewayCheck.ts). Harmless when Antigravity isn't
  // connected or isn't installed: agyModelSlugs() returns null and the field
  // stays null rather than claiming every model is missing.
  if (LITELLM_BASE_URL) void geminiGatewayModelCheck(LITELLM_BASE_URL, gatewayKey());
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
    // The LiteLLM gateway's address, which the settings form needs to offer the
    // Gateway preset at all (null hides it), and what it answered just now. The
    // KEY is never on this wire: only whether one is configured, so the card can
    // say "set a key" without ever being a way to read it.
    gateway_base_url: LITELLM_BASE_URL,
    gateway: gateway
      ? { ...gateway, gemini_missing_models: LITELLM_BASE_URL ? (lastGeminiGatewayModelCheck(LITELLM_BASE_URL)?.missing ?? null) : null }
      : gateway,
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
