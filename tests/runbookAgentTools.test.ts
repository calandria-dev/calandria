import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createProject } from "@/lib/store";
import { createSchedule } from "@/lib/schedule/store";
import { createRunbook, getRunbook, listRunbooks } from "@/lib/runbooks/store";
import { createRunbookForAgent, listRunbooksForAgent, updateRunbookForAgent } from "@/lib/runbookTools";
import { setAgentConnection } from "@/lib/agents/connections";

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

    // Strict in both directions — never a silent fallback to the caller's project.
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

  // The whole point of the screen: a model must not silently change what runs
  // unattended at 08:30.
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
});
