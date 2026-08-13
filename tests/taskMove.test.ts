import { describe, expect, it } from "vitest";
import { POST as moveRoute } from "@/app/api/tasks/[id]/move/route";
import {
  createProject,
  createTask,
  getTask,
  getTaskDeps,
  listTasks,
  moveTask,
  setTaskDeps,
  updateProject,
  updateTask,
} from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { claimTurn, unregisterTurn } from "@/lib/abort";

// Moving a task between projects: the one path that changes project_id after
// creation. A task's project used to be fixed, so a misfiled task meant delete
// + recreate — losing its transcript. What the move has to get right: refuse
// once the task owns a worktree (it was cut from the OLD project's repo),
// renumber the per-project position, reconcile the values inherited from the
// old project, and clear the dependency edges that can't span projects.

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function move(id: string, body: Record<string, unknown>) {
  return moveRoute(new Request("http://test", { method: "POST", body: JSON.stringify(body) }), params(id));
}

/** Two projects and a task filed in the first one. */
function pair(name: string) {
  const from = createProject({ name: `${name} from` });
  const to = createProject({ name: `${name} to` });
  const task = createTask({ project_id: from.id, title: "Misfiled" });
  return { from, to, task };
}

describe("moveTask (store)", () => {
  it("re-parents the task and appends it to the destination's order", () => {
    const { from, to, task } = pair("Order");
    createTask({ project_id: to.id, title: "Already here" });
    createTask({ project_id: to.id, title: "Also here" });

    const { task: moved } = moveTask(task.id, to.id);

    expect(moved.project_id).toBe(to.id);
    // Position is per-project (MAX+1 within the project) — a stale 0 would
    // collide with the destination's first task.
    expect(moved.position).toBe(2);
    expect(listTasks(to.id).map((t) => t.title)).toEqual(["Already here", "Also here", "Misfiled"]);
    expect(listTasks(from.id)).toEqual([]);
  });

  it("keeps the transcript-bearing row itself — same id, title, description", () => {
    const { to, task } = pair("Identity");
    updateTask(task.id, { description: "the whole point of moving instead of recreating" });

    const { task: moved } = moveTask(task.id, to.id);

    expect(moved.id).toBe(task.id);
    expect(moved.description).toBe("the whole point of moving instead of recreating");
  });

  it("refuses a started task — its worktree belongs to the old project's repo", () => {
    const { from, to, task } = pair("Started");
    updateTask(task.id, { started: 1 });

    expect(() => moveTask(task.id, to.id)).toThrow(/started task can't be moved/);
    expect(getTask(task.id)?.project_id).toBe(from.id);
  });

  it.each([
    ["a worktree on record", { worktree_path: "/tmp/wt" }],
    ["a work branch on record", { work_branch: "orch/abc" }],
    ["a base sha on record", { base_sha: "deadbeef" }],
    ["a running turn", { running: 1 }],
  ])("refuses a task with %s", (_label, patch) => {
    const { from, to, task } = pair("Refuse");
    updateTask(task.id, patch);

    expect(() => moveTask(task.id, to.id)).toThrow();
    expect(getTask(task.id)?.project_id).toBe(from.id);
  });

  it("moving to the project it's already in is a no-op", () => {
    const { from, task } = pair("Same");
    const result = moveTask(task.id, from.id);
    expect(result.task.project_id).toBe(from.id);
    expect(result.dropped_blockers).toEqual([]);
  });

  it("rejects an unknown task or project", () => {
    const { to, task } = pair("Missing");
    expect(() => moveTask("nope", to.id)).toThrow(/task not found/);
    expect(() => moveTask(task.id, "nope")).toThrow(/project not found/);
  });
});

describe("moveTask dependencies", () => {
  it("drops edges in both directions and reports them", () => {
    const { from, to, task } = pair("Edges");
    const blocker = createTask({ project_id: from.id, title: "Blocker" });
    const dependent = createTask({ project_id: from.id, title: "Dependent" });
    setTaskDeps(task.id, [blocker.id]);
    setTaskDeps(dependent.id, [task.id]);

    const result = moveTask(task.id, to.id);

    // Edges can't span projects (setTaskDeps enforces it), and nothing else
    // revalidates them — so the move clears every edge touching this task.
    expect(result.dropped_blockers).toEqual([blocker.id]);
    expect(result.dropped_dependents).toEqual([dependent.id]);
    expect(getTaskDeps(task.id)).toEqual([]);
    expect(getTaskDeps(dependent.id)).toEqual([]);
    // The tasks left behind are untouched apart from the edge.
    expect(getTask(blocker.id)?.project_id).toBe(from.id);
    expect(getTask(dependent.id)?.project_id).toBe(from.id);
  });

  it("leaves unrelated edges in the source project alone", () => {
    const { from, to, task } = pair("Unrelated");
    const a = createTask({ project_id: from.id, title: "A" });
    const b = createTask({ project_id: from.id, title: "B" });
    setTaskDeps(b.id, [a.id]);

    moveTask(task.id, to.id);

    expect(getTaskDeps(b.id)).toEqual([a.id]);
  });

  it("clears auto_start on both sides — a blocker-less task can never auto-start", () => {
    const { from, to, task } = pair("Autostart");
    const blocker = createTask({ project_id: from.id, title: "Blocker" });
    const dependent = createTask({ project_id: from.id, title: "Dependent" });
    setTaskDeps(task.id, [blocker.id]);
    setTaskDeps(dependent.id, [task.id]);
    updateTask(task.id, { auto_start: 1 });
    updateTask(dependent.id, { auto_start: 1 });

    moveTask(task.id, to.id);

    // lib/autoStart.ts only ever selects through task_dependencies, so an
    // opt-in with no blockers left is a flag that can never fire.
    expect(getTask(task.id)?.auto_start).toBe(0);
    expect(getTask(dependent.id)?.auto_start).toBe(0);
  });

  it("keeps a dependent's auto_start when it still has another blocker", () => {
    const { from, to, task } = pair("Partial");
    const other = createTask({ project_id: from.id, title: "Other blocker" });
    const dependent = createTask({ project_id: from.id, title: "Dependent" });
    setTaskDeps(dependent.id, [task.id, other.id]);
    updateTask(dependent.id, { auto_start: 1 });

    moveTask(task.id, to.id);

    expect(getTaskDeps(dependent.id)).toEqual([other.id]);
    expect(getTask(dependent.id)?.auto_start).toBe(1);
  });
});

describe("moveTask inherited settings", () => {
  it("re-derives an agent the task only inherited from the old project", () => {
    const from = createProject({ name: "Inherit from" });
    const to = createProject({ name: "Inherit to" });
    updateProject(from.id, { default_agent: "claude" });
    updateProject(to.id, { default_agent: "codex" });
    const task = createTask({ project_id: from.id, title: "Inherited" });
    expect(task.agent).toBe("claude");
    updateTask(task.id, { model: "claude-opus-4-1", reasoning: "deep", permission_mode: "acceptEdits" });

    const { task: moved } = moveTask(task.id, to.id);

    expect(moved.agent).toBe("codex");
    // Switching drivers invalidates the provider-specific run controls, same
    // rule the PATCH agent-switch path applies.
    expect(moved).toMatchObject({ model: null, resolved_model: null, reasoning: null, permission_mode: null, session_id: null });
  });

  it("preserves an agent the user explicitly picked", () => {
    const from = createProject({ name: "Explicit from" });
    const to = createProject({ name: "Explicit to" });
    updateProject(from.id, { default_agent: "claude" });
    updateProject(to.id, { default_agent: "claude" });
    const task = createTask({ project_id: from.id, title: "Explicit", agent: "codex" });
    updateTask(task.id, { reasoning: "high" });

    const { task: moved } = moveTask(task.id, to.id);

    // It differs from the source project's default, so it reads as a choice —
    // and the run controls that go with it survive.
    expect(moved.agent).toBe("codex");
    expect(moved.reasoning).toBe("high");
  });

  it("re-derives an inherited send_context, preserves an explicit opt-out", () => {
    const from = createProject({ name: "Ctx from" });
    const to = createProject({ name: "Ctx to" });
    updateProject(to.id, { send_context: 0 });
    const inherited = createTask({ project_id: from.id, title: "Inherited ctx" });
    const explicit = createTask({ project_id: from.id, title: "Explicit ctx", send_context: false });

    expect(moveTask(inherited.id, to.id).task.send_context).toBe(0);
    // 0 while the source project says 1 — an opt-out the user must have made,
    // so it survives even though the destination would have derived the same.
    expect(moveTask(explicit.id, to.id).task.send_context).toBe(0);
  });

  it("re-derives a value once it matches its project's default — the guess is a guess", () => {
    const off = createProject({ name: "Ctx off" });
    const on = createProject({ name: "Ctx on" });
    updateProject(off.id, { send_context: 0 });
    // Opted out inside a project that defaults to opted out: the column can no
    // longer say whether the user chose it. Moving into a send_context=1
    // project reads it as inherited and flips it. This is the acknowledged
    // limit of deriving provenance from a single bit — the UI previews the
    // outcome before the move, and the task-level toggle undoes it.
    const task = createTask({ project_id: off.id, title: "Ambiguous", send_context: false });

    expect(moveTask(task.id, on.id).task.send_context).toBe(1);
  });
});

describe("POST /api/tasks/[id]/move", () => {
  it("moves the task and reports the dropped edges", async () => {
    const { to, task } = pair("Route");
    const blocker = createTask({ project_id: task.project_id, title: "Blocker" });
    setTaskDeps(task.id, [blocker.id]);

    const res = await move(task.id, { project_id: to.id });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ id: task.id, project_id: to.id, depends_on: [], dropped_blockers: [blocker.id], dropped_dependents: [] });
    expect(getTask(task.id)?.project_id).toBe(to.id);
  });

  it("publishes tasks_moved with both project ids so either tray can re-sync", async () => {
    const { from, to, task } = pair("Publish");
    const seen: [string, BusEvent][] = [];
    const unsub = subscribeGlobal((taskId, ev) => seen.push([taskId, ev]));
    try {
      await move(task.id, { project_id: to.id });
    } finally {
      unsub();
    }
    // One shape on the wire for one task and for eleven — a single move is just
    // the batch event with one-element lists (see tests/taskMoveBulk.test.ts).
    expect(seen).toEqual([[task.id, { type: "tasks_moved", taskIds: [task.id], fromProjectIds: [from.id], toProjectId: to.id }]]);
  });

  it("409s on a started task, leaving it where it was", async () => {
    const { from, to, task } = pair("Route started");
    updateTask(task.id, { started: 1, worktree_path: "/tmp/wt" });

    const res = await move(task.id, { project_id: to.id });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/started task can't be moved/);
    expect(getTask(task.id)?.project_id).toBe(from.id);
  });

  it("409s while a turn is claimed — the launch path claims before it locks", async () => {
    const { from, to, task } = pair("Route claimed");
    // POST /messages claims the turn slot before taking the task lock, so the
    // row still reads running=0 while a launch is in flight.
    const controller = claimTurn(task.id)!;
    try {
      const res = await move(task.id, { project_id: to.id });
      expect(res.status).toBe(409);
      expect(getTask(task.id)?.project_id).toBe(from.id);
    } finally {
      unregisterTurn(task.id, controller);
    }
  });

  it("404s on an unknown task or destination, 400s without a project_id", async () => {
    const { to, task } = pair("Route bad");

    expect((await move("nope", { project_id: to.id })).status).toBe(404);
    expect((await move(task.id, { project_id: "nope" })).status).toBe(404);
    expect((await move(task.id, {})).status).toBe(400);
  });

  it("accepts a move to the task's current project as a no-op, even when started", async () => {
    const { from, task } = pair("Route same");
    updateTask(task.id, { started: 1 });

    const res = await move(task.id, { project_id: from.id });

    expect(res.status).toBe(200);
    expect(getTask(task.id)?.project_id).toBe(from.id);
  });
});
