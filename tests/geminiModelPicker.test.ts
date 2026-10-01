import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fn = execFileMock as unknown as typeof actual.execFile & Record<symbol, unknown>;
  fn[Symbol.for("nodejs.util.promisify.custom")] = (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      execFileMock(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  return { ...actual, execFile: fn };
});

import { checkEnvironmentModel } from "@/lib/agents/environmentRef";
import { getCapabilities } from "@/lib/agents/capabilities";
import { clearGeminiCatalogCache } from "@/lib/agents/gemini/catalog";
import { getDb } from "@/lib/db";
import { placeModel } from "@/lib/providers/families";
import {
  clearVendorModelCache,
  modelsTreeForEnvironment,
  providerCatalog,
  readProviderModels,
} from "@/lib/providers/catalog";
import { createProvider, getProvider } from "@/lib/providers/store";
import type { ModelProvider } from "@/lib/providers/rows";

// Hypothetical fixture ids prove that newly reported future model versions flow through.
const PRO = "gemini-4-pro-high";
const FLASH = "gemini-4-flash-low";
const RETIRED = "gemini-3.1-pro-high";

function succeed(stdout: string) {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => cb(null, stdout, ""));
}

function googleProvider(model_policy?: unknown, defaultModel?: string): ModelProvider {
  return createProvider({
    type: "google",
    config: defaultModel ? { default_model: defaultModel } : {},
    ...(model_policy === undefined ? {} : { model_policy }),
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  clearGeminiCatalogCache();
  clearVendorModelCache();
  getDb().prepare("DELETE FROM model_providers").run();
});

afterEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
  clearGeminiCatalogCache();
  clearVendorModelCache();
  vi.restoreAllMocks();
});

describe("live Gemini catalog in the model picker", () => {
  it("feeds the Google catalog, picker tree, capabilities, and environment model check", async () => {
    const provider = googleProvider();
    succeed(`${PRO}\tGemini 4 Pro (High)\n${FLASH}\tGemini 4 Flash (Low)\n`);

    const catalog = await providerCatalog(provider, "gemini");
    expect(catalog.map((model) => model.id)).toEqual([PRO, FLASH]);
    expect(catalog[0]).toMatchObject({ id: PRO, label: "Gemini 4 Pro (High)" });

    const models = getCapabilities("gemini").models;
    expect(models.map((model) => model.value)).toEqual([PRO, FLASH]);
    const capabilityModel = models.find((model) => model.value === PRO)!;
    expect(capabilityModel.contextWindow).toBe(placeModel(PRO, "google").ctx);
    expect(checkEnvironmentModel("gemini", PRO.toUpperCase())).toEqual({ model: PRO });
    expect(checkEnvironmentModel("gemini", RETIRED)).toMatchObject({ error: expect.stringContaining("isn't a model gemini runs") });

    const tree = await modelsTreeForEnvironment("gemini");
    const pickerSource = tree.families
      .flatMap((family) => family.versions)
      .flatMap((version) => version.sources)
      .find((source) => source.provider_id === provider.id && source.model === PRO);
    expect(pickerSource).toMatchObject({ provider_id: provider.id, model: PRO });
    const pickerVersion = tree.families
      .flatMap((family) => family.versions)
      .find((version) => version.sources.some((source) => source.provider_id === provider.id && source.model === PRO));
    expect(pickerVersion?.ctx).toBe(capabilityModel.contextWindow);
  });

  it("refreshes the live catalog and preserves disabled and pinned model policy", async () => {
    const provider = googleProvider(
      { mode: "deny", ids: [FLASH], known: [PRO, FLASH], unavailable: [] },
      PRO,
    );
    succeed(`${PRO}\tGemini 4 Pro (High)\n${FLASH}\tGemini 4 Flash (Low)\n`);
    const initial = await readProviderModels(provider, "gemini");
    expect(initial.on.map((model) => model.id)).toEqual([PRO]);
    expect(initial.off.map((model) => model.id)).toEqual([FLASH]);

    succeed(`${FLASH}\tGemini 4 Flash (Low)\n`);
    const refreshed = await readProviderModels(getProvider(provider.id)!, "gemini", true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(refreshed.on).toEqual([]);
    expect(refreshed.off.map((model) => model.id)).toEqual([FLASH]);
    expect(refreshed.unavailable.map((model) => model.id)).toEqual([PRO]);
    expect(refreshed.nextPolicy.ids).toContain(FLASH);
    expect(refreshed.nextPolicy.ids).not.toContain(PRO);
    expect(refreshed.nextPolicy.unavailable).toEqual([PRO]);
  });

  it("keeps the last successful catalog and policy when an explicit refresh fails", async () => {
    const provider = googleProvider();
    succeed(`${PRO}\tGemini 4 Pro (High)\n`);
    const initial = await readProviderModels(provider, "gemini");
    expect(initial.on.map((model) => model.id)).toContain(PRO);

    execFileMock.mockImplementation((_command: string, _args: string[], _options: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => cb(new Error("agy unavailable"), "", ""));
    const refreshed = await readProviderModels(getProvider(provider.id)!, "gemini", true);
    expect(refreshed.on.map((model) => model.id)).toContain(PRO);
    expect(refreshed.nextPolicy.known).toContain(PRO);
    expect(refreshed.nextPolicy.unavailable).not.toContain(PRO);

    const tree = await modelsTreeForEnvironment("gemini");
    const pickerSource = tree.families
      .flatMap((family) => family.versions)
      .flatMap((version) => version.sources)
      .find((source) => source.provider_id === provider.id && source.model === PRO);
    expect(pickerSource).toMatchObject({ provider_id: provider.id, model: PRO });
    expect(checkEnvironmentModel("gemini", PRO.toUpperCase())).toEqual({ model: PRO });
  });
});
