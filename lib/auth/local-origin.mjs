/* Browser boundary for open/local mode.
 *
 * Cloudflare Access mode authenticates every request with a signed JWT. Local
 * mode deliberately has no login, but it still needs a browser boundary:
 * WebSockets are not protected by the same-origin policy, and DNS rebinding can
 * make an attacker's hostname resolve to 127.0.0.1. Since /pty grants a full
 * shell, accepting every Host/Origin pair in "open" mode is not safe.
 *
 * Defaults:
 *   - localhost / *.localhost / 127.0.0.1 / ::1 are allowed on any port;
 *   - PUBLIC_BASE_URL is allowed exactly when configured;
 *   - ORCH_ALLOWED_ORIGINS adds comma-separated, exact http(s) origins for
 *     intentional LAN/reverse-proxy access.
 *
 * This module is plain, Web-API-only ESM so both Next middleware (edge runtime)
 * and the unbundled CommonJS server.js can use the exact same policy.
 */

function normalizeOrigin(value) {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Origins never carry a path/query/hash. Reject rather than silently
    // broadening a mistyped allowlist entry such as https://host/some/path.
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
    ...(env.ORCH_ALLOWED_ORIGINS || "").split(","),
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
 * declare an Origin must be same-origin, and Fetch Metadata gives us a second
 * guard for cross-site requests (including methods that omit Origin).
 *
 * `env` is annotated as a plain record rather than inheriting process.env's
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
