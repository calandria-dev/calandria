import { beforeEach, describe, expect, it, vi } from "vitest";

const helpers = vi.hoisted(() => ({
  summarizeTranscript: vi.fn(async () => ({ text: "HANDOFF" })),
  draftProjectContext: vi.fn(async () => ({ text: "DRAFT" })),
  summarizeProjectRecap: vi.fn(async () => ({ text: "RECAP" })),
}));

vi.mock("../lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Claude Code",
    ...helpers,
  },
}));

import { createProject, createTask, getSetting, setSetting } from "../lib/store";
import { setAgentConnection } from "../lib/agents/connections";
import { draftProjectContext, summarizeProjectRecap, summarizeTranscript } from "../lib/agents/oneshots";
import { sweepRecaps } from "../lib/recap";
import { GET as getSettings, PATCH as patchSettings } from "../app/api/settings/route";

describe("background agent job controls", () => {
  beforeEach(() => {
    setSetting("background_jobs", null);
    setSetting("recap_mode", null);
    setSetting("default_agent", "claude");
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
    for (const mock of Object.values(helpers)) mock.mockClear();
  });

  it("makes a recap sweep a no-op when the master switch is off", async () => {
    setSetting("background_jobs", "off");

    await expect(sweepRecaps()).resolves.toBe(0);
    expect(helpers.summarizeProjectRecap).not.toHaveBeenCalled();
  });

  it("makes a recap sweep a no-op when automatic recaps are off", async () => {
    setSetting("background_jobs", "on");
    setSetting("recap_mode", "off");

    await expect(sweepRecaps()).resolves.toBe(0);
    expect(helpers.summarizeProjectRecap).not.toHaveBeenCalled();
  });

  it("refuses unattended one-shots while leaving explicit /clear and Refresh with AI available", async () => {
    setSetting("background_jobs", "off");
    const project = createProject({ name: "Explicit jobs" });
    const task = createTask({ project_id: project.id, title: "Session", description: "" });

    await expect(summarizeProjectRecap(project, "digest")).rejects.toThrow(/Background jobs are off/);
    await expect(summarizeTranscript(task, "transcript", project)).resolves.toBe("HANDOFF");
    await expect(draftProjectContext(project, "digest")).resolves.toBe("DRAFT");

    expect(helpers.summarizeProjectRecap).not.toHaveBeenCalled();
    expect(helpers.summarizeTranscript).toHaveBeenCalledOnce();
    expect(helpers.draftProjectContext).toHaveBeenCalledOnce();
  });

  it("round-trips both keys through the settings PATCH allowlist", async () => {
    const response = await patchSettings(new Request("http://test/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ background_jobs: "off", recap_mode: "on_open", not_allowed: "nope" }),
    }));
    expect(await response.json()).toMatchObject({ background_jobs: "off", recap_mode: "on_open" });
    expect(getSetting("not_allowed")).toBeNull();

    const read = await getSettings();
    expect(await read.json()).toMatchObject({ background_jobs: "off", recap_mode: "on_open" });
  });
});
