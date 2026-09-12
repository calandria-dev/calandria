import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractPins,
  extractPackagePins,
  npmPinEntries,
  byUpstreamValue,
  npmStaleness,
  agyBumpPlan,
  applyAgyPin,
} from "../scripts/check-pin-drift.mjs";

const ROOT = path.join(__dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const PACKAGE_JSON = path.join(ROOT, "package.json");

/**
 * scripts/check-pin-drift.mjs reads the Dockerfile with regexes, and the only
 * other place those regexes run is a cron. Renaming an ARG or reflowing the
 * apt-get line would leave the check exiting 2 at 08:11 UTC, with nobody
 * watching for it. These cases fail here instead, on the PR that does it.
 *
 * This is the pure extraction half, hermetic and independent of network
 * access. The network half is exercised by running the script.
 */
describe("pin drift extraction", () => {
  const source = readFileSync(DOCKERFILE, "utf8");

  it("finds every pin it claims to watch in the real Dockerfile", () => {
    const pins = extractPins(source, "Dockerfile");

    expect(pins.agyVersion.value).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.gh.value).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.claudeCode.value).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.codexVersion.value).toMatch(/^\d+\.\d+\.\d+/);
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
      pins.claudeCode.where,
      pins.codexVersion.where,
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
    // Guard against the replace matching nothing and leaving the source unchanged.
    expect(renamed).not.toBe(source);
    expect(() => extractPins(renamed, "Dockerfile")).toThrow(/AGY_VERSION/);
  });
});

/**
 * The other half of check-pin-drift.mjs writes the Dockerfile: agyBumpPlan()
 * decides what an agy bump would write, and applyAgyPin() writes it. Every
 * refusal in that path has to be pinned here, where it costs nothing to run
 * again, because the upstream manifest states that would trigger it in
 * production cannot be replayed on demand.
 */
