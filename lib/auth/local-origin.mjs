/* Browser boundary rules. Both auth modes need one, but different rules,
 * which is what this file keeps straight.
 *
 * Local mode (no login):
 * - The origin boundary is the whole security gate, since there is no login
 *   underneath it.
 * - WebSockets are not protected by the same-origin policy, and DNS
 *   rebinding can make an attacker's hostname resolve to 127.0.0.1; since
 *   /pty grants a full shell, accepting every Host/Origin pair is not safe.
 * - `localHttpRequestAllowed` / `localWebSocketRequestAllowed` pin the
 *   TARGET to a known-good host: localhost / *.localhost / 127.0.0.1 / ::1
 *   on any port; PUBLIC_BASE_URL when configured; and
 *   CALANDRIA_ALLOWED_ORIGINS for comma-separated, exact http(s) origins
 *   (intentional LAN/reverse-proxy access).
 * - The HTTP rule also rejects `Sec-Fetch-Site: cross-site`, which would
 *   otherwise break an ordinary cross-site top-level navigation (a link
 *   from an email or a wiki); safe here because nobody links to localhost.
 *
 * Cloudflare Access mode (JWT):
 * - Every request carries a signed JWT, so a target-host allowlist is
 *   neither necessary (a rebound hostname produces no valid assertion) nor
 *   knowable (the tunnel hostname is whatever the operator configured, and
 *   PUBLIC_BASE_URL is optional).
 * - Identity is not the same property as intent: `CF_Authorization` is
 *   `SameSite=None` by default, so a hostile page can open a cross-site
 *   WebSocket, the victim's browser attaches the cookie, the edge injects a
 *   valid assertion, and a JWT-only gate hands that page a shell. Hence
 *   `sameOriginWebSocketRequestAllowed`, the same-origin half the JWT
 *   doesn't cover.
 * - The same gap applies to plain HTTP, covered by
 *   `sameOriginHttpRequestAllowed`. CORS does not close it:
 *   `Request.json()` ignores Content-Type, and `text/plain` is
 *   CORS-safelisted, so a `no-cors` fetch with `content-type: text/plain`
 *   reaches every JSON route with no preflight. Many mutating routes
 *   (`/merge`, `/abort`, `/clear`, `/pr`, `/sync`, …) also ignore the body
 *   and act on the path alone, so even a bodyless form post reaches them,
 *   and `multipart/form-data` uploads are safelisted too. The reachable
 *   write surface includes `POST /api/tasks/[id]/messages`, handing an
 *   arbitrary instruction to an agent that may be running in
 *   `bypassPermissions`. Non-simple methods (PUT/PATCH/DELETE) still always
 *   preflight.
 * - The HTTP rule is narrower than local mode's: it rejects only when an
 *   Origin header is present and does not match Host, and does not reject
 *   `Sec-Fetch-Site: cross-site`, since cross-site navigations send no
 *   Origin and a tunnel hostname is exactly the kind of thing people link to.
 *
 * This module is plain, Web-API-only ESM so Next middleware (edge runtime),
 * the unbundled CommonJS server.js, and the pty sidecar can share the exact
 * same policy.
 */
import { readEnv } from "../env.mjs";

