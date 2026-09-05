// Filing a suggested task into a project other than the one the session runs in.
//
// The agent discovers targets with `list_projects` and names one via
// suggest_task's optional `project` param. This pins the rules that make a
// cross-project suggestion safe, not just possible:
//   - resolution is strict (id, else case-insensitive name, else refuse): a
//     misfiled task is worse than a refusal, so there is no fallback to the
//     calling project;
//   - every default (agent, send_context, board position) comes from the
//     target project, or the task lands unrunnable;
//   - `blocked_by` is project-scoped in setTaskDeps, so refs must resolve
//     inside the target; refs that don't are reported, not dropped;
//   - the live-UI fan-out names the target project, or the receiving tray
//     never refreshes.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createProject, updateProject, deleteProject, createTask, getTask, getTaskDeps, getProject, listProjects, countAwaiting } from "@/lib/store";
import {
  createSuggestedTask,
  listProjectsForAgent,
  rememberSuggestedTitle,
  resolveTargetProject,
  resolveTitleRefs,
  titleKey,
} from "@/lib/agentTools";
import { POST as suggestTask } from "@/app/api/internal/agent-tools/suggest-task/route";
import { POST as listProjectsTool } from "@/app/api/internal/agent-tools/list-projects/route";
import { GET as eventsRoute } from "@/app/api/events/route";
import { publish, subscribeGlobal, type BusEvent } from "@/lib/events";

