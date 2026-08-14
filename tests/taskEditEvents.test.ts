// What PATCH /api/tasks/[id] announces on the bus.
//
// The coarse /api/events payload only carries running/awaiting_input/status, so
// a rename or a reprioritisation is unpatchable by listeners — it has to arrive
// as `task_edited` ("refetch the row"). Without that, a user renaming a task in
// one tab leaves every OTHER tab showing the old title until it reloads; the
// editing tab looks fine because it patched its own state optimistically, which
// is exactly what makes the bug easy to miss by hand.
import { afterEach, describe, expect, it } from "vitest";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { createProject, createTask, getTaskDeps, updateTask } from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function patch(id: string, body: Record<string, unknown>) {
  return patchTask(new Request("http://test", { method: "PATCH", body: JSON.stringify(body) }), params(id));
}

let unsub = () => {};
afterEach(() => unsub());

/** Mutation events published while `run` was in flight. */
async function published(run: () => Promise<unknown>): Promise<BusEvent["type"][]> {
  const seen: BusEvent["type"][] = [];
  unsub = subscribeGlobal((_id, ev) => seen.push(ev.type));
  try {
    await run();
  } finally {
    unsub();
    unsub = () => {};
  }
  return seen;
}

describe("PATCH /api/tasks/[id] mutation events", () => {
  it("publishes task_edited when a title, description or priority changes", async () => {
    const project = createProject({ name: "Edits" });
    const task = createTask({ project_id: project.id, title: "Old title", priority: "med" });

    expect(await published(() => patch(task.id, { title: "New title" }))).toEqual(["task_edited"]);
    expect(await published(() => patch(task.id, { description: "Now with detail" }))).toEqual(["task_edited"]);
    expect(await published(() => patch(task.id, { priority: "hi" }))).toEqual(["task_edited"]);
  });

  it("publishes only task_edited when one patch changes both a field and the status", async () => {
    // task_edited makes the client refetch the row, which settles the status
    // too — a second task_updated alongside it would be a duplicate refresh.
    const project = createProject({ name: "Both" });
    const task = createTask({ project_id: project.id, title: "Rename and park" });

    const seen = await published(() => patch(task.id, { title: "Renamed", status: "on_hold" }));

    expect(seen).toEqual(["task_edited"]);
  });

  it("still publishes task_updated for a status-only change", async () => {
    // The awaiting badges ride on this one: a manual status change clears
    // awaiting_input outside any turn, so no runner publish will follow.
    const project = createProject({ name: "Status only" });
    const task = createTask({ project_id: project.id, title: "Park me" });
    updateTask(task.id, { awaiting_input: 1 });

    expect(await published(() => patch(task.id, { status: "on_hold" }))).toEqual(["task_updated"]);
    // Re-asserting the same status is still a settle — it clears awaiting_input,
    // which is the half the badges actually read.
    updateTask(task.id, { awaiting_input: 1 });
    expect(await published(() => patch(task.id, { status: "on_hold" }))).toEqual(["task_updated"]);
  });

  it("publishes task_edited when dependency edges change", async () => {
    // A dependency edit changes what the tray renders for the NEIGHBOURING rows
    // too, so the whole-tray refetch task_edited triggers is the right response.
    const project = createProject({ name: "Deps" });
    const blocker = createTask({ project_id: project.id, title: "First" });
    const task = createTask({ project_id: project.id, title: "Second" });

    expect(await published(() => patch(task.id, { depends_on: [blocker.id] }))).toEqual(["task_edited"]);
    expect(getTaskDeps(task.id)).toEqual([blocker.id]);
    expect(await published(() => patch(task.id, { depends_on: [] }))).toEqual(["task_edited"]);
  });

  it("stays silent on a no-op save", async () => {
    // The edit dialog submits every field on every save, touched or not — and
    // setTaskDeps drops unusable refs, so a submitted list often lands
    // identical. Publishing on the submission rather than the change would make
    // every tab refetch its tray for nothing.
    const project = createProject({ name: "No-op" });
    const other = createProject({ name: "Elsewhere" });
    const stranger = createTask({ project_id: other.id, title: "Not reachable" });
    const task = createTask({ project_id: project.id, title: "Same", priority: "med" });
    await patch(task.id, { description: "Unchanged" });

    const seen = await published(() =>
      patch(task.id, { title: "Same", description: "Unchanged", priority: "med", depends_on: [] }),
    );

    expect(seen).toEqual([]);
    // A cross-project ref is dropped by setTaskDeps, so the stored set doesn't
    // move and there is nothing for other tabs to redraw.
    expect(await published(() => patch(task.id, { depends_on: [stranger.id] }))).toEqual([]);
    expect(getTaskDeps(task.id)).toEqual([]);
  });

  it("publishes task_edited when a suggestion is accepted out of the tray", async () => {
    // `suggested: 0` moves the card from the Suggested tray into the board —
    // invisible to a listener that can only see running/awaiting_input/status.
    const project = createProject({ name: "Suggestions" });
    const task = createTask({ project_id: project.id, title: "Filed by an agent", suggested: true });

    expect(await published(() => patch(task.id, { suggested: 0 }))).toEqual(["task_edited"]);
  });
});
