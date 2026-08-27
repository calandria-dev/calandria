// The tag context block — what a MEMBER session is told about each feature it
// is a step of (docs/superpowers/specs/2026-08-27-tags-design.md; the
// one-tag-per-task ancestor is docs/superpowers/specs/2026-08-24-task-grouping-design.md).
// Pure read: nothing here launches a turn.
import { describe, expect, it } from "vitest";
import { createProject, createTask, createTag, getProject, getTask, setTaskDeps, setTaskTags, updateTask } from "@/lib/store";
import { tagContextBlock } from "@/lib/tagContext";
import { buildProjectContext } from "@/lib/agents/shared";

/** A member of `tagId`, created in board order (position follows creation). */
function member(projectId: string, tagId: string | null, title: string) {
  return createTask({ project_id: projectId, title, description: `brief for ${title}`, tag_ids: tagId ? [tagId] : [] });
}

describe("tagContextBlock", () => {
  it("orders members topologically, breaking ties by board position", () => {
    const pid = createProject({ name: "tctx-order" }).id;
    const g = createTag({ project_id: pid, name: "Auth migration", description: "Sessions move behind AuthService." });
    // Filed in one order, ordered by their edges in another: c is a blocker of
    // a, so it has to come first however late it was suggested.
    const a = member(pid, g.id, "Port login route");
    const b = member(pid, g.id, "Remove legacy middleware");
    const c = member(pid, g.id, "Introduce AuthService");
    setTaskDeps(a.id, [c.id]);

    const block = tagContextBlock(getTask(a.id)!);
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

  it('says which step of how many, from that same order', () => {
    const pid = createProject({ name: "tctx-step" }).id;
    const g = createTag({ project_id: pid, name: "Mobile PWA" });
    const one = member(pid, g.id, "One");
    const two = member(pid, g.id, "Two");
    const three = member(pid, g.id, "Three");
    setTaskDeps(three.id, [one.id]);
    setTaskDeps(two.id, [three.id]);

    // Topo order is One → Three → Two, so the LAST-filed task is step 2.
    expect(tagContextBlock(getTask(one.id)!)).toContain('tagged "Mobile PWA" (step 1 of 3)');
    expect(tagContextBlock(getTask(three.id)!)).toContain("(step 2 of 3)");
    expect(tagContextBlock(getTask(two.id)!)).toContain("(step 3 of 3)");
  });

  it("marks this task, spells out sibling status, and names what waits on it", () => {
    const pid = createProject({ name: "tctx-marks" }).id;
    const g = createTag({ project_id: pid, name: "Auth migration", description: "The description." });
    const done = member(pid, g.id, "Add session table");
    const self = member(pid, g.id, "Port login route");
    const next = member(pid, g.id, "Port signup route");
    const gone = member(pid, g.id, "Drop the old table");
    setTaskDeps(self.id, [done.id]);
    setTaskDeps(next.id, [self.id]);
    updateTask(done.id, { status: "done", merged_at: Date.now() });
    updateTask(gone.id, { status: "cancelled", withdrawn_reason: "covered by the rewrite" });

    const block = tagContextBlock(getTask(self.id)!);
    expect(block).toContain("The description.");
    expect(block).toContain("  ✓ Add session table (done, merged)");
    expect(block).toContain("  → Port login route   ← this task");
    // The relationship worth stating: finishing here releases that sibling.
    expect(block).toContain("  · Port signup route (not started, blocked by this task)");
    expect(block).toContain("  ✗ Drop the old table (withdrawn)");
    // Sibling BRIEFS are deliberately absent — a seven-task tag would spend a
    // fifth of the session's context on work this task isn't doing.
    expect(block).not.toContain("brief for Port signup route");
    expect(block).toContain("get_task");
  });

  it("links back to the session that planned the tag", () => {
    const pid = createProject({ name: "tctx-origin" }).id;
    const planner = createTask({ project_id: pid, title: "Plan the auth migration", description: "" });
    const g = createTag({ project_id: pid, name: "Auth migration", origin_task_id: planner.id });
    const step = member(pid, g.id, "Step one");

    const block = tagContextBlock(getTask(step.id)!);
    expect(block).toContain(`Planned in task "Plan the auth migration" (id ${planner.id})`);
    // The planning session itself, if it happens to carry the tag, isn't told it
    // planned itself.
    setTaskTags([planner.id], [g.id]);
    expect(tagContextBlock(getTask(planner.id)!)).not.toContain("Planned in task");
  });

  it("handles a member with no siblings without pretending it has any", () => {
    const pid = createProject({ name: "tctx-alone" }).id;
    const g = createTag({ project_id: pid, name: "Solo", description: "just the one for now" });
    const only = member(pid, g.id, "The only step");

    const block = tagContextBlock(getTask(only.id)!);
    expect(block).toContain('tagged "Solo" (step 1 of 1)');
    expect(block).toContain("just the one for now");
    expect(block).toContain("Nothing else carries this tag yet.");
    expect(block).not.toContain("Other tasks with this tag");
  });

  it("is empty for a tagless task, and for a tag that was deleted under it", () => {
    const pid = createProject({ name: "tctx-none" }).id;
    const loose = member(pid, null, "Untagged");
    expect(tagContextBlock(getTask(loose.id)!)).toBe("");
  });

  it("send_context = 0 suppresses it, the way it suppresses project context", () => {
    const pid = createProject({ name: "tctx-optout", context: "the project context" }).id;
    const g = createTag({ project_id: pid, name: "Auth migration", description: "the tag description" });
    member(pid, g.id, "Sibling");
    const quiet = member(pid, g.id, "Quiet one");
    updateTask(quiet.id, { send_context: 0 });

    expect(tagContextBlock(getTask(quiet.id)!)).toBe("");
    // …and through the real prompt builder, where the two opt-outs must agree:
    // a task run deliberately context-free must not get the plan it belongs to
    // smuggled back in under a different heading.
    const off = buildProjectContext(getProject(pid)!, getTask(quiet.id)!);
    expect(off).not.toContain("the project context");
    expect(off).not.toContain("the tag description");
    expect(off).not.toContain('tagged "Auth migration"');
  });

  it("reaches the session through buildProjectContext, next to the brief", () => {
    const pid = createProject({ name: "tctx-prompt" }).id;
    const g = createTag({ project_id: pid, name: "Auth migration", description: "Sessions move behind AuthService." });
    const first = member(pid, g.id, "Introduce AuthService");
    const self = member(pid, g.id, "Port login route");
    setTaskDeps(self.id, [first.id]);

    const prompt = buildProjectContext(getProject(pid)!, getTask(self.id)!);
    expect(prompt).toContain('This task is tagged "Auth migration" (step 2 of 2)');
    expect(prompt).toContain("Sessions move behind AuthService.");
    // Framing for the brief, so it sits with it rather than after the tool docs.
    expect(prompt.indexOf('tagged "Auth migration"')).toBeGreaterThan(prompt.indexOf("The current task is"));
    expect(prompt.indexOf('tagged "Auth migration"')).toBeLessThan(prompt.indexOf("suggest_task"));
  });

  it("a task carrying two tags gets TWO context blocks, in tag order", () => {
    const pid = createProject({ name: "tctx-multi" }).id;
    const first = createTag({ project_id: pid, name: "Auth migration" });
    const second = createTag({ project_id: pid, name: "Flaky tests" });
    const t = createTask({ project_id: pid, title: "t", tag_ids: [first.id, second.id] });

    const block = tagContextBlock(getTask(t.id)!);
    expect(block).toContain('tagged "Auth migration"');
    expect(block).toContain('tagged "Flaky tests"');
    expect(block.indexOf('tagged "Auth migration"')).toBeLessThan(block.indexOf('tagged "Flaky tests"'));

    // Reordering the tags on the task reorders the blocks the same way.
    setTaskTags([t.id], [second.id, first.id]);
    const reordered = tagContextBlock(getTask(t.id)!);
    expect(reordered.indexOf('tagged "Flaky tests"')).toBeLessThan(reordered.indexOf('tagged "Auth migration"'));
  });
});
