// The Claude model picker, when the instance routes through Vertex.
//
// The shape asserted here is MEASURED, not inferred. Every value in the catalog
// was probed with a one-shot `claude -p --model <value>` against Vertex project
// example-vertex-project (region global, CLI 2.1.228), reading the resolved
// id back out of the run's `modelUsage`, and cross-checked with a direct
// rawPredict to the Vertex REST endpoint. What that found:
//
//   fable                 403 — publisher data sharing not enabled on the project
//   opus                  -> claude-opus-5[1m]      (1M)
//   sonnet                -> claude-sonnet-5[1m]    (1M)
//   haiku                 -> claude-haiku-4-5@20251001 (200k)
//   opusplan              -> claude-sonnet-5[1m]    (1M, post-plan)
//   opus[1m]              -> claude-opus-5[1m]      (1M, same string as `opus`)
//   sonnet[1m]            -> claude-sonnet-5[1m]    (1M, same string as `sonnet`)
//   opusplan[1m]          -> claude-sonnet-5[1m]    (1M)
//   claude-opus-4-8       -> claude-opus-4-8        (200k)
//   claude-opus-4-8[1m]   -> claude-opus-4-8[1m]    (1M)
//   claude-sonnet-4-6     -> claude-sonnet-4-6      (200k)
//   claude-sonnet-4-6[1m] -> claude-sonnet-4-6[1m]  (1M)
//   claude-opus-4-7       -> claude-opus-4-7        (200k)
//   claude-opus-4-6       -> claude-opus-4-6        (200k)
//
// The headline is the negative result: the bare pinned ids DO resolve on Vertex,
// so the "Pinned versions" group must survive untouched. The `@version` suffix
// (claude-haiku-4-5@20251001) is an optional pin there, not a required spelling.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AgentCapabilities, AgentModelOption } from "@/lib/agents/types";
import { CLAUDE_CAPABILITIES, claudeCapabilities } from "@/lib/agents/claude/capabilities";
import { configuredProvider, claudeDefaultModels } from "@/lib/agents/claude/provider";

const K200 = 200_000;
const M1 = 1_000_000;

let dir: string;
/** A config dir holding the given settings.json (or none at all). */
function configDir(settings?: unknown): string {
  const d = fs.mkdtempSync(path.join(dir, "cfg-"));
  if (settings !== undefined) fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings));
  return d;
}

// This machine's real configuration, as the probes found it.
const VERTEX_SETTINGS = {
  env: {
    CLAUDE_CODE_USE_VERTEX: "1",
    CLOUD_ML_REGION: "global",
    ANTHROPIC_VERTEX_PROJECT_ID: "example-vertex-project",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5@20251001",
  },
};

const optionFor = (caps: AgentCapabilities, value: string): AgentModelOption =>
  caps.models.find((m) => m.value === value)!;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-vertex-caps-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("configuredProvider", () => {
  it("defaults to the plain Anthropic path with no provider config anywhere", () => {
    expect(configuredProvider({ CLAUDE_CONFIG_DIR: configDir() })).toBe("anthropic");
  });

  it("reads the flag out of ~/.claude/settings.json, not just the process env", () => {
    expect(configuredProvider({ CLAUDE_CONFIG_DIR: configDir(VERTEX_SETTINGS) })).toBe("vertex");
  });

  it("also honors the flag from the process env, for container deployments that ship no settings.json", () => {
    expect(configuredProvider({ CLAUDE_CONFIG_DIR: configDir(), CLAUDE_CODE_USE_VERTEX: "1" })).toBe("vertex");
    expect(configuredProvider({ CLAUDE_CONFIG_DIR: configDir(), CLAUDE_CODE_USE_BEDROCK: "true" })).toBe("bedrock");
  });

  it("treats an off-ish flag value as not configured", () => {
    expect(configuredProvider({ CLAUDE_CONFIG_DIR: configDir(), CLAUDE_CODE_USE_VERTEX: "0" })).toBe("anthropic");
  });
});

describe("claudeDefaultModels", () => {
  // MEASURED precedence, and the reason this isn't just process.env: exporting
  // ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8 into the process while
  // settings.json said claude-opus-5[1m] still ran claude-opus-5[1m]. Reading
  // these the other way round would make the picker name a model the turn
  // won't use.
  it("lets the settings.json env block win over the process env", () => {
    const mapped = claudeDefaultModels({
      CLAUDE_CONFIG_DIR: configDir(VERTEX_SETTINGS),
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
    });
    expect(mapped.opus).toBe("claude-opus-5[1m]");
  });

  it("falls back to the process env when settings.json doesn't map the family", () => {
    const mapped = claudeDefaultModels({
      CLAUDE_CONFIG_DIR: configDir({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }),
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
    });
    expect(mapped.opus).toBe("claude-opus-4-8");
  });
});

