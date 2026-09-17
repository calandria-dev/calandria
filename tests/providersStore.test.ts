import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, createTask } from "@/lib/store";
import { createSchedule } from "@/lib/schedule/store";
import { createRunbook } from "@/lib/runbooks/store";
import { setProviderSecret } from "@/lib/providerSecrets";
import {
  bundledProviderFor,
  createProvider,
  deleteProvider,
  ensureBundledProvider,
  firstProviderOfType,
  getProvider,
  listProviders,
  providersForEnvironment,
  providerUsage,
  removeBundledProvider,
  updateProvider,
} from "@/lib/providers/store";

const project = (name = `prov-${Math.random().toString(36).slice(2)}`) => createProject({ name }).id;

beforeEach(() => {
  getDb().prepare("DELETE FROM model_providers").run();
  getDb().prepare("DELETE FROM runbooks").run();
  getDb().prepare("DELETE FROM schedules").run();
});

describe("provider store: CRUD", () => {
  it("creates a litellm provider and normalizes its config", () => {
    const row = createProvider({
      type: "litellm",
      label: "Work gateway",
      config: { base_url: "http://gw.home.arpa:4000" },
    });
    expect(row.id).toBeTruthy();
    expect(row.label).toBe("Work gateway");
    expect(row.config.base_url).toBe("http://gw.home.arpa:4000");
    expect(row.bundled).toBeNull();
    expect(row.environments).toEqual(["claude", "codex", "gemini"]);
    expect(row.has_key).toBe(false);
    expect(row.has_admin_key).toBe(false);
    expect(row.model_policy.mode).toBe("allow");
  });

  it("reads a created row back by id", () => {
    const row = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    expect(getProvider(row.id)).toEqual(row);
  });

  it("updates the label and moves updated_at forward or leaves it equal", () => {
    const row = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const updated = updateProvider(row.id, { label: "Home gateway" })!;
    expect(updated.label).toBe("Home gateway");
    expect(updated.updated_at).toBeGreaterThanOrEqual(row.updated_at);
  });

  it("updateProvider on an unknown id returns null", () => {
    expect(updateProvider("nope", { label: "x" })).toBeNull();
  });

  it("deleteProvider removes the row", () => {
    const row = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    expect(deleteProvider(row.id)).not.toBeNull();
    expect(getProvider(row.id)).toBeNull();
  });

  it("deleteProvider on an unknown id returns null", () => {
    expect(deleteProvider("nope")).toBeNull();
  });

  it("listProviders sorts bundled rows before user-added rows", () => {
    createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const anthropic = ensureBundledProvider("claude")!;
    const listed = listProviders();
    expect(listed[0].id).toBe(anthropic.id);
  });
});

describe("provider store: per-type policy default", () => {
  it("litellm defaults to allow", () => {
    const row = createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    expect(row.model_policy.mode).toBe("allow");
    expect(row.model_policy.ids).toEqual([]);
    expect(row.model_policy.known).toEqual([]);
    expect(row.model_policy.unavailable).toEqual([]);
  });

  it("ollama, custom and openai_key default to deny", () => {
    const ollama = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    expect(ollama.model_policy.mode).toBe("deny");
    const custom = createProvider({ type: "custom", config: { base_url: "http://x.example.com", api: "openai" } });
    expect(custom.model_policy.mode).toBe("deny");
    const openaiKey = createProvider({ type: "openai_key" });
    expect(openaiKey.model_policy.mode).toBe("deny");
  });

  it("a bundled row also defaults to deny", () => {
    const row = ensureBundledProvider("claude")!;
    expect(row.model_policy.mode).toBe("deny");
    expect(row.model_policy.ids).toEqual([]);
    expect(row.model_policy.known).toEqual([]);
    expect(row.model_policy.unavailable).toEqual([]);
  });
});

