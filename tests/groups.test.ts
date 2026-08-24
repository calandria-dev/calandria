// Task groups — the store half of docs/superpowers/specs/2026-08-24-task-grouping-design.md.
// DB only: nothing here launches a turn.
import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  createProject, createTask, updateTask, deleteTask, moveTasks,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroup, setTaskGroup,
  GroupNameConflictError,
} from "@/lib/store";
import { groupIsDone, parseGroupColor, GROUP_COLORS } from "@/lib/types";

const project = (name = `grp-${Math.random().toString(36).slice(2)}`) => createProject({ name }).id;

describe("task groups store", () => {
  let pid: string;
  beforeEach(() => {
    getDb().prepare("DELETE FROM task_groups").run();
    pid = project();
  });

  it("creates with defaults, trims the name, and lists per project in creation order", () => {
    const a = createGroup({ project_id: pid, name: "  Auth migration " });
    const b = createGroup({ project_id: pid, name: "Mobile PWA", description: "install + offline", color: GROUP_COLORS[1] });
    createGroup({ project_id: project(), name: "elsewhere" });
    expect(a.name).toBe("Auth migration");
    expect(a.description).toBe("");
    expect(a.color).toBeNull();
    expect(a.origin_task_id).toBeNull();
    expect(a.counts).toEqual({ total: 0, done: 0, cancelled: 0, running: 0, awaiting: 0 });
    expect(b.color).toBe(GROUP_COLORS[1]);
    expect(listGroups(pid).map((g) => g.id)).toEqual([a.id, b.id]);
    expect(a.position).toBeLessThan(b.position);
    expect(getGroup(a.id)).toEqual(a);
  });

  it("refuses an empty name", () => {
    expect(() => createGroup({ project_id: pid, name: "   " })).toThrow(/name required/);
  });

  it("names are unique per project — on create and on rename — but not across projects", () => {
    createGroup({ project_id: pid, name: "Auth migration" });
    expect(() => createGroup({ project_id: pid, name: "Auth migration" })).toThrow(GroupNameConflictError);
    // The store checks before the constraint fires, so the error names the group.
    expect(() => createGroup({ project_id: pid, name: "Auth migration" })).toThrow(/"Auth migration" already exists/);
    // Another project may reuse the name: groups are project-scoped.
    expect(createGroup({ project_id: project(), name: "Auth migration" }).name).toBe("Auth migration");
    const other = createGroup({ project_id: pid, name: "Mobile PWA" });
    expect(() => updateGroup(other.id, { name: "Auth migration" })).toThrow(GroupNameConflictError);
    // Renaming to its OWN name is not a collision.
    expect(updateGroup(other.id, { name: "Mobile PWA" })!.name).toBe("Mobile PWA");
    // Exact match: case differs, different group.
    expect(createGroup({ project_id: pid, name: "auth migration" }).name).toBe("auth migration");
  });

  it("updates only the fields given and bumps updated_at", async () => {
    const g = createGroup({ project_id: pid, name: "A", description: "d", color: GROUP_COLORS[0] });
    await new Promise((r) => setTimeout(r, 2));
    const next = updateGroup(g.id, { description: "changed" })!;
    expect(next.name).toBe("A");
    expect(next.color).toBe(GROUP_COLORS[0]);
    expect(next.description).toBe("changed");
    expect(next.updated_at).toBeGreaterThan(g.updated_at);
    expect(updateGroup(g.id, { color: null })!.color).toBeNull();
    expect(updateGroup("nope", { name: "x" })).toBeUndefined();
  });

  it("resolveGroup: id or exact name, strict by default, create on request with provenance", () => {
    const g = createGroup({ project_id: pid, name: "Auth migration" });
    expect(resolveGroup(pid, g.id)).toEqual({ group: g, created: false });
    expect(resolveGroup(pid, "Auth migration")).toEqual({ group: g, created: false });
    expect(resolveGroup(pid, "  Auth migration ")).toEqual({ group: g, created: false });
    // Strict: a miss is null, and nothing was minted.
    expect(resolveGroup(pid, "Auth Migration")).toBeNull();
    expect(resolveGroup(pid, "")).toBeNull();
    expect(listGroups(pid)).toHaveLength(1);
    // A group's id from ANOTHER project does not resolve here — scope is the project.
    const elsewhere = createGroup({ project_id: project(), name: "Elsewhere" });
    expect(resolveGroup(pid, elsewhere.id)).toBeNull();
    // Planning verb: create on miss, tagged with the session that filed it.
    const planner = createTask({ project_id: pid, title: "Plan the migration" });
    const made = resolveGroup(pid, "Mobile PWA", { create: true, originTaskId: planner.id })!;
    expect(made.created).toBe(true);
    expect(made.group.name).toBe("Mobile PWA");
    expect(made.group.origin_task_id).toBe(planner.id);
    expect(made.group.project_id).toBe(pid);
    // Second resolve of the same ref finds it rather than minting a duplicate.
    expect(resolveGroup(pid, "Mobile PWA", { create: true })).toEqual({ group: getGroup(made.group.id), created: false });
    // Deleting the planning task keeps the group; provenance goes SET NULL.
    deleteTask(planner.id);
    expect(getGroup(made.group.id)!.origin_task_id).toBeNull();
  });

  it("setTaskGroup assigns and clears in a batch, reports what changed, and refuses cross-project rows whole", () => {
    const g = createGroup({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a" });
    const b = createTask({ project_id: pid, title: "b" });
    const stray = createTask({ project_id: project(), title: "stray" });
    expect(setTaskGroup([a.id, b.id, a.id], g.id).sort()).toEqual([a.id, b.id].sort());
    expect(getGroup(g.id)!.counts.total).toBe(2);
    // Already a member: not rewritten, not reported.
    expect(setTaskGroup([a.id], g.id)).toEqual([]);
    // One stray refuses the whole batch — nothing half-applied.
    expect(() => setTaskGroup([b.id, stray.id], g.id)).toThrow(/another project/);
    expect(getGroup(g.id)!.counts.total).toBe(2);
    expect(() => setTaskGroup([a.id], "nope")).toThrow(/no such group/);
    // Clearing is the same verb with null; unknown ids are skipped.
    expect(setTaskGroup([a.id, "ghost"], null)).toEqual([a.id]);
    expect(getGroup(g.id)!.counts.total).toBe(1);
    expect(setTaskGroup([], g.id)).toEqual([]);
  });

  it("createTask and updateTask carry group_id", () => {
    const g = createGroup({ project_id: pid, name: "G" });
    const t = createTask({ project_id: pid, title: "t", group_id: g.id });
    expect(t.group_id).toBe(g.id);
    expect(updateTask(t.id, { group_id: null })!.group_id).toBeNull();
    expect(updateTask(t.id, { group_id: g.id })!.group_id).toBe(g.id);
    // A patch that doesn't mention the group leaves it alone.
    expect(updateTask(t.id, { title: "renamed" })!.group_id).toBe(g.id);
  });

  it("deleting a group ungroups its members and never deletes them", () => {
    const g = createGroup({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a", group_id: g.id });
    const b = createTask({ project_id: pid, title: "b", group_id: g.id });
    expect(deleteGroup(g.id)).toBe(true);
    expect(deleteGroup(g.id)).toBe(false);
    expect(getGroup(g.id)).toBeUndefined();
    const rows = getDb().prepare("SELECT id, group_id FROM tasks WHERE id IN (?, ?)").all(a.id, b.id) as { id: string; group_id: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.group_id === null)).toBe(true);
  });

  it("deleting the last member keeps the group; deleting the project cascades it", () => {
    const g = createGroup({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a", group_id: g.id });
    deleteTask(a.id);
    expect(getGroup(g.id)!.counts.total).toBe(0);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(pid);
    expect(getGroup(g.id)).toBeUndefined();
  });

  it("counts are read-time and treat cancelled/withdrawn as terminal", () => {
    const g = createGroup({ project_id: pid, name: "G" });
    const mk = (title: string) => createTask({ project_id: pid, title, group_id: g.id });
    const a = mk("done"), b = mk("running"), c = mk("awaiting"), d = mk("withdrawn"), e = mk("cancelled");
    updateTask(a.id, { status: "done" });
    updateTask(b.id, { status: "in_progress", running: 1 });
    updateTask(c.id, { status: "in_progress", awaiting_input: 1 });
    // A withdrawn suggestion is cancelled + still suggested (withdraw_suggestion).
    updateTask(d.id, { status: "cancelled", suggested: 1, withdrawn_reason: "redundant" });
    updateTask(e.id, { status: "cancelled" });
    let counts = getGroup(g.id)!.counts;
    expect(counts).toEqual({ total: 5, done: 1, cancelled: 2, running: 1, awaiting: 1 });
    expect(groupIsDone(getGroup(g.id)!)).toBe(false);
    // A snoozed awaiting task is not "needs you" — same predicate as the project badge.
    updateTask(c.id, { snoozed_until: Date.now() + 60_000 });
    expect(getGroup(g.id)!.counts.awaiting).toBe(0);
    // Finish the live ones: 3 done + 2 cancelled = every member terminal → done.
    updateTask(b.id, { status: "done", running: 0 });
    updateTask(c.id, { status: "done", awaiting_input: 0, snoozed_until: 0 });
    counts = getGroup(g.id)!.counts;
    expect(counts).toEqual({ total: 5, done: 3, cancelled: 2, running: 0, awaiting: 0 });
    expect(groupIsDone(getGroup(g.id)!)).toBe(true);
    // Nothing cached: deleting a done member changes the answer on the next read.
    deleteTask(a.id);
    expect(getGroup(g.id)!.counts.done).toBe(2);
    // An empty group is never "done" — there's nothing it finished.
    expect(groupIsDone({ counts: { total: 0, done: 0, cancelled: 0, running: 0, awaiting: 0 } })).toBe(false);
    // Suggestions in the tray are members too: the chip appears as the plan lands.
    createTask({ project_id: pid, title: "planned", suggested: true, group_id: g.id });
    expect(getGroup(g.id)!.counts.total).toBe(5);
    expect(groupIsDone(getGroup(g.id)!)).toBe(false);
  });

  it("moving a task to another project clears its group", () => {
    const g = createGroup({ project_id: pid, name: "G" });
    const t = createTask({ project_id: pid, title: "t", group_id: g.id });
    const dest = project();
    const res = moveTasks([t.id], dest, { resetCheckout: new Set() });
    expect(res.moved.map((m) => m.id)).toEqual([t.id]);
    expect(getDb().prepare("SELECT group_id FROM tasks WHERE id = ?").get(t.id)).toEqual({ group_id: null });
    expect(getGroup(g.id)!.counts.total).toBe(0);
  });

  it("parseGroupColor accepts the palette and clears on empty", () => {
    expect(parseGroupColor(undefined)).toEqual({ ok: true, color: null });
    expect(parseGroupColor("")).toEqual({ ok: true, color: null });
    expect(parseGroupColor(GROUP_COLORS[2])).toEqual({ ok: true, color: GROUP_COLORS[2] });
    expect(parseGroupColor("#000000").ok).toBe(false);
    expect(parseGroupColor(42).ok).toBe(false);
  });
});