describe("agy bump", () => {
  const source = readFileSync(DOCKERFILE, "utf8");
  const pins = extractPins(source, "Dockerfile");
  const AMD = "a".repeat(128);
  const ARM = "b".repeat(128);

  it("reads a bump out of the manifests both arches agree on", () => {
    const plan = agyBumpPlan(pins, {
      amd64: { version: "9.9.9", sha512: AMD },
      arm64: { version: "9.9.9", sha512: ARM },
    });
    expect(plan?.kind).toBe("version");
    expect(plan?.version).toBe("9.9.9");
    expect(plan?.from).toBe(pins.agyVersion.value);
    expect(plan?.amd64).toBe(AMD);
    expect(plan?.arm64).toBe(ARM);
  });

  it("lowercases the digests it will hand to sha512sum", () => {
    const plan = agyBumpPlan(pins, {
      amd64: { version: "9.9.9", sha512: AMD.toUpperCase() },
      arm64: { version: "9.9.9", sha512: ARM.toUpperCase() },
    });
    expect(plan?.amd64).toBe(AMD);
    expect(plan?.arm64).toBe(ARM);
  });

  it("says nothing when the Dockerfile already carries the manifests", () => {
    const plan = agyBumpPlan(pins, {
      amd64: { version: pins.agyVersion.value, sha512: pins.agySha.amd64.value },
      arm64: { version: pins.agyVersion.value, sha512: pins.agySha.arm64.value },
    });
    expect(plan).toBeNull();
  });

  it("calls a rebuilt tarball under an unchanged version a digest refresh", () => {
    const plan = agyBumpPlan(pins, {
      amd64: { version: pins.agyVersion.value, sha512: AMD },
      arm64: { version: pins.agyVersion.value, sha512: ARM },
    });
    expect(plan?.kind).toBe("digest");
    expect(plan?.version).toBe(plan?.from);
  });

  it("refuses two arches that advertise different versions", () => {
    expect(() =>
      agyBumpPlan(pins, {
        amd64: { version: "9.9.9", sha512: AMD },
        arm64: { version: "9.9.8", sha512: ARM },
      }),
    ).toThrow(/disagree/);
  });

  it("refuses a manifest missing its version or digest", () => {
    expect(() =>
      agyBumpPlan(pins, {
        amd64: { version: "9.9.9" },
        arm64: { version: "9.9.9", sha512: ARM },
      }),
    ).toThrow(/no version\/sha512/);

    expect(() =>
      agyBumpPlan(pins, {
        amd64: { version: "9.9.9", sha512: AMD },
        arm64: undefined,
      }),
    ).toThrow(/no version\/sha512/);
  });

  it("refuses a digest sha512sum could not read", () => {
    expect(() =>
      agyBumpPlan(pins, {
        amd64: { version: "9.9.9", sha512: AMD.slice(0, 127) },
        arm64: { version: "9.9.9", sha512: ARM },
      }),
    ).toThrow(/128 hex/);

    expect(() =>
      agyBumpPlan(pins, {
        amd64: { version: "9.9.9", sha512: AMD },
        arm64: { version: "9.9.9", sha512: "z".repeat(128) },
      }),
    ).toThrow(/128 hex/);
  });

  it("refuses a version the Dockerfile's guard could not match", () => {
    expect(() =>
      agyBumpPlan(pins, {
        amd64: { version: "1.2.2-beta", sha512: AMD },
        arm64: { version: "1.2.2-beta", sha512: ARM },
      }),
    ).toThrow(/AGY_VERSION guard/);
  });

  it("moves all three ARGs together", () => {
    const plan = { version: "9.9.9", amd64: AMD, arm64: ARM };
    const applied = applyAgyPin(source, plan, "Dockerfile");
    expect(applied.changed).toBe(true);

    const rewritten = extractPins(applied.source, "Dockerfile");
    expect(rewritten.agyVersion.value).toBe("9.9.9");
    expect(rewritten.agySha.amd64.value).toBe(AMD);
    expect(rewritten.agySha.arm64.value).toBe(ARM);

    expect(applied.source.split("\n").length).toBe(source.split("\n").length);
  });

  it("leaves an already-current Dockerfile byte-identical", () => {
    const plan = {
      version: pins.agyVersion.value,
      amd64: pins.agySha.amd64.value,
      arm64: pins.agySha.arm64.value,
    };
    const applied = applyAgyPin(source, plan, "Dockerfile");
    expect(applied.changed).toBe(false);
    expect(applied.source).toBe(source);
  });

  it("is idempotent", () => {
    const plan = { version: "9.9.9", amd64: AMD, arm64: ARM };
    const first = applyAgyPin(source, plan, "Dockerfile");
    const second = applyAgyPin(first.source, plan, "Dockerfile");
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  it("writes nothing when an ARG it must move has been renamed away", () => {
    const renamed = source.replace(
      "ARG AGY_SHA512_ARM64=",
      "ARG AGY_SHA512_AARCH64=",
    );
    expect(renamed).not.toBe(source);
    const plan = { version: "9.9.9", amd64: AMD, arm64: ARM };

    expect(() => applyAgyPin(renamed, plan, "Dockerfile")).toThrow(
      /AGY_SHA512_ARM64/,
    );

    // Nothing partial leaked: the string itself never changes, since it is a
    // value, not a file the failed call could have half-written.
    try {
      applyAgyPin(renamed, plan, "Dockerfile");
    } catch {
      /* already asserted above */
    }
    expect(renamed).toContain(`AGY_VERSION=${pins.agyVersion.value}`);
  });

  it("refuses a plan that is missing one of the three values", () => {
    expect(() =>
      applyAgyPin(source, { version: "9.9.9", amd64: AMD }, "Dockerfile"),
    ).toThrow(/AGY_SHA512_ARM64/);
  });
});

/**
 * `@anthropic-ai/claude-agent-sdk` is watched too, and it is the one pin with
 * no Dockerfile ARG: the image installs no copy of it, so it is read out of
 * package.json `dependencies` instead. It reached 104 patch releases behind
 * before anyone counted, and now that it is pinned exactly nothing floats it,
 * so this check is the only thing that reports it is behind.
 */
describe("package.json pin extraction", () => {
  const source = readFileSync(PACKAGE_JSON, "utf8");
  const SDK = "@anthropic-ai/claude-agent-sdk";

  it("finds the Agent SDK pin and points at its real line", () => {
    const pins = extractPackagePins(source, "package.json");
    const pkg = JSON.parse(source);

    expect(pins[SDK].value).toBe(pkg.dependencies[SDK]);
    expect(pins[SDK].value).toMatch(/^\d+\.\d+\.\d+$/);

    const line = Number(pins[SDK].where.split(":")[1]);
    expect(pins[SDK].where.split(":")[0]).toBe("package.json");
    expect(source.split("\n")[line - 1]).toContain(`"${SDK}"`);
  });

  it("fails loudly when the dependency is renamed away", () => {
    const renamed = source.replace(`"${SDK}"`, `"@anthropic-ai/agent-sdk"`);
    expect(renamed).not.toBe(source);
    expect(() => extractPackagePins(renamed, "package.json")).toThrow(
      /claude-agent-sdk/,
    );
  });

  it("refuses a range, which is not a pin it can report on", () => {
    const declared = JSON.parse(source).dependencies[SDK];
    const floated = source.replace(
      `"${SDK}": "${declared}"`,
      `"${SDK}": "^${declared}"`,
    );
    expect(floated).not.toBe(source);
    expect(() => extractPackagePins(floated, "package.json")).toThrow(
      /not an exact version/,
    );
  });

  it("puts the SDK on the same staleness path as the two CLI pins", () => {
    // One row per npm pin whichever file it lives in, so the SDK gets the same
    // MAX_PIN_AGE_DAYS / MAX_MINORS_BEHIND rules and the same report tables.
    const entries = npmPinEntries(
      extractPins(readFileSync(DOCKERFILE, "utf8"), "Dockerfile"),
      extractPackagePins(source, "package.json"),
    );
    expect(entries.map((e: { pkg: string }) => e.pkg)).toEqual([
      "@anthropic-ai/claude-code",
      "@openai/codex",
      SDK,
    ]);

    const sdk = entries.find((e: { pkg: string }) => e.pkg === SDK)!;
    expect(sdk.pinned).toBe(JSON.parse(source).dependencies[SDK]);
    expect(sdk.where).toMatch(/^package\.json:\d+$/);
    // No ARG to name, so the package names itself in the report tables.
    expect(sdk.pin).toBe(`\`${SDK}\``);
    expect(sdk.pinLabel).toBe(sdk.pinned);
  });

  it("can only ever fire on age, never on minors", () => {
    // The SDK moves on the PATCH within one 0.3.x minor: 0.3.159 to 0.3.263 is
    // 104 releases and zero newer minor lines. MAX_MINORS_BEHIND counts nothing
    // here by construction, and no patch-distance trigger was added, so age is
    // the only thing that reports this pin.
    const versions = Array.from({ length: 264 }, (_, i) => `0.3.${i}`);
    const NOW = Date.parse("2026-09-03T00:00:00Z");
    const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

    const quiet = npmStaleness({
      pinned: "0.3.159",
      latest: "0.3.263",
      pinnedAt: daysAgo(20),
      versions,
      now: NOW,
    });
    expect(quiet).toBeNull();

    const aged = npmStaleness({
      pinned: "0.3.159",
      latest: "0.3.263",
      pinnedAt: daysAgo(21),
      versions,
      now: NOW,
    });
    expect(aged?.minorsAhead).toBe(0);
    expect(aged?.reasons).toEqual(["pinned 21 days ago"]);
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

/**
 * The npm pins are reported on STALENESS, not on difference, and the
 * thresholds matter: too tight and this files a notice every morning, too
 * loose and it misses the case it exists for. Both directions are pinned
 * here, since the live behaviour only shows up against a registry nobody can
 * replay.
 */
describe("npmStaleness", () => {
  const NOW = Date.parse("2026-09-03T00:00:00Z");
  const daysAgo = (n: number) =>
    new Date(NOW - n * 86_400_000).toISOString();
  const patches = (minor: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${minor}.${i}`);

  it("says nothing when the pin is the latest", () => {
    expect(
      npmStaleness({
        pinned: "2.1.259",
        latest: "2.1.259",
        pinnedAt: daysAgo(400),
        versions: patches("2.1", 260),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("stays quiet through a burst of patches on one minor", () => {
    // @anthropic-ai/claude-code published 25 releases in 23 days. Reporting on
    // "something newer exists" is a notice a day, which is the noise this
    // threshold exists to avoid.
    expect(
      npmStaleness({
        pinned: "2.1.228",
        latest: "2.1.253",
        pinnedAt: daysAgo(5),
        versions: patches("2.1", 254),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("fires on age once the same pin has sat for three weeks", () => {
    const verdict = npmStaleness({
      pinned: "2.1.228",
      latest: "2.1.259",
      pinnedAt: daysAgo(23),
      versions: patches("2.1", 260),
      now: NOW,
    });
    expect(verdict?.ageDays).toBe(23);
    // No newer MINOR line: claude-code stays on 2.1, so age is the only
    // trigger that can ever cover it.
    expect(verdict?.minorsAhead).toBe(0);
    expect(verdict?.reasons).toEqual(["pinned 23 days ago"]);
  });

  it("fires on minors before the age threshold when upstream moves fast", () => {
    const verdict = npmStaleness({
      pinned: "0.146.0",
      latest: "0.150.0",
      pinnedAt: daysAgo(4),
      versions: [...patches("0.146", 3), "0.147.0", "0.148.0", "0.150.0"],
      now: NOW,
    });
    expect(verdict?.minorsAhead).toBe(3);
    expect(verdict?.reasons).toEqual(["3 newer minors published"]);
  });

  it("would have caught the pin GPT-6 Astra could not run on", () => {
    // Both triggers fire well before a newly released model would outpace
    // the pinned CLI.
    const verdict = npmStaleness({
      pinned: "0.146.0",
      latest: "0.153.1",
      pinnedAt: "2026-07-29T00:00:00Z",
      versions: [
        "0.146.0",
        "0.146.1",
        ...["0.147", "0.148", "0.149", "0.150", "0.151", "0.152", "0.153"].map(
          (m) => `${m}.0`,
        ),
        "0.153.1",
      ],
      now: NOW,
    });
    expect(verdict?.ageDays).toBe(36);
    expect(verdict?.minorsAhead).toBe(7);
    expect(verdict?.reasons).toHaveLength(2);
  });

  it("counts neither prereleases nor the pin's own minor as newer minors", () => {
    // 0.146.1 is not a newer minor line, and an alpha is never what the
    // Dockerfile installs; both would otherwise inflate the count past the
    // threshold on their own.
    const verdict = npmStaleness({
      pinned: "0.146.0",
      latest: "0.147.0",
      pinnedAt: daysAgo(1),
      versions: [
        "0.146.0",
        "0.146.1",
        "0.146.2",
        "0.147.0-alpha.1",
        "0.148.0-rc.1",
        "0.147.0",
      ],
      now: NOW,
    });
    expect(verdict).toBeNull();
  });
});
