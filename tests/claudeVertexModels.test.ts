// The Claude model picker when the instance routes through Vertex.
//
// On Vertex, opus and sonnet resolve to their `[1m]` spellings and haiku
// stays at 200k; opusplan follows the sonnet mapping since it runs on Sonnet
// after planning. Fable is unavailable there (403, publisher data sharing not
// enabled). Bare pinned model ids resolve unchanged on Vertex, so the
// "Pinned versions" group must survive untouched, and the `@version` suffix
// (claude-haiku-4-5@20251001) is an optional pin there, not a required
// spelling.

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

// The project id here is a placeholder: nothing reads it, and it should not
// appear in a public repo. The model mappings below are what the assertions
// depend on.
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
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "calandria-vertex-caps-"));
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
  // settings.json's env block takes precedence over process.env: exporting
  // ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8 into the process while
  // settings.json says claude-opus-5[1m] still runs claude-opus-5[1m].
  // Reading these the other way round would make the picker name a model the
  // turn does not use.
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

  // Bedrock has no equivalent catalog here, and upstream's Bedrock list drops
  // the [1m] variants that work on Vertex, so Bedrock stays on the default
  // catalog instead of an unverified guess.
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

  // Spelled out instead of derived from the same predicate the implementation
  // uses, so a filter that widens by accident fails here instead of agreeing
  // with itself.
  const DROPPED_ON_VERTEX = ["fable", "claude-fable-5-1"];

  it("drops only the Fable rows — every value measured as working is still offered", () => {
    expect(caps.models.map((m) => m.value)).toEqual(
      CLAUDE_CAPABILITIES.models.map((m) => m.value).filter((v) => !DROPPED_ON_VERTEX.includes(v))
    );
  });

  it("does not disturb anything but the model list", () => {
    expect(caps.permissionModes).toBe(CLAUDE_CAPABILITIES.permissionModes);
    expect(caps.reasoningOptions).toBe(CLAUDE_CAPABILITIES.reasoningOptions);
    expect(caps.loginStyle).toBe(CLAUDE_CAPABILITIES.loginStyle);
  });

  // Bare Anthropic model ids do not need an `@version` suffix on Vertex; all
  // six pinned entries resolve.
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

  // contextWindow feeds the context gauge and the overflow notice; a mapping
  // carrying [1m] makes the bare alias 1M.
  it("gives the family aliases the window of the id they actually resolve to", () => {
    expect(optionFor(CLAUDE_CAPABILITIES, "opus").contextWindow).toBe(K200); // what the catalog claims
    expect(optionFor(caps, "opus").contextWindow).toBe(M1); // what the turn actually gets
    expect(optionFor(caps, "sonnet").contextWindow).toBe(M1);
    expect(optionFor(caps, "haiku").contextWindow).toBe(K200);
  });

  it("labels each alias with the id it resolves to", () => {
    expect(optionFor(caps, "opus").sub).toBe("claude-opus-5[1m]");
    expect(optionFor(caps, "sonnet").sub).toBe("claude-sonnet-5[1m]");
    expect(optionFor(caps, "haiku").sub).toBe("claude-haiku-4-5@20251001");
  });

  // No alias label claims a version on either catalog: the default catalog
  // says "(latest)" because the installed CLI picks the version, and this one
  // says "(provider default)" because the env mapping picks it and the value
  // can be read. Only a real pin names a version.
  it("names the resolver in an alias label, but keeps the version on a real pin", () => {
    expect(optionFor(CLAUDE_CAPABILITIES, "opus").label).toBe("Opus (latest)");
    expect(optionFor(caps, "opus").label).toBe("Opus (provider default)");
    expect(optionFor(caps, "haiku").label).toBe("Haiku (provider default)");
    expect(optionFor(caps, "opus[1m]").label).toBe("Opus (1M)");
    expect(optionFor(caps, "claude-opus-4-8").label).toBe("Opus 4.8");
  });

  // Neither catalog may leak a version into an alias row.
  it("lets no alias row on either catalog carry a version number", () => {
    const aliases = ["fable", "opus", "sonnet", "haiku", "opusplan", "opus[1m]", "sonnet[1m]", "opusplan[1m]"];
    for (const list of [CLAUDE_CAPABILITIES.models, caps.models]) {
      for (const m of list.filter((o) => aliases.includes(o.value))) {
        // "(1M)" is a window, not a model version, and is the only digit allowed.
        expect(m.label.replace("(1M)", ""), `${m.value} label claims a version`).not.toMatch(/\d/);
      }
    }
  });

  // opusplan plans on Opus and runs on Sonnet afterward, using the sonnet
  // mapping, so the session's window is Sonnet's.
  it("follows the sonnet mapping for opusplan, which is what runs after the plan", () => {
    expect(optionFor(caps, "opusplan").sub).toBe("claude-sonnet-5[1m]");
    expect(optionFor(caps, "opusplan").contextWindow).toBe(M1);
  });

  it("says so when a [1m] entry is the same model string as its bare alias", () => {
    expect(optionFor(caps, "opus[1m]").sub).toContain("same as opus");
    expect(optionFor(caps, "sonnet[1m]").sub).toContain("same as sonnet");
  });

  // Fable rows are dropped instead of labeled, since they 403 (publisher data
  // sharing not enabled) on this project. The gate applies per publisher, so
  // a pinned Fable version is dropped for the same reason as the alias.
  it("drops every Fable row, which 403s on this project", () => {
    for (const v of DROPPED_ON_VERTEX) expect(caps.models.find((m) => m.value === v)).toBeUndefined();
    // Still offered on the plain Anthropic path, where they work: the alias
    // names its resolver, and the pin names the version it pins.
    expect(optionFor(CLAUDE_CAPABILITIES, "fable").label).toBe("Fable (latest)");
    expect(optionFor(CLAUDE_CAPABILITIES, "claude-fable-5-1").label).toBe("Fable 5.1");
  });

  it("leaves an unmapped family alone rather than inventing a resolution for it", () => {
    const partial = claudeCapabilities({
      CLAUDE_CONFIG_DIR: configDir({
        env: { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]" },
      }),
    });
    expect(optionFor(partial, "opus").contextWindow).toBe(M1);
    // sonnet and haiku are unmapped here: the CLI picks its own built-in
    // default, which cannot be named, so the catalog entry stands.
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
    // With a 200k mapping, the [1m] variant is a different model, so it must
    // stay 1M and must not be labeled a duplicate. `claude-opus-4-8[1m]` is a
    // real, distinct model with a 1M window.
    expect(optionFor(narrow, "opus[1m]").sub).toBe("claude-opus-4-8[1m]");
    expect(optionFor(narrow, "opus[1m]").contextWindow).toBe(M1);
  });
});
