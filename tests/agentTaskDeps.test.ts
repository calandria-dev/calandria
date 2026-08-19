// Wiring dependencies from an agent, AFTER the tasks exist.
//
// `suggest_task` has always taken `blocked_by`, but only at creation time — so
// the ONE moment an agent could express order was the same call that invented
// the task, before any of its blockers had ids. A planning turn files N tasks in
// one parallel tool-call batch (no ids returned yet, and title refs race the
// handler order), realizes the order afterwards, and then had nowhere to put it:
// `update_task` wrote title/description/priority/status and nothing else. The
// live DB bears this out — every dependency edge on the board was drawn by the
// UI's Edit dialog; not one transcript contains the "Blocked by N task(s)" line
// depNote returns.
//
// So `update_task` takes `blocked_by` too, and the two-phase recipe (file the
// tasks, then wire the order) becomes possible. What's pinned here:
//   - it replaces the dep set, the way the Edit dialog's DepPicker does, and []
//     clears it;
//   - refs are partitioned and REPORTED exactly as suggest_task's are, since the
//     same project-scoping rule applies;
//   - a cycle refuses the WHOLE call — no half-applied title/priority left over;
//   - the caller's own row is refused: blockers gate STARTING, and a session
//     calling this has already started, so the honest verb is `on_hold`;
//   - the cross-task boundary is unchanged — only an inert tray suggestion.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createProject, createTask, getTask, getTaskDeps, setTaskDeps, updateTask } from "@/lib/store";
import { createSuggestedTask, updateTaskForAgent } from "@/lib/agentTools";
import { buildProjectContext } from "@/lib/agents/shared";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** A running session's own task — the trusted `caller` every tool call carries. */
function callerTask(projectId: string, title = "Caller") {
  const t = createTask({ project_id: projectId, title, description: "" });
  return updateTask(t.id, { started: 1, running: 1 })!;
}

