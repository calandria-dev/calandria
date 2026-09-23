import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractPins,
  extractPackagePins,
  npmPinEntries,
  byUpstreamValue,
  npmStaleness,
  compareClaudeAliasResolutions,
  CLAUDE_PROBE_ALIASES,
  extractCodexEmbeddedCatalog,
  codexEmbeddedDefault,
  compareCodexDefaults,
  agyBumpPlan,
  applyAgyPin,
  npmBumpPlan,
  applyNpmDockerfilePins,
  applyNpmPackagePins,
} from "../scripts/check-pin-drift.mjs";

const ROOT = path.join(__dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const PIN_WORKFLOW = path.join(ROOT, ".github/workflows/pin-drift.yml");
const MODEL_PROBE = path.join(ROOT, "lib/agents/claude/modelProbe.ts");

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

describe("npm CLI bump", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const packageJson = readFileSync(PACKAGE_JSON, "utf8");
  const pins = extractPins(dockerfile, "Dockerfile");

  it("selects only stale CLI pins and preserves the SDK issue path", () => {
    const plan = npmBumpPlan(
      pins,
      {
        "@anthropic-ai/claude-code": "9.9.9",
        "@openai/codex": "8.8.8",
      },
      [
        { pkg: "@anthropic-ai/claude-code" },
        { pkg: "@openai/codex" },
        { pkg: "@anthropic-ai/claude-agent-sdk" },
      ],
    );
    expect(plan).toEqual({ claudeCode: "9.9.9", codexVersion: "8.8.8" });
  });

  it("rejects an upstream version that is not exact semver", () => {
    expect(
      () => npmBumpPlan(
        pins,
        { "@openai/codex": "8.8.8-beta" },
        [{ pkg: "@openai/codex" }],
      ),
    ).toThrow(/exact stable semver/);
  });

  it("rewrites only the selected Dockerfile ARGs", () => {
    const applied = applyNpmDockerfilePins(dockerfile, {
      claudeCode: "9.9.9",
      codexVersion: "8.8.8",
    });
    expect(applied.changed).toBe(true);
    const rewritten = extractPins(applied.source, "Dockerfile");
    expect(rewritten.claudeCode.value).toBe("9.9.9");
    expect(rewritten.codexVersion.value).toBe("8.8.8");
    expect(rewritten.agyVersion.value).toBe(pins.agyVersion.value);
    expect(applyNpmDockerfilePins(applied.source, {
      claudeCode: "9.9.9",
      codexVersion: "8.8.8",
    })).toEqual({ source: applied.source, changed: false });
  });

  it("updates Codex SDK in package.json and refuses a missing dependency", () => {
    const applied = applyNpmPackagePins(packageJson, { codexVersion: "8.8.8" });
    expect(JSON.parse(applied.source).dependencies["@openai/codex-sdk"]).toBe(
      "8.8.8",
    );
    expect(applyNpmPackagePins(applied.source, { codexVersion: "8.8.8" })).toEqual(
      { source: applied.source, changed: false },
    );
    expect(() =>
      applyNpmPackagePins(
        packageJson.replace('"@openai/codex-sdk"', '"@openai/codex-sdk-old"'),
        { codexVersion: "8.8.8" },
      ),
    ).toThrow(/codex-sdk/);
  });
});

