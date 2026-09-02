/**
 * Issue #46 — a task blocked by an unreviewed SUGGESTION.
 *
 * `update_task`'s `blocked_by` validates same-project and acyclicity, never
 * `suggested`, so an ordered plan filed by an agent can leave an accepted task
 * waiting on siblings still sitting in the tray. That edge is real: `blocks()`
 * counts it, server-side auto-start honors it, and the board's chip shows it.
 *
 * What was missing was any way to SEE or CLEAR it — the edit dialog's picker
 * was fed real tasks only, so the blocker had no row to untick, and every save
 * re-submitted it. This file pins the two halves that fix has to stand on:
 * the wire carries the suggested blocker (so the picker can draw it), and the
 * PATCH the picker sends actually removes the edge.
 */
import { describe, it, expect } from "vitest";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { blocks } from "@/lib/autoStart";
import { createProject, createTask, getTask, getTaskDeps, listTasks, setTaskDeps, updateTask } from "@/lib/store";

function board() {
  const project = createProject({ name: `deps-${Math.random().toString(36).slice(2, 8)}` });
  const dependent = createTask({ project_id: project.id, title: "Accepted step", description: "" });
  const suggestion = createTask({ project_id: project.id, title: "Still in the tray", description: "", suggested: true });
  const real = createTask({ project_id: project.id, title: "Accepted blocker", description: "" });
  return { project, dependent, suggestion, real };
}

const patch = (id: string, body: unknown) =>
  patchTask(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("a suggestion as a blocker", () => {
  it("is a real edge the server honors, which is why it has to be visible", () => {
    const { dependent, suggestion, real } = board();
    setTaskDeps(dependent.id, [suggestion.id, real.id]);

    // Not filtered on the way in, and not filtered on the way out: the whole
    // point of the bug is that this edge is load-bearing.
    expect(getTaskDeps(dependent.id).sort()).toEqual([suggestion.id, real.id].sort());
    expect(blocks(suggestion.id)).toBe(true);
  });

  it("stops blocking once it is done, cancelled or gone — the rule isBlocking mirrors", () => {
    const { suggestion } = board();
    expect(blocks("no-such-task")).toBe(false);
    updateTask(suggestion.id, { status: "cancelled" });
    expect(blocks(suggestion.id)).toBe(false);
    updateTask(suggestion.id, { status: "done" });
    expect(blocks(suggestion.id)).toBe(false);
  });

  it("rides the same list the picker is fed, so a row exists to untick", () => {
    const { project, dependent, suggestion } = board();
    setTaskDeps(dependent.id, [suggestion.id]);

    const rows = listTasks(project.id);
    const blocker = rows.find((t) => t.id === suggestion.id);
    expect(blocker).toBeTruthy();
    expect(blocker!.suggested).toBe(1);
    // The dependent's own row names it, so the client can resolve the id
    // against the list without a second fetch.
    expect(rows.find((t) => t.id === dependent.id)!.depends_on).toContain(suggestion.id);
  });
});

describe("clearing a suggested blocker from the edit dialog", () => {
  it("removes the edge the save leaves out, and keeps the ones it doesn't", async () => {
    const { dependent, suggestion, real } = board();
    setTaskDeps(dependent.id, [suggestion.id, real.id]);

    // What the dialog sends after the user unticks the suggestion: the whole
    // list, minus that one. Before the fix the suggestion had no row, so it was
    // always still in this array.
    const res = await patch(dependent.id, { depends_on: [real.id] });
    expect(res.status).toBe(200);
    expect(getTaskDeps(dependent.id)).toEqual([real.id]);
    expect(blocks(real.id)).toBe(true);
  });

  it("can drop the last blocker outright, unblocking the task", async () => {
    const { dependent, suggestion } = board();
    setTaskDeps(dependent.id, [suggestion.id]);

    const res = await patch(dependent.id, { depends_on: [] });
    expect(res.status).toBe(200);
    expect(getTaskDeps(dependent.id)).toEqual([]);
    expect(getTask(dependent.id)!.status).toBe("not_started");
  });
});
