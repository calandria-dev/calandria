import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractPins,
  extractPackagePins,
  npmPinEntries,
  npmStaleness,
  codexTargetVersion,
  compareClaudeAliasResolutions,
  CLAUDE_PROBE_ALIASES,
  extractCodexEmbeddedCatalog,
  codexEmbeddedDefault,
  compareCodexDefaults,
  npmBumpPlan,
  applyNpmDockerfilePins,
  applyNpmPackagePins,
  withCodexEmbeddedDefault,
  applyCodexEmbeddedDefault,
  CODEX_EMBEDDED_DEFAULT_JSON,
  CODEX_PRICING_TS,
  codexPricePrefixes,
  codexPricedPrefix,
  holdUnpricedCodexBump,
  applyDefaultCodexModel,
} from "../scripts/check-pin-drift.mjs";
import { codexPriceRow, DEFAULT_CODEX_MODEL } from "../lib/agents/codex/pricing";

const ROOT = path.join(__dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const PIN_WORKFLOW = path.join(ROOT, ".github/workflows/pin-drift.yml");
const EMBEDDED_DEFAULT = path.join(ROOT, CODEX_EMBEDDED_DEFAULT_JSON);
const MODEL_PROBE = path.join(ROOT, "lib/agents/claude/modelProbe.ts");

/**
 * scripts/check-pin-drift.mjs reads the Dockerfile with regexes, and the only
 * other place those regexes run is a cron. Renaming an ARG would leave the
 * check exiting 2 every hour, with nobody watching for it. These cases fail
 * here instead, on the PR that does it.
 *
 * This is the pure extraction half, hermetic and independent of network
 * access. The network half is exercised by running the script.
 */
describe("pin drift extraction", () => {
  const source = readFileSync(DOCKERFILE, "utf8");

  it("finds every pin it claims to watch in the real Dockerfile", () => {
    const pins = extractPins(source, "Dockerfile");

    expect(pins.gh.value).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.claudeCode.value).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.codexVersion.value).toMatch(/^\d+\.\d+\.\d+/);

    // Every `where` is a real line, so an issue body can be clicked through.
    const lineCount = source.split("\n").length;
    for (const where of [
      pins.gh.where,
      pins.claudeCode.where,
      pins.codexVersion.where,
    ]) {
      const line = Number(where.split(":")[1]);
      expect(line).toBeGreaterThan(0);
      expect(line).toBeLessThanOrEqual(lineCount);
    }
  });

  it("reads the gh pin off ARG GH_VERSION", () => {
    const pins = extractPins(source, "Dockerfile");
    const line = source.split("\n")[Number(pins.gh.where.split(":")[1]) - 1];
    expect(line).toBe(`ARG GH_VERSION=${pins.gh.value}`);
  });

  it("does not watch agy, which the image installs unpinned", () => {
    const pins = extractPins(source, "Dockerfile");
    expect(Object.keys(pins).sort()).toEqual(["claudeCode", "codexVersion", "gh"]);
  });

  it("fails loudly when a pin it watches has been renamed away", () => {
    const renamed = source.replace("ARG GH_VERSION=", "ARG GITHUB_CLI_VERSION=");
    // Guard against the replace matching nothing and leaving the source unchanged.
    expect(renamed).not.toBe(source);
    expect(() => extractPins(renamed, "Dockerfile")).toThrow(/GH_VERSION/);
  });
});

