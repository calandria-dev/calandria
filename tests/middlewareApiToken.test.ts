import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// CALANDRIA_API_TOKEN lets a non-browser REST client (the calandria CLI) reach
// the API from a host the browser-origin rules would refuse, in both auth
// modes. These run the real middleware() so the bypass can't widen to the
// internal service-token paths, or apply while the token is unset.
describe("middleware: CALANDRIA_API_TOKEN", () => {
  const keys = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "SERVICE_TOKEN", "CALANDRIA_API_TOKEN", "CALANDRIA_ALLOWED_ORIGINS", "PUBLIC_BASE_URL"];
  const prevEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const k of keys) delete process.env[k];
    process.env.SERVICE_TOKEN = "instance-secret";
    process.env.CALANDRIA_API_TOKEN = "api-secret";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function accessMode() {
    process.env.CF_ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "test-aud";
  }

  function req(url: string, headers: Record<string, string> = {}, method = "GET") {
    // NextRequest sets no Host header of its own; the origin rules read it.
    return new NextRequest(url, { method, headers: { host: new URL(url).host, ...headers } });
  }

  it("admits the token from a host local mode would refuse", async () => {
    const refused = await middleware(req("http://calandria.lan:3000/api/projects"));
    expect(refused.status).toBe(403);

    const res = await middleware(req("http://calandria.lan:3000/api/projects", { authorization: "Bearer api-secret" }));
    expect(res.status).toBe(200);
  });

  it("admits the token in Access mode with no Access JWT", async () => {
    accessMode();
    const refused = await middleware(req("https://calandria.example.com/api/tasks"));
    expect(refused.status).toBe(403);

    const res = await middleware(req("https://calandria.example.com/api/tasks", { authorization: "Bearer api-secret" }, "POST"));
    expect(res.status).toBe(200);
  });

  it("answers a wrong token with 401 in both modes", async () => {
    const local = await middleware(req("http://127.0.0.1:3000/api/projects", { authorization: "Bearer stale" }));
    expect(local.status).toBe(401);
    expect(await local.text()).toMatch(/does not match CALANDRIA_API_TOKEN/);

    accessMode();
    const access = await middleware(req("https://calandria.example.com/api/projects", { authorization: "Bearer stale" }));
    expect(access.status).toBe(401);
  });

  it("ignores a bearer header while the token is unset", async () => {
    delete process.env.CALANDRIA_API_TOKEN;
    const loopback = await middleware(req("http://127.0.0.1:3000/api/projects", { authorization: "Bearer anything" }));
    expect(loopback.status).toBe(200);
    const lan = await middleware(req("http://calandria.lan:3000/api/projects", { authorization: "Bearer anything" }));
    expect(lan.status).toBe(403);
  });

  it("never opens the internal service-token paths", async () => {
    accessMode();
    for (const path of ["/api/internal/agent-tools/suggest_task", "/api/instance/drain", "/api/instance/services-restore"]) {
      const res = await middleware(req(`https://calandria.example.com${path}`, { authorization: "Bearer api-secret" }, "POST"));
      expect(res.status).toBe(403);
    }
  });
});
