import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createProject, createTask, deleteTask, getTask, getTaskDeps, setTaskDeps, updateTask } from "@/lib/store";
import {
  createSuggestedTask,
  getTaskForAgent,
  listTasksForAgent,
  registerExposedService,
  resolveTitleRefs,
  titleKey,
  updateOwnTask,
} from "@/lib/agentTools";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as exposeService } from "@/app/api/internal/agent-tools/expose-service/route";
import { POST as listTasksEp } from "@/app/api/internal/agent-tools/list-tasks/route";
import { POST as getTaskEp } from "@/app/api/internal/agent-tools/get-task/route";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";
import { instanceServiceTokenOk } from "@/lib/cf-access.mjs";

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("agentTools shared logic", () => {
  it("createSuggestedTask creates a suggested task with the given priority", () => {
    const project = createProject({ name: "Shared" });
    const { task, text } = createSuggestedTask(project, { title: "Do X", description: "the X", priority: "hi" });
    const row = getTask(task!.id)!;
    expect(row).toMatchObject({ title: "Do X", description: "the X", priority: "hi", suggested: 1, status: "not_started" });
    expect(text).toContain("Do X");
    expect(text).toContain(task!.id);
  });

  it("wires blocked_by deps and drops unknown/foreign ids without throwing", () => {
    const project = createProject({ name: "Deps" });
    const a = createSuggestedTask(project, { title: "A", description: "" }).task!;
    const b = createSuggestedTask(project, { title: "B", description: "", blocked_by: [a.id] });
    expect(getTaskDeps(b.task!.id)).toEqual([a.id]);
    expect(b.text).toContain("Blocked by 1 task(s).");

    // An unknown id is silently dropped by setTaskDeps — no throw, real dep kept.
    const other = createProject({ name: "Deps2" });
    const foreign = createSuggestedTask(other, { title: "Foreign", description: "" }).task!;
    const c = createSuggestedTask(project, { title: "C", description: "", blocked_by: [a.id, "ghost", foreign.id] });
    expect(getTaskDeps(c.task!.id)).toEqual([a.id]);
  });

  it("resolveTitleRefs maps session titles to ids and passes ids through", () => {
    // Entries are keyed by (project, title) — see crossProjectSuggest.test.ts
    // for why, and for the cross-project scoping this keying buys.
    const map = new Map<string, string>([[titleKey("proj-1", "First task"), "id-1"]]);
    expect(resolveTitleRefs(["First task", "id-2"], map, "proj-1")).toEqual(["id-1", "id-2"]);
    expect(resolveTitleRefs(undefined, map, "proj-1")).toEqual([]);
  });

  it("registerExposedService records the port and returns a URL + text", () => {
    const project = createProject({ name: "Svc" });
    const { info, url, text } = registerExposedService(project, "dev", 4321);
    expect(info.port).toBe(4321);
    expect(url).toBeTruthy();
    expect(text).toContain("4321");
    expect(text).toContain(url);
  });
});

