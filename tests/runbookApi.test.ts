import { describe, expect, it, beforeEach, vi } from "vitest";

const started: { taskId: string; text: string }[] = [];
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string) => {
    started.push({ taskId: task.id, text: userText });
  },
}));
vi.mock("@/lib/schedule/commands", () => ({ validatePrompt: async () => ({ ok: true }) }));

import { createProject, getTask, listTasks } from "@/lib/store";
import { getDb } from "@/lib/db";
import { createRunbook, getRunbook, listRunbooks, composeRunbookPrompt } from "@/lib/runbooks/store";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";

import { GET as listRoute, POST as createRoute } from "@/app/api/projects/[id]/runbooks/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/runbooks/[id]/route";
import { POST as runRoute } from "@/app/api/runbooks/[id]/run/route";
import { POST as copyRoute } from "@/app/api/runbooks/[id]/copy/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `rbapi-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

describe("runbook API", () => {
  beforeEach(() => {
    started.length = 0;
    getDb().prepare("DELETE FROM runbooks").run();
    setAgentConnection("claude", { method: "subscription", email: null, plan: null });
  });

  it("creates, lists and rejects a nameless or promptless runbook", async () => {
    const p = await projectWithRepo();
    const created = await createRoute(post({ name: "Sweep", prompt: "/sweep" }), params(p.id));
    expect(created.status).toBe(201);

    const listed = await (await listRoute(new Request("http://localhost/x"), params(p.id))).json();
    expect(listed.runbooks).toHaveLength(1);
    expect(listed.runbooks[0].name).toBe("Sweep");
    expect(listed.runbooks[0].last_run).toBeNull();
    expect(listed.runbooks[0].used_by).toEqual([]);

    expect((await createRoute(post({ prompt: "/x" }), params(p.id))).status).toBe(400);
    expect((await createRoute(post({ name: "n" }), params(p.id))).status).toBe(400);
    // A non-string name must 400, not throw on .trim() and 500.
    expect((await createRoute(post({ name: 7, prompt: "/x" }), params(p.id))).status).toBe(400);
  });

  it("rejects an out-of-range priority at creation and on PATCH", async () => {
    const p = await projectWithRepo();
    const bad = await createRoute(post({ name: "Sweep", prompt: "/sweep", priority: "urgent" }), params(p.id));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/priority/);
    expect(listRunbooks(p.id)).toHaveLength(0);

    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const badPatch = await patchRoute(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ priority: "urgent" }) }), params(rb.id));
    expect(badPatch.status).toBe(400);
    expect((await badPatch.json()).error).toMatch(/priority/);
    expect(getRunbook(rb.id)!.priority).toBe(rb.priority);
  });

  it("running one mints a task and launches it with the composed prompt", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep", priority: "hi" });

    const res = await runRoute(post({ extra: "focus on CEAP-1234" }), params(rb.id));
    expect(res.status).toBe(201);
    const { task } = await res.json();

    const row = getTask(task.id)!;
    expect(row.runbook_id).toBe(rb.id);
    expect(row.priority).toBe("hi");
    expect(row.title).toContain("Sweep");
    expect(started[0].text).toBe(composeRunbookPrompt("/sweep", "focus on CEAP-1234"));
    expect(started[0].text).toContain("/sweep");
    expect(started[0].text).toContain("CEAP-1234");
  });

  it("running with start=false creates the task without launching a turn", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const res = await runRoute(post({ start: false }), params(rb.id));
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(getTask(task.id)!.running).toBe(0);
    expect(started).toHaveLength(0);
  });

  it("an override title is used verbatim", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const res = await runRoute(post({ title: "Friday sweep" }), params(rb.id));
    const { task } = await res.json();
    expect(getTask(task.id)!.title).toBe("Friday sweep");
  });

  it("a failed dispatch reports the reason rather than a bare 500", async () => {
    const p = createProject({ name: `norepo-${Math.random().toString(36).slice(2)}` });
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const res = await runRoute(post({}), params(rb.id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/working directory/i);
    expect(listTasks(p.id)).toHaveLength(0);
  });

  it("patches fields and deletes", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const patched = await (await patchRoute(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }), params(rb.id))).json();
    expect(patched.name).toBe("Renamed");
    expect((await deleteRoute(new Request("http://localhost/x", { method: "DELETE" }), params(rb.id))).status).toBe(200);
    expect(getRunbook(rb.id)).toBeNull();
  });

  it("copies into another project and refuses an unknown destination", async () => {
    const p = await projectWithRepo();
    const dest = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });

    const res = await copyRoute(post({ project_id: dest.id }), params(rb.id));
    expect(res.status).toBe(201);
    expect(listRunbooks(dest.id)).toHaveLength(1);
    expect(listRunbooks(p.id)).toHaveLength(1);

    expect((await copyRoute(post({ project_id: "nope" }), params(rb.id))).status).toBe(400);
  });

  it("404s on a runbook that doesn't exist", async () => {
    expect((await runRoute(post({}), params("nope"))).status).toBe(404);
    expect((await copyRoute(post({ project_id: "x" }), params("nope"))).status).toBe(404);
  });
});

describe("composeRunbookPrompt", () => {
  it("returns the prompt untouched with no extras", () => {
    expect(composeRunbookPrompt("/sweep", "")).toBe("/sweep");
    expect(composeRunbookPrompt("/sweep", "   ")).toBe("/sweep");
  });
  it("appends extras under a delimiter", () => {
    const out = composeRunbookPrompt("/sweep", "focus on CEAP-1234");
    expect(out.startsWith("/sweep")).toBe(true);
    expect(out).toContain("focus on CEAP-1234");
  });
});
