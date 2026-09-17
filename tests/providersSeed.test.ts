import fs from "node:fs";
import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { PROVIDER_SECRETS_PATH, getProviderSecret } from "@/lib/providerSecrets";
import { seedProvidersFromEnv } from "@/lib/providers/seed";
import type { ProviderSeedEnv } from "@/lib/config";
import { createProvider, firstProviderOfType, listProviders } from "@/lib/providers/store";

function env(overrides: Partial<ProviderSeedEnv> = {}): ProviderSeedEnv {
  return {
    litellmBaseUrl: null,
    litellmKey: "",
    litellmAdminKey: "",
    litellmMcp: true,
    litellmKeyTimeoutMs: 8000,
    localBaseUrl: "http://localhost:11434",
    localBaseUrlSet: false,
    ...overrides,
  };
}

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
  fs.rmSync(PROVIDER_SECRETS_PATH, { force: true });
});

describe("seedProvidersFromEnv", () => {
  it("seeds nothing when nothing is set", () => {
    seedProvidersFromEnv(getDb(), env());
    expect(listProviders()).toEqual([]);
  });

  it("the default local URL with localBaseUrlSet false seeds nothing", () => {
    seedProvidersFromEnv(getDb(), env({ localBaseUrl: "http://localhost:11434", localBaseUrlSet: false }));
    expect(listProviders()).toEqual([]);
  });

  it("a gateway base URL seeds exactly one litellm row", () => {
    seedProvidersFromEnv(
      getDb(),
      env({
        litellmBaseUrl: "http://gw.example.com",
        litellmKey: "sk-key",
        litellmAdminKey: "sk-admin",
        litellmMcp: false,
        litellmKeyTimeoutMs: 5000,
      }),
    );
    const rows = listProviders();
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.type).toBe("litellm");
    expect(row.config.base_url).toBe("http://gw.example.com");
    expect(row.config.mcp).toBe(false);
    expect(row.config.key_timeout_ms).toBe(5000);
    expect(row.has_key).toBe(true);
    expect(row.has_admin_key).toBe(true);
    expect(getProviderSecret(row.id, "key")).toBe("sk-key");
    expect(getProviderSecret(row.id, "admin_key")).toBe("sk-admin");
  });

  it("a gateway with no keys seeds a row with both flags false", () => {
    seedProvidersFromEnv(getDb(), env({ litellmBaseUrl: "http://gw.example.com" }));
    const row = firstProviderOfType("litellm")!;
    expect(row.has_key).toBe(false);
    expect(row.has_admin_key).toBe(false);
  });

  it("seeds once: a second call with the same env leaves exactly one row", () => {
    const e = env({ litellmBaseUrl: "http://gw.example.com" });
    seedProvidersFromEnv(getDb(), e);
    seedProvidersFromEnv(getDb(), e);
    expect(listProviders().filter((p) => p.type === "litellm").length).toBe(1);
  });

  it("env is ignored once a litellm row already exists", () => {
    createProvider({ type: "litellm", config: { base_url: "http://existing.example.com" } });
    seedProvidersFromEnv(getDb(), env({ litellmBaseUrl: "http://gw.example.com" }));
    const rows = listProviders().filter((p) => p.type === "litellm");
    expect(rows.length).toBe(1);
    expect(rows[0].config.base_url).toBe("http://existing.example.com");
  });

  it("port 11434 seeds an ollama row", () => {
    seedProvidersFromEnv(getDb(), env({ localBaseUrl: "http://localhost:11434", localBaseUrlSet: true }));
    const row = firstProviderOfType("ollama")!;
    expect(row).not.toBeNull();
    expect(row.config.base_url).toBe("http://localhost:11434");
  });

  it("port 1234 seeds an lmstudio row", () => {
    seedProvidersFromEnv(getDb(), env({ localBaseUrl: "http://localhost:1234", localBaseUrlSet: true }));
    const row = firstProviderOfType("lmstudio")!;
    expect(row).not.toBeNull();
    expect(row.config.base_url).toBe("http://localhost:1234");
  });

  it("port 8080 seeds a custom row with the openai API shape", () => {
    seedProvidersFromEnv(getDb(), env({ localBaseUrl: "http://localhost:8080", localBaseUrlSet: true }));
    const row = firstProviderOfType("custom")!;
    expect(row).not.toBeNull();
    expect(row.config.api).toBe("openai");
    expect(row.config.base_url).toBe("http://localhost:8080");
  });

  it("a local row of any type blocks the local seed", () => {
    createProvider({ type: "lmstudio", config: { base_url: "http://localhost:1234" } });
    seedProvidersFromEnv(getDb(), env({ localBaseUrl: "http://localhost:11434", localBaseUrlSet: true }));
    expect(firstProviderOfType("ollama")).toBeNull();
    const localRows = listProviders().filter((p) => ["ollama", "lmstudio", "custom"].includes(p.type));
    expect(localRows.length).toBe(1);
  });

  it("a gateway env and a local env seed one row of each, independently", () => {
    seedProvidersFromEnv(
      getDb(),
      env({ litellmBaseUrl: "http://gw.example.com", localBaseUrl: "http://localhost:11434", localBaseUrlSet: true }),
    );
    expect(firstProviderOfType("litellm")).not.toBeNull();
    expect(firstProviderOfType("ollama")).not.toBeNull();
  });
});
