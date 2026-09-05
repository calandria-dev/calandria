import { describe, expect, it } from "vitest";
import {
  isLoopbackPeer,
  localHttpRequestAllowed,
  localWebSocketRequestAllowed,
  safeRedirectPath,
  sameOriginHttpRequestAllowed,
  sameOriginWebSocketRequestAllowed,
} from "../lib/auth/local-origin.mjs";

const emptyEnv = {};

describe("local origin boundary", () => {
  it("allows ordinary loopback HTTP traffic and non-browser local callers", () => {
    expect(localHttpRequestAllowed(
      { host: "localhost:3000", origin: null, secFetchSite: null },
      emptyEnv,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "127.0.0.1:10001", origin: "http://127.0.0.1:10001", secFetchSite: "same-origin" },
      emptyEnv,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "[::1]:3000", origin: "http://[::1]:3000", secFetchSite: "same-origin" },
      emptyEnv,
    )).toBe(true);
  });

  it("rejects cross-origin and DNS-rebinding-style HTTP requests", () => {
    expect(localHttpRequestAllowed(
      { host: "localhost:3000", origin: "https://evil.example", secFetchSite: "cross-site" },
      emptyEnv,
    )).toBe(false);
    expect(localHttpRequestAllowed(
      { host: "attacker.example", origin: null, secFetchSite: null },
      emptyEnv,
    )).toBe(false);
    // Fetch Metadata is useful defense-in-depth for browser requests that omit
    // Origin (for example, some cross-site GET/navigation shapes).
    expect(localHttpRequestAllowed(
      { host: "localhost:3000", origin: null, secFetchSite: "cross-site" },
      emptyEnv,
    )).toBe(false);
  });

  it("requires a same-origin browser Origin for WebSocket upgrades", () => {
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: "http://localhost:3000" },
      emptyEnv,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: "https://evil.example" },
      emptyEnv,
    )).toBe(false);
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: null },
      emptyEnv,
    )).toBe(false);
    // Ports are part of an origin; another localhost service is not trusted.
    expect(localWebSocketRequestAllowed(
      { host: "localhost:3000", origin: "http://localhost:4173" },
      emptyEnv,
    )).toBe(false);
  });

  it("trusts PUBLIC_BASE_URL exactly for reverse-proxied deployments", () => {
    const env = { PUBLIC_BASE_URL: "https://calandria.example.com" };
    expect(localWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "https://calandria.example.com" },
      env,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "http://calandria.example.com" },
      env,
    )).toBe(false);
    expect(localHttpRequestAllowed(
      { host: "other.example.com", origin: null, secFetchSite: null },
      env,
    )).toBe(false);
  });

  it("supports explicit comma-separated origins for intentional LAN access", () => {
    const env = {
      CALANDRIA_ALLOWED_ORIGINS: "http://192.168.1.50:3000, https://calandria.internal",
    };
    expect(localWebSocketRequestAllowed(
      { host: "192.168.1.50:3000", origin: "http://192.168.1.50:3000" },
      env,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "calandria.internal", origin: "https://calandria.internal", secFetchSite: "same-origin" },
      env,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "192.168.1.51:3000", origin: "http://192.168.1.51:3000" },
      env,
    )).toBe(false);
  });

  it("ignores malformed or path-bearing allowlist entries", () => {
    const env = {
      CALANDRIA_ALLOWED_ORIGINS: "not-a-url, https://calandria.example.com/path",
    };
    expect(localHttpRequestAllowed(
      { host: "calandria.example.com", origin: "https://calandria.example.com", secFetchSite: "same-origin" },
      env,
    )).toBe(false);
  });
});

/* The WebSocket boundary for Cloudflare Access mode is a different rule from
 * the local one.
 *
 * Too strict: reusing the local rule here puts the tunnel hostname in no
 * allowlist, so the terminal is dead on every Access deployment that leaves
 * PUBLIC_BASE_URL empty, which the docs describe as the normal case.
 * Too loose: dropping the origin check entirely, on the assumption the JWT
 * already proves enough, opens cross-site WebSocket hijacking, because the
 * Access cookie is SameSite=None and the edge stamps a valid assertion on a
 * handshake a hostile page initiated.
 */
