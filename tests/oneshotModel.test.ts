import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotOptions } from "../lib/agents/types";

// Both drivers are stubbed down to the one-shot helpers so the assertions are
// about ROUTING (which key each job reads, off which agent) rather than about
// what a real CLI does with a model id. The codex stub deliberately omits
// summarizeTranscript, which is what exercises the fall-back-to-utility path.
const claude = vi.hoisted(() => ({
  summarizeTranscript: vi.fn(async (_t: string, _p: unknown, _o?: OneShotOptions) => ({ text: "HANDOFF" })),
  draftProjectContext: vi.fn(async (_p: unknown, _d: string, _o?: OneShotOptions) => ({ text: "DRAFT" })),
  summarizeProjectRecap: vi.fn(async (_p: unknown, _d: string, _o?: OneShotOptions) => ({ text: "RECAP" })),
}));
const codex = vi.hoisted(() => ({
  draftProjectContext: vi.fn(async (_p: unknown, _d: string, _o?: OneShotOptions) => ({ text: "DRAFT" })),
  summarizeProjectRecap: vi.fn(async (_p: unknown, _d: string, _o?: OneShotOptions) => ({ text: "RECAP" })),
}));

vi.mock("../lib/agents/claude/driver", () => ({
  claudeDriver: { id: "claude", label: "Claude Code", ...claude },
}));
vi.mock("../lib/agents/codex/driver", () => ({
  codexDriver: { id: "codex", label: "Codex", ...codex },
}));

import { createProject, createTask, setSetting } from "../lib/store";
import { setAgentConnection } from "../lib/agents/connections";
import { draftProjectContext, oneShotModel, summarizeProjectRecap, summarizeTranscript } from "../lib/agents/oneshots";
import { PATCH as patchSettings } from "../app/api/settings/route";
import type { Project, Task } from "../lib/types";


describe("one-shot model selection", () => {
  let project: Project;
  let task: Task;

  beforeEach(() => {
    for (const key of ["claude", "codex"]) {
      setSetting(`job_model_light:${key}`, null);
      setSetting(`job_model_heavy:${key}`, null);
    }
    setSetting("default_agent", "claude");
    setSetting("utility_agent", null);
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
    setAgentConnection("codex", { method: "subscription", email: null, plan: null });
    for (const mock of [...Object.values(claude), ...Object.values(codex)]) mock.mockClear();
    project = createProject({ name: "One-shot models" });
    task = createTask({ project_id: project.id, title: "Session", description: "" });
  });

  it("passes no model when nothing is set, so every job inherits the driver's own default", async () => {
    await summarizeTranscript(task, "transcript", project);
    await summarizeProjectRecap(project, "digest", { unattended: false });
    await draftProjectContext(project, "digest");

    expect(claude.summarizeTranscript.mock.lastCall?.[2]).toEqual({ model: null });
    expect(claude.summarizeProjectRecap.mock.lastCall?.[2]).toEqual({ model: null });
    expect(claude.draftProjectContext.mock.lastCall?.[2]).toEqual({ model: null });
  });

  it("routes the two text-only jobs to the light tier and the repo-reading one to the heavy tier", async () => {
    setSetting("job_model_light:claude", "haiku");
    setSetting("job_model_heavy:claude", "opus");

    await summarizeTranscript(task, "transcript", project);
    await summarizeProjectRecap(project, "digest", { unattended: false });
    await draftProjectContext(project, "digest");

    expect(claude.summarizeTranscript.mock.lastCall?.[2]).toEqual({ model: "haiku" });
    expect(claude.summarizeProjectRecap.mock.lastCall?.[2]).toEqual({ model: "haiku" });
    expect(claude.draftProjectContext.mock.lastCall?.[2]).toEqual({ model: "opus" });
  });

  it("keeps the tiers independent — setting one leaves the other inheriting", async () => {
    setSetting("job_model_heavy:claude", "opus");

    await summarizeProjectRecap(project, "digest", { unattended: false });
    await draftProjectContext(project, "digest");

    expect(claude.summarizeProjectRecap.mock.lastCall?.[2]).toEqual({ model: null });
    expect(claude.draftProjectContext.mock.lastCall?.[2]).toEqual({ model: "opus" });
  });

  it("scopes the setting to the agent the job runs on, not to one global model id", async () => {
    setSetting("job_model_light:claude", "haiku");
    setSetting("job_model_light:codex", "gpt-5.6-luna");
    setSetting("utility_agent", "codex");

    // Task-scoped: follows the task's own agent, so it reads the claude key.
    await summarizeTranscript(task, "transcript", project);
    // Project-scoped: runs on the utility agent, so it reads the codex key.
    await summarizeProjectRecap(project, "digest", { unattended: false });

    expect(claude.summarizeTranscript.mock.lastCall?.[2]).toEqual({ model: "haiku" });
    expect(codex.summarizeProjectRecap.mock.lastCall?.[2]).toEqual({ model: "gpt-5.6-luna" });
  });

  it("reads the RESOLVED agent's key when a driver falls back to the utility agent", async () => {
    // A model id names one provider's catalog: a Codex task whose /clear note is
    // written by Claude (the codex stub has no summarizeTranscript) must not
    // hand Claude the codex id.
    setSetting("job_model_light:claude", "haiku");
    setSetting("job_model_light:codex", "gpt-5.6-luna");
    const codexTask = createTask({ project_id: project.id, title: "Codex session", description: "", agent: "codex" });

    await summarizeTranscript(codexTask, "transcript", project);

    expect(claude.summarizeTranscript.mock.lastCall?.[2]).toEqual({ model: "haiku" });
  });

  it("exposes the same resolution to callers that only want to report it", () => {
    setSetting("job_model_light:claude", "haiku");
    setSetting("job_model_heavy:claude", "opus");

    expect(oneShotModel("claude", "summarizeTranscript")).toBe("haiku");
    expect(oneShotModel("claude", "summarizeProjectRecap")).toBe("haiku");
    expect(oneShotModel("claude", "draftProjectContext")).toBe("opus");
    expect(oneShotModel("codex", "draftProjectContext")).toBeNull();
  });

  it("round-trips both tier keys through the settings PATCH allowlist, and rejects an unscoped one", async () => {
    const response = await patchSettings(new Request("http://test/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        "job_model_light:claude": "haiku",
        "job_model_heavy:codex": "gpt-5.6-sol",
        // No un-scoped form: a model id can't be right for every driver.
        job_model_light: "haiku",
        job_model_medium: "sonnet",
      }),
    }));
    const settings = (await response.json()) as Record<string, string>;

    expect(settings["job_model_light:claude"]).toBe("haiku");
    expect(settings["job_model_heavy:codex"]).toBe("gpt-5.6-sol");
    expect(settings.job_model_light).toBeUndefined();
    expect(settings.job_model_medium).toBeUndefined();
  });
});
