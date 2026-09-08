// API-level smoke over the remaining core surfaces: diff and sync inspection,
// /clear (generation lineage), agent listing, and hard deletes. These pin the
// REST contracts the UI depends on, cheaply, against the real server + SQLite.

import { expect, test } from "@playwright/test";
import { ensureOnboarded, getTask, runTaskToCompletion, uid } from "./helpers";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
});

test("diff endpoint lists the turn's uncommitted changes against base", async ({ request }) => {
  const { task } = await runTaskToCompletion(request, {
    name: `diff-${uid()}`,
    title: "Diff me",
    description: "e2e:write=src/feature.ts:export const x = 1;",
  });
  const diff = await (await request.get(`/api/tasks/${task.id}/diff`)).json();
  expect(diff.baseLabel).toBe("main");
  expect(diff.merged_at).toBeFalsy();
  const files = diff.files.map((f: { path: string }) => f.path);
  expect(files).toContain("src/feature.ts");
});

test("sync endpoint reports an isolated, up-to-date worktree", async ({ request }) => {
  const { task } = await runTaskToCompletion(request, { name: `sync-${uid()}`, title: "Sync me" });
  const sync = await (await request.get(`/api/tasks/${task.id}/sync`)).json();
  expect(sync.isolated).toBe(true);
  expect(sync.baseBranch).toBe("main");
  expect(sync.behind).toBe(0);
});

test("base-branch endpoint stays quiet for a project with no remote", async ({ request }) => {
  // A local-only project must not error or hang, and the banner must render
  // nothing. A remote-aware surface no-ops when there's nowhere to fetch
  // from, instead of degrading.
  const { task } = await runTaskToCompletion(request, { name: `remote-${uid()}`, title: "No remote here" });
  const res = await request.get(`/api/projects/${task.project_id}/base-branch`);
  expect(res.ok()).toBe(true);
  const status = await res.json();
  expect(status.hasRemote).toBe(false);
  expect(status.behind ?? 0).toBe(0);
});

test("/clear condenses the generation and starts the next one fresh", async ({ request }) => {
  const { task } = await runTaskToCompletion(request, { name: `clear-${uid()}`, title: "Clear me" });
  expect(task.generation).toBe(1);

  const res = await request.post(`/api/tasks/${task.id}/clear`);
  expect(res.ok()).toBeTruthy();
  const { summary } = await res.json();
  expect(summary).toContain("Mock handoff summary");

  const fresh = await getTask(request, task.id);
  expect(fresh.generation).toBe(2);
  expect(fresh.session_id).toBeNull();
});

test("agent registry exposes the drivers with capabilities", async ({ request }) => {
  const bundle = await (await request.get("/api/agents")).json();
  const ids = bundle.agents.map((a: { id: string }) => a.id);
  expect(ids).toContain("claude");
  expect(ids).toContain("codex");
  expect(ids).toContain("mock");
  const mock = bundle.agents.find((a: { id: string }) => a.id === "mock");
  expect(mock.capabilities.models[0].value).toBe("mock-1");
});

test("deletes are hard: task then project", async ({ request }) => {
  const { project, task } = await runTaskToCompletion(request, { name: `delete-${uid()}`, title: "Delete me" });

  expect((await request.delete(`/api/tasks/${task.id}`)).ok()).toBeTruthy();
  expect((await request.get(`/api/tasks/${task.id}`)).status()).toBe(404);

  expect((await request.delete(`/api/projects/${project.id}`)).ok()).toBeTruthy();
  expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(404);
  const projects = await (await request.get("/api/projects")).json();
  expect(projects.find((p: { id: string }) => p.id === project.id)).toBeUndefined();
});
