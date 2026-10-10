import { describe, expect, it, beforeEach, vi } from "vitest";

const started: { taskId: string; text: string }[] = [];
const validation = vi.hoisted(() => ({ validate: vi.fn(async () => ({ ok: true as const })) }));
vi.mock("@/lib/runner", () => ({
  startTurn: (task: { id: string }, _p: unknown, userText: string) => {
    started.push({ taskId: task.id, text: userText });
  },
}));
vi.mock("@/lib/schedule/commands", () => ({ validatePrompt: validation.validate }));

import { createProject, getTask, listTasks } from "@/lib/store";
import { getDb } from "@/lib/db";
import { createRunbook, getRunbook, listRunbooks, composeRunbookPrompt, listRunbookAgentEdits } from "@/lib/runbooks/store";
import { updateRunbookForAgent } from "@/lib/runbookTools";
import { createProvider } from "@/lib/providers/store";
import { setAgentConnection } from "@/lib/agents/connections";
import { makeRepo } from "./helpers";

import { GET as listRoute, POST as createRoute } from "@/app/api/projects/[id]/runbooks/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/runbooks/[id]/route";
import { POST as runRoute } from "@/app/api/runbooks/[id]/run/route";
import { POST as copyRoute } from "@/app/api/runbooks/[id]/copy/route";
import { GET as editsGet, POST as editsPost } from "@/app/api/runbooks/[id]/agent-edits/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

async function projectWithRepo() {
  const repo = await makeRepo();
  return createProject({ name: `rbapi-${Math.random().toString(36).slice(2)}`, repo_path: repo });
}

