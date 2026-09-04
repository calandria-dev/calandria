import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startFakeGateway, type FakeGateway } from "./fakeGateway";
import { clearGatewayModelCache } from "@/lib/gatewayModels";

// What the gateway health card checks for Antigravity (docs/design/litellm.md,
// "Antigravity driver"): `agy models` diffed against the gateway's own
// /model/info catalog, so a model the CLI needs (the flash-lite side call
// included) but the gateway doesn't serve shows up before a task hits the
// opaque "Agent execution terminated due to error" failure. `agyModelSlugs`
// is mocked rather than spawning a real CLI — it's a thin wrapper over
// `agy models`, already covered by tests/geminiDriver.test.ts's argv/parsing
// coverage — so this exercises the diff logic and the null-propagation rules
// against a real (fake) gateway server.

const agyModelSlugsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/gemini/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/gemini/auth")>();
  return { ...actual, agyModelSlugs: agyModelSlugsMock };
});

import { geminiGatewayModelCheck, lastGeminiGatewayModelCheck, clearGeminiGatewayModelCheckCache } from "@/lib/agents/gemini/gatewayCheck";

let gw: FakeGateway | undefined;

beforeEach(() => {
  agyModelSlugsMock.mockReset();
  clearGatewayModelCache();
  clearGeminiGatewayModelCheckCache();
});

afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

describe("geminiGatewayModelCheck", () => {
  it("names a model the CLI uses that the gateway's catalog doesn't serve", async () => {
    gw = await startFakeGateway({ models: [{ name: "gemini-3.1-pro-preview", provider: "gemini" }] });
    agyModelSlugsMock.mockResolvedValue(["gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"]);

    const result = await geminiGatewayModelCheck(gw.url, "");

    expect(result).toEqual({
      checked: ["gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"],
      missing: ["gemini-3.1-flash-lite-preview"],
    });
  });

  it("reports nothing missing when the catalog covers every model the CLI uses", async () => {
    gw = await startFakeGateway({
      models: [
        { name: "gemini-3.1-pro-preview", provider: "gemini" },
        { name: "gemini-3.1-flash-lite-preview", provider: "gemini" },
      ],
    });
    agyModelSlugsMock.mockResolvedValue(["gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"]);

    const result = await geminiGatewayModelCheck(gw.url, "");
    expect(result?.missing).toEqual([]);
  });

  it("says nothing rather than claiming everything is missing when agy can't answer", async () => {
    gw = await startFakeGateway({ models: ["gemini-3.1-pro-preview"] });
    agyModelSlugsMock.mockResolvedValue(null); // signed out, no binary, or empty output

    const result = await geminiGatewayModelCheck(gw.url, "");
    expect(result).toBeNull();
  });

  it("says nothing when the gateway itself didn't answer", async () => {
    agyModelSlugsMock.mockResolvedValue(["gemini-3.1-pro-preview"]);
    const result = await geminiGatewayModelCheck("http://127.0.0.1:1", "");
    expect(result).toBeNull();
  });

  it("caches the answer, so a second read doesn't spawn agy again", async () => {
    gw = await startFakeGateway({ models: ["gemini-3.1-pro-preview"] });
    agyModelSlugsMock.mockResolvedValue(["gemini-3.1-pro-preview"]);

    await geminiGatewayModelCheck(gw.url, "");
    await geminiGatewayModelCheck(gw.url, "");
    expect(agyModelSlugsMock).toHaveBeenCalledTimes(1);
  });

  it("lets a later read see the cached answer synchronously", async () => {
    gw = await startFakeGateway({ models: ["gemini-3.1-pro-preview"] });
    agyModelSlugsMock.mockResolvedValue(["gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"]);

    expect(lastGeminiGatewayModelCheck(gw.url)).toBeNull();
    await geminiGatewayModelCheck(gw.url, "");
    expect(lastGeminiGatewayModelCheck(gw.url)?.missing).toEqual(["gemini-3.1-flash-lite-preview"]);
  });
});
