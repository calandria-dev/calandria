import { describe, expect, it } from "vitest";
import {
  localHttpRequestAllowed,
  localWebSocketRequestAllowed,
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
