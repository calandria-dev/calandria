import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as createTaskRoute } from "@/app/api/tasks/route";
import { PATCH as patchTaskRoute } from "@/app/api/tasks/[id]/route";
import { POST as suggestTaskRoute } from "@/app/api/internal/agent-tools/suggest-task/route";
import { createProject, createTag, createTask, getProject, getTask, getTaskDeps, getTaskTagIds, listTags, listTasks, setTaskDeps, setTaskTags, updateProject } from "@/lib/store";
import { createSuggestedTask } from "@/lib/agentTools";

const request = (method: string, body: unknown) => new Request("http://test", {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const bridgePost = (body: unknown) => suggestTaskRoute(new NextRequest("http://test/api/internal/agent-tools/suggest-task", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

describe("task reasoning persistence", () => {
  it("stores null by default and persists every supported preset", () => {
    const project = createProject({ name: "Reasoning store" });
    expect(createTask({ project_id: project.id, title: "Inherited" }).reasoning).toBeNull();

    for (const reasoning of ["off", "think", "think_hard", "ultrathink"] as const) {
      const task = createTask({ project_id: project.id, title: reasoning, reasoning });
      expect(task.reasoning).toBe(reasoning);
      expect(getTask(task.id)?.reasoning).toBe(reasoning);
    }
  });
});

describe("task reasoning HTTP routes", () => {
  it("POST persists an explicit preset and rejects invalid input before creating a row", async () => {
    const project = createProject({ name: "Reasoning create" });
    const before = listTasks(project.id).length;
    const created = await createTaskRoute(request("POST", {
      project_id: project.id,
      title: "Explicit effort",
      reasoning: "think_hard",
    }));
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; reasoning: string | null };
    expect(body.reasoning).toBe("think_hard");
    expect(getTask(body.id)?.reasoning).toBe("think_hard");

    const inherited = await createTaskRoute(request("POST", {
      project_id: project.id,
      title: "Null effort",
      reasoning: null,
    }));
    expect(inherited.status).toBe(201);
    expect((await inherited.json() as { reasoning: string | null }).reasoning).toBeNull();

    const nonstring = await createTaskRoute(request("POST", {
      project_id: project.id,
      title: "Wrong effort shape",
      reasoning: 42,
    }));
    expect(nonstring.status).toBe(400);

    const rejected = await createTaskRoute(request("POST", {
      project_id: project.id,
      title: "Invalid effort",
      reasoning: "bogus",
    }));
    expect(rejected.status).toBe(400);
    expect(listTasks(project.id)).toHaveLength(before + 2);
  });

  it("PATCH clears inherited effort, preserves an explicit valid value on agent change, and rejects invalid values atomically", async () => {
    const project = createProject({ name: "Reasoning patch" });
    const task = createTask({ project_id: project.id, title: "Patch me", reasoning: "think" });
    const blocker = createTask({ project_id: project.id, title: "Blocker" });
    const tag = createTag({ project_id: project.id, name: "keep" });
    setTaskDeps(task.id, [blocker.id]);
    setTaskTags([task.id], [tag.id]);

    let response = await patchTaskRoute(request("PATCH", { reasoning: null }), params(task.id));
    expect(response.status).toBe(200);
    expect(getTask(task.id)?.reasoning).toBeNull();

    response = await patchTaskRoute(request("PATCH", { reasoning: "think_hard" }), params(task.id));
    expect(response.status).toBe(200);
    expect(getTask(task.id)?.reasoning).toBe("think_hard");

    response = await patchTaskRoute(request("PATCH", { agent: "codex", reasoning: "think_hard" }), params(task.id));
    expect(response.status).toBe(200);
    expect(getTask(task.id)).toMatchObject({ agent: "codex", reasoning: "think_hard" });

    response = await patchTaskRoute(request("PATCH", {
      title: "must stay unchanged",
      agent: "claude",
      reasoning: "bogus",
      tag_ids: [],
      depends_on: [],
    }), params(task.id));
    expect(response.status).toBe(400);
    expect(getTask(task.id)).toMatchObject({ title: "Patch me", agent: "codex", reasoning: "think_hard" });
    expect(getTaskDeps(task.id)).toEqual([blocker.id]);
    expect(getTaskTagIds(task.id)).toEqual([tag.id]);

    response = await patchTaskRoute(request("PATCH", { agent: "claude" }), params(task.id));
    expect(response.status).toBe(200);
    expect(getTask(task.id)).toMatchObject({ agent: "claude", reasoning: null });

    response = await patchTaskRoute(request("PATCH", { agent: "gemini", reasoning: "think_hard" }), params(task.id));
    expect(response.status).toBe(400);
    expect(getTask(task.id)).toMatchObject({ agent: "claude", reasoning: null });

    response = await patchTaskRoute(request("PATCH", { reasoning: 42 }), params(task.id));
    expect(response.status).toBe(400);
    expect(getTask(task.id)).toMatchObject({ agent: "claude", reasoning: null });
  });
});

describe("suggest_task reasoning validation", () => {
  it("forwards supported presets over the bridge and stores the selected value", async () => {
    const project = createProject({ name: "Reasoning bridge" });
    for (const reasoning of ["off", "think", "think_hard", "ultrathink"] as const) {
      const response = await bridgePost({ projectId: project.id, title: `Suggestion ${reasoning}`, reasoning });
      expect(response.status).toBe(200);
      const body = await response.json() as { id: string };
      expect(getTask(body.id)?.reasoning).toBe(reasoning);
    }
  });

  it("refuses unsupported reasoning before creating tags or a task", () => {
    const project = createProject({ name: "Reasoning no capability" });
    updateProject(project.id, { default_agent: "gemini" });
    const beforeTasks = listTasks(project.id).length;
    const beforeTags = listTags(project.id).length;
    const result = createSuggestedTask(getProject(project.id)!, {
      title: "Gemini effort",
      description: "",
      reasoning: "think_hard",
      tags: ["must-not-be-created"],
    });
    expect(result.task).toBeNull();
    expect(result.text).toMatch(/reasoning|effort|supported/i);
    expect(listTasks(project.id)).toHaveLength(beforeTasks);
    expect(listTags(project.id)).toHaveLength(beforeTags);
  });

  it("refuses invalid bridge reasoning without tag side effects", async () => {
    const project = createProject({ name: "Reasoning invalid bridge" });
    const tag = createTag({ project_id: project.id, name: "existing" });
    const before = listTasks(project.id).length;
    const response = await bridgePost({
      projectId: project.id,
      title: "Invalid suggestion",
      reasoning: "made-up",
      tags: [tag.id, "new-tag-must-not-exist"],
    });
    expect(response.status).not.toBe(200);
    expect(listTasks(project.id)).toHaveLength(before);
    expect(listTags(project.id).map((t) => t.name)).toEqual(["existing"]);
  });
});
