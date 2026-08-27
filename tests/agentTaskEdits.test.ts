// The "changed since you accepted it" audit trail: what update_task now
// records when it writes to a row the OLD ownership gate would have refused
// (see the block comment above updateTaskForAgent in lib/agentTools.ts). The
// recording rule is precise on purpose — only a write the old policy would
// have refused counts, so an edit to the caller's own row or to an unreviewed
// tray suggestion (both always allowed) leaves no trace and no chip.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createTag, createProject, createTask, deleteTag, getTask, getTaskDeps, getTaskTagIds, listAgentEdits, setTaskDeps, updateTask } from "@/lib/store";
import { createSuggestedTask, updateTaskForAgent } from "@/lib/agentTools";
import { GET as agentEditsGet, POST as agentEditsPost } from "@/app/api/tasks/[id]/agent-edits/route";
import type { TaskAgentEdit } from "@/lib/types";

function getEdits(id: string) {
  return agentEditsGet(new NextRequest(`http://127.0.0.1:3000/api/tasks/${id}/agent-edits`), { params: Promise.resolve({ id }) });
}

function postEdits(id: string, body: unknown) {
  return agentEditsPost(
    new NextRequest(`http://127.0.0.1:3000/api/tasks/${id}/agent-edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

/** A task the user has already accepted: not a tray suggestion, started, not running. */
function accepted(projectId: string, title = "Accepted") {
  const t = createTask({ project_id: projectId, title, description: "old", priority: "med" });
  return updateTask(t.id, { suggested: 0, started: 1, running: 0 })!;
}

describe("update_task records an edit exactly when the old ownership gate would have refused it", () => {
  it("edits an ACCEPTED task in another project and records one edit naming the fields that moved", () => {
    const project = createProject({ name: "Edits-Basic" });
    const other = createProject({ name: "Edits-Basic-Other" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(other.id);

    const { task, text } = updateTaskForAgent(caller, target.id, { title: "Renamed", priority: "hi" });
    expect(task).not.toBeNull();
    expect(getTask(target.id)).toMatchObject({ title: "Renamed", priority: "hi" });

    const edits = listAgentEdits(target.id);
    expect(edits).toHaveLength(1);
    expect(edits[0].changes.map((c) => c.field).sort()).toEqual(["priority", "title"]);
    expect(edits[0].actor_task_id).toBe(caller.id);
    expect(edits[0].project_id).toBe(other.id);
    // The chip: 0 until a write like this one raises it.
    expect(getTask(target.id)!.agent_edited_at).toBeGreaterThan(0);
    expect(text).toContain("flagged as changed");
  });

  it("refuses a RUNNING task that isn't the caller's own row, writes nothing, and records nothing", () => {
    const project = createProject({ name: "Edits-Running" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = createTask({ project_id: project.id, title: "Live", description: "" });
    updateTask(target.id, { running: 1 });

    const { task, text } = updateTaskForAgent(caller, target.id, { title: "Hijacked" });
    expect(task).toBeNull();
    expect(text).toContain("streaming");
    expect(getTask(target.id)!.title).toBe("Live");
    expect(listAgentEdits(target.id)).toHaveLength(0);
    expect(getTask(target.id)!.agent_edited_at).toBe(0);
  });

  it("edits an inert tray suggestion and records NOTHING — that write was always allowed", () => {
    const project = createProject({ name: "Edits-Inert" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const inert = createSuggestedTask(project, { title: "Proposed", description: "" }).task!;

    const { task } = updateTaskForAgent(caller, inert.id, { title: "Sharpened" });
    expect(task!.title).toBe("Sharpened");
    expect(listAgentEdits(inert.id)).toHaveLength(0);
    expect(getTask(inert.id)!.agent_edited_at).toBe(0);
  });

  it("edits the caller's OWN row and records NOTHING", () => {
    const project = createProject({ name: "Edits-Own" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });

    updateTaskForAgent(caller, undefined, { title: "Renamed" });
    expect(getTask(caller.id)!.title).toBe("Renamed");
    expect(listAgentEdits(caller.id)).toHaveLength(0);
    expect(getTask(caller.id)!.agent_edited_at).toBe(0);
  });
});

describe("GET /api/tasks/[id]/agent-edits", () => {
  it("lists an accepted task's edit history, newest first, and 404s an unknown task", async () => {
    const project = createProject({ name: "Edits-Get" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(project.id, "T");
    updateTaskForAgent(caller, target.id, { title: "Renamed" });

    const res = await getEdits(target.id);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { edits: TaskAgentEdit[] };
    expect(json.edits).toHaveLength(1);
    expect(json.edits[0].changes[0]).toMatchObject({ field: "title", after: "Renamed" });

    expect((await getEdits("ghost")).status).toBe(404);
  });
});

describe("POST /api/tasks/[id]/agent-edits — revert and ack", () => {
  it("revert restores title, description, priority and status", async () => {
    const project = createProject({ name: "Edits-Revert-Scalar" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(project.id, "Original");

    updateTaskForAgent(caller, target.id, {
      title: "Renamed",
      description: "new brief",
      priority: "hi",
      status: "in_progress",
    });
    const edit = listAgentEdits(target.id)[0];

    const res = await postEdits(target.id, { action: "revert", edit_id: edit.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { task: { title: string; description: string; priority: string; status: string }; edits: TaskAgentEdit[] };
    expect(json.task).toMatchObject({ title: "Original", description: "old", priority: "med", status: "not_started" });
    expect(getTask(target.id)).toMatchObject({ title: "Original", description: "old", priority: "med", status: "not_started" });
    // The one outstanding edit was just reverted — the chip clears with it.
    expect(getTask(target.id)!.agent_edited_at).toBe(0);
    expect(json.edits[0].reverted_at).toBeGreaterThan(0);
  });

  it("revert restores blocked_by and tag membership", async () => {
    const project = createProject({ name: "Edits-Revert-Deps" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const b = createTask({ project_id: project.id, title: "B", description: "" });
    const c = createTask({ project_id: project.id, title: "C", description: "" });
    const tagA = createTag({ project_id: project.id, name: "Tag A" });
    const tagB = createTag({ project_id: project.id, name: "Tag B" });
    const target = createTask({ project_id: project.id, title: "Target", description: "", tag_ids: [tagA.id] });
    updateTask(target.id, { suggested: 0, started: 1 });
    setTaskDeps(target.id, [b.id]);

    updateTaskForAgent(caller, target.id, { blocked_by: [c.id], tags: [tagB.id] });
    expect(getTaskDeps(target.id)).toEqual([c.id]);
    expect(getTaskTagIds(target.id)).toEqual([tagB.id]);

    const edit = listAgentEdits(target.id)[0];
    const res = await postEdits(target.id, { action: "revert", edit_id: edit.id });
    expect(res.status).toBe(200);
    expect(getTaskDeps(target.id)).toEqual([b.id]);
    expect(getTaskTagIds(target.id)).toEqual([tagA.id]);
  });

  it("revert drops a tag that was deleted since the edit, rather than refusing", async () => {
    const project = createProject({ name: "Edits-Revert-DeletedTag" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const tagA = createTag({ project_id: project.id, name: "Tag A" });
    const tagB = createTag({ project_id: project.id, name: "Tag B" });
    const target = createTask({ project_id: project.id, title: "Target", description: "", tag_ids: [tagA.id] });
    updateTask(target.id, { suggested: 0, started: 1 });

    updateTaskForAgent(caller, target.id, { tags: [tagB.id] });
    expect(getTaskTagIds(target.id)).toEqual([tagB.id]);
    const edit = listAgentEdits(target.id)[0];

    // tagA — the one the revert would restore — is gone by the time it runs.
    deleteTag(tagA.id);

    const res = await postEdits(target.id, { action: "revert", edit_id: edit.id });
    expect(res.status).toBe(200);
    expect(getTaskTagIds(target.id)).toEqual([]);
  });

  it("reverting the only outstanding edit clears agent_edited_at; ack clears it without reverting", async () => {
    const project = createProject({ name: "Edits-Chip" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });

    const target1 = accepted(project.id, "T1");
    updateTaskForAgent(caller, target1.id, { title: "T1-renamed" });
    expect(getTask(target1.id)!.agent_edited_at).toBeGreaterThan(0);
    const edit1 = listAgentEdits(target1.id)[0];
    const revertRes = await postEdits(target1.id, { action: "revert", edit_id: edit1.id });
    expect(revertRes.status).toBe(200);
    expect(getTask(target1.id)!.agent_edited_at).toBe(0);
    expect(getTask(target1.id)!.title).toBe("T1");

    const target2 = accepted(project.id, "T2");
    updateTaskForAgent(caller, target2.id, { title: "T2-renamed" });
    expect(getTask(target2.id)!.agent_edited_at).toBeGreaterThan(0);
    const ackRes = await postEdits(target2.id, { action: "ack" });
    expect(ackRes.status).toBe(200);
    expect(getTask(target2.id)!.agent_edited_at).toBe(0);
    // Ack doesn't revert — the agent's write stands.
    expect(getTask(target2.id)!.title).toBe("T2-renamed");
    // History is untouched: the edit is still there, still unreverted.
    const edits2 = listAgentEdits(target2.id);
    expect(edits2).toHaveLength(1);
    expect(edits2[0].reverted_at).toBe(0);
  });

  it("refuses (409) to revert a field the user has changed since, and leaves the row alone", async () => {
    const project = createProject({ name: "Edits-Stale" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(project.id, "A");
    updateTaskForAgent(caller, target.id, { title: "B", priority: "hi" });
    const edit = listAgentEdits(target.id)[0];
    // The user renames it themselves without acking the chip…
    updateTask(target.id, { title: "C" });
    const res = await postEdits(target.id, { action: "revert", edit_id: edit.id });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('title is now "C"');
    // …and nothing moved: not the title, not the priority the same edit carried.
    expect(getTask(target.id)).toMatchObject({ title: "C", priority: "hi" });
    expect(listAgentEdits(target.id)[0].reverted_at).toBe(0);
  });

  it("stacked edits on one field revert newest-first to the original, and refuse oldest-first", async () => {
    const project = createProject({ name: "Edits-Stack" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(project.id, "A");
    updateTaskForAgent(caller, target.id, { title: "B" });
    updateTaskForAgent(caller, target.id, { title: "C" });
    const [newer, older] = listAgentEdits(target.id);
    expect(older.changes[0].after).toBe("B");
    // Oldest first: B is no longer what the row holds, so this would land on
    // A with C's edit still marked applied.
    expect((await postEdits(target.id, { action: "revert", edit_id: older.id })).status).toBe(409);
    expect(getTask(target.id)!.title).toBe("C");
    // Newest first walks the stack back.
    expect((await postEdits(target.id, { action: "revert", edit_id: newer.id })).status).toBe(200);
    expect(getTask(target.id)!.title).toBe("B");
    expect((await postEdits(target.id, { action: "revert", edit_id: older.id })).status).toBe(200);
    expect(getTask(target.id)!.title).toBe("A");
    expect(getTask(target.id)!.agent_edited_at).toBe(0);
  });

  it("an acked edit no longer counts as outstanding, so reverting a later edit clears the chip", async () => {
    const project = createProject({ name: "Edits-AckThenRevert" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(project.id, "A");
    updateTaskForAgent(caller, target.id, { title: "B" });
    expect((await postEdits(target.id, { action: "ack" })).status).toBe(200);
    expect(listAgentEdits(target.id)[0].acknowledged_at).toBeGreaterThan(0);
    expect(getTask(target.id)!.agent_edited_at).toBe(0);
    // A fresh edit re-raises the chip…
    updateTaskForAgent(caller, target.id, { priority: "hi" });
    expect(getTask(target.id)!.agent_edited_at).toBeGreaterThan(0);
    const latest = listAgentEdits(target.id)[0];
    // …and reverting it alone clears the chip: the acked row is not outstanding.
    expect((await postEdits(target.id, { action: "revert", edit_id: latest.id })).status).toBe(200);
    expect(getTask(target.id)!.agent_edited_at).toBe(0);
    expect(getTask(target.id)).toMatchObject({ title: "B", priority: "med" });
  });

  it("refuses an unknown edit id (404), one from another task (400), and a double revert (400)", async () => {
    const project = createProject({ name: "Edits-Refuse" });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const target = accepted(project.id, "T");
    const other = accepted(project.id, "Other");
    updateTaskForAgent(caller, target.id, { title: "Renamed" });
    const edit = listAgentEdits(target.id)[0];

    expect((await postEdits(target.id, { action: "revert", edit_id: "ghost" })).status).toBe(404);
    expect((await postEdits(other.id, { action: "revert", edit_id: edit.id })).status).toBe(400);

    const first = await postEdits(target.id, { action: "revert", edit_id: edit.id });
    expect(first.status).toBe(200);
    const second = await postEdits(target.id, { action: "revert", edit_id: edit.id });
    expect(second.status).toBe(400);
  });
});
