import { renderMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/**
 * Prometheus scrape target: turn counters, live turns, DB and worktree
 * footprint, schedule-run outcomes. lib/metrics.ts holds the series; this
 * file is only the transport.
 *
 * Auth is the same read-only service-token exemption /api/version and
 * /api/instance/usage take (middleware.ts): under Cloudflare Access a scraper
 * has no JWT, so it presents SERVICE_TOKEN, or the fleet-wide
 * CALANDRIA_FLEET_TOKEN, one secret for a dashboard polling every box. In
 * no-login local mode the ordinary origin rules apply and a loopback scrape
 * needs nothing.
 *
 * Kept SDK-free and pinned by tests/importGraph.test.ts: a metrics endpoint is
 * exactly the sort of route that gets a "which agents are configured?" series
 * bolted on later, and reaching lib/agents/registry.ts for it would drag both
 * agent SDKs into a sync-compiled route entry. lib/agents/capabilities.ts has
 * the same data without them.
 *
 * `Cache-Control: no-store` keeps a proxy-cached scrape from reading as a
 * healthy idle instance when the service is actually down.
 */
export async function GET() {
  try {
    return new Response(await renderMetrics(), {
      headers: {
        // The version the exposition format's own spec names, and what
        // Prometheus sends in its scrape Accept header.
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    // Not the JSON shape lib/apiGuard.ts produces: the caller here is a
    // scraper that asked for text, and Next's HTML error page would be
    // logged by Prometheus as a parse failure with no clue what broke. Plain
    // text with the message, at a status that marks the scrape down.
    console.error("[metrics] scrape failed:", e);
    return new Response(`# scrape failed: ${e instanceof Error ? e.message : String(e)}\n`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
