import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createProject } from "@/lib/store";
import { createSchedule } from "@/lib/schedule/store";
import { createRunbook, getRunbook, listRunbooks } from "@/lib/runbooks/store";
import { createRunbookForAgent, listRunbooksForAgent, updateRunbookForAgent } from "@/lib/runbookTools";
import { setAgentConnection } from "@/lib/agents/connections";
import { createProvider } from "@/lib/providers/store";

describe("runbook agent tools", () => {
  let here: ReturnType<typeof createProject>;
  beforeEach(() => {
    getDb().prepare("DELETE FROM runbooks").run();
    getDb().prepare("DELETE FROM schedules").run();
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
    here = createProject({ name: `rbt-${Math.random().toString(36).slice(2)}` });
  });

  it("creates in the calling project and records which agent filed it", () => {
    const { runbook, text } = createRunbookForAgent(here, { name: "Sweep", description: "d", prompt: "/sweep" }, "claude");
    expect(runbook).not.toBeNull();
    expect(runbook!.project_id).toBe(here.id);
    expect(runbook!.created_by).toBe("claude");
    expect(text).toContain("Sweep");
  });

  it("files into another project named exactly, and refuses an unrecognized one", () => {
    const other = createProject({ name: `Elsewhere-${Math.random().toString(36).slice(2)}` });
    const ok = createRunbookForAgent(here, { name: "S", description: "", prompt: "/s", project: other.name }, "claude");
    expect(ok.runbook!.project_id).toBe(other.id);

    // Strict in both directions: no fallback to the caller's project.
    const bad = createRunbookForAgent(here, { name: "S", description: "", prompt: "/s", project: "nope" }, "claude");
    expect(bad.runbook).toBeNull();
    expect(bad.text).toContain("No project matches");
    expect(listRunbooks(here.id).filter((r) => r.name === "S")).toHaveLength(0);
  });

  it("requires a name and a prompt", () => {
    expect(createRunbookForAgent(here, { name: "  ", description: "", prompt: "/s" }, "claude").runbook).toBeNull();
    expect(createRunbookForAgent(here, { name: "S", description: "", prompt: "  " }, "claude").runbook).toBeNull();
  });

  it("lists the calling project's runbooks, flagging the schedules that fire them", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a" });
    const s = createSchedule({
      project_id: here.id, name: "Morning sweep", prompt: "x",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET runbook_id = ? WHERE id = ?").run(rb.id, s.id);

    const out = listRunbooksForAgent(here);
    expect("error" in out).toBe(false);
    const listed = (out as { runbooks: { name: string; used_by: string[] }[] }).runbooks;
    expect(listed.map((r) => r.name)).toEqual(["A"]);
    // The agent has to be able to see WHY update_runbook will refuse this one.
    expect(listed[0].used_by).toEqual(["Morning sweep"]);
  });

  it("updates a runbook no schedule depends on", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a" });
    const { runbook, text } = updateRunbookForAgent(here, rb.id, { prompt: "/b" });
    expect(runbook!.prompt).toBe("/b");
    expect(text).toContain("A");
  });

  // A model must not change what runs unattended at 08:30 with no warning.
  it("REFUSES to update a runbook a schedule fires, and names the schedule", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a" });
    const s = createSchedule({
      project_id: here.id, name: "Morning sweep", prompt: "x",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET runbook_id = ? WHERE id = ?").run(rb.id, s.id);

    const { runbook, text } = updateRunbookForAgent(here, rb.id, { prompt: "/hijacked" });
    expect(runbook).toBeNull();
    expect(text).toContain("Morning sweep");
    expect(getRunbook(rb.id)!.prompt).toBe("/a");
  });

  it("refuses to update a runbook that doesn't exist", () => {
    expect(updateRunbookForAgent(here, "nope", { prompt: "/x" }).runbook).toBeNull();
  });

  it("refuses to blank a name or prompt through an update", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a" });
    expect(updateRunbookForAgent(here, rb.id, { name: "  " }).runbook).toBeNull();
    expect(updateRunbookForAgent(here, rb.id, { prompt: "  " }).runbook).toBeNull();
    expect(getRunbook(rb.id)!.name).toBe("A");
  });

  // bypassPermissions (the never-asks mode) skips every permission card, and the ⌘K
  // palette dispatches a runbook with no preview, so this is the one field an
  // agent (steered by injected instructions in anything it read) must never be
  // able to write. Only a human, from the UI, may set it.
  it("refuses to create with permission_mode bypassPermissions, and creates nothing", () => {
    const { runbook, text } = createRunbookForAgent(
      here, { name: "S", description: "", prompt: "/s", permission_mode: "bypassPermissions" }, "claude"
    );
    expect(runbook).toBeNull();
    expect(text).toContain("bypassPermissions");
    expect(listRunbooks(here.id).filter((r) => r.name === "S")).toHaveLength(0);
  });

  it("refuses to create with an unrecognized permission_mode string", () => {
    const { runbook, text } = createRunbookForAgent(
      here, { name: "S", description: "", prompt: "/s", permission_mode: "nonsenseMode" }, "claude"
    );
    expect(runbook).toBeNull();
    expect(text).toContain("nonsenseMode");
    expect(listRunbooks(here.id).filter((r) => r.name === "S")).toHaveLength(0);
  });

  it("still creates with a valid permission_mode", () => {
    const { runbook } = createRunbookForAgent(
      here, { name: "S", description: "", prompt: "/s", permission_mode: "acceptEdits" }, "claude"
    );
    expect(runbook).not.toBeNull();
    expect(runbook!.permission_mode).toBe("acceptEdits");
  });

  it("refuses to update permission_mode to bypassPermissions, leaving the row unchanged", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a", permission_mode: "plan" });
    const { runbook, text } = updateRunbookForAgent(here, rb.id, { permission_mode: "bypassPermissions" });
    expect(runbook).toBeNull();
    expect(text).toContain("bypassPermissions");
    expect(getRunbook(rb.id)!.permission_mode).toBe("plan");
  });

  it("refuses to update permission_mode to an unrecognized string", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a", permission_mode: "plan" });
    const { runbook, text } = updateRunbookForAgent(here, rb.id, { permission_mode: "nonsenseMode" });
    expect(runbook).toBeNull();
    expect(text).toContain("nonsenseMode");
    expect(getRunbook(rb.id)!.permission_mode).toBe("plan");
  });

  it("still updates to a valid permission_mode", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a" });
    const { runbook } = updateRunbookForAgent(here, rb.id, { permission_mode: "acceptEdits" });
    expect(runbook!.permission_mode).toBe("acceptEdits");
  });

  // The schema only types permission_mode optional(), so a model meaning
  // "leave the default" has no way to say so besides omitting the key or
  // sending "". Both must read as inherit, instead of a refused unknown mode.
  it("treats an empty or whitespace permission_mode as omitted (inherit) on create", () => {
    const empty = createRunbookForAgent(here, { name: "S1", description: "", prompt: "/s", permission_mode: "" }, "claude");
    expect(empty.runbook).not.toBeNull();
    expect(empty.runbook!.permission_mode).toBeNull();

    const whitespace = createRunbookForAgent(here, { name: "S2", description: "", prompt: "/s", permission_mode: "   " }, "claude");
    expect(whitespace.runbook).not.toBeNull();
    expect(whitespace.runbook!.permission_mode).toBeNull();
  });

  it("treats an empty or whitespace permission_mode as omitted (inherit) on update", () => {
    const rb = createRunbook({ project_id: here.id, name: "A", prompt: "/a", permission_mode: "plan" });
    const { runbook } = updateRunbookForAgent(here, rb.id, { permission_mode: "" });
    expect(runbook).not.toBeNull();
    expect(runbook!.permission_mode).toBeNull();

    const rb2 = createRunbook({ project_id: here.id, name: "B", prompt: "/b", permission_mode: "plan" });
    const whitespace = updateRunbookForAgent(here, rb2.id, { permission_mode: "   " });
    expect(whitespace.runbook).not.toBeNull();
    expect(whitespace.runbook!.permission_mode).toBeNull();
  });
});

