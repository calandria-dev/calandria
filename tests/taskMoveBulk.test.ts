import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GET as bulkPreviewRoute, POST as bulkMoveRoute } from "@/app/api/tasks/move/route";
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
import { ensureWorktree, mergeTask } from "@/lib/git";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { claimTurn, unregisterTurn } from "@/lib/abort";
import { withTaskLock } from "@/lib/taskLock";
import { repoLockKey, withRepoLock } from "@/lib/repoLock";
import { commitFile, makeRepo, writeFile } from "./helpers";

// Pins bulk moves of tasks across projects.
//
// A task that can't move (started, or with a turn in flight) is reported as
// skipped, not dropped and not fatal to the rest of the batch. A dependency
// edge survives only when both ends are in the moving set, staying
// intra-project so the single-task move's "edges never span projects" rule
// still holds.
//
// A started task can move too, but only for ids the caller named: the
// acknowledgement that discards a checkout is per task id, never a blanket
// flag, since eleven worktrees are eleven separate irreversible answers. The
// batch preview (GET on the same route) reports what each one holds so the
// answer can be given knowing the cost.

async function bulkMove(body: Record<string, unknown>) {
  return bulkMoveRoute(new Request("http://test", { method: "POST", body: JSON.stringify(body) }));
}

async function bulkPreview(ids: string[]) {
  const qs = ids.length ? `?ids=${ids.map(encodeURIComponent).join(",")}` : "";
  return bulkPreviewRoute(new Request(`http://test/api/tasks/move${qs}`));
}

/** Two projects and `n` unstarted tasks filed in the first one. */
function batch(name: string, n: number) {
  const from = createProject({ name: `${name} from` });
  const to = createProject({ name: `${name} to` });
  const tasks = Array.from({ length: n }, (_, i) => createTask({ project_id: from.id, title: `${name} ${i + 1}` }));
  return { from, to, tasks, ids: tasks.map((t) => t.id) };
}

/**
 * Two projects with real repos, and `n` started tasks in the first: each holds
 * a worktree cut from that repo, with its work already landed in main. Every
 * one is a clean, discardable checkout until a test dirties it.
 */
async function startedBatch(name: string, n: number) {
  const fromRepo = await makeRepo();
  const toRepo = await makeRepo();
  const from = createProject({ name: `${name} from`, repo_path: fromRepo, branch: "main" });
  const to = createProject({ name: `${name} to`, repo_path: toRepo, branch: "main" });
  const wts: { path: string; branch: string }[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const task = createTask({ project_id: from.id, title: `${name} ${i + 1}` });
    const wt = await ensureWorktree(fromRepo, task.id, "main");
    if (!wt) throw new Error("ensureWorktree returned null in fixture");
    updateTask(task.id, { started: 1, worktree_path: wt.path, work_branch: wt.branch, base_sha: wt.baseSha });
    await commitFile(wt.path, `feature-${i}.txt`, "the work\n", `task ${i} commit`);
    const merged = await mergeTask({
      repoPath: fromRepo, worktreePath: wt.path, workBranch: wt.branch, baseBranch: "main", message: `land ${i}`,
    });
    if (!merged.ok) throw new Error(`fixture merge failed: ${merged.error}`);
    wts.push(wt);
    ids.push(task.id);
  }
  return { from, to, fromRepo, toRepo, ids, wts };
}

