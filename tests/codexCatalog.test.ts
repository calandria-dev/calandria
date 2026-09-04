// The window and the default model a Codex turn actually gets, read off the
// CLI's own state in ~/.codex instead of hardcoded.
//
// Fixture-driven on purpose. There is no models_cache.json and no auth.json on
// the machine this was written against (`codex login status`: "Not logged in"),
// so the absent-file branch is the one a developer exercises for real and the
// populated ones can only be reached by writing the file. The catalog rows here
// are the shape measured against a codex-cli 0.153.0 account catalog.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexContextWindow, codexDefaultModel, codexLocalCatalog, resetCodexCatalogStateForTests } from "@/lib/agents/codex/catalog";
import { codexCapabilities } from "@/lib/agents/codex/capabilities";
import { DEFAULT_CODEX_MODEL, resolveCodexModel, estimateCostUsd } from "@/lib/agents/codex/pricing";

// tests/setup.ts gives the run its own tmp dirs, but CODEX_HOME is this
// module's own concern — point it at a scratch dir so a developer's real
// ~/.codex can't make these pass or fail.
let codexHome: string;
const suiteCodexHome = process.env.CODEX_HOME;

const entry = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  context_window: 272000,
  max_context_window: 872000,
  effective_context_window_percent: 95,
  display_name: slug,
  description: "",
  supported_reasoning_levels: ["low", "medium", "high"],
  visibility: "list",
  priority: 1,
  ...over,
});

function writeCache(models: unknown[], over: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify({ fetched_at: "2026-09-03T00:00:00Z", etag: "abc", client_version: "0.153.0", models, ...over })
  );
  resetCodexCatalogStateForTests();
}

function writeConfig(toml: string) {
  fs.writeFileSync(path.join(codexHome, "config.toml"), toml);
  resetCodexCatalogStateForTests();
}

const windowOf = (slug: string) => codexCapabilities().models.find((m) => m.value === slug)!.contextWindow;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-"));
  process.env.CODEX_HOME = codexHome;
  resetCodexCatalogStateForTests();
});

afterEach(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
  // Restore rather than delete: tests/setup.ts pins this for the whole suite.
  process.env.CODEX_HOME = suiteCodexHome;
  resetCodexCatalogStateForTests();
});

describe("codex catalog: fail-soft reads", () => {
  it("falls back to the hardcoded window and model when ~/.codex has nothing in it", () => {
    // The branch every install without a login takes, and the one this machine
    // takes. A wrong gauge is worse than a static one, so absent means "keep
    // the constant", never zero or undefined.
    expect(codexLocalCatalog()).toEqual({ entries: [], model: null, windowOverride: null });
    expect(codexContextWindow("gpt-5.6-sol", 272_000)).toBe(272_000);
    expect(codexDefaultModel(DEFAULT_CODEX_MODEL)).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
    expect(windowOf("gpt-5.6-sol")).toBe(272_000);
  });

  it("falls back on malformed JSON rather than throwing on the request path", () => {
    fs.writeFileSync(path.join(codexHome, "models_cache.json"), "{ this is not json");
    resetCodexCatalogStateForTests();
    expect(codexLocalCatalog().entries).toEqual([]);
    expect(codexContextWindow("gpt-5.6-sol", 272_000)).toBe(272_000);
    expect(codexDefaultModel(DEFAULT_CODEX_MODEL)).toBe(DEFAULT_CODEX_MODEL);
  });

  it("falls back on a shape a future client_version might write", () => {
    // Valid JSON, no `models` array — indistinguishable from a file we can't
    // read, and must be treated as one.
    writeCache([], { models: { "gpt-9": { context_window: 5 } } });
    expect(codexLocalCatalog().entries).toEqual([]);
    expect(codexContextWindow("gpt-5.6-sol", 272_000)).toBe(272_000);
  });

  it("skips individual entries it can't read and keeps the ones it can", () => {
    writeCache([null, { context_window: 1000 }, "nope", entry("gpt-5.6-sol", { context_window: 200000, effective_context_window_percent: null })]);
    expect(codexLocalCatalog().entries.map((e) => e.slug)).toEqual(["gpt-5.6-sol"]);
    expect(codexContextWindow("gpt-5.6-sol", 272_000)).toBe(200_000);
  });
});

