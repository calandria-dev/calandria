import { describe, expect, it } from "vitest";
import { POST as bulkMoveRoute } from "@/app/api/tasks/move/route";
import {
  createProject,
  createTask,
  deleteProject,
  getTask,
  getTaskDeps,
  listTasks,
  moveTasks,
  setTaskDeps,
  updateTask,
} from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";

// Moving MANY tasks at once. The motivating case is a handful of tasks filed
// into the wrong project: one round trip instead of eleven, one re-sync in the
// other tabs instead of eleven.
//
// Two rules only the batch can express, both pinned here:
//  - a task that can't move (started, or a turn in flight) is REPORTED as
//    skipped, not silently dropped and not fatal to the rest;
//  - a dependency edge survives when BOTH its ends are in the moving set. It
//    stays intra-project, so the "edges never span projects" invariant that
//    forces the single-task move to drop everything doesn't apply.

async function bulkMove(body: Record<string, unknown>) {
  return bulkMoveRoute(new Request("http://test", { method: "POST", body: JSON.stringify(body) }));
}

/** Two projects and `n` unstarted tasks filed in the first one. */
function batch(name: string, n: number) {
  const from = createProject({ name: `${name} from` });
  const to = createProject({ name: `${name} to` });
  const tasks = Array.from({ length: n }, (_, i) => createTask({ project_id: from.id, title: `${name} ${i + 1}` }));
  return { from, to, tasks, ids: tasks.map((t) => t.id) };
}