describe("claudeCapabilities on a plain Anthropic login", () => {
  it("returns the built-in catalog untouched, so a subscription user sees no change", () => {
    expect(claudeCapabilities({ CLAUDE_CONFIG_DIR: configDir() })).toBe(CLAUDE_CAPABILITIES);
  });

  // No Bedrock instance exists to measure against, and upstream's Bedrock list
  // drops the [1m] variants that demonstrably work on Vertex — so Bedrock is
  // deliberately left on the default catalog rather than guessed at.
  it("leaves Bedrock on the default catalog rather than guessing at an unmeasured list", () => {
    const caps = claudeCapabilities({ CLAUDE_CONFIG_DIR: configDir(), CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(caps).toBe(CLAUDE_CAPABILITIES);
  });
});

describe("claudeCapabilities on Vertex", () => {
  let caps: ReturnType<typeof claudeCapabilities>;
  beforeAll(() => {
    caps = claudeCapabilities({ CLAUDE_CONFIG_DIR: configDir(VERTEX_SETTINGS) });
  });

  it("drops only fable — every value measured as working is still offered", () => {
    expect(caps.models.map((m) => m.value)).toEqual(
      CLAUDE_CAPABILITIES.models.map((m) => m.value).filter((v) => v !== "fable")
    );
  });

  it("does not disturb anything but the model list", () => {
    expect(caps.permissionModes).toBe(CLAUDE_CAPABILITIES.permissionModes);
    expect(caps.reasoningOptions).toBe(CLAUDE_CAPABILITIES.reasoningOptions);
    expect(caps.loginStyle).toBe(CLAUDE_CAPABILITIES.loginStyle);
  });

  // The headline finding: the suspicion that bare Anthropic ids need an
  // `@version` suffix on Vertex is FALSE. All six pinned entries ran.
  it("leaves the pinned-version group exactly as it is — bare ids do resolve on Vertex", () => {
    for (const value of [
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-opus-4-7",
      "claude-opus-4-6",
    ]) {
      expect(optionFor(caps, value)).toEqual(optionFor(CLAUDE_CAPABILITIES, value));
    }
  });

  // The bug worth fixing: contextWindow feeds the context gauge and the
  // overflow notice, and a mapping carrying [1m] makes the bare alias 1M.
  it("gives the family aliases the window of the id they actually resolve to", () => {
    expect(optionFor(CLAUDE_CAPABILITIES, "opus").contextWindow).toBe(K200); // what the catalog claims
    expect(optionFor(caps, "opus").contextWindow).toBe(M1); // what the turn really gets
    expect(optionFor(caps, "sonnet").contextWindow).toBe(M1);
    expect(optionFor(caps, "haiku").contextWindow).toBe(K200);
  });

  it("labels each alias with the id it resolves to", () => {
    expect(optionFor(caps, "opus").sub).toBe("claude-opus-5[1m]");
    expect(optionFor(caps, "sonnet").sub).toBe("claude-sonnet-5[1m]");
    expect(optionFor(caps, "haiku").sub).toBe("claude-haiku-4-5@20251001");
  });

  // "Opus 5" is a guess about where the mapping points; the subtitle carries
  // the measured answer, so the label must stop claiming a version.
  it("drops the version claim from an alias label, but keeps it on a real pin", () => {
    expect(optionFor(CLAUDE_CAPABILITIES, "opus").label).toBe("Opus 5");
    expect(optionFor(caps, "opus").label).toBe("Opus (provider default)");
    expect(optionFor(caps, "haiku").label).toBe("Haiku (provider default)");
    expect(optionFor(caps, "opus[1m]").label).toBe("Opus (1M)");
    expect(optionFor(caps, "claude-opus-4-8").label).toBe("Opus 4.8");
  });

  // opusplan plans on Opus and runs on Sonnet afterwards; probing it resolved
  // the sonnet mapping, so the session's window is Sonnet's.
  it("follows the sonnet mapping for opusplan, which is what runs after the plan", () => {
    expect(optionFor(caps, "opusplan").sub).toBe("claude-sonnet-5[1m]");
    expect(optionFor(caps, "opusplan").contextWindow).toBe(M1);
  });

  it("says so when a [1m] entry is the same model string as its bare alias", () => {
    expect(optionFor(caps, "opus[1m]").sub).toContain("same as opus");
    expect(optionFor(caps, "sonnet[1m]").sub).toContain("same as sonnet");
  });

  // The one entry that genuinely fails here (403, publisher data sharing not
  // enabled). Dropped rather than labeled: on this fork Fable arrives with the
  // direct-platform arrangement with Anthropic, not by flipping a GCP setting,
  // so until then it would 403 every turn it was picked for.
  it("drops fable, which 403s on this project", () => {
    expect(caps.models.find((m) => m.value === "fable")).toBeUndefined();
    // still offered on the plain Anthropic path, where it works
    expect(optionFor(CLAUDE_CAPABILITIES, "fable").label).toBe("Fable 5");
  });

  it("leaves an unmapped family alone rather than inventing a resolution for it", () => {
    const partial = claudeCapabilities({
      CLAUDE_CONFIG_DIR: configDir({
        env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]" },
      }),
    });
    expect(optionFor(partial, "opus").contextWindow).toBe(M1);
    // sonnet/haiku unmapped: the CLI picks its own built-in default, which we
    // can't name, so the catalog entry stands.
    expect(optionFor(partial, "sonnet")).toEqual(optionFor(CLAUDE_CAPABILITIES, "sonnet"));
    expect(optionFor(partial, "haiku")).toEqual(optionFor(CLAUDE_CAPABILITIES, "haiku"));
  });

  it("tracks a mapping that is NOT 1M, rather than assuming this machine's", () => {
    const narrow = claudeCapabilities({
      CLAUDE_CONFIG_DIR: configDir({
        env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8" },
      }),
    });
    expect(optionFor(narrow, "opus").contextWindow).toBe(K200);
    expect(optionFor(narrow, "opus").sub).toBe("claude-opus-4-8");
    // With a 200k mapping the [1m] variant is a genuinely different model, so
    // it must stay 1M and must not be labeled a duplicate. `claude-opus-4-8[1m]`
    // is real — it was probed directly and ran with a 1M window.
    expect(optionFor(narrow, "opus[1m]").sub).toBe("claude-opus-4-8[1m]");
    expect(optionFor(narrow, "opus[1m]").contextWindow).toBe(M1);
  });
});
