// The group context block — what a MEMBER session is told about the feature it
// is a step of (docs/superpowers/specs/2026-08-24-task-grouping-design.md).
// Pure read: nothing here launches a turn.
import { describe, expect, it } from "vitest";
import { createProject, createTask, createGroup, getProject, getTask, setTaskDeps, updateTask } from "@/lib/store";
import { groupContextBlock } from "@/lib/groupContext";
import { buildProjectContext } from "@/lib/agents/shared";

/** A member of `groupId`, created in board order (position follows creation). */
function member(projectId: string, groupId: string | null, title: string) {
  return createTask({ project_id: projectId, title, description: `brief for ${title}`, group_id: groupId });
}

describe("groupContextBlock", () => {
  it("orders members topologically, breaking ties by board position", () => {
    const pid = createProject({ name: "gctx-order" }).id;
    const g = createGroup({ project_id: pid, name: "Auth migration", description: "Sessions move behind AuthService." });
    // Filed in one order, ordered by their edges in another: c is a blocker of
    // a, so it has to come first however late it was suggested.
    const a = member(pid, g.id, "Port login route");
    const b = member(pid, g.id, "Remove legacy middleware");
    const c = member(pid, g.id, "Introduce AuthService");
    setTaskDeps(a.id, [c.id]);

    const block = groupContextBlock(getTask(a.id)!);
    const order = block
      .split("\n")
      .filter((l) => /^ {2}[✓·→✗] /.test(l))
      .map((l) => l.replace(/^ {2}[✓·→✗] /, "").split(" (")[0].replace(/ {3}← this task$/, ""));
    // c before a (the edge), then b — which is tied with c and therefore falls
    // where the tray already shows it, after nothing and before a's dependents.
    expect(order).toEqual(["Remove legacy middleware", "Introduce AuthService", "Port login route"]);
    expect(order.indexOf("Introduce AuthService")).toBeLessThan(order.indexOf("Port login route"));
    expect(b.id).toBeTruthy();
  });

  it("says which step of how many, from that same order", () => {
    const pid = createProject({ name: "gctx-step" }).id;
    const g = createGroup({ project_id: pid, name: "Mobile PWA" });
    const one = member(pid, g.id, "One");
    const two = member(pid, g.id, "Two");
    const three = member(pid, g.id, "Three");
    setTaskDeps(three.id, [one.id]);
    setTaskDeps(two.id, [three.id]);

    // Topo order is One → Three → Two, so the LAST-filed task is step 2.
    expect(groupContextBlock(getTask(one.id)!)).toContain('group "Mobile PWA" (step 1 of 3)');
    expect(groupContextBlock(getTask(three.id)!)).toContain("(step 2 of 3)");
    expect(groupContextBlock(getTask(two.id)!)).toContain("(step 3 of 3)");
  });

  it("marks this task, spells out sibling status, and names what waits on it", () => {
    const pid = createProject({ name: "gctx-marks" }).id;
    const g = createGroup({ project_id: pid, name: "Auth migration", description: "The description." });
    const done = member(pid, g.id, "Add session table");
    const self = member(pid, g.id, "Port login route");
    const next = member(pid, g.id, "Port signup route");
    const gone = member(pid, g.id, "Drop the old table");
    setTaskDeps(self.id, [done.id]);
    setTaskDeps(next.id, [self.id]);
    updateTask(done.id, { status: "done", merged_at: Date.now() });
    updateTask(gone.id, { status: "cancelled", withdrawn_reason: "covered by the rewrite" });

    const block = groupContextBlock(getTask(self.id)!);
    expect(block).toContain("The description.");
    expect(block).toContain("  ✓ Add session table (done, merged)");
    expect(block).toContain("  → Port login route   ← this task");
    // The relationship worth stating: finishing here releases that sibling.
    expect(block).toContain("  · Port signup route (not started, blocked by this task)");
    expect(block).toContain("  ✗ Drop the old table (withdrawn)");
    // Sibling BRIEFS are deliberately absent — a seven-task group would spend a
    // fifth of the session's context on work this task isn't doing.
    expect(block).not.toContain("brief for Port signup route");
    expect(block).toContain("get_task");
  });

  it("links back to the session that planned the group", () => {
    const pid = createProject({ name: "gctx-origin" }).id;
    const planner = createTask({ project_id: pid, title: "Plan the auth migration", description: "" });
    const g = createGroup({ project_id: pid, name: "Auth migration", origin_task_id: planner.id });
    const step = member(pid, g.id, "Step one");

    const block = groupContextBlock(getTask(step.id)!);
    expect(block).toContain(`Planned in task "Plan the auth migration" (id ${planner.id})`);
    // The planning session itself, if it happens to be a member, isn't told it
    // planned itself.
    updateTask(planner.id, { group_id: g.id });
    expect(groupContextBlock(getTask(planner.id)!)).not.toContain("Planned in task");
  });

  it("handles a member with no siblings without pretending it has any", () => {
    const pid = createProject({ name: "gctx-alone" }).id;
    const g = createGroup({ project_id: pid, name: "Solo", description: "just the one for now" });
    const only = member(pid, g.id, "The only step");

    const block = groupContextBlock(getTask(only.id)!);
    expect(block).toContain('group "Solo" (step 1 of 1)');
    expect(block).toContain("just the one for now");
    expect(block).toContain("Nothing else has been filed under this group yet.");
    expect(block).not.toContain("Other tasks in this group");
  });

  it("is empty for an ungrouped task, and for a group that was deleted under it", () => {
    const pid = createProject({ name: "gctx-none" }).id;
    const loose = member(pid, null, "Ungrouped");
    expect(groupContextBlock(getTask(loose.id)!)).toBe("");
    // group_id pointing at nothing can only happen mid-delete (the FK nulls it),
    // but a member must degrade to silence rather than throw inside a turn's
    // system prompt.
    expect(groupContextBlock({ ...getTask(loose.id)!, group_id: "ghost" })).toBe("");
  });

  it("send_context = 0 suppresses it, the way it suppresses project context", () => {
    const pid = createProject({ name: "gctx-optout", context: "the project context" }).id;
    const g = createGroup({ project_id: pid, name: "Auth migration", description: "the group description" });
    member(pid, g.id, "Sibling");
    const quiet = member(pid, g.id, "Quiet one");
    updateTask(quiet.id, { send_context: 0 });

    expect(groupContextBlock(getTask(quiet.id)!)).toBe("");
    // …and through the real prompt builder, where the two opt-outs must agree:
    // a task run deliberately context-free must not get the plan it belongs to
    // smuggled back in under a different heading.
    const off = buildProjectContext(getProject(pid)!, getTask(quiet.id)!);
    expect(off).not.toContain("the project context");
    expect(off).not.toContain("the group description");
    expect(off).not.toContain("part of the group");
  });

  it("reaches the session through buildProjectContext, next to the brief", () => {
    const pid = createProject({ name: "gctx-prompt" }).id;
    const g = createGroup({ project_id: pid, name: "Auth migration", description: "Sessions move behind AuthService." });
    const first = member(pid, g.id, "Introduce AuthService");
    const self = member(pid, g.id, "Port login route");
    setTaskDeps(self.id, [first.id]);

    const prompt = buildProjectContext(getProject(pid)!, getTask(self.id)!);
    expect(prompt).toContain('This task is part of the group "Auth migration" (step 2 of 2)');
    expect(prompt).toContain("Sessions move behind AuthService.");
    // Framing for the brief, so it sits with it rather than after the tool docs.
    expect(prompt.indexOf("part of the group")).toBeGreaterThan(prompt.indexOf("The current task is"));
    expect(prompt.indexOf("part of the group")).toBeLessThan(prompt.indexOf("suggest_task"));
  });
});