describe("authenticated (Access) mode WebSocket origin boundary", () => {
  it("accepts the tunnel hostname with no PUBLIC_BASE_URL configured", () => {
    // This is the documented default Access setup.
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "https://calandria.example.com" },
      emptyEnv,
    )).toBe(true);
    // The local rule, for contrast: it rejects this configuration.
    expect(localWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "https://calandria.example.com" },
      emptyEnv,
    )).toBe(false);
  });

  it("refuses a cross-site handshake even though the JWT would be valid", () => {
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "https://evil.example" },
      emptyEnv,
    )).toBe(false);
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: null },
      emptyEnv,
    )).toBe(false);
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "null" },
      emptyEnv,
    )).toBe(false);
  });

  it("distinguishes scheme and port, both of which are part of an origin", () => {
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com:8443", origin: "https://calandria.example.com" },
      emptyEnv,
    )).toBe(false);
    // Scheme is not carried by Host, so http:// vs https:// on the same
    // host:port is same-origin as far as this check can tell; the tunnel
    // terminates TLS anyway. This pins that asymmetry.
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "http://calandria.example.com" },
      emptyEnv,
    )).toBe(true);
  });

  it("falls back to PUBLIC_BASE_URL when the proxy rewrites Host", () => {
    const env = { PUBLIC_BASE_URL: "https://calandria.example.com" };
    expect(sameOriginWebSocketRequestAllowed(
      { host: "internal-app:3000", origin: "https://calandria.example.com" },
      env,
    )).toBe(true);
    expect(sameOriginWebSocketRequestAllowed(
      { host: "internal-app:3000", origin: "https://evil.example" },
      env,
    )).toBe(false);
  });
});

/* The HTTP half of the Access-mode boundary. The JWT proves identity, not
 * intent, and `CF_Authorization` is SameSite=None, so without this check a
 * hostile page can drive the victim's browser into any mutating route and
 * the edge stamps a valid assertion on it.
 *
 * CORS does not already cover this. `Request.json()` ignores Content-Type
 * while `text/plain` is CORS-safelisted, so every JSON route parses a
 * preflight-free body; many routes also ignore the body and act on the path
 * alone. Both are pinned below as the shapes an attacker actually sends, so
 * deleting the check fails a test naming the attack instead of one that only
 * asserts a boolean.
 *
 * This rule is narrower than localHttpRequestAllowed, for the reason the
 * navigation case below states. Do not converge them.
 */