function normalizeOrigin(value) {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Origins never carry a path/query/hash. Reject a mistyped allowlist
    // entry such as https://host/some/path instead of broadening it.
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function hostnameFromHost(host) {
  if (!host) return null;
  try {
    // URL handles bracketed IPv6 and ports correctly. The scheme is irrelevant.
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function configuredOrigins(env) {
  const values = [
    env.PUBLIC_BASE_URL || "",
    ...(readEnv("CALANDRIA_ALLOWED_ORIGINS", env) || "").split(","),
  ];
  return new Set(values.map((value) => normalizeOrigin(value.trim())).filter(Boolean));
}

function targetAllowed(host, env) {
  const hostname = hostnameFromHost(host);
  if (isLoopbackHostname(hostname)) return true;
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  for (const origin of configuredOrigins(env)) {
    if (new URL(origin).host.toLowerCase() === normalizedHost) return true;
  }
  return false;
}

function originMatchesTarget(origin, host, env) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const url = new URL(normalized);
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  // Matching the target Host is what enforces same-origin, including the port.
  // Being present in the allowlist alone must not authorize a request aimed at
  // a different Host header.
  if (url.host.toLowerCase() !== normalizedHost) return false;
  if (isLoopbackHostname(url.hostname.toLowerCase())) return true;
  return configuredOrigins(env).has(normalized);
}

/**
 * Local HTTP requests may omit Origin when they come from curl, the MCP bridge,
 * health checks, or a top-level browser navigation. Browser requests that DO
 * declare an Origin must be same-origin, and Fetch Metadata is a second guard
 * for cross-site requests, including methods that omit Origin.
 *
 * `env` is annotated as a plain record instead of process.env's
 * NodeJS.ProcessEnv type: only two keys are ever read, and tests pass small
 * literals. Without this, strict tsc rejects every `{}` a test hands in for
 * missing NODE_ENV.
 *
 * @param {{host?: string|null, origin?: string|null, secFetchSite?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function localHttpRequestAllowed(
  { host, origin, secFetchSite },
  env = process.env,
) {
  if (!targetAllowed(host, env)) return false;
  if (String(secFetchSite || "").toLowerCase() === "cross-site") return false;
  return origin ? originMatchesTarget(origin, host, env) : true;
}

/**
 * A browser WebSocket handshake always includes Origin, so require it. This is
 * stricter than HTTP because /pty is an interactive shell and WebSockets are
 * not blocked by the browser's normal same-origin read protections.
 *
 * @param {{host?: string|null, origin?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function localWebSocketRequestAllowed({ host, origin }, env = process.env) {
  return targetAllowed(host, env) && originMatchesTarget(origin, host, env);
}

/* Does a PRESENT Origin belong to this instance? No target-host allowlist: in
 * Access mode the app is reached on whatever hostname the operator's tunnel
 * uses, PUBLIC_BASE_URL is genuinely optional, and the rebinding attack the
 * allowlist defends against cannot produce a valid assertion anyway.
 *
 * `configuredOrigins` is still honoured as the escape hatch for a proxy that
 * REWRITES Host (Cloudflare Tunnel's `httpHostHeader`, say): the browser's
 * Origin is then the public hostname while Host is the internal one, so the
 * operator names the public origin in PUBLIC_BASE_URL and it matches there. */
function originIsOurs(origin, host, env) {
  const normalized = normalizeOrigin(origin);
  // Also the `Origin: null` case (sandboxed iframe, cross-origin redirected
  // POST): opaque, so it can never be shown to be ours.
  if (!normalized) return false;
  const normalizedHost = String(host || "").toLowerCase().replace(/\.$/, "");
  if (new URL(normalized).host.toLowerCase() === normalizedHost) return true;
  return configuredOrigins(env).has(normalized);
}

/**
 * The WebSocket boundary for AUTHENTICATED (Cloudflare Access) mode, applied on
 * top of the JWT; see the module header for why the JWT alone is not enough.
 *
 * Origin must be PRESENT and must be ours. A browser WebSocket handshake always
 * sends one, so absence is not a case worth accommodating here, unlike the
 * HTTP rule below, which has navigations and raw clients to think about.
 *
 * @param {{host?: string|null, origin?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function sameOriginWebSocketRequestAllowed({ host, origin }, env = process.env) {
  return originIsOurs(origin, host, env);
}

/**
 * The HTTP boundary for AUTHENTICATED (Cloudflare Access) mode, applied on top
 * of the JWT. See the module header for the audit behind this and for why the
 * rule stops where it does.
 *
 * Absent Origin is ALLOWED by design: a cross-site top-level navigation (a
 * link from an email) sends no Origin, and neither do curl, health checks or
 * the MCP bridge. Every cross-site vector that can mutate (form post,
 * `no-cors` fetch, `text/plain` JSON) does send one. Do not "harden" this
 * into `localHttpRequestAllowed` by also rejecting
 * `Sec-Fetch-Site: cross-site`; that buys nothing here and breaks the link.
 *
 * @param {{host?: string|null, origin?: string|null}} req
 * @param {Record<string, string|undefined>} [env]
 */
export function sameOriginHttpRequestAllowed({ host, origin }, env = process.env) {
  if (!origin) return true;
  return originIsOurs(origin, host, env);
}

/**
 * Sanitize a user-supplied post-auth redirect down to a path on THIS host.
 *
 * Lives here with the other boundary rules because the obvious version is
 * wrong in two ways that are easy to reintroduce. `startsWith("/") &&
 * !startsWith("//")` looks sufficient, but browsers normalize a backslash to a
 * forward slash in the authority position, so "/\evil.com" is fetched as
 * "//evil.com": a protocol-relative URL to the attacker. They also strip
 * tab/CR/LF from URLs before parsing, so "/\t/evil.com" collapses to
 * "//evil.com" too. Strip the ignorable characters FIRST, then reject anything
 * whose second character can begin an authority.
 *
 * @param {string|null|undefined} raw
 * @returns {string} a safe same-host path, or "/"
 */
export function safeRedirectPath(raw) {
  const s = String(raw || "").replace(/[\t\n\r]/g, "");
  if (!s.startsWith("/")) return "/";
  if (s[1] === "/" || s[1] === "\\") return "/";
  return s;
}

/**
 * Is this socket peer the machine itself?
 *
 * The pty sidecar's own gate, independent of any header. server.js already
 * checks Host/Origin before proxying /pty, but the sidecar spawns a real shell
 * for anyone who completes a handshake, so it must not depend on sitting behind
 * that proxy: a non-loopback PTY_HOST would otherwise be a way around the
 * whole boundary. Headers are attacker-controlled; the peer address is not.
 *
 * Escape hatch for a split app/sidecar deployment: CALANDRIA_PTY_ALLOW_REMOTE=1.
 * Anything that reaches the sidecar gets a shell, so that opt-in means "I have
 * my own network controls".
 *
 * @param {string|null|undefined} remoteAddress
 * @param {Record<string, string|undefined>} [env]
 */
export function isLoopbackPeer(remoteAddress, env = process.env) {
  if (readEnv("CALANDRIA_PTY_ALLOW_REMOTE", env) === "1") return true;
  // Node reports IPv4 peers over a dual-stack socket as ::ffff:127.0.0.1.
  const addr = String(remoteAddress || "").replace(/^::ffff:/, "");
  return addr === "::1" || addr === "127.0.0.1" || addr.startsWith("127.");
}