describe("runbook provider/model", () => {
  it("create_runbook stores a resolved provider and model", () => {
    const project = createProject({ name: "RB-Provider" });
    const provider = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const { runbook } = createRunbookForAgent(project, { name: "Sweep", description: "", prompt: "/sweep", provider: provider.id, model: "qwen3-coder" }, "claude");
    expect(runbook).toMatchObject({ provider_id: provider.id, model: "qwen3-coder" });
  });

  it("refuses an unrecognized provider on create, and creates nothing", () => {
    const project = createProject({ name: "RB-BadProvider" });
    const { runbook, text } = createRunbookForAgent(project, { name: "Sweep", description: "", prompt: "/sweep", provider: "ghost" }, "claude");
    expect(runbook).toBeNull();
    expect(text).toMatch(/No provider matches/);
    expect(listRunbooks(project.id)).toHaveLength(0);
  });

  it("refuses a model the named provider doesn't list", () => {
    const project = createProject({ name: "RB-BadModel" });
    const provider = createProvider({
      type: "ollama", config: { base_url: "http://localhost:11434" },
      model_policy: { mode: "deny", ids: [], known: ["qwen3-coder"], unavailable: [] },
    });
    const { runbook, text } = createRunbookForAgent(project, { name: "Sweep", description: "", prompt: "/sweep", provider: provider.id, model: "made-up" }, "claude");
    expect(runbook).toBeNull();
    expect(text).toMatch(/isn't a model/);
  });

  it("update_runbook changes provider and validates the model against it, carrying both", () => {
    const project = createProject({ name: "RB-Update" });
    const provider = createProvider({
      type: "ollama", config: { base_url: "http://localhost:11434" },
      model_policy: { mode: "deny", ids: ["off-model"], known: ["on-model", "off-model"], unavailable: [] },
    });
    const rb = createRunbook({ project_id: project.id, name: "Sweep", prompt: "/sweep" });
    const ok = updateRunbookForAgent(project, rb.id, { provider: provider.id, model: "on-model" });
    expect(ok.runbook).toMatchObject({ provider_id: provider.id, model: "on-model" });

    const off = updateRunbookForAgent(project, rb.id, { model: "off-model" });
    expect(off.runbook).toBeNull();
    expect(off.text).toMatch(/is off under/);
  });
});

// A runbook stores one agent and every task it dispatches runs under it, so a
// model id from another environment is a recipe that fails on the first turn of
// every task it ever mints, the same failure suggest_task's `environment`
// check prevents (lib/agents/environmentRef.ts).
describe("runbook model environment", () => {
  beforeEach(() => {
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
  });

  it("refuses a model the resolved environment doesn't run, and creates nothing", () => {
    const project = createProject({ name: "RB-Env-Wrong" });
    const { runbook, text } = createRunbookForAgent(
      project, { name: "Sweep", description: "", prompt: "/sweep", model: "gpt-5.6-sol" }, "claude"
    );
    expect(runbook).toBeNull();
    expect(text).toMatch(/isn't a model claude runs/);
    expect(listRunbooks(project.id)).toHaveLength(0);
  });

  it("stores the environment catalog's own spelling of a model on its bundled login", () => {
    const project = createProject({ name: "RB-Env-Normalize" });
    const { runbook } = createRunbookForAgent(
      project, { name: "Sweep", description: "", prompt: "/sweep", model: "SONNET" }, "claude"
    );
    expect(runbook!.model).toBe("sonnet");
  });

  it("an explicit environment sets the runbook's agent and decides which catalog the model is checked against", () => {
    setAgentConnection("codex", { method: "subscription", email: null, plan: null });
    const project = createProject({ name: "RB-Env-Explicit" });
    const { runbook } = createRunbookForAgent(
      project, { name: "Sweep", description: "", prompt: "/sweep", environment: "codex", model: "gpt-5.6-sol" }, "claude"
    );
    expect(runbook!.agent).toBe("codex");
    expect(runbook!.model).toBe("gpt-5.6-sol");
  });

  it("refuses an unregistered environment id", () => {
    const project = createProject({ name: "RB-Env-Ghost" });
    const { runbook, text } = createRunbookForAgent(
      project, { name: "Sweep", description: "", prompt: "/sweep", environment: "ghost-agent" }, "claude"
    );
    expect(runbook).toBeNull();
    expect(text).toMatch(/isn't a coding environment/);
    expect(listRunbooks(project.id)).toHaveLength(0);
  });

  // The environment catalog governs a bundled login only. A provider the user
  // added carries its own on-list, and its models are not in any CLI's catalog.
  it("leaves a user-added provider's model to the provider policy", () => {
    const project = createProject({ name: "RB-Env-NonBundled" });
    const provider = createProvider({
      type: "ollama",
      config: { base_url: "http://localhost:11434" },
      model_policy: { mode: "deny", ids: [], known: ["qwen3-coder"], unavailable: [] },
    });
    const { runbook } = createRunbookForAgent(
      project,
      { name: "Sweep", description: "", prompt: "/sweep", provider: provider.id, model: "qwen3-coder" },
      "claude"
    );
    expect(runbook).toMatchObject({ provider_id: provider.id, model: "qwen3-coder" });
  });

  // update_runbook never changes a runbook's agent, so the stored one is the
  // environment its new model has to be valid for.
  it("checks an update's model against the runbook's stored environment", () => {
    setAgentConnection("codex", { method: "subscription", email: null, plan: null });
    const project = createProject({ name: "RB-Env-Update" });
    const rb = createRunbook({ project_id: project.id, name: "Sweep", prompt: "/sweep", agent: "codex" });

    const bad = updateRunbookForAgent(project, rb.id, { model: "opus" });
    expect(bad.runbook).toBeNull();
    expect(bad.text).toMatch(/isn't a model codex runs/);
    expect(getRunbook(rb.id)!.model).toBeNull();

    const ok = updateRunbookForAgent(project, rb.id, { model: "GPT-5.6-SOL" });
    expect(ok.runbook!.model).toBe("gpt-5.6-sol");
  });

  // Last in the file: connecting gemini writes instance settings every later
  // test in this file would see, the same reason agentTools.test.ts orders its
  // gemini case last.
  it("refuses a provider that doesn't serve the resolved environment", () => {
    setAgentConnection("gemini", { method: "subscription", email: null, plan: null });
    const project = createProject({ name: "RB-Env-ProviderMismatch" });
    const provider = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const { runbook, text } = createRunbookForAgent(
      project, { name: "Sweep", description: "", prompt: "/sweep", environment: "gemini", provider: provider.id }, "claude"
    );
    expect(runbook).toBeNull();
    expect(text).toMatch(/doesn't serve gemini/);
    expect(listRunbooks(project.id)).toHaveLength(0);
  });
});
