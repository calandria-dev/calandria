// Tags — the store half of docs/superpowers/specs/2026-08-27-tags-design.md
// (many-to-many; the one-tag-per-task ancestor is the 2026-08-24 grouping spike).
// DB only: nothing here launches a turn.
import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import {
  createProject, createTask, getTask, updateTask, deleteTask, moveTasks,
  listTags, getTag, createTag, updateTag, deleteTag, resolveTag,
  setTaskTags, addTaskTags, removeTaskTags, getTaskTagIds,
  TagNameConflictError,
} from "@/lib/store";
import { tagIsDone, parseTagColor, TAG_COLORS } from "@/lib/types";
import { resolveBaseBranch } from "@/lib/baseBranch";

const project = (name = `tag-${Math.random().toString(36).slice(2)}`) => createProject({ name }).id;

describe("tags store", () => {
  let pid: string;
  beforeEach(() => {
    getDb().prepare("DELETE FROM tags").run();
    pid = project();
  });

  it("creates with defaults, trims the name, and lists per project in creation order", () => {
    const a = createTag({ project_id: pid, name: "  Auth migration " });
    const b = createTag({ project_id: pid, name: "Mobile PWA", description: "install + offline", color: TAG_COLORS[1] });
    createTag({ project_id: project(), name: "elsewhere" });
    expect(a.name).toBe("Auth migration");
    expect(a.description).toBe("");
    expect(a.color).toBeNull();
    expect(a.origin_task_id).toBeNull();
    expect(a.counts).toEqual({ total: 0, done: 0, cancelled: 0, running: 0, awaiting: 0 });
    expect(b.color).toBe(TAG_COLORS[1]);
    expect(listTags(pid).map((g) => g.id)).toEqual([a.id, b.id]);
    expect(a.position).toBeLessThan(b.position);
    expect(getTag(a.id)).toEqual(a);
  });

  it("refuses an empty name", () => {
    expect(() => createTag({ project_id: pid, name: "   " })).toThrow(/name required/);
  });

  it("names are unique per project — on create and on rename — but not across projects", () => {
    createTag({ project_id: pid, name: "Auth migration" });
    expect(() => createTag({ project_id: pid, name: "Auth migration" })).toThrow(TagNameConflictError);
    // The store checks before the constraint fires, so the error names the tag.
    expect(() => createTag({ project_id: pid, name: "Auth migration" })).toThrow(/"Auth migration" already exists/);
    // Another project may reuse the name: tags are project-scoped.
    expect(createTag({ project_id: project(), name: "Auth migration" }).name).toBe("Auth migration");
    const other = createTag({ project_id: pid, name: "Mobile PWA" });
    expect(() => updateTag(other.id, { name: "Auth migration" })).toThrow(TagNameConflictError);
    // Renaming to its OWN name is not a collision.
    expect(updateTag(other.id, { name: "Mobile PWA" })!.name).toBe("Mobile PWA");
    // Exact match: case differs, different tag.
    expect(createTag({ project_id: pid, name: "auth migration" }).name).toBe("auth migration");
  });

  it("updates only the fields given and bumps updated_at", async () => {
    const g = createTag({ project_id: pid, name: "A", description: "d", color: TAG_COLORS[0] });
    await new Promise((r) => setTimeout(r, 2));
    const next = updateTag(g.id, { description: "changed" })!;
    expect(next.name).toBe("A");
    expect(next.color).toBe(TAG_COLORS[0]);
    expect(next.description).toBe("changed");
    expect(next.updated_at).toBeGreaterThan(g.updated_at);
    expect(updateTag(g.id, { color: null })!.color).toBeNull();
    expect(updateTag("nope", { name: "x" })).toBeUndefined();
  });

  it("resolveTag: id or exact name, strict by default, create on request with provenance", () => {
    const g = createTag({ project_id: pid, name: "Auth migration" });
    expect(resolveTag(pid, g.id)).toEqual({ tag: g, created: false });
    expect(resolveTag(pid, "Auth migration")).toEqual({ tag: g, created: false });
    expect(resolveTag(pid, "  Auth migration ")).toEqual({ tag: g, created: false });
    // Strict: a miss is null, and nothing was minted.
    expect(resolveTag(pid, "Auth Migration")).toBeNull();
    expect(resolveTag(pid, "")).toBeNull();
    expect(listTags(pid)).toHaveLength(1);
    // A tag's id from ANOTHER project does not resolve here — scope is the project.
    const elsewhere = createTag({ project_id: project(), name: "Elsewhere" });
    expect(resolveTag(pid, elsewhere.id)).toBeNull();
    // Planning verb: create on miss, tagged with the session that filed it.
    const planner = createTask({ project_id: pid, title: "Plan the migration" });
    const made = resolveTag(pid, "Mobile PWA", { create: true, originTaskId: planner.id })!;
    expect(made.created).toBe(true);
    expect(made.tag.name).toBe("Mobile PWA");
    expect(made.tag.origin_task_id).toBe(planner.id);
    expect(made.tag.project_id).toBe(pid);
    // Second resolve of the same ref finds it rather than minting a duplicate.
    expect(resolveTag(pid, "Mobile PWA", { create: true })).toEqual({ tag: getTag(made.tag.id), created: false });
    // Deleting the planning task keeps the tag; provenance goes SET NULL.
    deleteTask(planner.id);
    expect(getTag(made.tag.id)!.origin_task_id).toBeNull();
  });

  it("setTaskTags replaces the whole set, reports what changed, and refuses cross-project rows whole", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a" });
    const b = createTask({ project_id: pid, title: "b" });
    const stray = createTask({ project_id: project(), title: "stray" });
    expect(setTaskTags([a.id, b.id, a.id], [g.id]).sort()).toEqual([a.id, b.id].sort());
    expect(getTag(g.id)!.counts.total).toBe(2);
    // Already carrying exactly this set: not rewritten, not reported.
    expect(setTaskTags([a.id], [g.id])).toEqual([]);
    // One stray refuses the whole batch — nothing half-applied.
    expect(() => setTaskTags([b.id, stray.id], [g.id])).toThrow(/another project/);
    expect(getTag(g.id)!.counts.total).toBe(2);
    expect(() => setTaskTags([a.id], ["nope"])).toThrow(/no such tag/);
    // Clearing is the same verb with an empty array.
    expect(setTaskTags([a.id], [])).toEqual([a.id]);
    expect(getTag(g.id)!.counts.total).toBe(1);
    expect(setTaskTags([], [g.id])).toEqual([]);
    // Unknown task ids are simply not in the batch.
    expect(setTaskTags(["ghost"], [g.id])).toEqual([]);
  });

  it("createTask seeds tag_ids, and listTasks reports them in tag order", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const h = createTag({ project_id: pid, name: "H" });
    const t = createTask({ project_id: pid, title: "t", tag_ids: [g.id, h.id] });
    expect(t.id).toBeTruthy();
    expect(getTaskTagIds(t.id)).toEqual([g.id, h.id]);
    // A patch that doesn't mention tags leaves them alone (updateTask has no tag columns).
    expect(updateTask(t.id, { title: "renamed" })!.title).toBe("renamed");
    expect(getTaskTagIds(t.id)).toEqual([g.id, h.id]);
  });

  it("addTaskTags/removeTaskTags leave a task's other tags alone; setTaskTags replaces", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const h = createTag({ project_id: pid, name: "H" });
    const k = createTag({ project_id: pid, name: "K" });
    const t = createTask({ project_id: pid, title: "t", tag_ids: [g.id] });
    expect(addTaskTags([t.id], [h.id])).toEqual([t.id]);
    expect(getTaskTagIds(t.id)).toEqual([g.id, h.id]);
    // Adding a tag already carried is a no-op — nothing changed, nothing reported.
    expect(addTaskTags([t.id], [h.id])).toEqual([]);
    expect(removeTaskTags([t.id], [g.id])).toEqual([t.id]);
    expect(getTaskTagIds(t.id)).toEqual([h.id]);
    // Removing a tag it doesn't carry changes nothing.
    expect(removeTaskTags([t.id], [k.id])).toEqual([]);
    // setTaskTags replaces the whole set, dropping h.
    expect(setTaskTags([t.id], [k.id])).toEqual([t.id]);
    expect(getTaskTagIds(t.id)).toEqual([k.id]);
  });

  it("deleting a tag untags its members and never deletes them, leaving other tags intact", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const h = createTag({ project_id: pid, name: "H" });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id, h.id] });
    const b = createTask({ project_id: pid, title: "b", tag_ids: [g.id] });
    expect(deleteTag(g.id)).toBe(true);
    expect(deleteTag(g.id)).toBe(false);
    expect(getTag(g.id)).toBeUndefined();
    expect(getTaskTagIds(a.id)).toEqual([h.id]);
    expect(getTaskTagIds(b.id)).toEqual([]);
    expect(getTask(a.id)).toBeTruthy();
    expect(getTask(b.id)).toBeTruthy();
  });

  it("deleting the last member keeps the tag; deleting the project cascades it", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id] });
    deleteTask(a.id);
    expect(getTag(g.id)!.counts.total).toBe(0);
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(pid);
    expect(getTag(g.id)).toBeUndefined();
  });

  it("counts are read-time and treat cancelled/withdrawn as terminal", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const mk = (title: string) => createTask({ project_id: pid, title, tag_ids: [g.id] });
    const a = mk("done"), b = mk("running"), c = mk("awaiting"), d = mk("withdrawn"), e = mk("cancelled");
    updateTask(a.id, { status: "done" });
    updateTask(b.id, { status: "in_progress", running: 1 });
    updateTask(c.id, { status: "in_progress", awaiting_input: 1 });
    // A withdrawn suggestion is cancelled + still suggested (withdraw_suggestion).
    updateTask(d.id, { status: "cancelled", suggested: 1, withdrawn_reason: "redundant" });
    updateTask(e.id, { status: "cancelled" });
    let counts = getTag(g.id)!.counts;
    expect(counts).toEqual({ total: 5, done: 1, cancelled: 2, running: 1, awaiting: 1 });
    expect(tagIsDone(getTag(g.id)!)).toBe(false);
    // A snoozed awaiting task is not "needs you" — same predicate as the project badge.
    updateTask(c.id, { snoozed_until: Date.now() + 60_000 });
    expect(getTag(g.id)!.counts.awaiting).toBe(0);
    // Finish the live ones: 3 done + 2 cancelled = every member terminal → done.
    updateTask(b.id, { status: "done", running: 0 });
    updateTask(c.id, { status: "done", awaiting_input: 0, snoozed_until: 0 });
    counts = getTag(g.id)!.counts;
    expect(counts).toEqual({ total: 5, done: 3, cancelled: 2, running: 0, awaiting: 0 });
    expect(tagIsDone(getTag(g.id)!)).toBe(true);
    // Nothing cached: deleting a done member changes the answer on the next read.
    deleteTask(a.id);
    expect(getTag(g.id)!.counts.done).toBe(2);
    // An empty tag is never "done" — there's nothing it finished.
    expect(tagIsDone({ counts: { total: 0, done: 0, cancelled: 0, running: 0, awaiting: 0 } })).toBe(false);
    // Suggestions in the tray are members too: the chip appears as the plan lands.
    createTask({ project_id: pid, title: "planned", suggested: true, tag_ids: [g.id] });
    expect(getTag(g.id)!.counts.total).toBe(5);
    expect(tagIsDone(getTag(g.id)!)).toBe(false);
  });

  // ---- moveTasks: a tag follows its whole contents, or not at all — decided
  // PER TAG, since a task can carry several. ----

  it("a partly-selected tag stays put, and the rows that left report it in `untagged`", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id] });
    const b = createTask({ project_id: pid, title: "b", tag_ids: [g.id] });
    const dest = project();
    const res = moveTasks([a.id], dest, { resetCheckout: new Set() });
    expect(res.moved.map((m) => m.id)).toEqual([a.id]);
    // Reported beside the dropped edges — the name, so the caller can say WHICH
    // label the task just lost.
    expect(res.untagged).toEqual([{ id: a.id, tag_id: g.id, tag_name: "G" }]);
    expect(res.carried).toEqual([]);
    expect(getTaskTagIds(a.id)).toEqual([]);
    // The tag and its remaining member are untouched.
    expect(getTaskTagIds(b.id)).toEqual([g.id]);
    expect(getTag(g.id)!.project_id).toBe(pid);
    expect(getTag(g.id)!.counts.total).toBe(1);
  });

  it("a tag whose every member moves is re-keyed to the destination, badges intact", () => {
    const g = createTag({ project_id: pid, name: "G", description: "d" });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id] });
    const b = createTask({ project_id: pid, title: "b", tag_ids: [g.id] });
    // A tagless task in the same selection changes nothing about the rule.
    const loose = createTask({ project_id: pid, title: "loose" });
    const dest = project();
    const res = moveTasks([a.id, b.id, loose.id], dest, { resetCheckout: new Set() });
    expect(res.carried).toEqual([{ id: g.id, name: "G", renamed_from: null }]);
    expect(res.untagged).toEqual([]);
    expect(getTaskTagIds(a.id)).toEqual([g.id]);
    expect(getTaskTagIds(b.id)).toEqual([g.id]);
    const moved = getTag(g.id)!;
    expect(moved.project_id).toBe(dest);
    expect(moved.description).toBe("d");
    expect(moved.counts.total).toBe(2);
    // It left the source's chip bar and joined the destination's.
    expect(listTags(pid)).toHaveLength(0);
    expect(listTags(dest).map((x) => x.id)).toEqual([g.id]);
  });

  it("a carried tag is suffixed when the destination already has that name", () => {
    const dest = project();
    createTag({ project_id: dest, name: "G" });
    createTag({ project_id: dest, name: "G (moved)" });
    const g = createTag({ project_id: pid, name: "G" });
    const t = createTask({ project_id: pid, title: "t", tag_ids: [g.id] });
    const res = moveTasks([t.id], dest, { resetCheckout: new Set() });
    // Suffixed rather than merged — two same-named tags are two features —
    // and the report names both spellings so the caller can say what happened.
    expect(res.carried).toEqual([{ id: g.id, name: "G (moved 2)", renamed_from: "G" }]);
    expect(getTag(g.id)!.name).toBe("G (moved 2)");
    expect(listTags(dest).map((x) => x.name)).toEqual(["G", "G (moved)", "G (moved 2)"]);
    // The destination's own tag of that name is untouched.
    expect(listTags(dest).find((x) => x.name === "G")!.id).not.toBe(g.id);
  });

  it("a carried tag keeps its provenance only when the planning task moves too", () => {
    const planner = createTask({ project_id: pid, title: "plan" });
    const g = createTag({ project_id: pid, name: "G", origin_task_id: planner.id });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id] });
    const dest = project();
    // `a` is the tag's only member, so the tag travels — but the planning task
    // stays behind, and a link across projects is exactly what the rest of this
    // rule exists to prevent, so the provenance goes.
    moveTasks([a.id], dest, { resetCheckout: new Set() });
    expect(getTag(g.id)!.project_id).toBe(dest);
    expect(getTag(g.id)!.origin_task_id).toBeNull();

    const g2 = createTag({ project_id: pid, name: "G2", origin_task_id: planner.id });
    const b = createTask({ project_id: pid, title: "b", tag_ids: [g2.id] });
    const res = moveTasks([b.id, planner.id], dest, { resetCheckout: new Set() });
    expect(res.carried.map((c) => c.id)).toEqual([g2.id]);
    expect(getTag(g2.id)!.origin_task_id).toBe(planner.id);
  });

  it("a member the move refuses keeps the whole tag behind", () => {
    const g = createTag({ project_id: pid, name: "G" });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id] });
    const b = createTask({ project_id: pid, title: "b", tag_ids: [g.id] });
    // A started task can't move without the checkout acknowledgement, so it
    // isn't in the moving set — which makes this a partial selection.
    updateTask(b.id, { started: 1, worktree_path: "/tmp/nope" });
    const dest = project();
    const res = moveTasks([a.id, b.id], dest, { resetCheckout: new Set() });
    expect(res.skipped.map((sk) => sk.id)).toEqual([b.id]);
    expect(res.carried).toEqual([]);
    expect(res.untagged.map((u) => u.id)).toEqual([a.id]);
    expect(getTag(g.id)!.project_id).toBe(pid);
  });

  it("a task with two tags where only one tag's membership moves whole: that tag is carried, the other is dropped and reported", () => {
    const whole = createTag({ project_id: pid, name: "Whole" }); // every member moves
    const partial = createTag({ project_id: pid, name: "Partial" }); // a member stays
    const a = createTask({ project_id: pid, title: "a", tag_ids: [whole.id, partial.id] });
    const stays = createTask({ project_id: pid, title: "stays", tag_ids: [partial.id] });
    const dest = project();
    const res = moveTasks([a.id], dest, { resetCheckout: new Set() });
    expect(res.carried).toEqual([{ id: whole.id, name: "Whole", renamed_from: null }]);
    expect(res.untagged).toEqual([{ id: a.id, tag_id: partial.id, tag_name: "Partial" }]);
    // The mover keeps the carried tag and loses only the partial one.
    expect(getTaskTagIds(a.id)).toEqual([whole.id]);
    expect(getTag(whole.id)!.project_id).toBe(dest);
    expect(getTag(partial.id)!.project_id).toBe(pid);
    expect(getTaskTagIds(stays.id)).toEqual([partial.id]);
  });

  it("a cross-project tag id is refused, whole batch, on every membership write", () => {
    const elsewhere = createTag({ project_id: project(), name: "Elsewhere" });
    const a = createTask({ project_id: pid, title: "a" });
    const b = createTask({ project_id: pid, title: "b" });
    expect(() => setTaskTags([a.id], [elsewhere.id])).toThrow(/another project/);
    expect(getTaskTagIds(a.id)).toEqual([]);
    expect(() => addTaskTags([a.id], [elsewhere.id])).toThrow(/another project/);
    // Nothing half-applied across the batch either.
    const g = createTag({ project_id: pid, name: "G" });
    expect(() => setTaskTags([a.id, b.id], [g.id, elsewhere.id])).toThrow(/another project/);
    expect(getTaskTagIds(a.id)).toEqual([]);
    expect(getTaskTagIds(b.id)).toEqual([]);
  });

  // ---- base_branch: a whole plan's base configured once instead of N times
  // (phase 2 of docs/superpowers/specs/2026-08-27-per-task-base-branch-design.md,
  // and the tie-break in its 2026-08-27 addendum). ----

  it("a tag's base branch defaults to inherit, round-trips, and clears on empty", () => {
    const g = createTag({ project_id: pid, name: "Auth" });
    expect(g.base_branch).toBe("");
    expect(updateTag(g.id, { base_branch: "  feature/auth  " })!.base_branch).toBe("feature/auth");
    expect(createTag({ project_id: pid, name: "Rel", base_branch: "release" }).base_branch).toBe("release");
    // "" is the clear, back to "members follow the project".
    expect(updateTag(g.id, { base_branch: "" })!.base_branch).toBe("");
  });

  it("a newly tagged task inherits the tag's base; one already cut keeps its own", () => {
    const project = createProject({ name: `basetag-${Math.random()}`, branch: "main" });
    const g = createTag({ project_id: project.id, name: "Auth", base_branch: "feature/auth" });
    // Not cut yet: nothing is pinned, so the tag answers.
    const fresh = createTask({ project_id: project.id, title: "fresh", tag_ids: [g.id] });
    expect(fresh.base_branch).toBe("");
    expect(resolveBaseBranch(getTask(fresh.id)!, project)).toBe("feature/auth");

    // Already cut: ensureWorktree pinned the branch its work is built on, and a
    // tag default set afterwards must not move its merge target.
    const cut = createTask({ project_id: project.id, title: "cut" });
    updateTask(cut.id, { started: 1, worktree_path: "/tmp/wt", work_branch: "calandria/cut", base_branch: "main" });
    setTaskTags([cut.id], [g.id]);
    expect(resolveBaseBranch(getTask(cut.id)!, project)).toBe("main");

    // And a task with no tag at all still falls through to the project.
    const loose = createTask({ project_id: project.id, title: "loose" });
    expect(resolveBaseBranch(getTask(loose.id)!, project)).toBe("main");
  });

  it("two tags disagreeing: the first in tag order that sets a base wins", () => {
    const project = createProject({ name: `basetie-${Math.random()}`, branch: "main" });
    const none = createTag({ project_id: project.id, name: "Sweep" });
    const auth = createTag({ project_id: project.id, name: "Auth", base_branch: "feature/auth" });
    const rel = createTag({ project_id: project.id, name: "Release", base_branch: "release" });
    const t = createTask({ project_id: project.id, title: "two plans" });

    // A tag with no opinion is skipped rather than counting as a vote for the
    // project's default — otherwise adding "flaky-tests" to a task would silently
    // take it off its feature branch.
    setTaskTags([t.id], [none.id, auth.id, rel.id]);
    expect(getTaskTagIds(t.id)).toEqual([none.id, auth.id, rel.id]);
    expect(resolveBaseBranch(getTask(t.id)!, project)).toBe("feature/auth");

    // Re-ordering the badges re-decides it: task_tags.position is the tie-break,
    // and it is the same order the strip numbers steps in.
    setTaskTags([t.id], [rel.id, auth.id]);
    expect(resolveBaseBranch(getTask(t.id)!, project)).toBe("release");

    // The task's OWN base still beats every tag.
    updateTask(t.id, { base_branch: "hotfix" });
    expect(resolveBaseBranch(getTask(t.id)!, project)).toBe("hotfix");
  });

  it("a carried tag loses its base branch on a cross-project move", () => {
    const g = createTag({ project_id: pid, name: "Auth", base_branch: "feature/auth" });
    const a = createTask({ project_id: pid, title: "a", tag_ids: [g.id] });
    const dest = createProject({ name: `dest-${Math.random()}`, branch: "trunk" });
    const res = moveTasks([a.id], dest.id, { resetCheckout: new Set() });

    // The whole membership moved, so the tag came too — but a branch name means
    // nothing in another repository, the same reason tasks.base_branch is cleared.
    expect(res.carried.map((c) => c.id)).toEqual([g.id]);
    expect(getTag(g.id)!.project_id).toBe(dest.id);
    expect(getTag(g.id)!.base_branch).toBe("");
    expect(getTask(a.id)!.base_branch).toBe("");
    expect(resolveBaseBranch(getTask(a.id)!, dest)).toBe("trunk");
  });

  it("parseTagColor accepts the palette and clears on empty", () => {
    expect(parseTagColor(undefined)).toEqual({ ok: true, color: null });
    expect(parseTagColor("")).toEqual({ ok: true, color: null });
    expect(parseTagColor(TAG_COLORS[2])).toEqual({ ok: true, color: TAG_COLORS[2] });
    expect(parseTagColor("#000000").ok).toBe(false);
    expect(parseTagColor(42).ok).toBe(false);
  });
});
