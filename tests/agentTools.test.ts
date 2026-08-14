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
  updateTaskForAgent,
  withdrawSuggestionForAgent,
} from "@/lib/agentTools";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as exposeService } from "@/app/api/internal/agent-tools/expose-service/route";
import { POST as listTasksEp } from "@/app/api/internal/agent-tools/list-tasks/route";
import { POST as getTaskEp } from "@/app/api/internal/agent-tools/get-task/route";
import { POST as updateTaskEp } from "@/app/api/internal/agent-tools/update-task/route";
import { POST as withdrawEp } from "@/app/api/internal/agent-tools/withdraw-suggestion/route";
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
    const { task: updated, text } = updateTaskForAgent(task, undefined,{ title: "  Renamed  ", priority: "hi", description: "new brief" });
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
    const { task: updated, text } = updateTaskForAgent(task, undefined,{ status: "cancelled" });
    expect(updated).toBeNull();
    expect(text).toContain("Nothing was changed");
    expect(getTask(task.id)!.status).toBe("not_started");
  });

  it("rejects an unknown status/priority and an empty title without writing", () => {
    const task = own("Invalid");
    for (const bad of [{ status: "shipped" as never }, { priority: "urgent" as never }, { title: "   " }]) {
      const { task: updated } = updateTaskForAgent(task, undefined,bad);
      expect(updated).toBeNull();
    }
    expect(getTask(task.id)).toMatchObject({ title: "Original", priority: "med", status: "not_started" });
  });

  it("re-reads the row before writing, so a task deleted mid-turn is a refusal", () => {
    // Turns run detached and the driver's MCP server closes over the task
    // snapshot taken at turn start — the row can vanish underneath it.
    const stale = own("Vanished");
    deleteTask(stale.id);
    const { task: updated, text } = updateTaskForAgent(stale, undefined, { title: "Too late" });
    expect(updated).toBeNull();
    expect(text).toContain("no longer exists");
  });

  it("reports a no-op instead of a spurious write when nothing differs", () => {
    const task = own("Noop");
    const before = getTask(task.id)!.updated_at;
    const { task: updated, text, autoStartDependents } = updateTaskForAgent(task, undefined,{ title: "Original", priority: "med" });
    expect(updated!.id).toBe(task.id);
    expect(text).toContain("No change");
    expect(autoStartDependents).toBe(false);
    expect(getTask(task.id)!.updated_at).toBe(before);
  });

  it("signals auto-start only on the transition into done, and clears awaiting_input", () => {
    const task = own("Done");
    updateTask(task.id, { awaiting_input: 1 });
    const first = updateTaskForAgent(task, undefined,{ status: "done" });
    expect(first.autoStartDependents).toBe(true);
    expect(getTask(task.id)).toMatchObject({ status: "done", awaiting_input: 0 });
    // Already done — no second launch of whatever was waiting on it.
    expect(updateTaskForAgent(task, undefined,{ status: "done" }).autoStartDependents).toBe(false);
  });

  it("announces the edit on the global bus so other tabs refetch the row", () => {
    const task = own("Bus");
    const seen: { taskId: string; ev: BusEvent }[] = [];
    const unsub = subscribeGlobal((taskId, ev) => seen.push({ taskId, ev }));
    try {
      updateTaskForAgent(task, undefined,{ title: "Announced" });
    } finally {
      unsub();
    }
    // task_edited, not task_updated: title/description/priority aren't on the
    // coarse wire payload, so listeners have to refetch rather than patch.
    expect(seen).toContainEqual({ taskId: task.id, ev: { type: "task_edited" } });
  });

  it("treats an explicit self-reference exactly like omitting the target", () => {
    const task = own("Self");
    const { task: updated } = updateTaskForAgent(task, task.id, { status: "in_progress" });
    expect(updated!.status).toBe("in_progress");
  });
});

