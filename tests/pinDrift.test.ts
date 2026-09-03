import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { extractPins, byUpstreamValue } from "../scripts/check-pin-drift.mjs";

const DOCKERFILE = path.join(__dirname, "..", "Dockerfile");

/**
 * scripts/check-pin-drift.mjs reads the Dockerfile with regexes, and the only
 * other place those regexes run is a cron. Renaming an ARG or reflowing the
 * apt-get line would leave the check exiting 2 at 08:11 UTC, which nobody is
 * watching for. These cases fail here instead, on the PR that does it.
 *
 * Hermetic on purpose: everything below is the pure extraction half. The
 * network half is exercised by running the script.
 */
describe("pin drift extraction", () => {
  const source = readFileSync(DOCKERFILE, "utf8");

  it("finds every pin it claims to watch in the real Dockerfile", () => {
    const pins = extractPins(source, "Dockerfile");

    expect(pins.agyVersion.value).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.gh.value).toMatch(/^\d+\.\d+\.\d+/);
    // SHA-512, hex, as `sha512sum -c` will read them.
    for (const arch of ["amd64", "arm64"] as const) {
      expect(pins.agySha[arch].value).toMatch(/^[0-9a-f]{128}$/);
    }

    // Every `where` is a real line, so an issue body can be clicked through.
    const lineCount = source.split("\n").length;
    for (const where of [
      pins.agyVersion.where,
      pins.gh.where,
      pins.agySha.amd64.where,
      pins.agySha.arm64.where,
    ]) {
      const line = Number(where.split(":")[1]);
      expect(line).toBeGreaterThan(0);
      expect(line).toBeLessThanOrEqual(lineCount);
    }
  });

  it("reads the gh pin off the apt-get line, not some other token", () => {
    const pins = extractPins(source, "Dockerfile");
    const line = source.split("\n")[Number(pins.gh.where.split(":")[1]) - 1];
    expect(line).toContain("apt-get install");
    expect(line).toContain(`gh=${pins.gh.value}`);
  });

  it("fails loudly when a pin it watches has been renamed away", () => {
    const renamed = source.replace("ARG AGY_VERSION=", "ARG AGY_CLI_VERSION=");
    // Guard against the replace silently doing nothing.
    expect(renamed).not.toBe(source);
    expect(() => extractPins(renamed, "Dockerfile")).toThrow(/AGY_VERSION/);
  });
});

describe("byUpstreamValue", () => {
  it("collapses arches that agree into one unlabelled finding", () => {
    const groups = byUpstreamValue({ amd64: "2.100.0", arm64: "2.100.0" });
    expect(groups).toHaveLength(1);
    expect(groups[0].value).toBe("2.100.0");
    expect(groups[0].label).toBe("");
  });

  it("names the arches when they disagree", () => {
    const groups = byUpstreamValue({ amd64: "2.100.0", arm64: "2.99.0" });
    expect(groups).toHaveLength(2);
    expect(groups.map((g: { label: string }) => g.label)).toEqual([
      " (amd64)",
      " (arm64)",
    ]);
  });
});