describe("authenticated (Access) mode HTTP origin boundary", () => {
  it("allows a cross-site top-level navigation — the reason this is not the local rule", () => {
    // Someone clicking a link to the instance from an email or a wiki. The
    // browser sends no Origin; Sec-Fetch-Site IS cross-site, which is exactly
    // what local mode rejects. Rejecting it here would be a real UX regression
    // (people do link to a tunnel hostname; nobody links to localhost).
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com", origin: null },
      emptyEnv,
    )).toBe(true);
    // The local rule, for contrast: applying it here would reject this
    // request.
    expect(localHttpRequestAllowed(
      { host: "calandria.example.com", origin: null, secFetchSite: "cross-site" },
      emptyEnv,
    )).toBe(false);
  });

  it("allows raw non-browser callers that omit Origin", () => {
    // curl, the Docker HEALTHCHECK, and the stdio MCP bridge's server-to-server
    // calls into /api/internal/agent-tools/*.
    expect(sameOriginHttpRequestAllowed({ host: "127.0.0.1:3000", origin: null }, emptyEnv)).toBe(true);
    expect(sameOriginHttpRequestAllowed({ host: "calandria.example.com", origin: undefined }, emptyEnv)).toBe(true);
  });

  it("allows the app's own same-origin XHR", () => {
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com", origin: "https://calandria.example.com" },
      emptyEnv,
    )).toBe(true);
  });

  it("rejects the cross-site form post that needs no preflight", () => {
    // <form method="post" action="https://calandria.example.com/api/tasks/X/merge">
    // The body is ignored by that route, so the form needs no fields at all.
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com", origin: "https://evil.example" },
      emptyEnv,
    )).toBe(false);
  });

  it("rejects the text/plain fetch that smuggles JSON past CORS", () => {
    // fetch("https://calandria.example.com/api/tasks/X/messages", {method:"POST",
    //   mode:"no-cors", credentials:"include",
    //   headers:{"content-type":"text/plain"}, body:'{"text":"…"}'})
    // text/plain is CORS-safelisted so this never preflights, and req.json()
    // parses it regardless of Content-Type. This has the same header shape
    // as above: one Origin check covers every simple-request variant.
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com", origin: "http://localhost:5173" },
      emptyEnv,
    )).toBe(false);
  });

  it("rejects an opaque Origin rather than treating it as absent", () => {
    // A sandboxed iframe or a cross-origin-redirected POST sends "null". It is
    // present-but-unattributable, so it must fall on the reject side of the
    // absent-Origin allowance above.
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com", origin: "null" },
      emptyEnv,
    )).toBe(false);
  });

  it("distinguishes port, and is scheme-blind by construction", () => {
    // Port is part of the comparison: another service on the same host is not us.
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com:3000", origin: "https://calandria.example.com:4173" },
      emptyEnv,
    )).toBe(false);
    // Scheme is not, and cannot be: the Host header carries no scheme, so
    // there is nothing to compare against. This is the same property the
    // WebSocket rule has, and it costs nothing here: for http://<same-host>
    // to be a different origin, an attacker must already own DNS or the
    // network path for the tunnel hostname, which defeats Access itself long
    // before this check matters. An operator who wants the scheme pinned
    // sets PUBLIC_BASE_URL, which is a full origin.
    expect(sameOriginHttpRequestAllowed(
      { host: "calandria.example.com", origin: "http://calandria.example.com" },
      emptyEnv,
    )).toBe(true);
    expect(sameOriginWebSocketRequestAllowed(
      { host: "calandria.example.com", origin: "http://calandria.example.com" },
      emptyEnv,
    )).toBe(true);
  });

  it("falls back to PUBLIC_BASE_URL when the proxy rewrites Host", () => {
    // Same httpHostHeader escape hatch the WebSocket rule has; the two must not
    // disagree about which deployments work.
    const env = { PUBLIC_BASE_URL: "https://calandria.example.com" };
    expect(sameOriginHttpRequestAllowed(
      { host: "internal-app:3000", origin: "https://calandria.example.com" },
      env,
    )).toBe(true);
    expect(sameOriginHttpRequestAllowed(
      { host: "internal-app:3000", origin: "https://evil.example" },
      env,
    )).toBe(false);
  });
});

/* The sidecar's own gate. Headers are attacker-controlled; the peer address
 * is not, so this sits alongside the Origin check instead of replacing it. */
describe("isLoopbackPeer", () => {
  it("accepts the proxy on this machine, including IPv4-over-IPv6 peers", () => {
    expect(isLoopbackPeer("127.0.0.1", {})).toBe(true);
    expect(isLoopbackPeer("::1", {})).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1", {})).toBe(true);
    expect(isLoopbackPeer("127.0.0.53", {})).toBe(true);
  });

  it("rejects someone who found PTY_PORT from the network", () => {
    expect(isLoopbackPeer("192.168.1.20", {})).toBe(false);
    expect(isLoopbackPeer("10.0.0.5", {})).toBe(false);
    expect(isLoopbackPeer(undefined, {})).toBe(false);
  });

  it("can be opted out of for a deliberately split deployment", () => {
    expect(isLoopbackPeer("192.168.1.20", { CALANDRIA_PTY_ALLOW_REMOTE: "1" })).toBe(true);
  });
});

/* The post-auth redirect guard. Each rejection below defeats the obvious
 * startsWith("/") && !startsWith("//") version. */
describe("safeRedirectPath", () => {
  it("keeps ordinary in-app paths", () => {
    expect(safeRedirectPath("/tasks/abc?x=1#y")).toBe("/tasks/abc?x=1#y");
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });

  it("rejects protocol-relative and absolute targets", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("https://evil.com")).toBe("/");
  });

  it("rejects the backslash browsers normalize into the authority position", () => {
    expect(safeRedirectPath("/\\evil.com")).toBe("/");
  });

  it("rejects tab/CR/LF smuggling browsers strip before parsing", () => {
    expect(safeRedirectPath("/\t/evil.com")).toBe("/");
    expect(safeRedirectPath("/\n\\evil.com")).toBe("/");
    expect(safeRedirectPath("/\r/evil.com")).toBe("/");
  });
});
