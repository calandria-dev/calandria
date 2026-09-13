import { NextResponse } from "next/server";
import { listDrivers, DEFAULT_AGENT } from "@/lib/agents/registry";
import { getSetting } from "@/lib/store";
import { getAgentConnection, getAgentAuthBroken, getAgentSandboxBroken } from "@/lib/agents/connections";
import { resolveUtilityAgent } from "@/lib/agents/oneshots";
import { endpointModels, summarizeEndpoint } from "@/lib/modelEndpoint";
import { gatewayHealth } from "@/lib/gatewayHealth";
import { ensureClaudeModelIds } from "@/lib/agents/claude/modelProbe";
import { claudeCapabilities } from "@/lib/agents/claude/capabilities";
import { gatewayModelCatalog } from "@/lib/gatewayModels";
import { geminiGatewayModelCheck, lastGeminiGatewayModelCheck } from "@/lib/agents/gemini/gatewayCheck";
import { detectAgentInstallation } from "@/lib/agents/detect";
import { listProviders } from "@/lib/providers/store";
import { presentProvider } from "@/lib/providers/present";
import { litellmRuntimeFor, localProviderBaseUrl } from "@/lib/providers/resolve";

export const dynamic = "force-dynamic";

// Every registered agent driver's capability descriptor plus its persisted
// connection state, so the client can render the model/reasoning/permission
// pickers, gate per-agent features (asks, cost display), and gray out or show
// a "Connect" CTA for agents that aren't wired up yet, all from data with no
// hardcoded per-agent lists in the UI. Connection state is read from the
// settings record (lib/agents/connections.ts), written on a successful login,
// verify or api-key save. Installation detection checks the filesystem and
// reads `--version` through a per-binary cache. `authenticated` mirrors
// `connected` for the run-control pickers.
export async function GET() {
  const gatewayRuntime = litellmRuntimeFor();
  const gatewayUrl = gatewayRuntime?.baseUrl ?? null;
  const gatewayKeyValue = gatewayRuntime?.key ?? "";
  const localBaseUrl = localProviderBaseUrl();
  // Is anything actually listening at the instance's local endpoint, and how
  // many models does it have? An agent's `connected` above is its CLI LOGIN,
  // which says nothing about a local server: a project on Ollama runs fine with
  // a "connected" Claude whose login is irrelevant, and fails with a perfectly
  // healthy login when Ollama isn't up. So the two states are reported
  // separately. Cached (lib/modelEndpoint.ts) and time-boxed, because every tab
  // loads this route.
  const local = localBaseUrl
    ? summarizeEndpoint(await endpointModels(localBaseUrl))
    : { reachable: false, models: 0 };
  // The same question for the LiteLLM gateway, and only when one is configured:
  // an instance with no LiteLLM provider row has no gateway preset, no
  // health card and nothing to probe, so it pays nothing for this route.
  const gateway = gatewayUrl ? await gatewayHealth(gatewayUrl, gatewayKeyValue) : null;
  // What Claude's family aliases resolve to, for the picker's subtitles. Not
  // awaited and not on the boot path: the sweep is several CLI spawns, so it
  // runs detached and lands in the descriptor for a later read of this same
  // route. Cheap after the first time: at most one `claude --version` per
  // minute, and none once this CLI's answer is cached.
  ensureClaudeModelIds();
  // The gateway's own model catalog, same reason: not awaited, so a slow proxy
  // never slows this route down, and it's what claudeCapabilities()'s gateway
  // branch and lib/gatewayPricing.ts's rate table read on their next call.
  // gatewayHealth() above already hits /model/info too, but only for a count;
  // this is the full parse, cached separately (lib/gatewayModels.ts).
  if (gatewayUrl) void gatewayModelCatalog(gatewayUrl, gatewayKeyValue);
  // Whether the gateway's catalog covers what `agy` needs. This is a real CLI
  // spawn, so it's fired the same way and read from whatever the last one found
  // (lib/agents/gemini/gatewayCheck.ts). Harmless when Antigravity isn't
  // connected or isn't installed: agyModelSlugs() returns null and the field
  // stays null instead of claiming every model is missing.
  if (gatewayUrl) void geminiGatewayModelCheck(gatewayUrl, gatewayKeyValue);
  const providers = listProviders().map(presentProvider);
  return NextResponse.json({
    // The app-level default agent (Settings → Run defaults) is the client's
    // ultimate fallback when a project hasn't set its own; unset → the built-in.
    default: getSetting("default_agent") || DEFAULT_AGENT,
    // The agent that will actually run project-scoped internal jobs (recaps,
    // "Refresh with AI"), resolved connected-first server-side so Settings can
    // show the effective choice, and flag it as a fallback when the configured
    // agent isn't connected. `id: null` means nothing is connected at all.
    utility: resolveUtilityAgent(),
    // The oldest configured local provider remains available to the legacy
    // health card until the Models settings surface replaces it.
    local_base_url: localBaseUrl,
    // …and whether that endpoint answered just now.
    local_endpoint: local,
    // The LiteLLM gateway's address, which the settings form needs to offer the
    // Gateway preset at all (null hides it), and what it answered just now. The
    // KEY is never on this wire: only whether one is configured, so the card can
    // say "set a key" without ever being a way to read it.
    gateway_base_url: gatewayUrl,
    // Whether the LiteLLM provider has an admin key. The key itself is never sent;
    // this just says whether minting a per-task key is possible at all
    // (docs/AGENTS.md, "Per-task virtual keys"), so the project settings form
    // can show the max_budget/duration fields only when they'd do something.
    gateway_keys_enabled: !!gatewayRuntime?.adminKey,
    // Whether the project settings picker should offer hosted MCP servers at
    // all (docs/AGENTS.md, "Hosted MCP servers"): the provider's MCP flag on and
    // a gateway actually configured, mirroring gateway_keys_enabled's "would
    // this do anything" gate.
    gateway_mcp_enabled: !!gatewayRuntime?.mcp && !!gatewayUrl,
    gateway: gateway
      ? { ...gateway, gemini_missing_models: gatewayUrl ? (lastGeminiGatewayModelCheck(gatewayUrl)?.missing ?? null) : null }
      : gateway,
    agents: listDrivers().map((d) => {
      const conn = getAgentConnection(d.id);
      // Effective-credential overlay (issue #4): the settings record says how
      // the user connected, but a live API key (persisted 0600 file, or env via
      // the CALANDRIA_ALLOW_API_KEY_ENV opt-in) is what turns actually bill. It
      // outranks a stored subscription login, so the route reports the live key.
      const keyed = !!d.apiKey?.has();
      const connected = keyed || !!conn;
      const installation = detectAgentInstallation(d.id);
      const capabilities = d.id === "claude" && gatewayUrl
        ? claudeCapabilities({ ...process.env, ANTHROPIC_BASE_URL: gatewayUrl }, gatewayUrl)
        : d.capabilities;
      return {
        id: d.id,
        label: d.label,
        capabilities,
        connected,
        authenticated: connected,
        status: connected ? "connected" as const : installation.installed ? "installed" as const : "absent" as const,
        installedVersion: installation.installedVersion,
        bundledProvider: capabilities.bundledProvider,
        providerTypes: capabilities.providerTypes,
        endpointTransport: capabilities.endpointTransport,
        providers: providers
          .filter((provider) => capabilities.providerTypes.includes(provider.type))
          .map(({ id, label, type, status }) => ({ id, label, type, status })),
        account: keyed
          ? { email: null, plan: "API", method: "api_key" as const }
          : conn
            ? { email: conn.email, plan: conn.plan, method: conn.method }
            : null,
        // Connected on record, but its credentials died in flight (expired OAuth
        // session, revoked key). Set by the runner when a turn fails on auth
        // (lib/authFailure.ts) and cleared by the next successful turn or
        // reconnect. Drives the titlebar reconnect banner; a tab that missed the
        // live event picks it up here on load or SSE reconnect.
        authBroken: getAgentAuthBroken(d.id),
        // The login is fine and the agent's own SANDBOX is not, so every
        // sandboxed turn would fail every command it ran. Recorded at connect
        // time and from a turn's own startup warnings, never probed here: this
        // route runs on every page load and the check is a process spawn
        // (lib/agents/codex/sandbox.ts). Drives the card's warning, and the
        // driver refuses the affected modes rather than running them.
        sandboxBroken: getAgentSandboxBroken(d.id),
      };
    }),
  });
}
