import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modelEndpoint", () => ({
  endpointModels: vi.fn(async () => ({ reachable: false })),
  summarizeEndpoint: vi.fn(() => ({
    base_url: "http://localhost:11434",
    reachable: false,
    api: null,
    model_count: 0,
    error: null,
  })),
}));

vi.mock("@/lib/agents/claude/modelProbe", () => ({ ensureClaudeModelIds: vi.fn() }));

import { GET } from "@/app/api/agents/route";
import { getCapabilities, listAgentIds } from "@/lib/agents/capabilities";
import { detectAgentInstallation } from "@/lib/agents/detect";
import { MOCK_CAPABILITIES } from "@/lib/agents/mock/capabilities";
import { getDb } from "@/lib/db";
import { createProvider } from "@/lib/providers/store";
import {
  PROVIDER_REGISTRY,
  PROVIDER_TYPES,
  type EnvironmentId,
  type ProviderType,
} from "@/lib/providers/types";

const ENV_LABELS: Record<EnvironmentId, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Antigravity",
};

const ENDPOINT_TRANSPORTS: Record<EnvironmentId, string> = {
  claude: "ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the turn's environment",
  codex: "a model_providers entry written through the SDK's config overrides",
  gemini: "GOOGLE_GEMINI_BASE_URL and GEMINI_API_KEY in the turn's environment",
};

const PROVIDER_COLUMNS: Record<ProviderType, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openai_key: "OpenAI key",
  gemini_key: "Gemini key",
  litellm: "LiteLLM",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  custom: "Custom",
};

function providerTypesFor(environment: EnvironmentId): ProviderType[] {
  return PROVIDER_TYPES.filter((type) => PROVIDER_REGISTRY[type].environments.includes(environment));
}

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'agent_conn_%' OR key LIKE 'onboarding_%'").run();
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.AGY_CLI_PATH;
});

describe("environment provider capabilities", () => {
  it("matches every real environment to the provider registry", () => {
    expect(listAgentIds()).toEqual(["claude", "codex", "gemini"]);
    for (const environment of listAgentIds() as EnvironmentId[]) {
      const capabilities = getCapabilities(environment);
      expect(capabilities.providerTypes).toEqual(providerTypesFor(environment));
      expect(PROVIDER_REGISTRY[capabilities.bundledProvider].bundled).toBe(environment);
      expect(capabilities.endpointTransport).toBe(ENDPOINT_TRANSPORTS[environment]);
    }
  });

  it("gives the mock the Claude provider set for e2e coverage", () => {
    expect(MOCK_CAPABILITIES.providerTypes).toEqual(providerTypesFor("claude"));
    expect(MOCK_CAPABILITIES.bundledProvider).toBe("anthropic");
  });

  it("keeps the documentation matrix in sync with the registry", () => {
    const markdown = fs.readFileSync(path.join(__dirname, "..", "docs", "AGENTS.md"), "utf8");
    const table = markdown
      .slice(markdown.indexOf("| Agent | Authentication |"))
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(0, 5)
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
    const [header, , ...rows] = table;
    expect(header.slice(3, 12)).toEqual(PROVIDER_TYPES.map((type) => PROVIDER_COLUMNS[type]));
    for (const environment of Object.keys(ENV_LABELS) as EnvironmentId[]) {
      const row = rows.find((cells) => cells[0] === ENV_LABELS[environment]);
      expect(row).toBeDefined();
      expect(row!.slice(3, 12)).toEqual(
        PROVIDER_TYPES.map((type) => PROVIDER_REGISTRY[type].environments.includes(environment) ? "Yes" : ""),
      );
    }
  });
});

describe("agent installation and provider response", () => {
  it("uses a CLI config directory as an installation signal", () => {
    const home = fs.mkdtempSync(path.join(process.env.CALANDRIA_TEST_TMP!, "agent-config-"));
    fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
    expect(detectAgentInstallation("gemini", { env: { NODE_ENV: "test" }, homeDir: home, pathEnv: "" }))
      .toEqual({ installed: true, installedVersion: null });
  });

  it("detects a PATH binary, reads its version, and reports installed without a connection", async () => {
    const root = fs.mkdtempSync(path.join(process.env.CALANDRIA_TEST_TMP!, "agent-detect-"));
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const agy = path.join(bin, process.platform === "win32" ? "agy.cmd" : "agy");
    fs.writeFileSync(
      agy,
      process.platform === "win32" ? "@echo off\r\necho agy 9.8.7\r\n" : "#!/bin/sh\nprintf 'agy 9.8.7\\n'\n",
    );
    if (process.platform !== "win32") fs.chmodSync(agy, 0o755);
    process.env.PATH = bin;
    process.env.HOME = home;

    expect(detectAgentInstallation("gemini")).toEqual({ installed: true, installedVersion: "9.8.7" });

    const gateway = createProvider({ type: "litellm", config: { base_url: "http://gateway.example.com" } });
    const ollama = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const response = await GET();
    const body = await response.json() as {
      agents: Array<{
        id: string;
        status: string;
        installedVersion: string | null;
        bundledProvider: ProviderType;
        providerTypes: ProviderType[];
        providers: Array<{ id: string; type: ProviderType }>;
      }>;
    };
    const byId = new Map(body.agents.map((agent) => [agent.id, agent]));

    expect(byId.get("gemini")).toMatchObject({
      status: "installed",
      installedVersion: "9.8.7",
      bundledProvider: "google",
      providerTypes: ["google", "gemini_key", "litellm"],
    });
    expect(byId.get("claude")!.providers.map((provider) => provider.id)).toEqual([gateway.id, ollama.id]);
    expect(byId.get("codex")!.providers.map((provider) => provider.id)).toEqual([gateway.id, ollama.id]);
    expect(byId.get("gemini")!.providers.map((provider) => provider.id)).toEqual([gateway.id]);
  });
});
