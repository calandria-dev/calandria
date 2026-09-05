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
 * The Codex CLI version is written down in four places that can drift
 * independently, with nothing at build time comparing them. This check
 * catches a mismatch on the PR that causes it.
 *
 * The SDK speaks JSONL to one exact binary, and which binary that is depends
 * on where Calandria is running. In the image, `ENV CODEX_CLI_PATH=/usr/local/bin/codex`
 * points at the globally installed `@openai/codex@${CODEX_VERSION}`, so the
 * Dockerfile ARG is what runs a turn. Outside it, in `npm run dev`, the test
 * suite, or a non-Docker install, CODEX_CLI_PATH is empty and the SDK falls
 * back to the copy it depends on exactly in `node_modules`. If the two
 * diverge, development and production run different CLI versions.
 *
 * `.github/workflows/pin-drift.yml` covers upstream pins and cannot catch
 * this: it can say a pin is behind but not that two of our own files
 * disagree.
 */
describe("Codex CLI pins", () => {
  const declared = pkg.dependencies["@openai/codex-sdk"];

  it("pins @openai/codex-sdk exactly, with no range", () => {
    // A caret lets `npm install` float the SDK a patch, desynchronizing it
    // from ARG CODEX_VERSION. An exact pin means a bump is a reviewed edit.
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
    // The coupling is read off the SDK's own dependency, not assumed from its
    // version number. @openai/codex-sdk depends exactly on @openai/codex, so
    // this is the version the SDK drives when CODEX_CLI_PATH is empty, and the
    // Dockerfile must install the same one.
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
    // `<version>-<platform>`. A lockfile edited by hand, or only partly
    // refreshed, leaves these behind, and the image installs a mismatched
    // binary.
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
    // Asymmetric with Codex above: the Agent SDK declares no dependency on
    // @anthropic-ai/claude-code and is versioned on its own line (0.3.x
    // against 2.1.x), so there is no version the two must share. It spawns
    // whatever CLAUDE_CLI_PATH resolves to, which the image installs from
    // CLAUDE_CODE_VERSION. Compatibility between them is a behavioral
    // question, verified by exercising a turn at bump time.
    const deps = lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"]
      .dependencies as Record<string, string> | undefined;
    expect(deps?.["@anthropic-ai/claude-code"]).toBeUndefined();
    expect(pkg.dependencies["@anthropic-ai/claude-code"]).toBeUndefined();
  });
});
