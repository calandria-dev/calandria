import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createProject, createTask } from "@/lib/store";
import { createSchedule, getSchedule } from "@/lib/schedule/store";
import {
  createRunbook, getRunbook, listRunbooks, updateRunbook, deleteRunbook,
  copyRunbook, lastRunOf, schedulesUsing,
} from "@/lib/runbooks/store";

const project = (name = `rb-${Math.random().toString(36).slice(2)}`) => createProject({ name }).id;

function runbook(projectId: string, over: Partial<Parameters<typeof createRunbook>[0]> = {}) {
  return createRunbook({
    project_id: projectId,
    name: "Push & babysit CI",
    description: "Push everything unpushed, then watch the pipeline.",
    prompt: "/push-and-watch",
    agent: "claude",
    permission_mode: "bypassPermissions",
    ...over,
  });
}

describe("runbook store", () => {
  let pid: string;
  beforeEach(() => {
    getDb().prepare("DELETE FROM runbooks").run();
    getDb().prepare("DELETE FROM schedules").run();
    pid = project();
  });

  it("creates with defaults and reads back", () => {
    const rb = runbook(pid);
    expect(getRunbook(rb.id)).toEqual(rb);
    expect(rb.send_context).toBe(1);
    expect(rb.priority).toBe("med");
    // '' means the user wrote it; an agent id means an agent filed it.
    expect(rb.created_by).toBe("");
  });

  it("lists per project in manual order, newest last", () => {
    const a = runbook(pid, { name: "A" });
    const b = runbook(pid, { name: "B" });
    runbook(project(), { name: "elsewhere" });
    expect(listRunbooks(pid).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(a.position).toBeLessThan(b.position);
  });

  it("updates only the fields given", () => {
    const rb = runbook(pid);
    const next = updateRunbook(rb.id, { name: "Renamed" })!;
    expect(next.name).toBe("Renamed");
    expect(next.prompt).toBe(rb.prompt);
    expect(next.updated_at).toBeGreaterThanOrEqual(rb.updated_at);
  });

  it("copies into another project as an independent row", () => {
    const rb = runbook(pid);
    const dest = project();
    const copy = copyRunbook(rb.id, dest)!;
    expect(copy.id).not.toBe(rb.id);
    expect(copy.project_id).toBe(dest);
    expect(copy.prompt).toBe(rb.prompt);
    // Editing the copy must not touch the original.
    updateRunbook(copy.id, { prompt: "changed" });
    expect(getRunbook(rb.id)!.prompt).toBe("/push-and-watch");
  });

  it("reports the schedules that link it", () => {
    const rb = runbook(pid);
    const s = createSchedule({
      project_id: pid, name: "Morning sweep", prompt: "ignored",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET runbook_id = ? WHERE id = ?").run(rb.id, s.id);
    expect(schedulesUsing(rb.id)).toEqual([{ id: s.id, name: "Morning sweep" }]);
  });

  // ON DELETE SET NULL alone would leave a schedule with no prompt, firing
  // nothing every morning with no warning, which is the failure the
  // schedules design exists to rule out.
  it("deleting DETACHES linked schedules with the recipe intact", () => {
    const rb = runbook(pid, { prompt: "/sweep", agent: "claude", permission_mode: "plan", priority: "hi" });
    const s = createSchedule({
      project_id: pid, name: "Morning sweep", prompt: "stale",
      days_mask: 62, time_of_day: "08:30", timezone: "America/Los_Angeles",
    });
    getDb().prepare("UPDATE schedules SET runbook_id = ? WHERE id = ?").run(rb.id, s.id);

    deleteRunbook(rb.id);

    const after = getSchedule(s.id)!;
    expect(getRunbook(rb.id)).toBeNull();
    expect(after.runbook_id).toBeNull();
    expect(after.prompt).toBe("/sweep");
    expect(after.permission_mode).toBe("plan");
    expect(after.priority).toBe("hi");
  });

  it("finds the most recent task it dispatched", () => {
    const rb = runbook(pid);
    expect(lastRunOf(rb.id)).toBeNull();
    createTask({ project_id: pid, title: "older", runbook_id: rb.id });
    const newer = createTask({ project_id: pid, title: "newer", runbook_id: rb.id });
    expect(lastRunOf(rb.id)!.id).toBe(newer.id);
  });

  it("a deleted runbook leaves the tasks it dispatched alone", () => {
    const rb = runbook(pid);
    const t = createTask({ project_id: pid, title: "ran", runbook_id: rb.id });
    deleteRunbook(rb.id);
    const row = getDb().prepare("SELECT runbook_id FROM tasks WHERE id = ?").get(t.id) as { runbook_id: string | null };
    expect(row.runbook_id).toBeNull();
  });
});
