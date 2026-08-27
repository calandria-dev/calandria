import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, createTask, listTasks, updateTask } from "../lib/store";

// Task order is RECENCY, most recently active first — `updated_at DESC` with
// `created_at` then `rowid` breaking same-millisecond ties. It replaced the
// manual board order (`tasks.position`), which the board's drag used to
// persist: the two can't both lead the sort, and a task you just worked on has
// to come back to the top on its own rather than being dragged there.
//
// The clock is faked throughout — every column this sorts by is a Date.now()
// stamp, and two writes in the same real millisecond would make the assertions
// below depend on how fast the machine is.
describe("task ordering", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("puts the most recently created task on top", () => {
    const project = createProject({ name: "Fresh" });
    const a = createTask({ project_id: project.id, title: "A" });
    vi.advanceTimersByTime(1000);
    const b = createTask({ project_id: project.id, title: "B" });
    vi.advanceTimersByTime(1000);
    createTask({ project_id: project.id, title: "C" });

    expect(listTasks(project.id).map((t) => t.title)).toEqual(["C", "B", "A"]);
    // Positions still count up in creation order — they're just not what the
    // list reads any more.
    expect([a.position, b.position]).toEqual([0, 1]);
  });

  it("breaks a same-millisecond tie by insertion order, newest first", () => {
    // Three tasks filed by one planning turn share a created_at to the
    // millisecond; the tray must still have a stable, non-arbitrary order.
    const project = createProject({ name: "Same tick" });
    createTask({ project_id: project.id, title: "A" });
    createTask({ project_id: project.id, title: "B" });
    createTask({ project_id: project.id, title: "C" });

    expect(listTasks(project.id).map((t) => t.title)).toEqual(["C", "B", "A"]);
  });

  it("floats a task back to the top when it is worked on", () => {
    // The whole point of the sort: activity, not filing date. `updated_at` is
    // bumped by every write the runner makes (running, awaiting_input, status),
    // so a live task climbs on its own.
    const project = createProject({ name: "Activity" });
    const a = createTask({ project_id: project.id, title: "A" });
    vi.advanceTimersByTime(1000);
    createTask({ project_id: project.id, title: "B" });
    vi.advanceTimersByTime(1000);
    createTask({ project_id: project.id, title: "C" });
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["C", "B", "A"]);

    vi.advanceTimersByTime(1000);
    updateTask(a.id, { status: "in_progress" });
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["A", "C", "B"]);
  });

  it("lists suggested tasks after real ones, newest first within the tray", () => {
    const project = createProject({ name: "Sugg" });
    createTask({ project_id: project.id, title: "S1", suggested: true });
    vi.advanceTimersByTime(1000);
    createTask({ project_id: project.id, title: "A" });
    vi.advanceTimersByTime(1000);
    createTask({ project_id: project.id, title: "S2", suggested: true });

    // S2 is the newest row in the project and still sorts below both real
    // tasks: the tray is a separate list, ordered by recency inside itself.
    expect(listTasks(project.id).map((t) => t.title)).toEqual(["A", "S2", "S1"]);
  });

  it("orders each project independently", () => {
    const p1 = createProject({ name: "P1" });
    const p2 = createProject({ name: "P2" });
    createTask({ project_id: p1.id, title: "P1-A" });
    vi.advanceTimersByTime(1000);
    const shared = createTask({ project_id: p2.id, title: "P2-A" });
    vi.advanceTimersByTime(1000);
    createTask({ project_id: p1.id, title: "P1-B" });

    expect(listTasks(p1.id).map((t) => t.title)).toEqual(["P1-B", "P1-A"]);
    expect(listTasks(p2.id).map((t) => t.title)).toEqual(["P2-A"]);
    expect(shared.position).toBe(0);
  });
});