function post(handler: (req: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("resolveTargetProject", () => {
  it("returns the calling project when no ref is given", () => {
    const here = createProject({ name: "RTP-Here" });
    expect(resolveTargetProject(here, undefined)).toEqual({ project: getProject(here.id) });
    // An empty / whitespace ref means "unspecified" too, not "a project named ''".
    expect(resolveTargetProject(here, "   ")).toEqual({ project: getProject(here.id) });
  });

  it("matches an exact project id", () => {
    const here = createProject({ name: "RTP-A" });
    const there = createProject({ name: "RTP-B" });
    const got = resolveTargetProject(here, there.id);
    expect(got).toEqual({ project: getProject(there.id) });
  });

  it("matches a project name case-insensitively", () => {
    const here = createProject({ name: "RTP-Caller" });
    const there = createProject({ name: "Calandria" });
    expect(resolveTargetProject(here, "calandria")).toEqual({ project: getProject(there.id) });
    expect(resolveTargetProject(here, "  CALANDRIA  ")).toEqual({ project: getProject(there.id) });
  });

  it("prefers an id over a name that collides with it", () => {
    const here = createProject({ name: "RTP-Collide" });
    const byName = createProject({ name: "collision-target" });
    // A second project literally NAMED the first one's id: the id wins.
    const byId = createProject({ name: byName.id });
    const got = resolveTargetProject(here, byName.id);
    expect(got).toEqual({ project: getProject(byName.id) });
    expect(got).not.toEqual({ project: getProject(byId.id) });
  });

  it("refuses an unrecognized ref and lists the valid names instead of guessing", () => {
    const here = createProject({ name: "RTP-Strict" });
    const got = resolveTargetProject(here, "not-a-project");
    expect("project" in got).toBe(false);
    const err = (got as { error: string }).error;
    expect(err).toContain("not-a-project");
    // The names it COULD have meant, so the agent can retry without guessing.
    expect(err).toContain("RTP-Strict");
    // Never a fallback to the calling project.
    expect(err.toLowerCase()).not.toContain("using the current project");
  });

  it("refuses an ambiguous name and names the ids, the only way out of the tie", () => {
    const here = createProject({ name: "RTP-Amb-Caller" });
    const a = createProject({ name: "Twin Project" });
    const b = createProject({ name: "twin project" });
    const got = resolveTargetProject(here, "TWIN PROJECT");
    expect("project" in got).toBe(false);
    const err = (got as { error: string }).error;
    expect(err).toMatch(/ambiguous/i);
    // Repeating the name would just fail again; the ids are what let the
    // agent retry successfully.
    expect(err).toContain(a.id);
    expect(err).toContain(b.id);
  });

  it("refuses when the calling project itself has been deleted mid-turn", () => {
    // The Claude driver's MCP server closes over the project captured at turn
    // start; the row can vanish while the turn runs.
    const here = createProject({ name: "RTP-Vanished" });
    const snapshot = { ...here };
    deleteProject(here.id);
    const got = resolveTargetProject(snapshot, undefined);
    expect("project" in got).toBe(false);
  });
});

describe("list_projects", () => {
  it("returns id, name and repo_path for every project and flags the caller's", () => {
    const here = createProject({ name: "LP-Here", repo_path: "/repos/here" });
    const there = createProject({ name: "LP-There", repo_path: "/repos/there" });
    const rows = listProjectsForAgent(here.id);
    expect(rows).toContainEqual({ id: here.id, name: "LP-Here", repo_path: "/repos/here", current: true });
    expect(rows).toContainEqual({ id: there.id, name: "LP-There", repo_path: "/repos/there", current: false });
  });

  it("is served to the stdio bridge over the internal endpoint", async () => {
    const here = createProject({ name: "LP-Endpoint", repo_path: "/repos/ep" });
    const res = await post(listProjectsTool, "/api/internal/agent-tools/list-projects", { projectId: here.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; projects: { id: string; name: string; repo_path: string; current: boolean }[] };
    expect(json.ok).toBe(true);
    expect(json.projects).toContainEqual({ id: here.id, name: "LP-Endpoint", repo_path: "/repos/ep", current: true });
  });
});

describe("suggest_task into another project", () => {
  it("files the task into the named target, not the caller", async () => {
    const here = createProject({ name: "XP-Caller" });
    const there = createProject({ name: "XP-Target" });
    const res = await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: here.id,
      project: "xp-target",
      title: "Cross-filed",
      description: "belongs over there",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; projectId: string; text: string };
    expect(getTask(json.id)!.project_id).toBe(there.id);
    expect(json.projectId).toBe(there.id);
    // The confirmation names where it actually landed; the agent reports this
    // back to the user verbatim.
    expect(json.text).toContain("XP-Target");
  });

  it("takes agent, send_context and board position from the TARGET project", async () => {
    const here = createProject({ name: "XP-Def-Caller" });
    updateProject(here.id, { default_agent: "claude", send_context: 1 });
    const there = createProject({ name: "XP-Def-Target" });
    updateProject(there.id, { default_agent: "codex", send_context: 0 });
    // An existing task in the target so "end of the target's order" is testable.
    const sibling = createTask({ project_id: there.id, title: "Sibling" });

    const { task } = createSuggestedTask(getProject(there.id)!, { title: "Inherits", description: "" });
    expect(task!.project_id).toBe(there.id);
    expect(task!.agent).toBe("codex");
    expect(task!.send_context).toBe(0);
    expect(task!.position).toBeGreaterThan(getTask(sibling.id)!.position);
  });

  it("refuses an unrecognized project ref with a 400 and creates nothing", async () => {
    const here = createProject({ name: "XP-Refuse" });
    const before = post(suggestTask, "/api/internal/agent-tools/suggest-task", {
      projectId: here.id,
      project: "typo-project",
      title: "Should not exist",
    });
    const res = await before;
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("typo-project");
    expect(json.error).toContain("XP-Refuse");
  });
});

describe("blocked_by resolves inside the target project", () => {
  it("keeps refs that live in the target and reports the ones it cannot use", () => {
    const here = createProject({ name: "XPD-Caller" });
    const there = createProject({ name: "XPD-Target" });
    const inTarget = createSuggestedTask(there, { title: "Blocker", description: "" }).task!;
    const inCaller = createSuggestedTask(here, { title: "Wrong project", description: "" }).task!;

    const { task, text } = createSuggestedTask(there, {
      title: "Dependent",
      description: "",
      blocked_by: [inTarget.id, inCaller.id, "ghost"],
    });
    expect(getTaskDeps(task!.id)).toEqual([inTarget.id]);
    expect(text).toContain("Blocked by 1 task(s).");
    // The two unusable refs are named, not swallowed.
    expect(text).toContain(inCaller.id);
    expect(text).toContain("ghost");
    expect(text).toContain("XPD-Target");
  });

  it("says so when NO blocked_by ref was usable", () => {
    const there = createProject({ name: "XPD-None" });
    const { task, text } = createSuggestedTask(there, { title: "Lonely", description: "", blocked_by: ["ghost"] });
    expect(getTaskDeps(task!.id)).toEqual([]);
    expect(text).not.toContain("Blocked by");
    expect(text).toContain("ghost");
  });
});

describe("per-session blocked_by title refs are scoped to their target project", () => {
  it("resolves a title only against suggestions filed into the same project", () => {
    const map = new Map<string, string>([
      [titleKey("proj-a", "Shared title"), "task-in-a"],
      [titleKey("proj-b", "Shared title"), "task-in-b"],
    ]);
    // The same title in two projects is not ambiguous: each resolves within
    // its own project, which is the only scope setTaskDeps accepts.
    expect(resolveTitleRefs(["Shared title"], map, "proj-a")).toEqual(["task-in-a"]);
    expect(resolveTitleRefs(["Shared title"], map, "proj-b")).toEqual(["task-in-b"]);
    // A title suggested into a DIFFERENT project passes through unresolved, so
    // createSuggestedTask reports it instead of wiring a foreign dependency.
    expect(resolveTitleRefs(["Shared title"], map, "proj-c")).toEqual(["Shared title"]);
    // Ids still pass straight through, and no refs is still no refs.
    expect(resolveTitleRefs(["task-in-a"], map, "proj-b")).toEqual(["task-in-a"]);
    expect(resolveTitleRefs(undefined, map, "proj-a")).toEqual([]);
  });

  it("leaves a title unresolved once it is ambiguous WITHIN one project", () => {
    // Two suggestions sharing a title in the same project: picking either by
    // luck would wire a dependency on a task the agent didn't mean. Record the
    // collision and let the ref travel on so it's reported as unusable instead.
    const map = new Map<string, string>();
    rememberSuggestedTitle(map, "proj-a", "Dup", "first-id");
    expect(resolveTitleRefs(["Dup"], map, "proj-a")).toEqual(["first-id"]);
    rememberSuggestedTitle(map, "proj-a", "Dup", "second-id");
    expect(resolveTitleRefs(["Dup"], map, "proj-a")).toEqual(["Dup"]);
    // …and the same title in another project is untouched by the collision.
    rememberSuggestedTitle(map, "proj-b", "Dup", "b-id");
    expect(resolveTitleRefs(["Dup"], map, "proj-b")).toEqual(["b-id"]);
  });
});

describe("badges and the needs-you pill on a cross-project suggestion", () => {
  it("moves neither count — a suggestion is not work waiting on the user", () => {
    // The fan-out only has to refresh the receiving TRAY. Both project-rail
    // counts exclude suggested rows (the NEEDS_YOU predicate and
    // task_count's `suggested = 0`), so there is nothing else to update: this
    // pins that, so the absence of a badge update is a decision, not a bug.
    const here = createProject({ name: "Badge-Caller" });
    const there = createProject({ name: "Badge-Target" });
    const before = listProjects().find((p) => p.id === there.id)!;

    createSuggestedTask(there, { title: "Filed from elsewhere", description: "" });

    const after = listProjects().find((p) => p.id === there.id)!;
    expect(after.awaiting_count).toBe(before.awaiting_count);
    expect(after.task_count).toBe(before.task_count);
    expect(countAwaiting(there.id)).toBe(countAwaiting(here.id));
  });
});

describe("cross-project suggestion fan-out", () => {
  it("the internal endpoint publishes the suggestion on the calling task's channel, naming the target", async () => {
    // Without this the Codex/bridge path publishes nothing on the bus, and no
    // tray anywhere refreshes until the user reloads.
    const here = createProject({ name: "FanOut-Caller" });
    const there = createProject({ name: "FanOut-Target" });
    const caller = createTask({ project_id: here.id, title: "Running turn" });

    const seen: BusEvent[] = [];
    const unsub = subscribeGlobal((tid, ev) => { if (tid === caller.id) seen.push(ev); });
    try {
      await post(suggestTask, "/api/internal/agent-tools/suggest-task", {
        projectId: here.id,
        taskId: caller.id,
        project: there.id,
        title: "Filed elsewhere",
      });
    } finally {
      unsub();
    }
    // `taskId` rides along with the target project id: it's what lets a
    // transcript settle a suggestion card onto the call that filed the task.
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "suggested", title: "Filed elsewhere", projectId: there.id, taskId: expect.any(String) })
    );
  });

  it("GET /api/events carries the TARGET project id so the receiving tray refreshes", async () => {
    const here = createProject({ name: "Wire-Caller" });
    const there = createProject({ name: "Wire-Target" });
    const caller = createTask({ project_id: here.id, title: "T" });

    const ac = new AbortController();
    const res = await eventsRoute(new Request("http://test/api/events", { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const nextData = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed before the expected frame");
        buf += decoder.decode(value);
      }
    };

    try {
      publish(caller.id, { type: "suggested", title: "Filed elsewhere", projectId: there.id });
      const frame = await nextData();
      expect(frame).toMatchObject({
        type: "task",
        event: "suggested",
        taskId: caller.id,
        // The calling task's own row is still the snapshot…
        projectId: here.id,
        // …but the tray that gained a row is named separately.
        suggestedProjectId: there.id,
      });
    } finally {
      ac.abort();
    }
  });
});