describe("update_task (writes to another row, scoped to inert tray suggestions)", () => {
  // The caller and an inert suggestion sharing a board. `suggested=1` is the
  // whole eligibility story: starting a task clears it in the same write, so a
  // suggestion has no session, no worktree and no turn that could be running.
  const board = (name: string) => {
    const project = createProject({ name });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    const { task: inert } = createSuggestedTask(project, { title: "Proposed", description: "old brief", priority: "med" });
    return { project, caller, inert: inert! };
  };

  it("edits an inert suggestion's title, description, priority and status", () => {
    const { caller, inert } = board("Foreign-Ok");
    const { task: updated, text } = updateTaskForAgent(caller, inert.id, {
      title: "Sharpened",
      description: "new brief",
      priority: "hi",
      status: "on_hold",
    });
    expect(updated!.id).toBe(inert.id);
    expect(getTask(inert.id)).toMatchObject({ title: "Sharpened", description: "new brief", priority: "hi", status: "on_hold" });
    expect(text).toContain("Sharpened");
    // The caller's own row is untouched — the write went where it was aimed.
    expect(getTask(caller.id)).toMatchObject({ title: "Caller", status: "not_started" });
  });

  it("edits an inert suggestion in ANOTHER project — writes range as widely as suggest_task files", () => {
    const { caller } = board("Foreign-Here");
    const there = createProject({ name: "Foreign-There" });
    const theirs = createSuggestedTask(there, { title: "Theirs", description: "" }).task!;
    const { task: updated } = updateTaskForAgent(caller, theirs.id, { priority: "lo" });
    expect(updated!.id).toBe(theirs.id);
    expect(getTask(theirs.id)!.priority).toBe("lo");
  });

  it("refuses a STARTED task — another session owns it", () => {
    const { caller, inert } = board("Foreign-Started");
    // What starting a suggestion does (POST /api/tasks/[id]/messages).
    updateTask(inert.id, { suggested: 0, started: 1 });
    const { task: updated, text } = updateTaskForAgent(caller, inert.id, { title: "Hijacked" });
    expect(updated).toBeNull();
    expect(text).toContain("Nothing was changed");
    expect(getTask(inert.id)!.title).toBe("Proposed");
  });

  it("refuses a RUNNING task even if it somehow still reads as a suggestion", () => {
    const { caller, inert } = board("Foreign-Running");
    updateTask(inert.id, { running: 1 });
    const { task: updated } = updateTaskForAgent(caller, inert.id, { title: "Hijacked" });
    expect(updated).toBeNull();
    expect(getTask(inert.id)!.title).toBe("Proposed");
  });

  it("refuses an accepted (no longer suggested) task that never started", () => {
    // "Add" in the tray clears `suggested` without starting anything. The row is
    // still inert, but the user has adopted it — it's their backlog item now.
    const { caller, inert } = board("Foreign-Accepted");
    updateTask(inert.id, { suggested: 0 });
    const { task: updated } = updateTaskForAgent(caller, inert.id, { title: "Hijacked" });
    expect(updated).toBeNull();
    expect(getTask(inert.id)!.title).toBe("Proposed");
  });

  it("refuses to cancel another row, exactly as it refuses to cancel its own", () => {
    const { caller, inert } = board("Foreign-Cancel");
    const { task: updated, text } = updateTaskForAgent(caller, inert.id, { status: "cancelled" });
    expect(updated).toBeNull();
    expect(text).toContain("Nothing was changed");
    expect(getTask(inert.id)!.status).toBe("not_started");
  });

  it("refuses an unknown id and points at list_tasks", () => {
    const { caller } = board("Foreign-Ghost");
    const { task: updated, text } = updateTaskForAgent(caller, "ghost", { title: "x" });
    expect(updated).toBeNull();
    expect(text).toContain("list_tasks");
  });

  it("announces the edit against the TARGET's id, not the caller's", () => {
    const { caller, inert } = board("Foreign-Bus");
    const seen: { taskId: string; ev: BusEvent }[] = [];
    const unsub = subscribeGlobal((taskId, ev) => seen.push({ taskId, ev }));
    try {
      updateTaskForAgent(caller, inert.id, { title: "Announced" });
    } finally {
      unsub();
    }
    expect(seen).toContainEqual({ taskId: inert.id, ev: { type: "task_edited" } });
    expect(seen.some((s) => s.taskId === caller.id)).toBe(false);
  });

  it("signals auto-start when a foreign suggestion is marked done", () => {
    // The flag rides the target, so the caller fires the sweep for the right row.
    const { caller, inert } = board("Foreign-Done");
    const { task: updated, autoStartDependents } = updateTaskForAgent(caller, inert.id, { status: "done" });
    expect(updated!.id).toBe(inert.id);
    expect(autoStartDependents).toBe(true);
  });
});

