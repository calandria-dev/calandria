// update_task accepting `blocked_by` after a task already exists, so a
// planning turn can file its tasks first and wire their order in a second
// phase. Pinned here:
//   - it replaces the dep set, the way the Edit dialog's DepPicker does, and []
//     clears it;
//   - refs are partitioned and reported exactly as suggest_task's are, since the
//     same project-scoping rule applies;
//   - a cycle refuses the whole call, with no half-applied title/priority left
//     over;
//   - the caller's own row is refused: blockers gate starting, and a session
//     calling this has already started, so the refusal names `on_hold`;
//   - the cross-task write boundary is unchanged: only an inert tray
//     suggestion is freely writable.
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

/** A running session's own task: the trusted `caller` every tool call carries. */
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
    // Fail-closed, unlike suggest_task, which partitions and reports.
    // suggest_task fills in a blank set on a newly invented task; this
    // replaces an existing one. Keeping the refs that resolved and dropping
    // the rest would delete edges the agent never mentioned while still
    // reporting success.
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
    // Each bad ref is named with the reason it failed. The fix differs per
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

  it("still refuses a target with a live turn streaming in it", () => {
    // A target with a live turn streaming in it is still refused: a turn may
    // be mid-way through reading the very fields this call would rewrite.
    const project = createProject({ name: "UD-Boundary" });
    const caller = callerTask(project.id);
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const theirs = callerTask(project.id, "Someone else's live task");

    const { task, text } = updateTaskForAgent(caller, theirs.id, { blocked_by: [blocker.id] });
    expect(task).toBeNull();
    expect(getTaskDeps(theirs.id)).toEqual([]);
    expect(text).toContain("streaming");
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
    // shape.
    expect(ctx).toContain("blocked_by");
    expect(ctx).toContain("update_task");
    expect(ctx.toLowerCase()).toContain("order");
  });
});
