import { describe, it, expect, afterEach } from "vitest";
import { clearGatewayProbeCache, gatewayHealth, probeGateway } from "@/lib/gatewayHealth";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// What Settings → Agents can say about a LiteLLM gateway, against the response
// shapes recorded in docs/design/litellm.md's appendix (tests/fakeGateway.ts).
// The card exists because an agent's `connected` is its CLI login and says
// nothing about whether the gateway is up, so "unreachable" is an ordinary
// answer here rather than a failure — probeGateway never throws.

let gw: FakeGateway | null = null;

afterEach(async () => {
  clearGatewayProbeCache();
  await gw?.close();
  gw = null;
});

describe("probeGateway", () => {
  it("reports liveness, version and model count from a healthy gateway", async () => {
    gw = await startFakeGateway({ models: ["claude-sonnet-4-5", "gpt-5-codex", "gemini-3.1-pro-preview"] });
    const h = await probeGateway(gw.url, "sk-test");
    expect(h).toMatchObject({ reachable: true, version: "1.101.0", model_count: 3, has_key: true, error: null });
  });

  // The one answer the card has to state rather than leave blank: every key,
  // budget and spend feature on a LiteLLM proxy needs its database, and without
  // one /key/info answers 500 "Database not connected".
  it("reads the no-database 500 as a fact about the proxy, not an outage", async () => {
    gw = await startFakeGateway({ database: false });
    const h = await probeGateway(gw.url, "sk-test");
    expect(h.reachable).toBe(true);
    expect(h.database).toBe(false);
    expect(h.error).toBe(null);
    // No database, no budget readout — all four together, never a mix.
    expect(h.spend).toBe(null);
    expect(h.max_budget).toBe(null);
    expect(h.budget_reset_at).toBe(null);
    expect(h.key_models).toBe(null);
  });

  it("reports a database when the proxy has one, plus the key's budget readout", async () => {
    gw = await startFakeGateway({ database: true, models: ["claude-sonnet-4-5", "gpt-5-codex"] });
    const h = await probeGateway(gw.url, "sk-test");
    expect(h.database).toBe(true);
    expect(h.spend).toBe(1.25);
    expect(h.max_budget).toBe(10);
    expect(h.budget_reset_at).toBe("2026-10-01T00:00:00Z");
    expect(h.key_models).toEqual(["claude-sonnet-4-5", "gpt-5-codex"]);
  });

  // /health/readiness takes no key, which is what lets an instance that has the
  // address but not the key still see whether the gateway is up.
  it("answers reachability with no key, and leaves the key-gated facts unknown", async () => {
    gw = await startFakeGateway({ requireKey: "sk-test" });
    const h = await probeGateway(gw.url, "");
    expect(h.reachable).toBe(true);
    expect(h.version).toBe("1.101.0");
    expect(h.model_count).toBe(null);
    expect(h.database).toBe(null);
    expect(h.has_key).toBe(false);
  });

  it("sends the key as x-litellm-api-key on the key-gated routes only", async () => {
    gw = await startFakeGateway({ requireKey: "sk-test" });
    await probeGateway(gw.url, "sk-test");
    const byPath = new Map(gw.calls.map((c) => [c.path, c.key]));
    expect(byPath.get("/health/readiness")).toBe(null);
    expect(byPath.get("/model/info")).toBe("Bearer sk-test");
    expect(byPath.get("/key/info")).toBe("Bearer sk-test");
  });

  it("never throws: a dead address, a bad URL and a blank one are ordinary answers", async () => {
    const dead = await probeGateway("http://127.0.0.1:1/", "", 250);
    expect(dead.reachable).toBe(false);
    expect(dead.error).toBeTruthy();
    expect((await probeGateway("not a url")).error).toBe("not a URL");
    expect((await probeGateway("ftp://gw.example.com")).error).toBe("not an http(s) URL");
    expect((await probeGateway("")).error).toBe("no base URL");
  });
});

describe("gatewayHealth cache", () => {
  it("reuses one probe rather than opening sockets per tab", async () => {
    gw = await startFakeGateway();
    await gatewayHealth(gw.url, "sk-test");
    const after = gw.calls.length;
    await gatewayHealth(gw.url, "sk-test");
    expect(gw.calls.length).toBe(after);
    // Saving a key has to re-probe: the count and database line were read
    // without it (app/api/settings/gateway-key).
    clearGatewayProbeCache();
    await gatewayHealth(gw.url, "sk-test");
    expect(gw.calls.length).toBeGreaterThan(after);
  });
});