describe("list_tasks / get_task (reads)", () => {
  it("lists the board, flags the caller's row, and hides finished work by default", () => {
    const project = createProject({ name: "Board" });
    const open = createTask({ project_id: project.id, title: "Open", description: "" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    const shut = createTask({ project_id: project.id, title: "Shut", description: "" });
    updateTask(shut.id, { status: "done" });
    setTaskDeps(mine.id, [open.id]);

    const rows = listTasksForAgent(project, mine.id);
    expect(rows.map((t) => t.title).sort()).toEqual(["Mine", "Open"]);
    expect(rows.find((t) => t.id === mine.id)).toMatchObject({ current: true, blocked_by: [open.id], suggested: false });
    expect(rows.find((t) => t.id === open.id)!.current).toBe(false);

    // include_done widens it to the whole board.
    expect(listTasksForAgent(project, mine.id, true).map((t) => t.title).sort()).toEqual(["Mine", "Open", "Shut"]);
  });

  it("always lists the caller's own row, even once it has closed itself", () => {
    const project = createProject({ name: "SelfDone" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    updateTask(mine.id, { status: "done" });
    // An agent that has just marked itself done must still see itself — the
    // terminal-status filter is about board noise, not about hiding the caller.
    expect(listTasksForAgent(project, mine.id).map((t) => t.id)).toEqual([mine.id]);
    expect(listTasksForAgent(project, "someone-else")).toEqual([]);
  });

  it("get_task returns the full brief with its blockers resolved to titles", () => {
    const project = createProject({ name: "Detail" });
    const blocker = createTask({ project_id: project.id, title: "First", description: "" });
    const task = createTask({ project_id: project.id, title: "Second", description: "the brief" });
    setTaskDeps(task.id, [blocker.id]);
    updateTask(blocker.id, { status: "done" });

    const detail = getTaskForAgent(task.id, task.id)!;
    expect(detail).toMatchObject({ title: "Second", description: "the brief", project_name: "Detail", current: true });
    expect(detail.blocked_by).toEqual([{ id: blocker.id, title: "First", status: "done", cleared: true }]);
    expect(getTaskForAgent("ghost", task.id)).toBeNull();
  });
});

describe("update_task (writes, scoped to the calling task)", () => {
  const own = (projectName: string) => {
    const project = createProject({ name: projectName });
    return createTask({ project_id: project.id, title: "Original", description: "old brief", priority: "med" });
  };

  it("retitles, reprioritizes and restates the task, reporting only what changed", () => {
    const task = own("Upd");
    const { task: updated, text } = updateOwnTask(task, { title: "  Renamed  ", priority: "hi", description: "new brief" });
    expect(getTask(task.id)).toMatchObject({ title: "Renamed", priority: "hi", description: "new brief" });
    expect(updated!.title).toBe("Renamed");
    expect(text).toContain('title → "Renamed"');
    expect(text).toContain("priority → hi");
    expect(text).toContain("description rewritten");
    // Untouched fields are left alone, not defaulted.
    expect(getTask(task.id)!.status).toBe("not_started");
  });

  it("refuses to cancel — it would abort the very turn making the call", () => {
    const task = own("NoCancel");
    const { task: updated, text } = updateOwnTask(task, { status: "cancelled" });
    expect(updated).toBeNull();
    expect(text).toContain("Nothing was changed");
    expect(getTask(task.id)!.status).toBe("not_started");
  });

  it("rejects an unknown status/priority and an empty title without writing", () => {
    const task = own("Invalid");
    for (const bad of [{ status: "shipped" as never }, { priority: "urgent" as never }, { title: "   " }]) {
      const { task: updated } = updateOwnTask(task, bad);
      expect(updated).toBeNull();
    }
    expect(getTask(task.id)).toMatchObject({ title: "Original", priority: "med", status: "not_started" });
  });

  it("re-reads the row before writing, so a task deleted mid-turn is a refusal", () => {
    // Turns run detached and the driver's MCP server closes over the task
    // snapshot taken at turn start — the row can vanish underneath it.
    const stale = own("Vanished");
    deleteTask(stale.id);
    const { task: updated, text } = updateOwnTask(stale, { title: "Too late" });
    expect(updated).toBeNull();
    expect(text).toContain("no longer exists");
  });

  it("reports a no-op instead of a spurious write when nothing differs", () => {
    const task = own("Noop");
    const before = getTask(task.id)!.updated_at;
    const { task: updated, text, autoStartDependents } = updateOwnTask(task, { title: "Original", priority: "med" });
    expect(updated!.id).toBe(task.id);
    expect(text).toContain("No change");
    expect(autoStartDependents).toBe(false);
    expect(getTask(task.id)!.updated_at).toBe(before);
  });

  it("signals auto-start only on the transition into done, and clears awaiting_input", () => {
    const task = own("Done");
    updateTask(task.id, { awaiting_input: 1 });
    const first = updateOwnTask(task, { status: "done" });
    expect(first.autoStartDependents).toBe(true);
    expect(getTask(task.id)).toMatchObject({ status: "done", awaiting_input: 0 });
    // Already done — no second launch of whatever was waiting on it.
    expect(updateOwnTask(task, { status: "done" }).autoStartDependents).toBe(false);
  });

  it("announces the edit on the global bus so other tabs refetch the row", () => {
    const task = own("Bus");
    const seen: { taskId: string; ev: BusEvent }[] = [];
    const unsub = subscribeGlobal((taskId, ev) => seen.push({ taskId, ev }));
    try {
      updateOwnTask(task, { title: "Announced" });
    } finally {
      unsub();
    }
    // task_edited, not task_updated: title/description/priority aren't on the
    // coarse wire payload, so listeners have to refetch rather than patch.
    expect(seen).toContainEqual({ taskId: task.id, ev: { type: "task_edited" } });
  });
});

describe("internal agent-tool endpoints", () => {
  it("suggest-task creates a task and returns its id + text", async () => {
    const project = createProject({ name: "EP-Suggest" });
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Endpoint task",
      description: "via HTTP",
      priority: "lo",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; text: string };
    expect(json.ok).toBe(true);
    expect(getTask(json.id)).toMatchObject({ title: "Endpoint task", priority: "lo", suggested: 1 });
    expect(json.text).toContain("Endpoint task");
  });

  it("suggest-task forwards resolved blocked_by ids to setTaskDeps", async () => {
    const project = createProject({ name: "EP-Deps" });
    const blocker = createSuggestedTask(project, { title: "Blocker", description: "" }).task!;
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: project.id,
      title: "Dependent",
      description: "",
      blocked_by: [blocker.id],
    });
    const json = (await res.json()) as { id: string };
    expect(getTaskDeps(json.id)).toEqual([blocker.id]);
  });

  it("suggest-task rejects an unknown project (404) and a missing title (400)", async () => {
    const bad = await post(suggestTask, "/api/internal/agent-tools/suggest-task", { projectId: "nope", title: "x" });
    expect(bad.status).toBe(404);
    const project = createProject({ name: "EP-Bad" });
    const noTitle = await post(suggestTask, "/api/internal/agent-tools/suggest-task", { projectId: project.id, title: "  " });
    expect(noTitle.status).toBe(400);
  });

  it("expose-service registers the service and returns the URL", async () => {
    const project = createProject({ name: "EP-Svc" });
    const res = await post(exposeService, "/api/internal/agent-tools/expose-service", {
      projectId: project.id,
      name: "api",
      port: 5555,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; name: string; url: string; text: string };
    expect(json.ok).toBe(true);
    expect(json.name).toBe("api");
    expect(json.url).toContain("5555");
    expect(json.text).toContain("5555");
  });

  it("list-tasks serves the session's own board and flags the calling task", async () => {
    const project = createProject({ name: "EP-List" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    createTask({ project_id: project.id, title: "Other", description: "" });
    const res = await post(listTasksEp, "/api/internal/agent-tools/list-tasks", { projectId: project.id, taskId: mine.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { project: string; tasks: { id: string; current: boolean }[] };
    expect(json.project).toBe("EP-List");
    expect(json.tasks).toHaveLength(2);
    expect(json.tasks.find((t) => t.id === mine.id)!.current).toBe(true);
  });

  it("list-tasks reads another project by name and refuses an unrecognized one (400)", async () => {
    const here = createProject({ name: "EP-Here" });
    const there = createProject({ name: "EP-There" });
    createTask({ project_id: there.id, title: "Theirs", description: "" });
    const ok = await post(listTasksEp, "/api/internal/agent-tools/list-tasks", { projectId: here.id, project: "ep-there" });
    const json = (await ok.json()) as { project: string; tasks: { title: string }[] };
    expect(json.project).toBe("EP-There");
    expect(json.tasks.map((t) => t.title)).toEqual(["Theirs"]);

    const bad = await post(listTasksEp, "/api/internal/agent-tools/list-tasks", { projectId: here.id, project: "nope" });
    expect(bad.status).toBe(400);
  });

  it("get-task defaults to the calling task and 404s an unknown id", async () => {
    const project = createProject({ name: "EP-Get" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "my brief" });
    const res = await post(getTaskEp, "/api/internal/agent-tools/get-task", { projectId: project.id, taskId: mine.id });
    const json = (await res.json()) as { task: { id: string; description: string; current: boolean } };
    expect(json.task).toMatchObject({ id: mine.id, description: "my brief", current: true });

    const miss = await post(getTaskEp, "/api/internal/agent-tools/get-task", { projectId: project.id, taskId: mine.id, task: "ghost" });
    expect(miss.status).toBe(404);
  });

  it("update-task writes the calling task and ignores any other id the model sends", async () => {
    const project = createProject({ name: "EP-Update" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    const theirs = createTask({ project_id: project.id, title: "Theirs", description: "" });
    // `task`/`id` are not part of the endpoint's contract — the target is
    // ORCH_TASK_ID, injected into the bridge's env, and nothing else.
    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      projectId: project.id,
      taskId: mine.id,
      task: theirs.id,
      id: theirs.id,
      title: "Renamed",
      status: "in_progress",
    });
    expect(res.status).toBe(200);
    expect(getTask(mine.id)).toMatchObject({ title: "Renamed", status: "in_progress" });
    expect(getTask(theirs.id)).toMatchObject({ title: "Theirs", status: "not_started" });
  });

  it("update-task rejects cancelling (400) and an unknown task (404)", async () => {
    const project = createProject({ name: "EP-UpdateBad" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    const cancel = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      projectId: project.id,
      taskId: mine.id,
      status: "cancelled",
    });
    expect(cancel.status).toBe(400);
    expect(getTask(mine.id)!.status).toBe("not_started");

    const ghost = await post(updateTaskEp, "/api/internal/agent-tools/update-task", { projectId: project.id, taskId: "ghost", title: "x" });
    expect(ghost.status).toBe(404);
  });

  it("expose-service rejects a non-positive / non-integer port (400)", async () => {
    const project = createProject({ name: "EP-Port" });
    for (const port of [0, -3, 1.5, "abc"]) {
      const res = await post(exposeService, "/api/internal/agent-tools/expose-service", {
        projectId: project.id,
        name: "x",
        port,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("instance service token gate", () => {
  it("accepts the exact SERVICE_TOKEN and rejects the fleet token / empties", () => {
    const prev = process.env.SERVICE_TOKEN;
    const prevFleet = process.env.ORCH_FLEET_TOKEN;
    process.env.SERVICE_TOKEN = "secret-instance";
    process.env.ORCH_FLEET_TOKEN = "fleet-wide";
    try {
      expect(instanceServiceTokenOk("secret-instance")).toBe(true);
      // The read-only fleet token must NOT open the mutating endpoints.
      expect(instanceServiceTokenOk("fleet-wide")).toBe(false);
      expect(instanceServiceTokenOk("")).toBe(false);
      expect(instanceServiceTokenOk(null)).toBe(false);
    } finally {
      process.env.SERVICE_TOKEN = prev;
      process.env.ORCH_FLEET_TOKEN = prevFleet;
    }
  });
});