describe("moveTasks (store)", () => {
  it("moves the whole selection, reporting it in source order", () => {
    const { from, to, ids } = batch("Bulk", 3);
    createTask({ project_id: to.id, title: "Already here" });

    // Out of order: the report, and the positions behind it, follow the order
    // the tasks had in the source project, not the order they were passed in.
    const result = moveTasks([ids[2], ids[0], ids[1]], to.id);

    expect(result.moved.map((t) => t.id)).toEqual(ids);
    expect(result.skipped).toEqual([]);
    // Membership only: the tray's order is recency, covered by
    // tests/taskOrder.test.ts, and every row here is written within the same
    // millisecond, so asserting a sequence would just pin the machine's speed.
    expect(listTasks(to.id).map((t) => t.title).sort()).toEqual(["Already here", "Bulk 1", "Bulk 2", "Bulk 3"]);
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

  it("resets the checkout of the named tasks only", () => {
    // The store's half of the per-task acknowledgement. A blanket flag would
    // also disable the started-task refusal for the whole batch, so an
    // unacknowledged task would move with its columns cleared and its worktree
    // orphaned in the repo it came from.
    const { from, to, ids } = batch("Reset set", 2);
    ids.forEach((id) => updateTask(id, { started: 1, worktree_path: `/tmp/wt-${id}`, work_branch: `calandria/${id}` }));

    const result = moveTasks(ids, to.id, { resetCheckout: new Set([ids[0]]) });

    expect(result.moved.map((t) => t.id)).toEqual([ids[0]]);
    expect(getTask(ids[0])).toMatchObject({ project_id: to.id, worktree_path: "", work_branch: "" });
    expect(result.skipped).toEqual([{ id: ids[1], reason: expect.stringMatching(/started task can't be moved/) }]);
    expect(getTask(ids[1])).toMatchObject({ project_id: from.id, worktree_path: `/tmp/wt-${ids[1]}` });
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
    // a → b → c with b unmovable: b's two edges each have one end left behind,
    // so both drop. The rest of the selection is unaffected.
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
    // unblocked as before. Its auto_start is a dead flag either way, but this
    // move doesn't clear it, and touching the row would bump an updated_at the
    // user never asked to change.
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
    expect(listTasks(to.id).map((t) => t.title).sort()).toEqual(["Stray", "Two sources 1"]);
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
    // POST /messages claims the turn slot before it takes the task lock, so the
    // row still reads running=0 while a launch is in flight. The abort registry
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
    // Moving a task to the project it's already in is an unconditional
    // success: there is nothing to refuse, so the liveness screen must not
    // turn it into one.
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
    // The destination is checked before the locks, so a typo fails fast, and
    // again inside them, so a project deleted while the move was queued can't
    // be moved into. The second check throws, so the route must answer 404,
    // not 500.
    const { to, ids } = batch("Dest vanishes", 1);
    let release!: () => void;
    const held = withTaskLock(ids[0], () => new Promise<void>((r) => (release = r)));
    // withTaskLock registers into the lock map synchronously (before any
    // await), so `held`'s tail is already in the map the instant it returns.
    const initialTail = global.__calandriaTaskLocks?.get(ids[0]);

    const pending = bulkMove({ ids, project_id: to.id });
    // The route's own withTaskLocks call re-registers a new tail chained
    // behind `held`'s. Waiting for that identity change is the signal that the
    // request has cleared its pre-flight checks and is now parked on the lock,
    // instead of guessing how long that takes.
    await vi.waitFor(() => expect(global.__calandriaTaskLocks?.get(ids[0])).not.toBe(initialTail));
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

describe("discarding worktrees for part of a selection", () => {
  it("tears down only the checkouts whose ids were acknowledged", async () => {
    const { from, to, ids, wts } = await startedBatch("Some acked", 3);

    const res = await bulkMove({ ids, project_id: to.id, discard_worktree: [ids[0], ids[2]] });
    const body = await res.json();

    expect(body.moved).toEqual([ids[0], ids[2]]);
    expect(fs.existsSync(wts[0].path)).toBe(false);
    expect(fs.existsSync(wts[2].path)).toBe(false);
    // The one nobody answered for is refused, and its checkout is untouched,
    // unlike a blanket switch.
    expect(body.skipped).toEqual([{ id: ids[1], reason: expect.stringMatching(/started task can't be moved/) }]);
    expect(getTask(ids[1])?.project_id).toBe(from.id);
    expect(fs.existsSync(wts[1].path)).toBe(true);
    expect(getTask(ids[1])?.worktree_path).toBe(wts[1].path);
  });

  it("clears the checkout columns of the acknowledged movers only", async () => {
    const { to, ids, wts } = await startedBatch("Columns", 2);

    await bulkMove({ ids, project_id: to.id, discard_worktree: [ids[0]] });

    expect(getTask(ids[0])).toMatchObject({ project_id: to.id, worktree_path: "", work_branch: "", base_sha: "" });
    // Still started, still pointing at the old repo's checkout: it never moved.
    expect(getTask(ids[1])).toMatchObject({ worktree_path: wts[1].path, work_branch: wts[1].branch });
  });

  it("ignores a blanket true — the acknowledgement is a list of ids", async () => {
    // One checkbox over three irreversible answers isn't consent. A caller that
    // sends the single route's boolean gets the plain refusal instead of a
    // shortcut.
    const { from, to, ids, wts } = await startedBatch("Blanket", 2);

    const res = await bulkMove({ ids, project_id: to.id, discard_worktree: true });
    const body = await res.json();

    expect(body.moved).toEqual([]);
    expect(body.skipped.map((s: { id: string }) => s.id)).toEqual(ids);
    expect(wts.every((wt) => fs.existsSync(wt.path))).toBe(true);
    expect(getTask(ids[0])?.project_id).toBe(from.id);
  });

  it("reports what each teardown destroyed", async () => {
    const { to, ids, wts } = await startedBatch("Cost", 2);

    const res = await bulkMove({ ids, project_id: to.id, discard_worktree: ids });
    const body = await res.json();

    expect(body.discarded).toEqual([
      { id: ids[0], branch: wts[0].branch, dirty: false, ahead: 0 },
      { id: ids[1], branch: wts[1].branch, dirty: false, ahead: 0 },
    ]);
  });

  it("moves an acknowledged started task alongside an unstarted one", async () => {
    const { from, to, ids } = await startedBatch("Mixed", 1);
    const fresh = createTask({ project_id: from.id, title: "Never ran" });
    setTaskDeps(fresh.id, [ids[0]]);

    const res = await bulkMove({ ids: [ids[0], fresh.id], project_id: to.id, discard_worktree: [ids[0]] });
    const body = await res.json();

    expect(body.moved).toEqual([ids[0], fresh.id]);
    // Both ends came along, so the link survives, extending the batch-only
    // behavior to a chain that includes a started task.
    expect(body.kept).toEqual([{ task_id: fresh.id, depends_on_id: ids[0] }]);
    expect(getTaskDeps(fresh.id)).toEqual([ids[0]]);
  });
});

describe("a dirty worktree inside a selection", () => {
  it("is refused until its id also names the unsaved work", async () => {
    const { from, to, ids, wts } = await startedBatch("Dirty one", 3);
    writeFile(wts[1].path, "feature-1.txt", "an afternoon of unsaved work\n");

    const res = await bulkMove({ ids, project_id: to.id, discard_worktree: ids });
    const body = await res.json();

    // Three of eleven dirty doesn't refuse the eight: they move, it's reported.
    expect(body.moved).toEqual([ids[0], ids[2]]);
    expect(body.skipped).toEqual([
      { id: ids[1], reason: expect.stringMatching(/unsaved work: uncommitted changes/) },
    ]);
    expect(getTask(ids[1])?.project_id).toBe(from.id);
    expect(fs.readFileSync(`${wts[1].path}/feature-1.txt`, "utf8")).toContain("an afternoon of unsaved work");
  });

  it("goes through once its id is in discard_unsafe", async () => {
    const { to, ids, wts } = await startedBatch("Dirty acked", 2);
    writeFile(wts[0].path, "feature-0.txt", "unsaved\n");
    await commitFile(wts[1].path, "extra.txt", "never landed\n", "unmerged commit");

    const res = await bulkMove({
      ids, project_id: to.id, discard_worktree: ids, discard_unsafe: ids,
    });
    const body = await res.json();

    expect(body.moved).toEqual(ids);
    expect(body.discarded).toEqual([
      { id: ids[0], branch: wts[0].branch, dirty: true, ahead: 0 },
      { id: ids[1], branch: wts[1].branch, dirty: false, ahead: 1 },
    ]);
    expect(wts.some((wt) => fs.existsSync(wt.path))).toBe(false);
  });

  it("acknowledges one task's unsaved work without covering its neighbour's", async () => {
    const { from, to, ids, wts } = await startedBatch("Unsafe per task", 2);
    wts.forEach((wt, i) => writeFile(wt.path, `feature-${i}.txt`, "unsaved\n"));

    const res = await bulkMove({
      ids, project_id: to.id, discard_worktree: ids, discard_unsafe: [ids[0]],
    });
    const body = await res.json();

    expect(body.moved).toEqual([ids[0]]);
    expect(body.skipped.map((s: { id: string }) => s.id)).toEqual([ids[1]]);
    expect(getTask(ids[1])?.project_id).toBe(from.id);
    expect(fs.existsSync(wts[1].path)).toBe(true);
  });

  it("404s when the destination is deleted while a teardown is in flight", async () => {
    // The window the plain move doesn't have: teardown is git, so the check
    // that the destination exists is no longer adjacent to the write. Held at
    // the repo lock, the destination is deleted underneath it, and the route
    // must answer the documented 404; the store's "project not found" must not
    // surface as a 500.
    const { to, ids, fromRepo } = await startedBatch("Dest vanishes mid-teardown", 1);
    let release!: () => void;
    const held = withRepoLock(fromRepo, () => new Promise<void>((r) => (release = r)));
    // fromRepo's key is already cached from startedBatch's own git ops, so
    // this resolves immediately after (not before) `held` has registered.
    const key = await repoLockKey(fromRepo);
    const initialTail = global.__calandriaRepoLocks?.get(key);

    const pending = bulkMove({ ids, project_id: to.id, discard_worktree: ids });
    // discardCheckout's withRepoLock call re-registers a new tail chained
    // behind `held`'s once it reaches the lock. That identity change is the
    // signal that the teardown is now parked, instead of a guess at how long
    // that takes.
    await vi.waitFor(() => expect(global.__calandriaRepoLocks?.get(key)).not.toBe(initialTail));
    deleteProject(to.id);
    release();
    await held;

    expect((await pending).status).toBe(404);
  });

  it("re-reads each worktree at teardown, not when the preview was taken", async () => {
    const { from, to, ids, wts } = await startedBatch("Raced", 2);
    const previews = await (await bulkPreview(ids)).json();
    expect(previews.previews[ids[1]]).toMatchObject({ has_worktree: true, safe: true });

    // …and then the user edits a file in their own editor before confirming.
    writeFile(wts[1].path, "feature-1.txt", "typed while the modal was open\n");
    const body = await (await bulkMove({ ids, project_id: to.id, discard_worktree: ids })).json();

    // The answer was given about a state that no longer holds, so it doesn't
    // carry, and it costs only its own row.
    expect(body.moved).toEqual([ids[0]]);
    expect(body.skipped[0].reason).toMatch(/unsaved work/);
    expect(getTask(ids[1])?.project_id).toBe(from.id);
    expect(fs.existsSync(wts[0].path)).toBe(false);
  });
});

describe("GET /api/tasks/move — the batch discard preview", () => {
  it("answers one preview per id, so each row can name its own cost", async () => {
    const { ids, wts } = await startedBatch("Preview", 2);
    // Committed first, then dirtied: commitFile stages the whole tree, so the
    // other order would land the "unsaved" edit in the commit.
    await commitFile(wts[1].path, "extra.txt", "more\n", "unmerged commit");
    writeFile(wts[1].path, "feature-1.txt", "unsaved\n");

    const res = await bulkPreview(ids);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.previews[ids[0]]).toMatchObject({ has_worktree: true, safe: true, dirty: false, ahead: 0, reason: null, branch: wts[0].branch });
    expect(body.previews[ids[1]]).toMatchObject({ has_worktree: true, safe: false, dirty: true, ahead: 1 });
    expect(body.previews[ids[1]].reason).toMatch(/uncommitted changes \+ 1 commit not yet in main/);
  });

  it("says there is nothing to discard for a task that never ran", async () => {
    const { ids } = batch("Preview unstarted", 1);

    const body = await (await bulkPreview(ids)).json();

    expect(body.previews[ids[0]]).toMatchObject({ has_worktree: false, safe: true, branch: "" });
  });

  it("omits an unknown id rather than failing the whole read", async () => {
    const { ids } = batch("Preview unknown", 1);

    const body = await (await bulkPreview([...ids, "nope"])).json();

    expect(Object.keys(body.previews)).toEqual(ids);
  });

  it("400s without ids", async () => {
    expect((await bulkPreview([])).status).toBe(400);
  });
});