describe("withdraw_suggestion (retracting a tray suggestion)", () => {
  const board = (name: string) => {
    const project = createProject({ name });
    const caller = createTask({ project_id: project.id, title: "Caller", description: "" });
    // The caller is a live session — that's what makes its own row ineligible.
    updateTask(caller.id, { started: 1, running: 1 });
    const { task: inert } = createSuggestedTask(project, { title: "Proposed", description: "old brief", priority: "med" });
    return { project, caller, inert: inert! };
  };

  it("cancels the suggestion but LEAVES it in the tray, with the reason on the row", () => {
    const { caller, inert } = board("Wd-Ok");
    const { task: updated, text } = withdrawSuggestionForAgent(caller, inert.id, "  already covered by the parser rewrite  ");
    expect(updated!.id).toBe(inert.id);
    const row = getTask(inert.id)!;
    // Cancelled, but still `suggested` — that flag is what keeps the card in
    // the tray for the user to revive or dismiss. Not a delete: the tray's own
    // Dismiss button is the hard delete, and this app has no undo for that.
    expect(row).toMatchObject({ status: "cancelled", suggested: 1, withdrawn_reason: "already covered by the parser rewrite" });
    // The brief is untouched — a revived suggestion has to still say what it was for.
    expect(row.description).toBe("old brief");
    expect(text).toContain("Suggested tray");
  });

  it("requires a reason, and refuses a blank one without touching the row", () => {
    const { caller, inert } = board("Wd-NoReason");
    for (const reason of ["", "   "]) {
      const { task: updated, text } = withdrawSuggestionForAgent(caller, inert.id, reason);
      expect(updated).toBeNull();
      expect(text).toContain("`reason` is required");
      expect(getTask(inert.id)).toMatchObject({ status: "not_started", suggested: 1, withdrawn_reason: "" });
    }
  });

  it("requires a target — there is no 'my own row' default", () => {
    const { caller } = board("Wd-NoTarget");
    const { task: updated, text } = withdrawSuggestionForAgent(caller, undefined, "redundant");
    expect(updated).toBeNull();
    expect(text).toContain("`task` is required");
  });

  it("refuses the caller's own row, which is never an inert suggestion anyway", () => {
    const { caller } = board("Wd-Self");
    const { task: updated, text } = withdrawSuggestionForAgent(caller, caller.id, "redundant");
    expect(updated).toBeNull();
    expect(text).toContain("this session is running in");
    expect(getTask(caller.id)!.status).toBe("not_started");
  });

  // The eligibility screen is update_task's, shared (isInertSuggestion) so the
  // two tools can never disagree about which rows an agent may write.
  it.each([
    ["a STARTED task", { suggested: 0, started: 1 } as const],
    ["a RUNNING task", { running: 1 } as const],
    ["an accepted (no longer suggested) task", { suggested: 0 } as const],
  ])("refuses %s with the row unchanged", (_label, patch) => {
    const { caller, inert } = board(`Wd-${_label.replace(/\W/g, "")}`);
    updateTask(inert.id, patch);
    const before = getTask(inert.id)!;
    const { task: updated, text } = withdrawSuggestionForAgent(caller, inert.id, "redundant");
    expect(updated).toBeNull();
    expect(text).toContain("Nothing was changed");
    expect(getTask(inert.id)).toMatchObject({ status: before.status, suggested: before.suggested, withdrawn_reason: "" });
  });

  it("refuses an unknown id and points at list_tasks", () => {
    const { caller } = board("Wd-Ghost");
    const { task: updated, text } = withdrawSuggestionForAgent(caller, "ghost", "redundant");
    expect(updated).toBeNull();
    expect(text).toContain("list_tasks");
  });

  it("is idempotent: withdrawing twice keeps the first reason", () => {
    const { caller, inert } = board("Wd-Twice");
    withdrawSuggestionForAgent(caller, inert.id, "first reason");
    const { task: again, text } = withdrawSuggestionForAgent(caller, inert.id, "second reason");
    expect(again!.withdrawn_reason).toBe("first reason");
    expect(text).toContain("already withdrawn");
  });

  it("announces task_edited against the TARGET, so other tabs refetch the row", () => {
    // task_edited, not task_updated: withdrawn_reason can't ride the coarse
    // /api/events payload, so listeners have to refetch to draw the card at all.
    const { caller, inert } = board("Wd-Bus");
    const seen: { taskId: string; ev: BusEvent }[] = [];
    const unsub = subscribeGlobal((taskId, ev) => seen.push({ taskId, ev }));
    try {
      withdrawSuggestionForAgent(caller, inert.id, "redundant");
    } finally {
      unsub();
    }
    expect(seen).toContainEqual({ taskId: inert.id, ev: { type: "task_edited" } });
    expect(seen.some((s) => s.taskId === caller.id)).toBe(false);
  });

  it("signals auto-start: cancelling a blocker clears it, so dependents must not strand", () => {
    // The whole hazard the tool has to avoid creating. blocks() treats cancelled
    // as terminal, so the dependent IS unblocked — if no sweep fires it sits
    // unblocked-but-never-launched forever.
    const { caller, inert } = board("Wd-AutoStart");
    const { task: updated, autoStartDependents } = withdrawSuggestionForAgent(caller, inert.id, "redundant");
    expect(updated!.id).toBe(inert.id);
    expect(autoStartDependents).toBe(true);
  });

  it("the endpoint runs the same policy, and refuses with 400 + the reason text", async () => {
    const project = createProject({ name: "EP-Withdraw" });
    const caller = createTask({ project_id: project.id, title: "Caller" });
    const inert = createSuggestedTask(project, { title: "Proposed", description: "brief" }).task!;

    const bad = await post(withdrawEp, "/api/internal/agent-tools/withdraw-suggestion", {
      taskId: caller.id,
      task: inert.id,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("`reason` is required");
    expect(getTask(inert.id)!.status).toBe("not_started");

    const res = await post(withdrawEp, "/api/internal/agent-tools/withdraw-suggestion", {
      taskId: caller.id,
      task: inert.id,
      reason: "superseded by the parser rewrite",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; status: string };
    expect(json).toMatchObject({ ok: true, id: inert.id, status: "cancelled" });
    expect(getTask(inert.id)).toMatchObject({ suggested: 1, withdrawn_reason: "superseded by the parser rewrite" });
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

  it("update-task defaults to the calling task when the model names no target", async () => {
    const project = createProject({ name: "EP-Update" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    const theirs = createTask({ project_id: project.id, title: "Theirs", description: "" });
    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      projectId: project.id,
      taskId: mine.id,
      title: "Renamed",
      status: "in_progress",
    });
    expect(res.status).toBe(200);
    expect(getTask(mine.id)).toMatchObject({ title: "Renamed", status: "in_progress" });
    expect(getTask(theirs.id)).toMatchObject({ title: "Theirs", status: "not_started" });
  });

  it("update-task honours a model-named inert suggestion but never lets it become the CALLER", async () => {
    const project = createProject({ name: "EP-Update-Target" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    const inert = createSuggestedTask(project, { title: "Proposed", description: "" }).task!;
    // `taskId` is the trusted, env-injected caller identity; `task` is the
    // untrusted target the MODEL chose. Only the latter may be aimed elsewhere.
    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      projectId: project.id,
      taskId: mine.id,
      task: inert.id,
      title: "Sharpened",
    });
    expect(res.status).toBe(200);
    expect(getTask(inert.id)!.title).toBe("Sharpened");
    expect(getTask(mine.id)!.title).toBe("Mine");
  });

  it("update-task refuses (400) a model-named target another session owns", async () => {
    const project = createProject({ name: "EP-Update-Live" });
    const mine = createTask({ project_id: project.id, title: "Mine", description: "" });
    const live = createTask({ project_id: project.id, title: "Live", description: "" });
    updateTask(live.id, { started: 1, running: 1 });
    const res = await post(updateTaskEp, "/api/internal/agent-tools/update-task", {
      projectId: project.id,
      taskId: mine.id,
      task: live.id,
      title: "Hijacked",
      status: "done",
    });
    expect(res.status).toBe(400);
    expect(getTask(live.id)).toMatchObject({ title: "Live", status: "not_started" });
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