describe("update_task sets dependencies after the fact", () => {
  it("wires blockers onto a suggestion filed earlier in the turn", () => {
    const project = createProject({ name: "UD-Wire" });
    const caller = callerTask(project.id);
    const first = createSuggestedTask(project, { title: "First", description: "" }).task!;
    const second = createSuggestedTask(project, { title: "Second", description: "" }).task!;

    const { task, text } = updateTaskForAgent(caller, second.id, { blocked_by: [first.id] });
    expect(task).not.toBeNull();
    expect(getTaskDeps(second.id)).toEqual([first.id]);
    expect(text).toContain("blocked by 1 task(s)");
  });

  it("replaces the dep set rather than adding to it, and [] clears it", () => {
    const project = createProject({ name: "UD-Replace" });
    const caller = callerTask(project.id);
    const a = createSuggestedTask(project, { title: "A", description: "" }).task!;
    const b = createSuggestedTask(project, { title: "B", description: "" }).task!;
    const dependent = createSuggestedTask(project, { title: "Dependent", description: "", blocked_by: [a.id] }).task!;

    updateTaskForAgent(caller, dependent.id, { blocked_by: [b.id] });
    expect(getTaskDeps(dependent.id)).toEqual([b.id]);

    const cleared = updateTaskForAgent(caller, dependent.id, { blocked_by: [] });
    expect(getTaskDeps(dependent.id)).toEqual([]);
    expect(cleared.task).not.toBeNull();
    expect(cleared.text).toContain("no longer blocked");
  });

  it("refuses the whole call on an unusable ref rather than wiring the rest", () => {
    // Fail-closed, and this is where it diverges from suggest_task, which
    // partitions and reports. suggest_task fills in a blank set on a task that
    // has just been invented; this REPLACES one. Keeping the refs we recognized
    // and dropping the rest would delete edges the agent never mentioned and
    // still hand back a success.
    const project = createProject({ name: "UD-Partition" });
    const other = createProject({ name: "UD-Foreign" });
    const caller = callerTask(project.id);
    const kept = createSuggestedTask(project, { title: "Already a blocker", description: "" }).task!;
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const foreign = createSuggestedTask(other, { title: "Foreign", description: "" }).task!;
    const target = createSuggestedTask(project, { title: "Target", description: "", blocked_by: [kept.id] }).task!;

    const { task, text } = updateTaskForAgent(caller, target.id, { blocked_by: [blocker.id, foreign.id, "ghost"] });
    expect(task).toBeNull();
    expect(getTaskDeps(target.id)).toEqual([kept.id]);
    // Each bad ref is named with the reason it failed — the fix differs per
    // reason, so "ignored 2 refs" would tell the agent nothing it can act on.
    expect(text).toContain(`"${foreign.id}" is in UD-Foreign, not UD-Partition`);
    expect(text).toContain(`"ghost" isn't a task id`);
  });

  it("refuses a self-reference instead of wiring a task to itself", () => {
    const project = createProject({ name: "UD-Self" });
    const caller = callerTask(project.id);
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;

    const { task, text } = updateTaskForAgent(caller, target.id, { blocked_by: [target.id] });
    expect(task).toBeNull();
    expect(getTaskDeps(target.id)).toEqual([]);
    expect(text).toContain("is this task itself");
  });

  it("takes several blockers at once and treats reordering as no change", () => {
    const project = createProject({ name: "UD-Many" });
    const caller = callerTask(project.id);
    const a = createSuggestedTask(project, { title: "A", description: "" }).task!;
    const b = createSuggestedTask(project, { title: "B", description: "" }).task!;
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;

    expect(updateTaskForAgent(caller, target.id, { blocked_by: [a.id, b.id] }).text).toContain("blocked by 2 task(s)");
    expect(getTaskDeps(target.id).slice().sort()).toEqual([a.id, b.id].sort());
    // Edges have no order, so the same set the other way round is not an edit.
    expect(updateTaskForAgent(caller, target.id, { blocked_by: [b.id, a.id] }).text).toContain("No change");
  });

  it("refuses the WHOLE call on a cycle, leaving the other fields untouched", () => {
    const project = createProject({ name: "UD-Cycle" });
    const caller = callerTask(project.id);
    const a = createSuggestedTask(project, { title: "A", description: "" }).task!;
    const b = createSuggestedTask(project, { title: "B", description: "", blocked_by: [a.id] }).task!;

    // a blocked_by b would close the loop a → b → a.
    const { task, text } = updateTaskForAgent(caller, a.id, { title: "Renamed", blocked_by: [b.id] });
    expect(task).toBeNull();
    expect(text).toContain("cycle");
    expect(getTaskDeps(a.id)).toEqual([]);
    // The title write in the same call must not have landed.
    expect(getTask(a.id)!.title).toBe("A");
  });

  it("refuses to set blockers on the calling session's own row", () => {
    const project = createProject({ name: "UD-Own" });
    const caller = callerTask(project.id);
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;

    const { task, text } = updateTaskForAgent(caller, undefined, { blocked_by: [blocker.id] });
    expect(task).toBeNull();
    expect(getTaskDeps(caller.id)).toEqual([]);
    // The refusal has to name the verb that does mean "park this": on_hold.
    expect(text).toContain("on_hold");
  });

  it("still refuses a target that isn't an inert suggestion", () => {
    const project = createProject({ name: "UD-Boundary" });
    const caller = callerTask(project.id);
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const theirs = callerTask(project.id, "Someone else's live task");

    const { task, text } = updateTaskForAgent(caller, theirs.id, { blocked_by: [blocker.id] });
    expect(task).toBeNull();
    expect(getTaskDeps(theirs.id)).toEqual([]);
    expect(text).toContain("unreviewed suggestion");
  });

  it("reports no change when the dep set already matches", () => {
    const project = createProject({ name: "UD-Noop" });
    const caller = callerTask(project.id);
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const target = createSuggestedTask(project, { title: "Target", description: "", blocked_by: [blocker.id] }).task!;

    const { task, text } = updateTaskForAgent(caller, target.id, { blocked_by: [blocker.id] });
    expect(task).not.toBeNull();
    expect(text).toContain("No change");
  });

  it("publishes task_edited so the board redraws the blocked badge", async () => {
    const project = createProject({ name: "UD-Event" });
    const caller = callerTask(project.id);
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;

    const seen: BusEvent[] = [];
    const off = subscribeGlobal((_id, e) => seen.push(e));
    updateTaskForAgent(caller, target.id, { blocked_by: [blocker.id] });
    off();
    expect(seen.map((e) => e.type)).toContain("task_edited");
  });
});

describe("the update-task endpoint behind the stdio bridge", () => {
  it("forwards blocked_by to the shared policy", async () => {
    const project = createProject({ name: "UD-Bridge" });
    const caller = callerTask(project.id);
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const target = createSuggestedTask(project, { title: "Target", description: "" }).task!;

    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      taskId: caller.id,
      task: target.id,
      blocked_by: [blocker.id],
    });
    expect(res.status).toBe(200);
    expect(getTaskDeps(target.id)).toEqual([blocker.id]);
  });

  it("refuses a cycle with the reason the agent needs", async () => {
    const project = createProject({ name: "UD-BridgeCycle" });
    const caller = callerTask(project.id);
    const a = createSuggestedTask(project, { title: "A", description: "" }).task!;
    const b = createSuggestedTask(project, { title: "B", description: "" }).task!;
    setTaskDeps(b.id, [a.id]);

    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      taskId: caller.id,
      task: a.id,
      blocked_by: [b.id],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("cycle");
  });
});

describe("the project-context prompt asks for ordered plans", () => {
  it("tells the agent to express order with blocked_by, in two phases", () => {
    const project = createProject({ name: "UD-Prompt" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    const ctx = buildProjectContext(project, task);
    // The prompt is the only always-present place the model learns the tool's
    // shape, and it used to mention blocked_by exclusively as a restriction.
    expect(ctx).toContain("blocked_by");
    expect(ctx).toContain("update_task");
    expect(ctx.toLowerCase()).toContain("order");
  });
});
