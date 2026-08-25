/* The bind-address rule.
 *
 * Every case passes env EXPLICITLY. That is the point: the bug being pinned is
 * ambient environment deciding the bind address, so a test that read
 * process.env would be able to reproduce the bug and still pass.
 */
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveHostname, hostnameMigrationWarning, DEFAULT_HOSTNAME } = require("../lib/resolveHostname");

describe("resolveHostname", () => {
  it("defaults to loopback with nothing set — an unauthenticated shell must not reach the network", () => {
    expect(resolveHostname({})).toBe("127.0.0.1");
    expect(DEFAULT_HOSTNAME).toBe("127.0.0.1");
  });

  it("IGNORES a machine name injected into HOSTNAME (the Fedora /etc/profile case)", () => {
    expect(resolveHostname({ HOSTNAME: "my-laptop" })).toBe("127.0.0.1");
  });

  it("ignores the container id Docker injects into HOSTNAME", () => {
    expect(resolveHostname({ HOSTNAME: "3f2a1b9c4d5e" })).toBe("127.0.0.1");
  });

  it("ignores HOSTNAME even when it looks like a deliberate bind address", () => {
    // No way to tell "the user meant this" from "the platform set it", so the
    // safe reading wins. The migration warning below is how that is surfaced.
    expect(resolveHostname({ HOSTNAME: "0.0.0.0" })).toBe("127.0.0.1");
  });

  it("honours CALANDRIA_HOSTNAME, and it wins over an ambient HOSTNAME", () => {
    expect(resolveHostname({ CALANDRIA_HOSTNAME: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveHostname({ CALANDRIA_HOSTNAME: "0.0.0.0", HOSTNAME: "my-laptop" })).toBe("0.0.0.0");
    expect(resolveHostname({ CALANDRIA_HOSTNAME: "192.168.1.5", HOSTNAME: "my-laptop" })).toBe("192.168.1.5");
  });

  it("treats an empty or whitespace CALANDRIA_HOSTNAME as unset", () => {
    expect(resolveHostname({ CALANDRIA_HOSTNAME: "" })).toBe("127.0.0.1");
    expect(resolveHostname({ CALANDRIA_HOSTNAME: "   " })).toBe("127.0.0.1");
  });

  it("falls back to process.env when called with no argument", () => {
    expect(typeof resolveHostname()).toBe("string");
  });
});

describe("hostnameMigrationWarning", () => {
  it("warns the deployment that deliberately set HOSTNAME to a bind address", () => {
    const w = hostnameMigrationWarning({ HOSTNAME: "0.0.0.0" });
    expect(w).toContain("CALANDRIA_HOSTNAME=0.0.0.0");
  });

  it("stays silent for an injected machine name — that would fire on every Fedora boot", () => {
    expect(hostnameMigrationWarning({ HOSTNAME: "my-laptop" })).toBeNull();
    expect(hostnameMigrationWarning({ HOSTNAME: "3f2a1b9c4d5e" })).toBeNull();
  });

  it("stays silent once CALANDRIA_HOSTNAME is set, and when HOSTNAME is absent", () => {
    expect(hostnameMigrationWarning({ CALANDRIA_HOSTNAME: "0.0.0.0", HOSTNAME: "0.0.0.0" })).toBeNull();
    expect(hostnameMigrationWarning({})).toBeNull();
  });
});
