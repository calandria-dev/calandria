import { describe, expect, it } from "vitest";
import {
  isLoopbackPeer,
  localHttpRequestAllowed,
  localWebSocketRequestAllowed,
  safeRedirectPath,
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
    const env = { PUBLIC_BASE_URL: "https://operator.example.com" };
    expect(localWebSocketRequestAllowed(
      { host: "operator.example.com", origin: "https://operator.example.com" },
      env,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "operator.example.com", origin: "http://operator.example.com" },
      env,
    )).toBe(false);
    expect(localHttpRequestAllowed(
      { host: "other.example.com", origin: null, secFetchSite: null },
      env,
    )).toBe(false);
  });

  it("supports explicit comma-separated origins for intentional LAN access", () => {
    const env = {
      ORCH_ALLOWED_ORIGINS: "http://192.168.1.50:3000, https://operator.internal",
    };
    expect(localWebSocketRequestAllowed(
      { host: "192.168.1.50:3000", origin: "http://192.168.1.50:3000" },
      env,
    )).toBe(true);
    expect(localHttpRequestAllowed(
      { host: "operator.internal", origin: "https://operator.internal", secFetchSite: "same-origin" },
      env,
    )).toBe(true);
    expect(localWebSocketRequestAllowed(
      { host: "192.168.1.51:3000", origin: "http://192.168.1.51:3000" },
      env,
    )).toBe(false);
  });

  it("ignores malformed or path-bearing allowlist entries", () => {
    const env = {
      ORCH_ALLOWED_ORIGINS: "not-a-url, https://operator.example.com/path",
    };
    expect(localHttpRequestAllowed(
      { host: "operator.example.com", origin: "https://operator.example.com", secFetchSite: "same-origin" },
      env,
    )).toBe(false);
  });
});

/* The sidecar's own gate. Headers are attacker-controlled; the peer address is
 * not, which is the whole reason this sits alongside the Origin check rather
 * than replacing it. */
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
    expect(isLoopbackPeer("192.168.1.20", { ORCH_PTY_ALLOW_REMOTE: "1" })).toBe(true);
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
