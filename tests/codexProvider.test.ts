import { describe, it, expect } from "vitest";
import { codexProviderConfig, CODEX_LOCAL_PROVIDER_ID } from "@/lib/agents/codex/provider";
import { agentTurnEnv, providerPresetEnv, serializeAgentEnv, cloudOverrideEnv } from "@/lib/agentEnv";
import type { Project, Task } from "@/lib/types";

// The Codex half of a provider override (lib/agents/codex/provider.ts): the
// codex CLI reads its provider from config.toml, not the environment, so the
// override becomes a `--config` provider entry the driver spreads into the
// SDK's `config`. Pure data, so this runs without the SDK or a codex binary.

const project = (agent_env: string) => ({ port: 0, agent_env }) as Pick<Project, "port" | "agent_env">;
const task = (agent_env: string) => ({ agent_env }) as Pick<Task, "agent_env">;

describe("codexProviderConfig", () => {
  it("emits nothing for the cloud", () => {
    expect(codexProviderConfig({})).toEqual({ config: {}, model: null });
    expect(codexProviderConfig({ ANTHROPIC_BASE_URL: "http://localhost:11434" })).toEqual({ config: {}, model: null });
  });

  it("maps OPENAI_BASE_URL onto a named provider entry on the Responses wire API, with the model beside it", () => {
    const out = codexProviderConfig({ OPENAI_BASE_URL: "http://localhost:11434/v1", CODEX_MODEL: "gpt-oss:20b" });
    expect(out.model).toBe("gpt-oss:20b");
    expect(out.config).toEqual({
      model_provider: CODEX_LOCAL_PROVIDER_ID,
      model_providers: {
        [CODEX_LOCAL_PROVIDER_ID]: { name: "Local model (Calandria)", base_url: "http://localhost:11434/v1", wire_api: "responses" },
      },
    });
  });

  it("adds /v1 to a bare host and tolerates a trailing slash", () => {
    const one = codexProviderConfig({ OPENAI_BASE_URL: "http://host.docker.internal:11434" });
    const two = codexProviderConfig({ OPENAI_BASE_URL: "http://host.docker.internal:11434/v1/" });
    const base = (c: typeof one) => (c.config.model_providers as Record<string, { base_url: string }>)[CODEX_LOCAL_PROVIDER_ID].base_url;
    expect(base(one)).toBe("http://host.docker.internal:11434/v1");
    expect(base(two)).toBe("http://host.docker.internal:11434/v1");
  });

  it("falls back to CODEX_OSS_BASE_URL for a hand-configured --oss user", () => {
    const out = codexProviderConfig({ CODEX_OSS_BASE_URL: "http://localhost:11434/v1" });
    expect(out.config.model_provider).toBe(CODEX_LOCAL_PROVIDER_ID);
  });

  it("reads the MERGED turn env, so a task-level cloud override wins over a local project", () => {
    const proj = project(serializeAgentEnv(providerPresetEnv({ baseUrl: "http://localhost:11434", model: "qwen3-coder" })));
    const local = codexProviderConfig(agentTurnEnv(proj, null, { PATH: "/usr/bin" }));
    expect(local.config.model_provider).toBe(CODEX_LOCAL_PROVIDER_ID);
    expect(local.model).toBe("qwen3-coder");
    const cloud = codexProviderConfig(agentTurnEnv(proj, task(serializeAgentEnv(cloudOverrideEnv())), { PATH: "/usr/bin" }));
    expect(cloud).toEqual({ config: {}, model: null });
  });
});