describe("npm CLI bump", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const packageJson = readFileSync(PACKAGE_JSON, "utf8");
  const pins = extractPins(dockerfile, "Dockerfile");

  const packagePins = extractPackagePins(packageJson, "package.json");

  it("selects only stale CLI pins when no package pins are passed", () => {
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

  it("plans the Agent SDK bump from package.json's pin", () => {
    const plan = npmBumpPlan(
      pins,
      { "@anthropic-ai/claude-agent-sdk": "9.9.9" },
      [{ pkg: "@anthropic-ai/claude-agent-sdk" }],
      packagePins,
    );
    expect(plan).toEqual({ sdkVersion: "9.9.9" });
  });

  it("plans nothing for an SDK that is not stale or already at the version", () => {
    expect(
      npmBumpPlan(pins, { "@anthropic-ai/claude-agent-sdk": "9.9.9" }, [], packagePins),
    ).toBeNull();
    expect(
      npmBumpPlan(
        pins,
        { "@anthropic-ai/claude-agent-sdk": packagePins["@anthropic-ai/claude-agent-sdk"].value },
        [{ pkg: "@anthropic-ai/claude-agent-sdk" }],
        packagePins,
      ),
    ).toBeNull();
  });

  it("rejects an SDK version that is not exact semver", () => {
    expect(() =>
      npmBumpPlan(
        pins,
        { "@anthropic-ai/claude-agent-sdk": "9.9.9-beta" },
        [{ pkg: "@anthropic-ai/claude-agent-sdk" }],
        packagePins,
      ),
    ).toThrow(/exact stable semver/);
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
    expect(rewritten.gh.value).toBe(pins.gh.value);
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

  it("updates the Agent SDK in package.json and touches nothing else", () => {
    const SDK = "@anthropic-ai/claude-agent-sdk";
    const applied = applyNpmPackagePins(packageJson, { sdkVersion: "9.9.9" });
    expect(applied.changed).toBe(true);
    const before = JSON.parse(packageJson);
    const after = JSON.parse(applied.source);
    expect(after.dependencies[SDK]).toBe("9.9.9");
    expect(after).toEqual({
      ...before,
      dependencies: { ...before.dependencies, [SDK]: "9.9.9" },
    });
    expect(applyNpmPackagePins(applied.source, { sdkVersion: "9.9.9" })).toEqual({
      source: applied.source,
      changed: false,
    });
    expect(() =>
      applyNpmPackagePins(packageJson.replace(`"${SDK}"`, '"@anthropic-ai/agent-sdk"'), {
        sdkVersion: "9.9.9",
      }),
    ).toThrow(/claude-agent-sdk/);
    expect(() => applyNpmPackagePins(packageJson, { sdkVersion: "^9.9.9" })).toThrow(
      /valid exact version/,
    );
  });

  it("moves the Codex SDK and the Agent SDK in one write", () => {
    const applied = applyNpmPackagePins(packageJson, {
      codexVersion: "8.8.8",
      sdkVersion: "9.9.9",
    });
    const deps = JSON.parse(applied.source).dependencies;
    expect(deps["@openai/codex-sdk"]).toBe("8.8.8");
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toBe("9.9.9");
  });
});

describe("Codex bump target", () => {
  const versions = {
    "0.200.0": { dependencies: { "@openai/codex": "0.199.0" } },
    "0.201.0": { dependencies: { "@openai/codex": "0.201.0" } },
    "0.202.0": { dependencies: {} },
  };

  it("is the SDK's latest when it depends on the same CLI version", () => {
    expect(codexTargetVersion("0.201.0", versions)).toBe("0.201.0");
  });

  it("waits when the SDK depends on a different CLI version", () => {
    expect(codexTargetVersion("0.200.0", versions)).toBeNull();
  });

  it("waits when the SDK names no CLI dependency or is unknown", () => {
    expect(codexTargetVersion("0.202.0", versions)).toBeNull();
    expect(codexTargetVersion("0.300.0", versions)).toBeNull();
    expect(codexTargetVersion("0.201.0", undefined)).toBeNull();
  });
});

describe("Codex embedded default on a bump", () => {
  const recorded = readFileSync(EMBEDDED_DEFAULT, "utf8");

  it("carries the latest probe's model into a plan that moves CODEX_VERSION", () => {
    expect(
      withCodexEmbeddedDefault(
        { claudeCode: "9.9.9", codexVersion: "8.8.8" },
        { version: "8.8.8", model: " gpt-7 " },
      ),
    ).toEqual({ claudeCode: "9.9.9", codexVersion: "8.8.8", codexModel: "gpt-7" });
  });

  it("leaves a plan without a Codex bump alone", () => {
    const latest = { version: "8.8.8", model: "gpt-7" };
    expect(withCodexEmbeddedDefault(null, latest)).toBeNull();
    expect(withCodexEmbeddedDefault({ claudeCode: "9.9.9" }, latest)).toEqual({
      claudeCode: "9.9.9",
    });
  });

  it("refuses a probe of a different version or with no model", () => {
    expect(() =>
      withCodexEmbeddedDefault(
        { codexVersion: "8.8.8" },
        { version: "8.8.9", model: "gpt-7" },
      ),
    ).toThrow(/8\.8\.9.*8\.8\.8/);
    expect(() =>
      withCodexEmbeddedDefault({ codexVersion: "8.8.8" }, { version: "8.8.8", model: " " }),
    ).toThrow(/did not resolve a model/);
  });

  it("rewrites the recorded version and model together", () => {
    const applied = applyCodexEmbeddedDefault(recorded, {
      codexVersion: "8.8.8",
      codexModel: "gpt-7",
    });
    expect(applied.changed).toBe(true);
    expect(applied.source.endsWith("}\n")).toBe(true);
    expect(JSON.parse(applied.source)).toEqual({
      ...JSON.parse(recorded),
      codexVersion: "8.8.8",
      model: "gpt-7",
    });
    expect(
      applyCodexEmbeddedDefault(applied.source, {
        codexVersion: "8.8.8",
        codexModel: "gpt-7",
      }),
    ).toEqual({ source: applied.source, changed: false });
  });

  it("moves only the version when the model is unchanged", () => {
    const { model } = JSON.parse(recorded);
    const applied = applyCodexEmbeddedDefault(recorded, {
      codexVersion: "8.8.8",
      codexModel: model,
    });
    expect(JSON.parse(applied.source)).toEqual({ codexVersion: "8.8.8", model });
  });

  it("writes nothing for a plan that does not move CODEX_VERSION", () => {
    expect(applyCodexEmbeddedDefault(recorded, { claudeCode: "9.9.9" })).toEqual({
      source: recorded,
      changed: false,
    });
  });

  it("refuses a Codex bump that carries no probed model", () => {
    expect(() =>
      applyCodexEmbeddedDefault(recorded, { codexVersion: "8.8.8" }),
    ).toThrow(/no probed model/);
    expect(() =>
      applyCodexEmbeddedDefault("not json", {
        codexVersion: "8.8.8",
        codexModel: "gpt-7",
      }),
    ).toThrow(/not JSON/);
  });

  it("is committed by the workflow alongside the Dockerfile", () => {
    const workflow = readFileSync(PIN_WORKFLOW, "utf8");
    expect(workflow).toMatch(/git add [^\n]*lib\/agents\/codex\/embeddedDefault\.json/);
    expect(workflow).toMatch(/git diff --quiet -- [^\n]*lib\/agents\/codex\/embeddedDefault\.json/);
  });

  it("commits the rewritten default model in pricing.ts too", () => {
    const workflow = readFileSync(PIN_WORKFLOW, "utf8");
    expect(workflow).toMatch(/git add [^\n]*lib\/agents\/codex\/pricing\.ts/);
    expect(workflow).toMatch(/git diff --quiet -- [^\n]*lib\/agents\/codex\/pricing\.ts/);
  });
});

describe("Codex default model and pricing on a bump", () => {
  const pricingSource = readFileSync(path.join(ROOT, CODEX_PRICING_TS), "utf8");
  const realPrefixes = codexPricePrefixes(pricingSource);
  const synthetic = ["gpt-6.1-sol", "gpt-5.4-mini", "gpt-5.4", "gpt-5"];

  it("parses the same prefixes the TS table holds", () => {
    expect(realPrefixes.length).toBeGreaterThan(0);
    for (const p of realPrefixes) expect(codexPriceRow(p)?.prefix).toBe(p);
  });

  it("prices an exact row id and a dated suffix, not a catch-all or an unknown", () => {
    expect(codexPricedPrefix("gpt-6.1-sol", synthetic)).toBe("gpt-6.1-sol");
    expect(codexPricedPrefix("gpt-5.4-mini-2026-03-01", synthetic)).toBe("gpt-5.4-mini");
    expect(codexPricedPrefix("gpt-5.7", synthetic)).toBeNull();
    expect(codexPricedPrefix("gpt-9-nova", synthetic)).toBeNull();
    expect(codexPricedPrefix(DEFAULT_CODEX_MODEL, realPrefixes)).not.toBeNull();
  });

  it("passes a priced bump through and holds an unpriced one", () => {
    const priced = { codexVersion: "1.0.0", codexModel: "gpt-6.1-sol" };
    expect(holdUnpricedCodexBump(priced, synthetic)).toEqual({ plan: priced, unpriced: null });

    const unpriced = { codexVersion: "1.0.0", codexModel: "gpt-9-nova" };
    expect(holdUnpricedCodexBump(unpriced, synthetic)).toEqual({
      plan: null,
      unpriced: { version: "1.0.0", model: "gpt-9-nova" },
    });
    expect(holdUnpricedCodexBump({ ...unpriced, claudeCode: "2.0.0" }, synthetic)).toEqual({
      plan: { claudeCode: "2.0.0" },
      unpriced: { version: "1.0.0", model: "gpt-9-nova" },
    });
    expect(holdUnpricedCodexBump(null, synthetic)).toEqual({ plan: null, unpriced: null });
    const noCodex = { claudeCode: "2.0.0" };
    expect(holdUnpricedCodexBump(noCodex, synthetic)).toEqual({ plan: noCodex, unpriced: null });
  });

  it("rewrites DEFAULT_CODEX_MODEL to another priced model and touches one line", () => {
    const other = realPrefixes.find((p) => p !== DEFAULT_CODEX_MODEL)!;
    const out = applyDefaultCodexModel(pricingSource, { codexVersion: "1.0.0", codexModel: other });
    expect(out.changed).toBe(true);
    expect(out.source).toContain(`export const DEFAULT_CODEX_MODEL = "${other}";`);
    const before = pricingSource.split("\n");
    const after: string[] = out.source.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
  });

  it("leaves the source alone when the model is unchanged or the plan has no Codex bump", () => {
    const same = applyDefaultCodexModel(pricingSource, {
      codexVersion: "1.0.0",
      codexModel: DEFAULT_CODEX_MODEL,
    });
    expect(same).toEqual({ source: pricingSource, changed: false });
    expect(applyDefaultCodexModel(pricingSource, { claudeCode: "2.0.0" })).toEqual({
      source: pricingSource,
      changed: false,
    });
  });

  it("refuses an unpriced model and a source without the constant", () => {
    expect(() =>
      applyDefaultCodexModel(pricingSource, { codexVersion: "1.0.0", codexModel: "gpt-9-nova" }),
    ).toThrow(/no row in the PRICES table/);
    expect(() =>
      applyDefaultCodexModel("const PRICES = [];\n", {
        codexVersion: "1.0.0",
        codexModel: "gpt-6.1-sol",
      }),
    ).toThrow(/DEFAULT_CODEX_MODEL/);
  });
});

describe("pin drift workflow", () => {
  const workflow = readFileSync(PIN_WORKFLOW, "utf8");

  it("applies the npm plan and repairs the lockfile for Codex and the Agent SDK", () => {
    expect(workflow).toContain("--update-npm");
    expect(workflow).toContain("--apply-npm");
    expect(workflow).toContain("npm install --package-lock-only");
    expect(workflow).toContain("npm run fix-lockfile");
    expect(workflow).toContain('if [ -n "$CODEX_VERSION" ] || [ -n "$SDK_VERSION" ]; then');
    expect(workflow).toContain("sdk_version=$(jq -r '.sdkVersion // empty'");
    expect(workflow).toContain("build(deps): bump Claude Agent SDK to $SDK_VERSION");
  });

  it("runs hourly and has no agy machinery", () => {
    expect(workflow).toContain('cron: "17 * * * *"');
    expect(workflow).not.toMatch(/--(update|apply)-agy|--agy-summary|AGY_CHANGED|steps\.agy/);
  });

  it("skips the push when the branch already proposes the same pins", () => {
    expect(workflow).toContain("proposal()");
    expect(workflow).toContain("git diff -U0");
    expect(workflow).toContain("already proposes these pins; leaving its head in place");
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

  it("installs isolated Codex probes from the Dockerfile pin and the SDK-gated target", () => {
    expect(workflow).toMatch(/\$2 ~ \/\^CODEX_VERSION=\/ \{/);
    expect(workflow).toContain('latest="$(npm view @openai/codex-sdk version)"');
    expect(workflow).toContain('if [ "$wants" != "$latest" ]; then');
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
 * `@anthropic-ai/claude-agent-sdk` is bumped too, and it is the one pin with
 * no Dockerfile ARG: the image installs no copy of it, so it is read out of
 * package.json `dependencies` instead.
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
    // staleness rule and the same report tables.
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

  it("is stale on any newer stable release, even one patch ahead", () => {
    expect(npmStaleness({ pinned: "0.3.159", latest: "0.3.160" })?.reasons).toEqual([
      "latest is 0.3.160",
    ]);
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

/**
 * An npm pin is stale as soon as the registry's `latest` is a stable version
 * above it. The bump PR moves it, so the rule has no thresholds to tune.
 */
describe("npmStaleness", () => {
  it("says nothing when the pin is the latest", () => {
    expect(npmStaleness({ pinned: "2.1.259", latest: "2.1.259" })).toBeNull();
  });

  it("is stale when the latest stable release is newer", () => {
    expect(npmStaleness({ pinned: "2.1.250", latest: "2.1.310" })).toEqual({
      reasons: ["latest is 2.1.310"],
    });
    expect(npmStaleness({ pinned: "0.146.0", latest: "0.147.0" })?.reasons).toEqual([
      "latest is 0.147.0",
    ]);
  });

  it("compares numerically, not as strings", () => {
    expect(npmStaleness({ pinned: "2.1.99", latest: "2.1.100" })).not.toBeNull();
    expect(npmStaleness({ pinned: "2.1.100", latest: "2.1.99" })).toBeNull();
  });

  it("ignores a latest that is a prerelease or older than the pin", () => {
    expect(npmStaleness({ pinned: "0.146.0", latest: "0.147.0-alpha.1" })).toBeNull();
    expect(npmStaleness({ pinned: "0.146.0", latest: "0.145.9" })).toBeNull();
  });
});
