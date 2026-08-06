import { describe, it, expect, afterEach } from "vitest";
import { stripInheritedAgentKeys, allowApiKeyEnv, AGENT_KEY_VARS } from "../lib/env-keys.mjs";
import { hasApiKey } from "../lib/anthropic-key";
import { hasOpenAiKey } from "../lib/openai-key";

// Issue #4: an ANTHROPIC_API_KEY inherited from the launch environment must
// not silently bill turns while the UI reports the subscription login. The
// entrypoints strip inherited keys at boot; after that, status surfaces treat
// any env key as the effective billing credential.

afterEach(() => {
  for (const v of AGENT_KEY_VARS) delete process.env[v];
  delete process.env.ORCH_ALLOW_API_KEY_ENV;
});

describe("stripInheritedAgentKeys", () => {
  it("strips all agent key vars and reports which ones", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-leaked",
      OPENAI_API_KEY: "sk-leaked",
      PATH: "/usr/bin",
    };
    const stripped = stripInheritedAgentKeys(env);
    expect(stripped.sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin"); // untouched
  });

  it("keeps keys when the opt-in is set on the env itself", () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: "sk-ant-deliberate",
      ORCH_ALLOW_API_KEY_ENV: "1",
    };
    expect(stripInheritedAgentKeys(env)).toEqual([]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-deliberate");
  });

  it("keeps keys when allow is passed explicitly", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_AUTH_TOKEN: "tok" };
    expect(stripInheritedAgentKeys(env, { allow: true })).toEqual([]);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
  });

  it("is a no-op on a clean env", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    expect(stripInheritedAgentKeys(env)).toEqual([]);
  });
});

describe("allowApiKeyEnv", () => {
  it("accepts 1/true/on, rejects everything else", () => {
    for (const v of ["1", "true", "on", "TRUE", "On"]) {
      expect(allowApiKeyEnv({ ORCH_ALLOW_API_KEY_ENV: v })).toBe(true);
    }
    for (const v of ["", "0", "false", "off", "yes"]) {
      expect(allowApiKeyEnv({ ORCH_ALLOW_API_KEY_ENV: v })).toBe(false);
    }
  });
});

describe("effective-credential status (env-aware has*Key)", () => {
  it("hasApiKey counts a live env key even with no persisted file", () => {
    expect(hasApiKey()).toBe(false); // setup.ts cleared the env; tmp DB dir has no key file
    process.env.ANTHROPIC_API_KEY = "sk-ant-live";
    expect(hasApiKey()).toBe(true);
  });

  it("hasOpenAiKey counts a live env key even with no persisted file", () => {
    expect(hasOpenAiKey()).toBe(false);
    process.env.OPENAI_API_KEY = "sk-live";
    expect(hasOpenAiKey()).toBe(true);
  });
});
