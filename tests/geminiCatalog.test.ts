import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGY_CLI_PATH } from "@/lib/config";

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

import {
  clearGeminiCatalogCache,
  geminiModelCatalog,
  invalidateGeminiCatalogCache,
  lastGeminiModelCatalog,
  parseGeminiModelCatalog,
} from "@/lib/agents/gemini/catalog";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function succeed(stdout: string, stderr = "") {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: ExecFileCallback) => cb(null, stdout, stderr));
}

function fail(message = "agy unavailable") {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: ExecFileCallback) => cb(new Error(message), "", ""));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  execFileMock.mockReset();
  clearGeminiCatalogCache();
});

afterEach(() => {
  clearGeminiCatalogCache();
  vi.useRealTimers();
});

describe("parseGeminiModelCatalog", () => {
  it("keeps Gemini 4 variants and other CLI models without a version allowlist", () => {
    expect(parseGeminiModelCatalog([
      "Fetching models…",
      "gemini-4.0-pro-high\tGemini 4 Pro\tHigh reasoning",
      "gemini-4.0-flash-low\tGemini 4 Flash Low",
      "claude-sonnet-5-2\tClaude Sonnet 5.2",
      "gpt-oss-120b-medium\tGPT OSS 120B Medium",
    ].join("\r\n"))).toEqual([
      { slug: "gemini-4.0-pro-high", label: "Gemini 4 Pro High reasoning" },
      { slug: "gemini-4.0-flash-low", label: "Gemini 4 Flash Low" },
      { slug: "claude-sonnet-5-2", label: "Claude Sonnet 5.2" },
      { slug: "gpt-oss-120b-medium", label: "GPT OSS 120B Medium" },
    ]);
  });

  it("skips chatter and malformed rows, and deduplicates by slug preserving order", () => {
    expect(parseGeminiModelCatalog([
      "Fetching available models...",
      "Error: Please sign in to view available models.",
      "bad slug\tBad slug",
      "gemini-4-flash\tFlash first",
      "gemini-4-flash\tFlash duplicate",
      "gemini-4-pro\t   ",
      "gemini-4-pro",
      "gemini-4-pro\tPro",
    ].join("\n"))).toEqual([
      { slug: "gemini-4-flash", label: "Flash first" },
      { slug: "gemini-4-pro", label: "Pro" },
    ]);
  });
});

describe("geminiModelCatalog", () => {
  it("uses the configured CLI path, read-only command, bounded options, and auto-update guard", async () => {
    succeed("gemini-4-pro\tGemini 4 Pro\n");
    await expect(geminiModelCatalog()).resolves.toEqual([{ slug: "gemini-4-pro", label: "Gemini 4 Pro" }]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileMock.mock.calls[0];
    expect(command).toBe(AGY_CLI_PATH || "agy");
    expect(args).toEqual(["models"]);
    expect(options).toMatchObject({ timeout: expect.any(Number), maxBuffer: expect.any(Number) });
    expect(options.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  });

  it("returns null on first probe errors, signed-out output, malformed output, and empty output", async () => {
    fail();
    await expect(geminiModelCatalog()).resolves.toBeNull();
    clearGeminiCatalogCache();
    succeed("Error: Please sign in to view available models.\n");
    await expect(geminiModelCatalog()).resolves.toBeNull();
    clearGeminiCatalogCache();
    succeed("gemini-4-pro\tGemini 4 Pro\n", "Please sign in to view available models.");
    await expect(geminiModelCatalog()).resolves.toBeNull();
    clearGeminiCatalogCache();
    succeed("Fetching models...\nnot a model row\n");
    await expect(geminiModelCatalog()).resolves.toBeNull();
    clearGeminiCatalogCache();
    succeed("");
    await expect(geminiModelCatalog()).resolves.toBeNull();
  });

  it("retains the last successful catalog on a transient failure", async () => {
    succeed("gemini-4-pro\tGemini 4 Pro\n");
    const catalog = await geminiModelCatalog();
    vi.advanceTimersByTime(60_001);
    fail();
    await expect(geminiModelCatalog()).resolves.toEqual(catalog);
    expect(lastGeminiModelCatalog()).toEqual(catalog);
  });

  it("retains the last good result after explicit invalidation and a failed refresh", async () => {
    succeed("gemini-4-pro\tGemini 4 Pro\n");
    const previous = await geminiModelCatalog();
    invalidateGeminiCatalogCache();
    fail();
    await expect(geminiModelCatalog()).resolves.toEqual(previous);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(lastGeminiModelCatalog()).toEqual(previous);
  });

  it("negative-caches a failed probe for the TTL", async () => {
    fail();
    await expect(geminiModelCatalog()).resolves.toBeNull();
    await expect(geminiModelCatalog()).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("serves fresh cached data and coalesces concurrent probes", async () => {
    let finish!: ExecFileCallback;
    execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: ExecFileCallback) => { finish = cb; });
    const first = geminiModelCatalog();
    const second = geminiModelCatalog();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    finish(null, "gemini-4-flash\tGemini 4 Flash\n", "");
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ slug: "gemini-4-flash", label: "Gemini 4 Flash" }],
      [{ slug: "gemini-4-flash", label: "Gemini 4 Flash" }],
    ]);
    await geminiModelCatalog();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the TTL expires", async () => {
    succeed("gemini-4-pro\tGemini 4 Pro\n");
    await geminiModelCatalog();
    vi.advanceTimersByTime(60_001);
    succeed("gemini-4.1-pro\tGemini 4.1 Pro\n");
    await expect(geminiModelCatalog()).resolves.toEqual([{ slug: "gemini-4.1-pro", label: "Gemini 4.1 Pro" }]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("clears state and prevents an invalidated pending result from repopulating it", async () => {
    let finish!: ExecFileCallback;
    execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: ExecFileCallback) => { finish = cb; });
    const pending = geminiModelCatalog();
    clearGeminiCatalogCache();
    expect(lastGeminiModelCatalog()).toBeNull();
    finish(null, "gemini-4-pro\tGemini 4 Pro\n", "");
    await expect(pending).resolves.toBeNull();
    expect(lastGeminiModelCatalog()).toBeNull();
  });

  it("does not let an invalidated pending result overwrite a fresh result", async () => {
    const callbacks: ExecFileCallback[] = [];
    execFileMock
      .mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: ExecFileCallback) => { callbacks.push(cb); })
      .mockImplementationOnce((_command: string, _args: string[], _options: unknown, cb: ExecFileCallback) => { callbacks.push(cb); });
    const stale = geminiModelCatalog();
    invalidateGeminiCatalogCache();
    const fresh = geminiModelCatalog();
    callbacks[1](null, "gemini-4.1-pro\tGemini 4.1 Pro\n", "");
    await expect(fresh).resolves.toEqual([{ slug: "gemini-4.1-pro", label: "Gemini 4.1 Pro" }]);
    callbacks[0](null, "gemini-4-pro\tGemini 4 Pro\n", "");
    await expect(stale).resolves.toEqual([{ slug: "gemini-4.1-pro", label: "Gemini 4.1 Pro" }]);
    expect(lastGeminiModelCatalog()).toEqual([{ slug: "gemini-4.1-pro", label: "Gemini 4.1 Pro" }]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
