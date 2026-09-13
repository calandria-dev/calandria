import fs from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { onPosix } from "@/tests/platform";
import {
  PROVIDER_SECRETS_PATH,
  clearProviderSecret,
  deleteProviderSecrets,
  getProviderSecret,
  hasProviderSecret,
  providerSecretFlags,
  setProviderSecret,
} from "@/lib/providerSecrets";
import { clearGatewayKey, gatewayKey, hasGatewayKey, setGatewayKey } from "@/lib/litellm-key";
import { createProvider } from "@/lib/providers/store";

beforeEach(() => {
  fs.rmSync(PROVIDER_SECRETS_PATH, { force: true });
});

describe("provider secrets: get and set", () => {
  it("round-trips a value", () => {
    setProviderSecret("p1", "key", "sk-abc");
    expect(getProviderSecret("p1", "key")).toBe("sk-abc");
  });

  it("hasProviderSecret is false before set and true after", () => {
    expect(hasProviderSecret("p1", "key")).toBe(false);
    setProviderSecret("p1", "key", "sk-abc");
    expect(hasProviderSecret("p1", "key")).toBe(true);
  });

  it("two providers keep separate values", () => {
    setProviderSecret("p1", "key", "sk-one");
    setProviderSecret("p2", "key", "sk-two");
    expect(getProviderSecret("p1", "key")).toBe("sk-one");
    expect(getProviderSecret("p2", "key")).toBe("sk-two");
  });

  it("two fields on one provider are independent", () => {
    setProviderSecret("p1", "key", "sk-key");
    setProviderSecret("p1", "admin_key", "sk-admin");
    expect(getProviderSecret("p1", "key")).toBe("sk-key");
    expect(getProviderSecret("p1", "admin_key")).toBe("sk-admin");
  });

  it("setting an empty value clears the field", () => {
    setProviderSecret("p1", "key", "sk-abc");
    setProviderSecret("p1", "key", "");
    expect(hasProviderSecret("p1", "key")).toBe(false);
  });

  it("clearing an unset field is a no-op", () => {
    expect(() => clearProviderSecret("p1", "key")).not.toThrow();
    expect(hasProviderSecret("p1", "key")).toBe(false);
  });

  it("deleteProviderSecrets forgets both fields of that provider and leaves another intact", () => {
    setProviderSecret("p1", "key", "sk-key");
    setProviderSecret("p1", "admin_key", "sk-admin");
    setProviderSecret("p2", "key", "sk-other");
    deleteProviderSecrets("p1");
    expect(hasProviderSecret("p1", "key")).toBe(false);
    expect(hasProviderSecret("p1", "admin_key")).toBe(false);
    expect(getProviderSecret("p2", "key")).toBe("sk-other");
  });

  it("the value is trimmed", () => {
    setProviderSecret("p1", "key", "  sk-abc  ");
    expect(getProviderSecret("p1", "key")).toBe("sk-abc");
  });

  it("a value containing a control character throws and nothing is stored", () => {
    expect(() => setProviderSecret("p1", "key", "sk-a\nb")).toThrow();
    expect(hasProviderSecret("p1", "key")).toBe(false);
  });
});

describe("providerSecretFlags", () => {
  it("reports has_key and has_admin_key for the fields given", () => {
    setProviderSecret("p1", "key", "sk-key");
    expect(providerSecretFlags("p1", ["key", "admin_key"])).toEqual({ has_key: true, has_admin_key: false });
  });

  it("returns an empty object for no fields", () => {
    expect(providerSecretFlags("p1", [])).toEqual({});
  });
});

describe("provider secrets: on-disk file", () => {
  onPosix("is written mode 0600", () => {
    setProviderSecret("p1", "key", "sk-abc");
    const mode = fs.statSync(PROVIDER_SECRETS_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is removed once the last secret is cleared", () => {
    setProviderSecret("p1", "key", "sk-abc");
    expect(fs.existsSync(PROVIDER_SECRETS_PATH)).toBe(true);
    clearProviderSecret("p1", "key");
    expect(fs.existsSync(PROVIDER_SECRETS_PATH)).toBe(false);
  });

  it("is keyed by provider id then field name", () => {
    setProviderSecret("p1", "key", "sk-key");
    setProviderSecret("p1", "admin_key", "sk-admin");
    const parsed = JSON.parse(fs.readFileSync(PROVIDER_SECRETS_PATH, "utf8"));
    expect(parsed).toEqual({ p1: { key: "sk-key", admin_key: "sk-admin" } });
  });
});

describe("litellm-key wrappers", () => {
  const ORIGINAL_ENV = process.env.CALANDRIA_LITELLM_KEY;

  beforeEach(() => {
    getDb().prepare("DELETE FROM model_providers").run();
    delete process.env.CALANDRIA_LITELLM_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CALANDRIA_LITELLM_KEY;
    else process.env.CALANDRIA_LITELLM_KEY = ORIGINAL_ENV;
  });

  it("stores and reads the key under the litellm row's own key field", () => {
    const row = createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    setGatewayKey("sk-1");
    expect(getProviderSecret(row.id, "key")).toBe("sk-1");
    expect(gatewayKey()).toBe("sk-1");
    expect(hasGatewayKey()).toBe(true);
  });

  it("clearGatewayKey empties the stored key", () => {
    createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    setGatewayKey("sk-1");
    clearGatewayKey();
    expect(gatewayKey()).toBe("");
    expect(hasGatewayKey()).toBe(false);
  });

  it("does not read CALANDRIA_LITELLM_KEY at runtime when no row exists", () => {
    process.env.CALANDRIA_LITELLM_KEY = "sk-env";
    expect(gatewayKey()).toBe("");
  });
});
