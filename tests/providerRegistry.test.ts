import { describe, expect, it } from "vitest";
import {
  PROVIDER_REGISTRY,
  PROVIDER_TYPES,
  USER_ADDED_TYPES,
  bundledTypeFor,
  defaultModelPolicy,
  localTypeForPort,
  parseModelPolicy,
  parseProviderConfig,
} from "@/lib/providers/types";
import type { ProviderType } from "@/lib/providers/types";

const TABLE: {
  type: ProviderType;
  environments: string[];
  bundled: string | null;
  policyMode: "allow" | "deny";
  secretFields: string[];
}[] = [
  { type: "anthropic", environments: ["claude"], bundled: "claude", policyMode: "deny", secretFields: [] },
  { type: "openai", environments: ["codex"], bundled: "codex", policyMode: "deny", secretFields: [] },
  { type: "google", environments: ["gemini"], bundled: "gemini", policyMode: "deny", secretFields: [] },
  { type: "openai_key", environments: ["codex"], bundled: null, policyMode: "deny", secretFields: ["key"] },
  { type: "gemini_key", environments: ["gemini"], bundled: null, policyMode: "deny", secretFields: ["key"] },
  {
    type: "litellm",
    environments: ["claude", "codex", "gemini"],
    bundled: null,
    policyMode: "allow",
    secretFields: ["key", "admin_key"],
  },
  { type: "ollama", environments: ["claude", "codex"], bundled: null, policyMode: "deny", secretFields: [] },
  { type: "lmstudio", environments: ["claude", "codex"], bundled: null, policyMode: "deny", secretFields: [] },
  { type: "custom", environments: ["claude", "codex"], bundled: null, policyMode: "deny", secretFields: ["key"] },
];

describe("PROVIDER_REGISTRY", () => {
  it.each(TABLE)("$type has the expected shape", ({ type, environments, bundled, policyMode, secretFields }) => {
    const entry = PROVIDER_REGISTRY[type];
    expect(entry.type).toBe(type);
    expect(entry.environments).toEqual(environments);
    expect(entry.bundled).toBe(bundled);
    expect(entry.policyMode).toBe(policyMode);
    expect(entry.secretFields).toEqual(secretFields);
  });

  it("PROVIDER_TYPES lists exactly the nine types in the table", () => {
    expect(PROVIDER_TYPES).toEqual(TABLE.map((row) => row.type));
  });

  it("USER_ADDED_TYPES is exactly the non-bundled types", () => {
    const expected = TABLE.filter((row) => row.bundled === null).map((row) => row.type);
    expect(USER_ADDED_TYPES).toEqual(expected);
  });

  it("bundledTypeFor resolves each environment's bundled type", () => {
    expect(bundledTypeFor("claude")).toBe("anthropic");
    expect(bundledTypeFor("codex")).toBe("openai");
    expect(bundledTypeFor("gemini")).toBe("google");
    expect(bundledTypeFor("mock")).toBeNull();
  });

  it("defaultModelPolicy matches the type's mode with nothing pinned", () => {
    for (const row of TABLE) {
      const policy = defaultModelPolicy(row.type);
      expect(policy.mode).toBe(row.policyMode);
      expect(policy.ids).toEqual([]);
      expect(policy.known).toEqual([]);
      expect(policy.unavailable).toEqual([]);
    }
  });
});

describe("localTypeForPort", () => {
  it("11434 is ollama", () => {
    expect(localTypeForPort("http://localhost:11434")).toBe("ollama");
  });

  it("11434 on any host is ollama", () => {
    expect(localTypeForPort("http://host.docker.internal:11434")).toBe("ollama");
  });

  it("1234 is lmstudio", () => {
    expect(localTypeForPort("http://localhost:1234")).toBe("lmstudio");
  });

  it("an unnamed port is custom", () => {
    expect(localTypeForPort("http://10.0.0.4:8080")).toBe("custom");
  });

  it("a string that is not a URL is custom", () => {
    expect(localTypeForPort("not a url")).toBe("custom");
  });

  it("a URL with no explicit port", () => {
    // WhatWG URL reports an empty port when none is given; localTypeForPort
    // has no port to match against 11434/1234, so it falls to custom.
    expect(localTypeForPort("http://localhost")).toBe("custom");
  });
});

describe("parseProviderConfig", () => {
  it("normalizes a litellm base_url and defaults billing and mcp", () => {
    const cfg = parseProviderConfig("litellm", { base_url: "http://gw.example.com/v1/" });
    expect(cfg.base_url).toBe("http://gw.example.com");
    expect(cfg.billing).toBe("key");
    expect(cfg.mcp).toBe(true);
  });

  it("a custom config without api throws", () => {
    expect(() => parseProviderConfig("custom", { base_url: "http://x.example.com" })).toThrow();
  });

  it("an ollama config with no base_url throws", () => {
    expect(() => parseProviderConfig("ollama", {})).toThrow();
  });

  it("an anthropic config accepts an empty object", () => {
    expect(parseProviderConfig("anthropic", {})).toEqual({});
  });

  it("an anthropic config accepts a default_model", () => {
    expect(parseProviderConfig("anthropic", { default_model: "x" })).toEqual({ default_model: "x" });
  });

  it("an unknown extra key throws under the strict schemas", () => {
    expect(() => parseProviderConfig("anthropic", { nope: true })).toThrow();
    expect(() =>
      parseProviderConfig("litellm", { base_url: "http://gw.example.com", nope: true }),
    ).toThrow();
  });
});

describe("parseModelPolicy", () => {
  it("corrects a mode that disagrees with the type, preserving ids", () => {
    const policy = parseModelPolicy("ollama", { mode: "allow", ids: ["a"] });
    expect(policy.mode).toBe("deny");
    expect(policy.ids).toEqual(["a"]);
  });

  it("falls back to defaultModelPolicy on garbage input", () => {
    expect(parseModelPolicy("litellm", "garbage")).toEqual(defaultModelPolicy("litellm"));
    expect(parseModelPolicy("litellm", null)).toEqual(defaultModelPolicy("litellm"));
    expect(parseModelPolicy("litellm", { mode: "not-a-mode" })).toEqual(defaultModelPolicy("litellm"));
  });
});
