import { describe, it, expect, afterEach } from "vitest";
import { CLAUDE_CAPABILITIES, claudeCapabilities } from "@/lib/agents/claude/capabilities";
import { gatewayModelCatalog, clearGatewayModelCache } from "@/lib/gatewayModels";
import { clearGatewayRates } from "@/lib/gatewayPricing";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";

// claudeCapabilities(env)'s gateway branch (docs/design/litellm.md, "Claude
// driver" + "Model catalog…"): reached when env.ANTHROPIC_BASE_URL IS the
// instance's configured gateway, read via CALANDRIA_LITELLM_BASE_URL — set
// here rather than assumed, since a hermetic run has neither by default.

async function withGatewayEnv<T>(url: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.CALANDRIA_LITELLM_BASE_URL;
  process.env.CALANDRIA_LITELLM_BASE_URL = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CALANDRIA_LITELLM_BASE_URL;
    else process.env.CALANDRIA_LITELLM_BASE_URL = prev;
  }
}

let gw: FakeGateway | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
  clearGatewayModelCache();
  clearGatewayRates();
});

describe("claudeCapabilities — gateway", () => {
  it("falls back to the static catalog when nothing has been probed yet", async () => {
    gw = await startFakeGateway({ models: ["claude-sonnet-4-5"] });
    await withGatewayEnv(gw.url, () => {
      expect(claudeCapabilities({ ANTHROPIC_BASE_URL: gw!.url })).toBe(CLAUDE_CAPABILITIES);
    });
  });

  it("offers the probed catalog once one lands, marking non-Anthropic entries translated", async () => {
    gw = await startFakeGateway({
      models: [
        { name: "claude-sonnet-4-5", provider: "anthropic" },
        { name: "gpt-5-codex", provider: "openai" },
      ],
    });
    await withGatewayEnv(gw.url, async () => {
      await gatewayModelCatalog(gw!.url, "");
      const caps = claudeCapabilities({ ANTHROPIC_BASE_URL: gw!.url });
      expect(caps.models.map((m) => m.value).sort()).toEqual(["claude-sonnet-4-5", "gpt-5-codex"].sort());
      expect(caps.models.find((m) => m.value === "gpt-5-codex")!.sub).toContain("translated");
      expect(caps).not.toBe(CLAUDE_CAPABILITIES);
    });
  });

  it("offers a [1m] sibling only when the catalog states a >=1M window", async () => {
    gw = await startFakeGateway({ models: [{ name: "claude-sonnet-4-5", max_input_tokens: 1_000_000 }] });
    await withGatewayEnv(gw.url, async () => {
      await gatewayModelCatalog(gw!.url, "");
      const caps = claudeCapabilities({ ANTHROPIC_BASE_URL: gw!.url });
      expect(caps.models.map((m) => m.value)).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-5[1m]"]);
      expect(caps.models.find((m) => m.value === "claude-sonnet-4-5[1m]")!.contextWindow).toBe(1_000_000);
    });
  });

  it("is not reached when ANTHROPIC_BASE_URL doesn't match the configured gateway", async () => {
    gw = await startFakeGateway({ models: ["claude-sonnet-4-5"] });
    await withGatewayEnv(gw.url, async () => {
      await gatewayModelCatalog(gw!.url, "");
      // A different base URL — a genuinely custom endpoint, not the gateway —
      // must not pick up the gateway's catalog just because one is configured.
      expect(claudeCapabilities({ ANTHROPIC_BASE_URL: "http://localhost:11434" })).toBe(CLAUDE_CAPABILITIES);
    });
  });
});