describe("provider store: bundled refusal", () => {
  it("ensureBundledProvider is idempotent", () => {
    const first = ensureBundledProvider("claude")!;
    const second = ensureBundledProvider("claude")!;
    expect(second.id).toBe(first.id);
    const count = (
      getDb().prepare("SELECT COUNT(*) AS n FROM model_providers WHERE type = 'anthropic'").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("createProvider refuses a second anthropic row", () => {
    ensureBundledProvider("claude");
    expect(() => createProvider({ type: "anthropic" })).toThrow();
  });

  it("firstProviderOfType and bundledProviderFor find the bundled row", () => {
    const row = ensureBundledProvider("claude")!;
    expect(firstProviderOfType("anthropic")!.id).toBe(row.id);
    expect(bundledProviderFor("claude")!.id).toBe(row.id);
    expect(bundledProviderFor("mock")).toBeNull();
  });

  it("removeBundledProvider deletes the row and is idempotent", () => {
    ensureBundledProvider("claude");
    expect(removeBundledProvider("claude")).not.toBeNull();
    expect(removeBundledProvider("claude")).toBeNull();
    expect(bundledProviderFor("claude")).toBeNull();
  });
});

describe("provider store: providerUsage", () => {
  it("names the project, task, schedule and runbook that reference a provider", () => {
    const provider = createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    const pid = project();
    getDb().prepare("UPDATE projects SET default_provider_id = ? WHERE id = ?").run(provider.id, pid);
    const task = createTask({ project_id: pid, title: "a task" });
    getDb().prepare("UPDATE tasks SET provider_id = ? WHERE id = ?").run(provider.id, task.id);
    const schedule = createSchedule({
      project_id: pid,
      name: "a schedule",
      prompt: "/ignored",
      days_mask: 62,
      time_of_day: "08:30",
      timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET provider_id = ? WHERE id = ?").run(provider.id, schedule.id);
    const runbook = createRunbook({ project_id: pid, name: "a runbook", prompt: "/ignored" });
    getDb().prepare("UPDATE runbooks SET provider_id = ? WHERE id = ?").run(provider.id, runbook.id);

    const usage = providerUsage(provider.id);
    expect(usage.projects.map((p) => p.id)).toEqual([pid]);
    expect(usage.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(usage.schedules.map((s) => s.id)).toEqual([schedule.id]);
    expect(usage.runbooks.map((r) => r.id)).toEqual([runbook.id]);
  });

  it("returns four empty lists for an unreferenced provider", () => {
    const provider = createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    const usage = providerUsage(provider.id);
    expect(usage.projects).toEqual([]);
    expect(usage.tasks).toEqual([]);
    expect(usage.schedules).toEqual([]);
    expect(usage.runbooks).toEqual([]);
  });
});

describe("provider store: ON DELETE SET NULL", () => {
  it("deleting a referenced provider detaches every referencing row instead of removing it", () => {
    const provider = createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    const pid = project();
    getDb().prepare("UPDATE projects SET default_provider_id = ? WHERE id = ?").run(provider.id, pid);
    const task = createTask({ project_id: pid, title: "a task" });
    getDb().prepare("UPDATE tasks SET provider_id = ? WHERE id = ?").run(provider.id, task.id);
    const schedule = createSchedule({
      project_id: pid,
      name: "a schedule",
      prompt: "/ignored",
      days_mask: 62,
      time_of_day: "08:30",
      timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET provider_id = ? WHERE id = ?").run(provider.id, schedule.id);
    const runbook = createRunbook({ project_id: pid, name: "a runbook", prompt: "/ignored" });
    getDb().prepare("UPDATE runbooks SET provider_id = ? WHERE id = ?").run(provider.id, runbook.id);

    const usage = deleteProvider(provider.id)!;
    expect(usage.projects.map((p) => p.id)).toEqual([pid]);
    expect(usage.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(usage.schedules.map((s) => s.id)).toEqual([schedule.id]);
    expect(usage.runbooks.map((r) => r.id)).toEqual([runbook.id]);

    const projectRow = getDb().prepare("SELECT default_provider_id FROM projects WHERE id = ?").get(pid) as {
      default_provider_id: string | null;
    };
    expect(projectRow.default_provider_id).toBeNull();
    const taskRow = getDb().prepare("SELECT provider_id FROM tasks WHERE id = ?").get(task.id) as {
      provider_id: string | null;
    };
    expect(taskRow.provider_id).toBeNull();
    const scheduleRow = getDb().prepare("SELECT provider_id FROM schedules WHERE id = ?").get(schedule.id) as {
      provider_id: string | null;
    };
    expect(scheduleRow.provider_id).toBeNull();
    const runbookRow = getDb().prepare("SELECT provider_id FROM runbooks WHERE id = ?").get(runbook.id) as {
      provider_id: string | null;
    };
    expect(runbookRow.provider_id).toBeNull();
  });
});

describe("provider store: secrets never appear on a row", () => {
  it("has_key flips to true and the value never shows up in the served row", () => {
    const row = createProvider({ type: "litellm", config: { base_url: "http://gw.example.com" } });
    setProviderSecret(row.id, "key", "sk-secret");
    const read = getProvider(row.id)!;
    expect(read.has_key).toBe(true);
    expect(JSON.stringify(read)).not.toContain("sk-secret");
    expect(JSON.stringify(listProviders())).not.toContain("sk-secret");
  });
});

describe("providersForEnvironment", () => {
  it("filters to providers that serve the given environment", () => {
    createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const anthropic = ensureBundledProvider("claude")!;
    const claude = providersForEnvironment("claude");
    expect(claude.some((p) => p.id === anthropic.id)).toBe(true);
    expect(claude.some((p) => p.type === "ollama")).toBe(true);
    const gemini = providersForEnvironment("gemini");
    expect(gemini.some((p) => p.type === "ollama")).toBe(false);
  });
});
