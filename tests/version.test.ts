import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * GET /api/version is the desktop shell's handshake (desktop/main.js
 * `probeVersion`): it reports `version` for the shell's stale-server warning,
 * and `instanceName` for the window title, menus and toasts.
 *
 * CALANDRIA_INSTANCE_NAME is read at import time by lib/config.ts, so each
 * case sets the env and re-imports the route instead of mutating a resolved
 * constant.
 */
async function version(instanceName?: string) {
  if (instanceName === undefined) delete process.env.CALANDRIA_INSTANCE_NAME;
  else process.env.CALANDRIA_INSTANCE_NAME = instanceName;
  vi.resetModules();
  const { GET } = await import("@/app/api/version/route");
  const res = await GET();
  return (await res.json()) as { version: string; sha: string; builtAt: string; instanceName: string | null };
}

describe("GET /api/version", () => {
  afterEach(() => {
    delete process.env.CALANDRIA_INSTANCE_NAME;
    vi.resetModules();
  });

  it("reports the instance name when one is configured", async () => {
    expect((await version("Build box")).instanceName).toBe("Build box");
  });

  it("reports null rather than an empty string when it is unset", async () => {
    // The desktop falls back to the URL's host when instanceName is null. An
    // empty string would be adopted as a name, labeling the instance with
    // nothing.
    expect((await version(undefined)).instanceName).toBeNull();
    expect((await version("   ")).instanceName).toBeNull();
  });

  it("trims and caps the name, which lands in a window title and a tray label", async () => {
    expect((await version("  Lab  ")).instanceName).toBe("Lab");
    expect((await version("x".repeat(200))).instanceName).toBe("x".repeat(60));
  });

  it("still carries the build provenance the handshake and the healthcheck read", async () => {
    const body = await version("Lab");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.sha).toBe("string");
    expect(typeof body.builtAt).toBe("string");
  });
});
