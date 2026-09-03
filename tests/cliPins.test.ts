import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { extractPins } from "../scripts/check-pin-drift.mjs";

const ROOT = path.join(__dirname, "..");
const read = (file: string) =>
  JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));

const pkg = read("package.json");
const lock = read("package-lock.json");
const pins = extractPins(
  readFileSync(path.join(ROOT, "Dockerfile"), "utf8"),
  "Dockerfile",
);

/**
 * The Codex CLI version is written down in four places that drift
 * independently, and nothing at build time compares them. This is the cheap
 * check that does, on the PR that desynchronizes them rather than on a cron.
 *
 * Why it matters that they agree, rather than merely being close: the SDK
 * speaks JSONL to one exact binary, and WHICH binary that is depends on where
 * Calandria is running. In the image, `ENV CODEX_CLI_PATH=/usr/local/bin/codex`
 * points at the globally installed `@openai/codex@${CODEX_VERSION}`, so the
 * Dockerfile ARG is what runs a turn. Outside it — `npm run dev`, the test
 * suite, a non-Docker install — CODEX_CLI_PATH is empty and the SDK falls back
 * to the copy it exact-depends on in `node_modules`. Let the two diverge and
 * development and production drive different CLI versions, which is precisely
 * the skew the Dockerfile comment warns about and nothing enforces.
 *
 * `.github/workflows/pin-drift.yml` is the other half, and cannot cover this:
 * it reads upstreams, so it can say a pin is behind but never that two of our
 * own files disagree.
 */
describe("Codex CLI pins", () => {
  const declared = pkg.dependencies["@openai/codex-sdk"];

  it("pins @openai/codex-sdk exactly, with no range", () => {
    // A caret lets `npm install` float the SDK a patch, which silently
    // desynchronizes it from ARG CODEX_VERSION — the failure this whole file
    // exists for. Exact means a bump is an edit somebody reviewed.
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps package.json, the lockfile and ARG CODEX_VERSION on one version", () => {
    expect(lock.packages[""].dependencies["@openai/codex-sdk"]).toBe(declared);
    expect(lock.packages["node_modules/@openai/codex-sdk"].version).toBe(
      declared,
    );
    expect(pins.codexVersion.value).toBe(declared);
  });

  it("installs the CLI version the SDK actually asks for", () => {
    // Read the coupling off the SDK rather than assuming its version number
    // equals the CLI's. @openai/codex-sdk exact-depends on @openai/codex, so
    // this is the version the SDK will drive when CODEX_CLI_PATH is empty, and
    // the Dockerfile has to install the same one.
    const wants =
      lock.packages["node_modules/@openai/codex-sdk"].dependencies[
        "@openai/codex"
      ];
    expect(wants).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages["node_modules/@openai/codex"].version).toBe(wants);
    expect(pins.codexVersion.value).toBe(wants);
  });

  it("moves every platform binary with it", () => {
    // The CLI ships its native builds as separate optional packages tagged
    // `<version>-<platform>`. A lockfile edited by hand, or refreshed only
    // partly, leaves these behind and the image installs a mismatched binary.
    const platforms = Object.entries(lock.packages).filter(([name]) =>
      /^node_modules\/@openai\/codex-(darwin|linux|win32)-/.test(name),
    );
    expect(platforms.length).toBeGreaterThan(0);
    for (const [name, entry] of platforms) {
      expect(`${name} ${(entry as { version: string }).version}`).toContain(
        `${declared}-`,
      );
    }
  });
});

describe("Claude CLI pin", () => {
  it("pins an exact CLAUDE_CODE_VERSION", () => {
    expect(pins.claudeCode.value).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has no version to couple @anthropic-ai/claude-agent-sdk to", () => {
    // Deliberately asymmetric with Codex above, and worth stating so nobody
    // adds the "missing" equality check: the Agent SDK declares no dependency
    // on @anthropic-ai/claude-code and is versioned on its own line (0.3.x
    // against 2.1.x), so there is no version the two must share. It spawns
    // whatever CLAUDE_CLI_PATH resolves to, which the image installs from
    // CLAUDE_CODE_VERSION. Compatibility between them is a behavioural
    // question, settled by exercising a turn at bump time, not by a file
    // comparison.
    const deps = lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"]
      .dependencies as Record<string, string> | undefined;
    expect(deps?.["@anthropic-ai/claude-code"]).toBeUndefined();
    expect(pkg.dependencies["@anthropic-ai/claude-code"]).toBeUndefined();
  });
});