describe("runbook API", () => {
  beforeEach(() => {
    started.length = 0;
    validation.validate.mockReset().mockResolvedValue({ ok: true });
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
    const provider = createProvider({ type: "ollama", config: { base_url: "http://localhost:11434" } });
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep", priority: "hi" });
    getDb().prepare("UPDATE runbooks SET provider_id = ?, model = ? WHERE id = ?").run(provider.id, "qwen3-coder", rb.id);

    const res = await runRoute(post({ extra: "focus on CEAP-1234" }), params(rb.id));
    expect(res.status).toBe(201);
    const { task } = await res.json();

    const row = getTask(task.id)!;
    expect(row.runbook_id).toBe(rb.id);
    expect(row.priority).toBe("hi");
    expect(row.provider_id).toBe(provider.id);
    expect(row.model).toBe("qwen3-coder");
    expect(row.title).toContain("Sweep");
    expect(started[0].text).toBe(composeRunbookPrompt("/sweep", "focus on CEAP-1234"));
    expect(started[0].text).toContain("/sweep");
    expect(started[0].text).toContain("CEAP-1234");
  });

  it("audits agent recipe edits and requires a revision-bound first-run confirmation", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    const actor = { id: "agent-task", title: "Planning", agent: "codex" };
    const edited = updateRunbookForAgent(null, rb.id, { prompt: "/injected", permission_mode: "plan" }, actor).runbook!;
    expect(edited.agent_edit_revision).toBe(1);
    expect(edited.reviewed_agent_edit_revision).toBe(0);
    expect(edited.agent_edited_at).toBeGreaterThan(0);

    const history = await (await editsGet(new Request("http://localhost/x"), params(rb.id))).json();
    expect(history.edits).toHaveLength(1);
    expect(history.edits[0]).toMatchObject({ actor_task_id: actor.id, actor_title: actor.title, actor_agent: actor.agent });
    expect(history.edits[0].changes.map((c: { field: string }) => c.field)).toEqual(["prompt", "permission_mode"]);

    const firstAttempt = await runRoute(post({}), params(rb.id));
    expect(firstAttempt.status).toBe(409);
    const challenge = await firstAttempt.json();
    expect(challenge.requires_confirmation).toBe(true);
    expect(challenge.recipe_revision).toBe(edited.recipe_revision);
    expect(started).toHaveLength(0);

    // Acknowledging the chip is not approval to dispatch the recipe.
    await editsPost(post({ action: "ack" }), params(rb.id));
    expect(getRunbook(rb.id)?.reviewed_agent_edit_revision).toBe(0);
    expect((await runRoute(post({}), params(rb.id))).status).toBe(409);

    const confirmed = await runRoute(post({ confirmed_recipe_revision: challenge.recipe_revision }), params(rb.id));
    expect(confirmed.status).toBe(201);
    expect(started[0].text).toBe("/injected");
    expect(getRunbook(rb.id)?.reviewed_agent_edit_revision).toBe(1);
    expect(listRunbookAgentEdits(rb.id)[0].acknowledged_at).toBeGreaterThan(0);
  });

  it("rejects a stale confirmation and leaves a newer agent edit unreviewed", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/first" });
    updateRunbookForAgent(null, rb.id, { prompt: "/second" }, { id: "a", title: "A", agent: "claude" });
    const revision = getRunbook(rb.id)!.recipe_revision;
    updateRunbookForAgent(null, rb.id, { prompt: "/third" }, { id: "b", title: "B", agent: "codex" });
    const res = await runRoute(post({ confirmed_recipe_revision: revision }), params(rb.id));
    expect(res.status).toBe(409);
    expect((await res.json()).recipe_revision).toBeGreaterThan(revision);
    expect(started).toHaveLength(0);
    expect(getRunbook(rb.id)?.reviewed_agent_edit_revision).toBe(0);
  });

  it("uses the confirmed snapshot across async validation and never reviews a later edit", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/approved" });
    updateRunbookForAgent(null, rb.id, { prompt: "/approved-agent-edit" }, { id: "a", title: "A", agent: "claude" });
    const confirmedRevision = getRunbook(rb.id)!.recipe_revision;
    let release!: (value: { ok: true }) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    validation.validate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; entered(); }));

    const dispatch = runRoute(post({ confirmed_recipe_revision: confirmedRevision }), params(rb.id));
    await waiting;
    updateRunbookForAgent(null, rb.id, { prompt: "/later-edit" }, { id: "b", title: "B", agent: "codex" });
    release({ ok: true });
    expect((await dispatch).status).toBe(201);
    expect(started[0].text).toBe("/approved-agent-edit");
    expect(getRunbook(rb.id)?.reviewed_agent_edit_revision).toBe(0);
    expect(getRunbook(rb.id)?.agent_edit_revision).toBe(2);
  });

  it("human recipe edits invalidate old confirmation tokens and no-op agent edits create no audit", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/agent" });
    const noOp = updateRunbookForAgent(null, rb.id, { prompt: "/agent" }, { id: "a", title: "A", agent: "claude" });
    expect(noOp.runbook?.recipe_revision).toBe(rb.recipe_revision);
    expect(listRunbookAgentEdits(rb.id)).toHaveLength(0);

    updateRunbookForAgent(null, rb.id, { prompt: "/agent-edit" }, { id: "a", title: "A", agent: "claude" });
    const token = getRunbook(rb.id)!.recipe_revision;
    await patchRoute(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ name: "Human revision" }) }), params(rb.id));
    const stale = await runRoute(post({ confirmed_recipe_revision: token }), params(rb.id));
    expect(stale.status).toBe(409);
    expect((await stale.json()).recipe_revision).toBeGreaterThan(token);
  });

  it("does not consume review when a confirmed dispatch fails preflight", async () => {
    const p = createProject({ name: `agent-rb-no-repo-${Math.random().toString(36).slice(2)}` });
    const rb = createRunbook({ project_id: p.id, name: "Agent recipe", prompt: "/agent", created_by: "external" });
    expect(rb.agent_edit_revision).toBe(1);
    const res = await runRoute(post({ confirmed_recipe_revision: rb.recipe_revision }), params(rb.id));
    expect(res.status).toBe(400);
    expect(getRunbook(rb.id)?.reviewed_agent_edit_revision).toBe(0);
  });

  it("reverts only when the recorded after values are still live", async () => {
    const p = await projectWithRepo();
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/old" });
    updateRunbookForAgent(null, rb.id, { prompt: "/new" }, { id: "a", title: "A", agent: "claude" });
    const edits = listRunbookAgentEdits(rb.id);
    const reverted = await editsPost(post({ action: "revert", edit_id: edits[0].id }), params(rb.id));
    expect(reverted.status).toBe(200);
    expect(getRunbook(rb.id)?.prompt).toBe("/old");
    expect(getRunbook(rb.id)?.agent_edited_at).toBe(0);
    expect(listRunbookAgentEdits(rb.id)[0].reverted_at).toBeGreaterThan(0);

    updateRunbookForAgent(null, rb.id, { prompt: "/later" }, { id: "b", title: "B", agent: "codex" });
    updateRunbookForAgent(null, rb.id, { prompt: "/latest" }, { id: "c", title: "C", agent: "claude" });
    const newestFirst = listRunbookAgentEdits(rb.id);
    const stale = await editsPost(post({ action: "revert", edit_id: newestFirst[1].id }), params(rb.id));
    expect(stale.status).toBe(409);
    expect(getRunbook(rb.id)?.prompt).toBe("/latest");
  });

  it("running with start=false creates the task without launching a turn", async () => {
    const p = await projectWithRepo();
    const provider = createProvider({ type: "lmstudio", config: { base_url: "http://localhost:1234" } });
    const rb = createRunbook({ project_id: p.id, name: "Sweep", prompt: "/sweep" });
    getDb().prepare("UPDATE runbooks SET provider_id = ?, model = ? WHERE id = ?").run(provider.id, "local-model", rb.id);
    const res = await runRoute(post({ start: false }), params(rb.id));
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(getTask(task.id)).toMatchObject({ running: 0, provider_id: provider.id, model: "local-model" });
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
