import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// The fleet-token invariant (cf-access.mjs: "Read-only paths only") is enforced
// in middleware.ts, which routes /api/instance/scheduler and
// /api/instance/services-restore through isInstanceOnlyServiceTokenPath rather
// than the broader isReadOnlyServiceTokenPath used for health/version/usage.
// These tests exercise the actual middleware() function rather than the
// underlying token helpers (already covered in tests/agentTools.test.ts), so a
// future change that reintroduces the fleet token on a mutating path fails here.
describe("middleware: fleet token stays read-only", () => {
  const prevEnv = {
    CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
    SERVICE_TOKEN: process.env.SERVICE_TOKEN,
    ORCH_FLEET_TOKEN: process.env.ORCH_FLEET_TOKEN,
  };

  beforeEach(() => {
    // Enables Access mode (originAuthEnabled()) so middleware reaches the
    // service-token branches at all — in local mode it never does.
    process.env.CF_ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "test-aud";
    process.env.SERVICE_TOKEN = "instance-secret";
    process.env.ORCH_FLEET_TOKEN = "fleet-secret";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function req(path: string, method: string, token?: string) {
    // No Origin header: matches the real callers here (server.js's loopback
    // self-ping, the fleet metrics poller), and sameOriginHttpRequestAllowed
    // allows an absent Origin in Access mode.
    return new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers: token ? { "x-service-token": token } : {},
    });
  }

  it("rejects the fleet token on POST scheduler (starts the ticker — a mutation)", async () => {
    const res = await middleware(req("/api/instance/scheduler", "POST", "fleet-secret"));
    expect(res.status).toBe(403);
  });

  it("accepts the instance token on POST scheduler", async () => {
    const res = await middleware(req("/api/instance/scheduler", "POST", "instance-secret"));
    expect(res.status).toBe(200);
  });

  it("rejects the fleet token on POST services-restore (restarts managed services — a mutation)", async () => {
    const res = await middleware(req("/api/instance/services-restore", "POST", "fleet-secret"));
    expect(res.status).toBe(403);
  });

  it("accepts the instance token on POST services-restore", async () => {
    const res = await middleware(req("/api/instance/services-restore", "POST", "instance-secret"));
    expect(res.status).toBe(200);
  });

  it("still accepts the fleet token on read-only paths", async () => {
    for (const path of ["/api/instance/idle", "/api/version", "/api/instance/usage"]) {
      const res = await middleware(req(path, "GET", "fleet-secret"));
      expect(res.status).toBe(200);
    }
    // GET scheduler only reads schedulerHealth() — the fleet-wide poller's use case.
    const schedulerGet = await middleware(req("/api/instance/scheduler", "GET", "fleet-secret"));
    expect(schedulerGet.status).toBe(200);
  });

  it("still accepts the instance token on read-only paths", async () => {
    const res = await middleware(req("/api/instance/idle", "GET", "instance-secret"));
    expect(res.status).toBe(200);
  });
});
