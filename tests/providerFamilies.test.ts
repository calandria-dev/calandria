import { describe, expect, it } from "vitest";
import { placeModel } from "@/lib/providers/families";

describe("model family placement", () => {
  it("covers every current driver catalog id", () => {
    const cases: Record<string, string[]> = {
      fable: ["claude-fable-5-1", "fable"],
      opus: ["opus", "opusplan", "opus[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-6-thinking"],
      sonnet: ["sonnet", "sonnet[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"],
      haiku: ["haiku"],
      gpt: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-oss-120b-medium"],
      gemini: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low", "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low", "gemini-3.1-pro-high", "gemini-3.1-pro-low"],
    };
    for (const [family, ids] of Object.entries(cases)) for (const id of ids) expect(placeModel(id, "anthropic").family).toBe(family);
    expect(placeModel("claude-sonnet-4-6", "google").family).toBe("sonnet");
    expect(placeModel("claude-opus-4-6-thinking", "google").family).toBe("opus");
  });

  it("places the built-in driver model families", () => {
    expect(placeModel("claude-opus-4-8", "anthropic")).toMatchObject({ family: "opus", version: "opus-4.8", label: "Opus 4.8", chat: true });
    expect(placeModel("gpt-5.6-sol", "openai")).toMatchObject({ family: "gpt", version: "gpt-5.6-sol", label: "GPT-5.6 Sol" });
    expect(placeModel("gemini-3.8-flash-high", "google").family).toBe("gemini");
    for (const id of ["qwen3-coder:30b", "deepseek-r2:14b", "zai/glm-5", "moonshot/kimi-k2.5", "gemma-4:27b", "llama-4-maverick", "mistral/devstral-2"]) {
      expect(placeModel(id, "litellm").family).not.toBe("other");
    }
  });

  it("normalizes gateway prefixes, size tags, dates, and one-million variants", () => {
    expect(placeModel("anthropic/claude-opus-4-8-20260212", "litellm")).toMatchObject({
      family: "opus", version: "opus-4.8", duplicate_of: "anthropic/claude-opus-4-8",
    });
    expect(placeModel("qwen3-coder:30b", "ollama")).toMatchObject({ family: "qwen", version: "qwen3-coder-30b", label: "Qwen3 Coder 30B" });
    expect(placeModel("sonnet[1m]", "anthropic")).toMatchObject({ family: "sonnet", version: "latest-1m", label: "Sonnet (latest, 1M)", ctx: 1_000_000 });
    expect(placeModel("claude-opus-4-8[1m]", "anthropic")).toMatchObject({
      family: "opus", version: "opus-4.8-1m", label: "Opus 4.8 (1M)", ctx: 1_000_000,
    });
    expect(placeModel("claude-opus-5", "litellm").ctx).toBe(1_000_000);
    expect(placeModel("deepseek-r2:14b", "ollama").ctx).toBe(64_000);
    expect(placeModel("gemma-4:27b", "ollama").ctx).toBe(128_000);
    expect(placeModel("together/llama-4-maverick", "litellm").ctx).toBe(1_000_000);
  });

  it("covers gateway test ids and all mock gateway extras", () => {
    expect(placeModel("claude-sonnet-4-5", "litellm").family).toBe("sonnet");
    expect(placeModel("gpt-5-codex", "litellm").family).toBe("gpt");
    expect(placeModel("gemini-3-flash", "litellm").family).toBe("gemini");
    for (const id of ["claude-on-vertex", "claude-on-bedrock", "anthropic/*"]) expect(placeModel(id, "litellm").family).toBe("other");
    expect(placeModel("text-embedding-3", "litellm")).toMatchObject({ family: "other", chat: false });
    expect(placeModel("together/llama-4-maverick", "litellm").family).toBe("llama");
    expect(placeModel("mistral/devstral-2", "litellm").family).toBe("devstral");
    expect(placeModel("openai/text-embedding-3-large", "litellm")).toMatchObject({ family: "other", chat: false });
    expect(placeModel("anthropic/claude-opus-4-8-20260212", "litellm").duplicate_of).toBe("anthropic/claude-opus-4-8");
  });

  it("keeps aliases in latest rows and marks non-chat modalities", () => {
    expect(placeModel("opus", "anthropic")).toMatchObject({ family: "opus", version: "latest", label: "Opus (latest)" });
    for (const id of ["text-embedding-3-large", "whisper-1", "dall-e-3", "rerank-v3"]) {
      expect(placeModel(id, "litellm").chat).toBe(false);
    }
  });

  it("places unknown ids in Other using the raw id", () => {
    expect(placeModel("vendor/surprise-model", "custom")).toEqual({ family: "other", version: "vendor/surprise-model", label: "vendor/surprise-model", ctx: 0, duplicate_of: null, chat: true });
  });
});
