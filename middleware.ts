/* Origin-side auth gate for every HTTP route. The active provider is chosen by
 * env (lib/auth/origin.mjs): open local mode by default, or Cloudflare Access
 * when configured. lib/cf-access.mjs has the threat model; server.js guards the
 * WebSocket side the same way.
 *
 * No `matcher` config: this covers _next assets, public/ files and every API
 * route alike, since a per-user instance is single-user and there is nothing
 * an unauthenticated client should fetch. The JWKS/secret is cached in module
 * scope, so the per-request cost after the first verification is local crypto.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  originAuthEnabled,
  serviceTokenOk,
  instanceServiceTokenOk,
  verifyOriginRequest,
} from "@/lib/auth/origin.mjs";
import {
  localHttpRequestAllowed,
  sameOriginHttpRequestAllowed,
} from "@/lib/auth/local-origin.mjs";

// The non-Access paths: health probes (Docker HEALTHCHECK / monitoring) and
// the build-version stamp present the shared SERVICE_TOKEN instead of an
// Access JWT, and may reach only these routes. VERSION_PATH doubles as the
// health probe target.
const VERSION_PATH = "/api/version";
const USAGE_PATH = "/api/instance/usage";
// The Prometheus scrape target. Same exemption as the two above, since a
// scraper polling from outside the tunnel (or from the host beside the
// container) has no Access JWT to present.
const METRICS_PATH = "/api/instance/metrics";
// The boot-time self-ping from server.js that restores persisted services.
const SERVICES_RESTORE_PATH = "/api/instance/services-restore";
// The boot-time self-ping from server.js that starts the schedule ticker.
// GET reads schedulerHealth() only; POST is what actually starts the ticker.
const SCHEDULER_PATH = "/api/instance/scheduler";
// The shutdown-time self-ping from server.js's SIGTERM/SIGINT handler that
// drains in-flight turns before the process exits.
const DRAIN_PATH = "/api/instance/drain";

// Read-only: the fleet-wide CALANDRIA_FLEET_TOKEN is honored here (see
// cf-access.mjs) because nothing reachable this way can mutate instance state.
function isReadOnlyServiceTokenPath(pathname: string, method: string): boolean {
  if (pathname === VERSION_PATH || pathname === USAGE_PATH || pathname === METRICS_PATH) {
    return true;
  }
  return pathname === SCHEDULER_PATH && method === "GET";
}

// Mutates instance state while authenticating with the service-token header
// instead of an Access JWT: services-restore always, the scheduler path's own
// POST (starts the ticker), and drain (aborts every live turn). These demand
// the strict per-instance token; the fleet-wide read token must be rejected
// here, same invariant as the agent-tools paths below.
function isInstanceOnlyServiceTokenPath(pathname: string): boolean {
  return pathname === SERVICES_RESTORE_PATH || pathname === SCHEDULER_PATH || pathname === DRAIN_PATH;
}

// The internal endpoints the stdio MCP bridge (scripts/calandria-mcp.mjs)
// proxies agent tool calls to. No Access JWT exists in that server-to-server
// call, so it presents the per-instance SERVICE_TOKEN instead. These mutate,
// so they demand the strict instance token, never the read-only fleet token.
// See cf-access.mjs.
const AGENT_TOOLS_PREFIX = "/api/internal/agent-tools/";
function isAgentToolPath(pathname: string): boolean {
  return pathname.startsWith(AGENT_TOOLS_PREFIX);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Local mode has no login, but it is not an unbounded browser trust zone:
  // restrict Host to loopback/configured origins (DNS-rebinding defense),
  // reject cross-site Fetch Metadata, and require any supplied Origin to
  // match Host. Raw local clients such as curl, health checks and the MCP
  // bridge omit the browser headers and stay supported as long as their Host
  // is allowed.
  if (!originAuthEnabled()) {
    return localHttpRequestAllowed({
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      secFetchSite: req.headers.get("sec-fetch-site"),
    })
      ? NextResponse.next()
      : new NextResponse("Forbidden: local origin not allowed.\n", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
  }

  // Access mode: the JWT proves who, never whether they meant it.
  // `CF_Authorization` is SameSite=None, so the edge stamps a valid assertion
  // onto a request a hostile page made the victim's browser send. Reject a
  // cross-origin browser caller before any of the auth paths below, using the
  // narrow Origin-vs-Host rule rather than local mode's, so a cross-site link
  // to the instance still opens. See the audit in lib/auth/local-origin.mjs
  // for what is reachable without it.
  if (!sameOriginHttpRequestAllowed({
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
  })) {
    return new NextResponse("Forbidden: cross-origin request.\n", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }

  if (
    isReadOnlyServiceTokenPath(pathname, req.method) &&
    serviceTokenOk(req.headers.get("x-service-token"))
  ) {
    return NextResponse.next();
  }

  if (
    isInstanceOnlyServiceTokenPath(pathname) &&
    instanceServiceTokenOk(req.headers.get("x-service-token"))
  ) {
    return NextResponse.next();
  }

  // The internal agent-tool endpoints authenticate with the instance
  // SERVICE_TOKEN (no Access JWT exists in that server-to-server call). They
  // mutate, so they demand the strict per-instance token, reject the
  // read-only fleet token, and never fall through to the JWT verify below.
  if (isAgentToolPath(pathname)) {
    return instanceServiceTokenOk(req.headers.get("x-service-token"))
      ? NextResponse.next()
      : new NextResponse("Forbidden.\n", { status: 403, headers: { "content-type": "text/plain" } });
  }

  try {
    await verifyOriginRequest(req);
    return NextResponse.next();
  } catch {
    // A real user behind the active provider always carries a valid credential;
    // landing here means the request skipped it. Deny flatly: no redirect that
    // would leak the team domain.
    return new NextResponse("Forbidden: authentication required.\n", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
}