describe("moveTasks (store)", () => {
  it("moves the whole selection and appends it in source order", () => {
    const { from, to, ids } = batch("Bulk", 3);
    createTask({ project_id: to.id, title: "Already here" });

    // Deliberately out of order: the destination should get them in the order
    // they had in the source project, not the order they were clicked.
    const result = moveTasks([ids[2], ids[0], ids[1]], to.id);

    expect(result.moved.map((t) => t.id)).toEqual(ids);
    expect(result.skipped).toEqual([]);
    expect(listTasks(to.id).map((t) => t.title)).toEqual(["Already here", "Bulk 1", "Bulk 2", "Bulk 3"]);
    expect(listTasks(from.id)).toEqual([]);
  });

  it("moves the movable ones and reports a started task as skipped", () => {
    const { from, to, ids } = batch("Skip", 3);
    updateTask(ids[1], { started: 1, worktree_path: "/tmp/wt" });

    const result = moveTasks(ids, to.id);

    expect(result.moved.map((t) => t.id)).toEqual([ids[0], ids[2]]);
    expect(result.skipped).toEqual([{ id: ids[1], reason: expect.stringMatching(/started task can't be moved/) }]);
    expect(getTask(ids[1])?.project_id).toBe(from.id);
  });

  it("keeps an edge whose both ends move together", () => {
    const { to, ids } = batch("Chain", 2);
    setTaskDeps(ids[1], [ids[0]]);

    const result = moveTasks(ids, to.id);

    expect(getTaskDeps(ids[1])).toEqual([ids[0]]);
    expect(result.kept).toEqual([{ task_id: ids[1], depends_on_id: ids[0] }]);
    expect(result.dropped).toEqual([]);
  });

  it("drops an edge whose other end stays behind, and reports it", () => {
    const { from, to, ids } = batch("Partial chain", 2);
    const blocker = createTask({ project_id: from.id, title: "Stays behind" });
    setTaskDeps(ids[0], [blocker.id]);

    const result = moveTasks(ids, to.id);

    expect(getTaskDeps(ids[0])).toEqual([]);
    expect(result.dropped).toEqual([{ task_id: ids[0], depends_on_id: blocker.id }]);
    expect(result.kept).toEqual([]);
  });

  it("drops only the skipped task's own edges when it sits mid-chain", () => {
    // a → b → c with b unmovable: b's two edges have one end left behind, so
    // they go. Nothing else in the selection is punished for it.
    const { to, ids } = batch("Middle", 3);
    const [a, b, c] = ids;
    const d = createTask({ project_id: getTask(a)!.project_id, title: "Tail" });
    setTaskDeps(a, [b]);
    setTaskDeps(b, [c]);
    setTaskDeps(c, [d.id]);
    updateTask(b, { started: 1 });

    const result = moveTasks([a, b, c, d.id], to.id);

    expect(result.skipped.map((s) => s.id)).toEqual([b]);
    expect(getTaskDeps(a)).toEqual([]);
    expect(getTaskDeps(b)).toEqual([]);
    // c → d survives: both ends moved.
    expect(getTaskDeps(c)).toEqual([d.id]);
    expect(result.kept).toEqual([{ task_id: c, depends_on_id: d.id }]);
  });

  it("keeps auto_start when the blocker came along", () => {
    const { to, ids } = batch("Autostart kept", 2);
    setTaskDeps(ids[1], [ids[0]]);
    updateTask(ids[1], { auto_start: 1 });

    moveTasks(ids, to.id);

    // The opt-in can still fire: lib/autoStart.ts selects through an edge that
    // is still there.
    expect(getTask(ids[1])?.auto_start).toBe(1);
  });

  it("clears auto_start when the last blocker stayed behind", () => {
    const { from, to, ids } = batch("Autostart dropped", 1);
    const blocker = createTask({ project_id: from.id, title: "Stays behind" });
    setTaskDeps(ids[0], [blocker.id]);
    updateTask(ids[0], { auto_start: 1 });

    moveTasks(ids, to.id);

    expect(getTask(ids[0])?.auto_start).toBe(0);
  });

  it("clears a left-behind dependent's auto_start when its last blocker leaves", () => {
    const { from, to, ids } = batch("Left behind", 1);
    const dependent = createTask({ project_id: from.id, title: "Dependent" });
    setTaskDeps(dependent.id, [ids[0]]);
    updateTask(dependent.id, { auto_start: 1 });

    moveTasks(ids, to.id);

    expect(getTask(dependent.id)?.auto_start).toBe(0);
  });

  it("leaves a left-behind BLOCKER's own flags alone — it lost nothing", () => {
    // The severed edge cost the mover a blocker; the blocker itself is just as
    // unblocked as it was. Its auto_start is a dead flag either way, but it is
    // not this move's business to reap it — and touching the row would bump an
    // updated_at the user never asked to change.
    const { from, to, ids } = batch("Blocker untouched", 1);
    const blocker = createTask({ project_id: from.id, title: "Stays behind" });
    setTaskDeps(ids[0], [blocker.id]);
    updateTask(blocker.id, { auto_start: 1 });
    const before = getTask(blocker.id)!.updated_at;

    moveTasks(ids, to.id);

    expect(getTask(blocker.id)).toMatchObject({ auto_start: 1, updated_at: before });
  });

  it("reports an id already in the destination as unchanged, not skipped", () => {
    const { to, ids } = batch("Already", 1);
    const settled = createTask({ project_id: to.id, title: "Home already" });

    const result = moveTasks([ids[0], settled.id], to.id);

    expect(result.unchanged).toEqual([settled.id]);
    expect(result.skipped).toEqual([]);
    expect(result.moved.map((t) => t.id)).toEqual([ids[0]]);
  });

  it("reports an unknown id as skipped rather than failing the batch", () => {
    const { to, ids } = batch("Unknown", 1);

    const result = moveTasks([ids[0], "nope"], to.id);

    expect(result.skipped).toEqual([{ id: "nope", reason: "task not found" }]);
    expect(result.moved.map((t) => t.id)).toEqual([ids[0]]);
  });

  it("throws on an unknown destination — that's the caller's mistake, not a skip", () => {
    const { ids } = batch("Bad dest", 1);
    expect(() => moveTasks(ids, "nope")).toThrow(/project not found/);
  });

  it("takes a selection spanning two source projects", () => {
    const { to, ids } = batch("Two sources", 1);
    const other = createProject({ name: "Two sources other" });
    const stray = createTask({ project_id: other.id, title: "Stray" });

    const result = moveTasks([ids[0], stray.id], to.id);

    expect(result.moved.map((t) => t.project_id)).toEqual([to.id, to.id]);
    expect(listTasks(to.id).map((t) => t.title)).toEqual(["Two sources 1", "Stray"]);
  });

  it("keeps each source tray's own order, rather than interleaving by position", () => {
    // Positions only mean something WITHIN a project: task A sitting at 2 in one
    // tray is not "after" task B sitting at 0 in another. Sorting them together
    // would interleave two unrelated orderings, so each source's run stays
    // whole, in the order the caller first named that source.
    const { to, ids } = batch("Interleave", 3);
    const other = createProject({ name: "Interleave other" });
    const stray = createTask({ project_id: other.id, title: "Stray" });

    const result = moveTasks([ids[2], stray.id, ids[0]], to.id);

    expect(result.moved.map((t) => t.title)).toEqual(["Interleave 1", "Interleave 3", "Stray"]);
  });

  it("is a no-op for an empty selection", () => {
    const { to } = batch("Empty", 0);
    expect(moveTasks([], to.id)).toMatchObject({ moved: [], skipped: [], unchanged: [], dropped: [], kept: [] });
  });
});

describe("POST /api/tasks/move", () => {
  it("moves the selection and reports what it cost", async () => {
    const { to, ids } = batch("Route", 3);
    setTaskDeps(ids[1], [ids[0]]);
    updateTask(ids[2], { started: 1 });

    const res = await bulkMove({ ids, project_id: to.id });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      moved: [ids[0], ids[1]],
      unchanged: [],
      skipped: [{ id: ids[2], reason: expect.stringMatching(/started task can't be moved/) }],
      kept: [{ task_id: ids[1], depends_on_id: ids[0] }],
      dropped: [],
    });
  });

  it("publishes ONE tasks_moved carrying every id, so other tabs re-sync once", async () => {
    const { from, to, ids } = batch("Publish", 3);
    const seen: BusEvent[] = [];
    const unsub = subscribeGlobal((_taskId, ev) => seen.push(ev));
    try {
      await bulkMove({ ids, project_id: to.id });
    } finally {
      unsub();
    }

    expect(seen).toEqual([{ type: "tasks_moved", taskIds: ids, fromProjectIds: [from.id], toProjectId: to.id }]);
  });

  it("publishes nothing when the whole selection was unmovable", async () => {
    const { to, ids } = batch("Nothing", 2);
    ids.forEach((id) => updateTask(id, { started: 1 }));
    const seen: BusEvent[] = [];
    const unsub = subscribeGlobal((_taskId, ev) => seen.push(ev));
    try {
      const res = await bulkMove({ ids, project_id: to.id });
      expect((await res.json()).skipped).toHaveLength(2);
    } finally {
      unsub();
    }

    expect(seen).toEqual([]);
  });

  it("skips a task whose turn is claimed, and moves the rest", async () => {
    const { from, to, ids } = batch("Claimed", 2);
    // POST /messages claims the turn slot BEFORE it takes the task lock, so the
    // row still reads running=0 while a launch is in flight — the abort registry
    // is the liveness truth the single-task route checks too.
    const controller = claimTurn(ids[0])!;
    try {
      const res = await bulkMove({ ids, project_id: to.id });
      const body = await res.json();

      expect(body.skipped).toEqual([{ id: ids[0], reason: expect.stringMatching(/running turn/) }]);
      expect(body.moved).toEqual([ids[1]]);
      expect(getTask(ids[0])?.project_id).toBe(from.id);
    } finally {
      unregisterTurn(ids[0], controller);
    }
  });

  it("still no-ops a same-project move on a task whose turn is claimed", async () => {
    // Moving a task to the project it's already in has always been an
    // unconditional success — there is nothing to refuse, so the liveness screen
    // must not turn it into one.
    const { from, ids } = batch("Same project live", 1);
    const controller = claimTurn(ids[0])!;
    try {
      const res = await bulkMove({ ids, project_id: from.id });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ unchanged: ids, skipped: [], moved: [] });
    } finally {
      unregisterTurn(ids[0], controller);
    }
  });

  it("404s when the destination is deleted while the move waits for the task lock", async () => {
    // The destination is checked before the locks (so a typo fails fast) and
    // again inside them (so a project deleted while we queued can't be moved
    // into). The second check throws — the route has to answer 404, not 500.
    const { to, ids } = batch("Dest vanishes", 1);
    let release!: () => void;
    const held = withTaskLock(ids[0], () => new Promise<void>((r) => (release = r)));

    const pending = bulkMove({ ids, project_id: to.id });
    // Let the request get past its own pre-flight checks and park on the lock.
    await new Promise((r) => setTimeout(r, 20));
    deleteProject(to.id);
    release();
    await held;

    expect((await pending).status).toBe(404);
  });

  it("400s on a missing or malformed ids list, 404s on an unknown destination", async () => {
    const { to, ids } = batch("Route bad", 1);

    expect((await bulkMove({ project_id: to.id })).status).toBe(400);
    expect((await bulkMove({ ids: "nope", project_id: to.id })).status).toBe(400);
    expect((await bulkMove({ ids, project_id: "" })).status).toBe(400);
    expect((await bulkMove({ ids, project_id: "nope" })).status).toBe(404);
  });
});