describe("codex catalog: the context window", () => {
  it("reads context_window per slug, not the max_context_window ceiling", () => {
    // The whole reason the file alone changes no number: context_window is
    // 272000 for every 0.153.0 entry while max_context_window varies, and
    // reporting the ceiling would over-report every task that never raised the
    // override.
    writeCache([
      entry("gpt-6-astra", { max_context_window: 872000, effective_context_window_percent: null }),
      entry("gpt-5.4", { max_context_window: 1000000, effective_context_window_percent: null }),
    ]);
    expect(codexContextWindow("gpt-6-astra", 1)).toBe(272_000);
    expect(codexContextWindow("gpt-5.4", 1)).toBe(272_000);
  });

  it("applies config.toml's model_context_window override — the point of parsing any of this", () => {
    writeCache([entry("gpt-6-astra", { effective_context_window_percent: null })]);
    writeConfig('model_context_window = 500000\n');
    expect(codexLocalCatalog().windowOverride).toBe(500_000);
    expect(codexContextWindow("gpt-6-astra", 272_000)).toBe(500_000);
    expect(windowOf("gpt-6-astra")).toBe(500_000);
  });

  it("clamps the override to the model's ceiling", () => {
    // max_context_window is the most the account may raise it to, so an
    // override past it is the user's number, not the turn's.
    writeCache([entry("gpt-5.5", { max_context_window: 272000, effective_context_window_percent: null })]);
    writeConfig("model_context_window = 872000\n");
    expect(codexContextWindow("gpt-5.5", 1)).toBe(272_000);
  });

  it("scales to effective_context_window_percent, the point the CLI compacts at", () => {
    writeCache([entry("gpt-5.6-sol")]);
    expect(codexContextWindow("gpt-5.6-sol", 1)).toBe(258_400);
    expect(windowOf("gpt-5.6-sol")).toBe(258_400);
  });

  it("keeps the fallback for a slug the catalog doesn't carry", () => {
    writeCache([entry("gpt-6-astra")]);
    expect(codexContextWindow("gpt-5.4-mini", 272_000)).toBe(272_000);
  });

  it("still applies a bare override with no catalog on disk", () => {
    writeConfig("model_context_window = 400000\n");
    expect(codexContextWindow("gpt-5.6-sol", 272_000)).toBe(400_000);
  });

  it("ignores a nonsense override rather than sizing the gauge at zero", () => {
    writeConfig('model_context_window = "wide"\n');
    expect(codexLocalCatalog().windowOverride).toBeNull();
    expect(codexContextWindow("gpt-5.6-sol", 272_000)).toBe(272_000);
  });
});

describe("codex catalog: the default model", () => {
  it("resolves the lowest-priority listed entry — the Astra case, where the constant is wrong", () => {
    // Measured against a 0.153.0 ACCOUNT catalog: gpt-6-astra at priority 1,
    // gpt-5.6-sol at 6. Astra bills $10/$50 against Sol's $5/$30, so getting
    // this wrong is a live 2x mispricing of every default turn, not a skewed
    // gauge.
    writeCache([entry("gpt-5.6-sol", { priority: 6 }), entry("gpt-6-astra", { priority: 1 })]);
    expect(codexDefaultModel(DEFAULT_CODEX_MODEL)).toBe("gpt-6-astra");
    expect(resolveCodexModel(null)).toBe("gpt-6-astra");
    expect(resolveCodexModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("prices an unknown model off the resolved default, not the constant", () => {
    writeCache([entry("gpt-6-astra", { priority: 1 })]);
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    // $10/1M input on Astra's row; the old constant fallback would say Sol's $5.
    expect(estimateCostUsd("gpt-unheard-of", usage)).toBeCloseTo(10, 6);
  });

  it("prices unknown models off the constant when the catalog names something with no price row", () => {
    // Fail-soft in the other direction: a catalog can name a model this repo's
    // price table has never seen, and the estimate must not become NaN.
    writeCache([entry("gpt-9-nova", { priority: 1 })]);
    const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    expect(estimateCostUsd("also-unheard-of", usage)).toBeCloseTo(5, 6);
  });

  it("skips hidden entries when ranking", () => {
    writeCache([entry("gpt-reserve", { priority: 0, visibility: "hide" }), entry("gpt-5.6-sol", { priority: 4 })]);
    expect(codexDefaultModel(DEFAULT_CODEX_MODEL)).toBe("gpt-5.6-sol");
  });

  it("lets config.toml's own model beat the catalog's ranking", () => {
    writeCache([entry("gpt-6-astra", { priority: 1 })]);
    writeConfig('model = "gpt-5.4-mini" # my cheap default\n');
    expect(codexDefaultModel(DEFAULT_CODEX_MODEL)).toBe("gpt-5.4-mini");
    expect(resolveCodexModel(null)).toBe("gpt-5.4-mini");
  });

  it("reads only top-level config keys, never a profile's", () => {
    // A [profiles.x] block applies when that profile is selected, and we don't
    // model selection. Reading one would apply somebody's occasional profile to
    // every turn; not reading it just leaves the fallback in place.
    writeConfig(['# a comment', 'model = "gpt-5.6-terra"', "", "[profiles.big]", 'model = "gpt-6-astra"', "model_context_window = 872000", ""].join("\n"));
    const cat = codexLocalCatalog();
    expect(cat.model).toBe("gpt-5.6-terra");
    expect(cat.windowOverride).toBeNull();
  });
});