describe("pin drift workflow", () => {
  const workflow = readFileSync(PIN_WORKFLOW, "utf8");

  it("applies both npm CLI plans and repairs the Codex lockfile", () => {
    expect(workflow).toContain("--update-npm");
    expect(workflow).toContain("--apply-npm");
    expect(workflow).toContain("npm install --package-lock-only");
    expect(workflow).toContain("npm run fix-lockfile");
  });

  it("installs isolated Claude Code probes and passes both binary paths", () => {
    expect(workflow).toContain('npm install --prefix "$pinned_prefix"');
    expect(workflow).toContain('npm install --prefix "$latest_prefix"');
    expect(workflow).toContain('"@anthropic-ai/claude-code@$pinned"');
    expect(workflow).toContain('"@anthropic-ai/claude-code@$latest"');
    expect(workflow).toContain("--claude-alias-pinned-bin");
    expect(workflow).toContain("--claude-alias-latest-bin");
    expect(workflow).toMatch(
      /- name: Open, update or close the drift issue\n\s+if: env\.DRY_RUN != 'true'/,
    );
  });

  it("installs isolated Codex probes from the Dockerfile pin and npm latest", () => {
    expect(workflow).toMatch(/\$2 ~ \/\^CODEX_VERSION=\/ \{/);
    expect(workflow).toContain('latest="$(npm view @openai/codex version)"');
    expect(workflow).toContain('"@openai/codex@$pinned"');
    expect(workflow).toContain('"@openai/codex@$latest"');
    expect(workflow).toContain('pinned_prefix="$RUNNER_TEMP/codex-default-pinned"');
    expect(workflow).toContain('latest_prefix="$RUNNER_TEMP/codex-default-latest"');
    expect(workflow).toContain("CODEX_DEFAULT_PINNED_BIN=$pinned_bin");
    expect(workflow).toContain("CODEX_DEFAULT_LATEST_BIN=$latest_bin");
    expect(workflow).toContain('--codex-default-pinned-bin "$CODEX_DEFAULT_PINNED_BIN"');
    expect(workflow).toContain('--codex-default-latest-bin "$CODEX_DEFAULT_LATEST_BIN"');
    // The Codex prefixes must reach the script from the same step that
    // supplies the Claude ones, so a missing pair fails the check instead of
    // silently skipping it.
    const check = /- name: Compare pins with upstream[\s\S]*?case "\$status" in/.exec(workflow);
    expect(check?.[0]).toContain("--claude-alias-latest-bin");
    expect(check?.[0]).toContain("--codex-default-latest-bin");
  });

  it("dispatches CI and enables exact-head squash auto-merge", () => {
    expect(workflow).toContain("dispatch_and_confirm test.yml Test");
    expect(workflow).toContain(
      'dispatch_and_confirm release-desktop.yml "Desktop release artifacts"',
    );
    expect(workflow).toContain(
      'dispatch_and_confirm publish-image.yml "Publish image"',
    );
    expect(workflow).toContain("--auto --squash --delete-branch");
    expect(workflow).toContain('--match-head-commit "$SHA"');
    expect(workflow).toContain(
      "--json state,isDraft,headRefOid,autoMergeRequest",
    );
  });

  it("approves only materialized exact-head pull_request runs", () => {
    expect(workflow).toContain(
      'name: Approve held pull-request checks for the exact head',
    );
    expect(workflow).toContain('["PR title", "Test", "Publish image"]');
    expect(workflow).toContain('.event == "pull_request" and .head_sha == $sha');
    expect(workflow).toContain(
      'select(any(.pull_requests[]?; (.number | tostring) == $pr))',
    );
    expect(workflow).toContain('"repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/approve"');
    expect(workflow).toContain('select(.conclusion == "action_required")');
    expect(workflow).toContain(
      'expected pull_request workflow runs never materialized for $SHA',
    );
    expect(workflow).toContain('exit 1');
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
    // MAX_PIN_AGE_DAYS / MAX_MINORS_BEHIND / MAX_PATCHES_BEHIND rules and the
    // same report tables.
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

  it("is reported on patch distance, since its minor never moves", () => {
    // The SDK moves on the PATCH within one 0.3.x minor: 0.3.159 to 0.3.263 is
    // 104 releases and zero newer minor lines. MAX_MINORS_BEHIND counts nothing
    // here by construction, so patch distance is what reports this pin long
    // before the age clock runs out.
    const versions = Array.from({ length: 264 }, (_, i) => `0.3.${i}`);
    const NOW = Date.parse("2026-09-03T00:00:00Z");
    const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

    const verdict = npmStaleness({
      pinned: "0.3.159",
      latest: "0.3.263",
      pinnedAt: daysAgo(3),
      versions,
      now: NOW,
    });
    expect(verdict?.minorsAhead).toBe(0);
    expect(verdict?.patchesAhead).toBe(104);
    expect(verdict?.reasons).toEqual(["104 newer patches on 0.3"]);
  });
});

describe("Claude alias resolution drift", () => {
  const version = "2.1.278";
  const pinned = {
    fable: { model: "claude-opus-4-6", version },
    opus: { model: "claude-opus-5", version },
    sonnet: { model: "claude-sonnet-4-5", version },
    haiku: { model: "claude-haiku-4-5", version },
    opusplan: { model: "claude-opus-4-6", version },
  };

  it("stays quiet when every family alias resolves identically", () => {
    expect(compareClaudeAliasResolutions(pinned, { ...pinned })).toEqual([]);
  });

  it("reports a changed alias before version staleness would fire", () => {
    expect(
      compareClaudeAliasResolutions(pinned, {
        ...pinned,
        opus: { model: "claude-opus-5-5", version: "2.1.280" },
        fable: { ...pinned.fable, version: "2.1.280" },
        sonnet: { ...pinned.sonnet, version: "2.1.280" },
        haiku: { ...pinned.haiku, version: "2.1.280" },
        opusplan: { ...pinned.opusplan, version: "2.1.280" },
      }),
    ).toEqual([
      {
        alias: "opus",
        pinned: "claude-opus-5",
        latest: "claude-opus-5-5",
        pinnedVersion: "2.1.278",
        latestVersion: "2.1.280",
      },
    ]);
  });

  it("orders several changed aliases by the probe's fixed alias order", () => {
    expect(
      compareClaudeAliasResolutions(pinned, {
        fable: { model: "claude-opus-5-5", version: "2.1.280" },
        opus: { model: "claude-opus-5-5", version: "2.1.280" },
        sonnet: { ...pinned.sonnet, version: "2.1.280" },
        haiku: { model: "claude-haiku-5", version: "2.1.280" },
        opusplan: { ...pinned.opusplan, version: "2.1.280" },
      }).map((change) => change.alias),
    ).toEqual(["fable", "opus", "haiku"]);
  });

  it("fails when either probe leaves an alias unresolved", () => {
    const incomplete: Partial<typeof pinned> = { ...pinned };
    delete incomplete.opus;
    expect(() => compareClaudeAliasResolutions(incomplete, pinned)).toThrow(
      /pinned Claude alias probe did not resolve `opus`/,
    );
    expect(() => compareClaudeAliasResolutions(pinned, incomplete)).toThrow(
      /latest Claude alias probe did not resolve `opus`/,
    );
  });

  it("fails when a probe omits its CLI version or mixes versions", () => {
    expect(() =>
      compareClaudeAliasResolutions(
        { ...pinned, opus: { model: pinned.opus.model, version: "" } },
        pinned,
      ),
    ).toThrow(/pinned Claude alias probe did not report a version/);

    expect(() =>
      compareClaudeAliasResolutions(
        { ...pinned, opus: { ...pinned.opus, version: "2.1.279" } },
        pinned,
      ),
    ).toThrow(/pinned Claude alias probe reported multiple versions/);
  });

  it("stays aligned with the application alias list", () => {
    const source = readFileSync(MODEL_PROBE, "utf8");
    const match = /export const PROBE_ALIASES = (\[[^;]+\]) as const;/.exec(source);
    expect(match?.[1]).toBeDefined();
    expect(CLAUDE_PROBE_ALIASES).toEqual(JSON.parse(match![1]));
  });
});

describe("Codex embedded default model drift", () => {
  const catalog = {
    models: [
      { slug: "gpt-6-astra", priority: 1, visibility: "list" },
      { slug: "gpt-5.6-sol", priority: 6, visibility: "list" },
      { slug: "gpt-daybreak-blue-latest", priority: 0, visibility: "hide" },
      { slug: "codex-auto-review", priority: 43, visibility: "hide" },
    ],
  };
  /** A binary-like buffer: junk, the pretty-printed catalog, more junk. */
  const embed = (json: string) =>
    Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff, 0x7b, 0x7d]),
      Buffer.from("other { \"models\": [] } text\n", "latin1"),
      Buffer.from(json, "latin1"),
      Buffer.from("\u0000}}}{{{ tail", "latin1"),
    ]);
  const pretty = JSON.stringify(catalog, null, 2);

  it("brace-matches the one embedded catalog out of surrounding bytes", () => {
    expect(extractCodexEmbeddedCatalog(embed(pretty))).toEqual(catalog);
    expect(extractCodexEmbeddedCatalog(embed(pretty).toString("latin1"))).toEqual(catalog);
  });

  it("refuses a binary with no catalog, two catalogs, or a broken one", () => {
    expect(() => extractCodexEmbeddedCatalog(embed('{"models": []}'))).toThrow(
      /embeds no fallback model catalog/,
    );
    expect(() => extractCodexEmbeddedCatalog(embed(pretty + "\n" + pretty))).toThrow(
      /more than one fallback model catalog/,
    );
    expect(() =>
      extractCodexEmbeddedCatalog(Buffer.from("junk " + pretty.slice(0, -3), "latin1")),
    ).toThrow(/unterminated/);
    expect(() => extractCodexEmbeddedCatalog(embed('{\n  "models": [ nope ] }'))).toThrow(
      /not JSON/,
    );
    expect(() =>
      extractCodexEmbeddedCatalog(embed('{\n  "models": [] , "x": { "models": {} } }')),
    ).not.toThrow();
    expect(() =>
      extractCodexEmbeddedCatalog(embed('{\n  "models": [],\n  "models": 5 }')),
    ).toThrow(/no `models` array/);
  });

  it("picks the listed entry with the lowest priority, skipping hidden ones", () => {
    expect(codexEmbeddedDefault(catalog)).toEqual({ slug: "gpt-6-astra", priority: 1 });
    expect(
      codexEmbeddedDefault({
        models: [
          { slug: "b", priority: 2 },
          { slug: "a", priority: 1, visibility: "hide" },
          { slug: "c", priority: "1" },
          { slug: "", priority: 0 },
          { slug: "d", priority: 3, visibility: "list" },
        ],
      }),
    ).toEqual({ slug: "b", priority: 2 });
  });

  it("fails when the catalog lists nothing it can rank", () => {
    expect(() => codexEmbeddedDefault({ models: [] })).toThrow(/lists no model with a priority/);
    expect(() =>
      codexEmbeddedDefault({ models: [{ slug: "hidden", priority: 1, visibility: "hide" }] }),
    ).toThrow(/lists no model with a priority/);
  });

  it("stays quiet when both CLIs embed the same default", () => {
    expect(
      compareCodexDefaults(
        { model: "gpt-6-astra", version: "0.155.1" },
        { model: "gpt-6-astra", version: "0.156.0" },
      ),
    ).toEqual([]);
  });

  it("reports a changed default with both versions, before staleness would fire", () => {
    expect(
      compareCodexDefaults(
        { model: "gpt-5.6-sol", version: "0.153.0" },
        { model: "gpt-6-astra", version: "0.153.1" },
      ),
    ).toEqual([
      {
        pinned: "gpt-5.6-sol",
        latest: "gpt-6-astra",
        pinnedVersion: "0.153.0",
        latestVersion: "0.153.1",
      },
    ]);
  });

  it("fails when either probe lacks a model or a version", () => {
    const ok = { model: "gpt-6-astra", version: "0.155.1" };
    expect(() => compareCodexDefaults({ model: "", version: "0.155.1" }, ok)).toThrow(
      /pinned Codex default probe did not resolve a model/,
    );
    expect(() => compareCodexDefaults(ok, undefined)).toThrow(
      /latest Codex default probe did not resolve a model/,
    );
    expect(() => compareCodexDefaults(ok, { model: "gpt-6-astra", version: " " })).toThrow(
      /latest Codex default probe did not report a version/,
    );
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

  it("stays quiet on the day upstream publishes past the pin", () => {
    // @anthropic-ai/claude-code ships 6 to 8 releases a week on one minor, so
    // a few patches ahead is the normal state of a pin bumped this week.
    // Reporting on "something newer exists" is a notice a day, which is the
    // noise these thresholds exist to avoid.
    expect(
      npmStaleness({
        pinned: "2.1.250",
        latest: "2.1.253",
        pinnedAt: daysAgo(1),
        versions: patches("2.1", 254),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("fires on patch distance long before the age clock runs out", () => {
    // The 2026-09-19 miss: 2.1.260 against 2.1.278 is 18 patches and zero
    // newer minors, with 5 days still to run on MAX_PIN_AGE_DAYS.
    const verdict = npmStaleness({
      pinned: "2.1.260",
      latest: "2.1.278",
      pinnedAt: daysAgo(16),
      versions: patches("2.1", 279),
      now: NOW,
    });
    expect(verdict?.ageDays).toBe(16);
    // No newer MINOR line: claude-code stays on 2.1.
    expect(verdict?.minorsAhead).toBe(0);
    expect(verdict?.patchesAhead).toBe(18);
    expect(verdict?.reasons).toEqual(["18 newer patches on 2.1"]);
  });

  it("fires on age when a slow line never reaches the patch threshold", () => {
    const verdict = npmStaleness({
      pinned: "2.1.259",
      latest: "2.1.261",
      pinnedAt: daysAgo(23),
      versions: patches("2.1", 262),
      now: NOW,
    });
    expect(verdict?.ageDays).toBe(23);
    expect(verdict?.patchesAhead).toBe(2);
    expect(verdict?.reasons).toEqual(["pinned 23 days ago"]);
  });

  it("counts only the pin's own minor line, and no prereleases", () => {
    // A patch on a LATER minor is that minor's business, and an alpha is never
    // what the Dockerfile installs. Both would otherwise carry this past the
    // threshold on their own.
    const verdict = npmStaleness({
      pinned: "0.146.0",
      latest: "0.147.4",
      pinnedAt: daysAgo(1),
      versions: [
        ...patches("0.146", 4),
        "0.146.4-alpha.1",
        "0.146.5-rc.1",
        ...patches("0.147", 5),
      ],
      now: NOW,
    });
    // 0.146.1 through 0.146.3 only, so under MAX_PATCHES_BEHIND.
    expect(verdict).toBeNull();
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
