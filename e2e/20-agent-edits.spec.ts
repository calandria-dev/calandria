// "Changed by agent" (app/shell/AgentEdits.tsx): a task the user already
// accepted can still be rewritten by an agent, whether its own session's
// update_task or another task's, per lib/agentTools.ts updateTaskForAgent.
// Every such write is recorded in task_agent_edits and raises a chip on the
// card; the panel shows the diff with a per-edit Revert, and "Keep changes"
// clears the chip without undoing anything. The write is driven straight at
// the real internal endpoint behind the tool
// (POST /api/internal/agent-tools/update-task). In this hermetic instance
// (local-origin auth, no Cloudflare Access) that route is reachable the same
// way the stdio MCP bridge reaches it in production, with no SERVICE_TOKEN
// needed, exactly like every other REST call these specs make.

import { expect, test, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, sendMessage, uid } from "./helpers";

const PROJECT = `Agent Edits ${uid()}`;
let projectId: string;
// The "another task's session" that makes the writes below, never itself
// edited, so its own row never carries a chip.
let callerId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("agent-edits") });
  projectId = project.id;
  const caller = await createTask(request, { projectId, title: `Planner session ${uid()}` });
  callerId = caller.id;
});

async function updateTaskAsAgent(
  request: import("@playwright/test").APIRequestContext,
  opts: { task: string; title?: string; priority?: "hi" | "med" | "lo"; status?: string }
) {
  return request.post("/api/internal/agent-tools/update-task", {
    data: { taskId: callerId, ...opts },
  });
}

const openProject = async (page: Page) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();
};

// Cards re-title themselves mid-test, so a card is located by a stable
// fragment (the uid) instead of the whole title, which changes.
const card = (page: Page, fragment: string) =>
  page.locator(".task-row").filter({ has: page.locator(".ttitle", { hasText: fragment }) });
const chip = (page: Page, fragment: string) => card(page, fragment).locator(".blocked-chip.changed");

test("the chip appears live, the panel shows the diff, and Revert restores the original", async ({ page, request }) => {
  const stamp = uid();
  const original = await createTask(request, { projectId, title: `Ship checkout redesign ${stamp}` });
  const renamed = `Ship checkout redesign ${stamp} (renamed)`;

  await openProject(page);
  await expect(card(page, stamp).locator(".ttitle")).toHaveText(`Ship checkout redesign ${stamp}`);
  await expect(chip(page, stamp)).toHaveCount(0);

  // Accepted already (suggested: 0, per createTask's default). This write
  // lands and is recorded.
  const res = await updateTaskAsAgent(request, { task: original.id, title: renamed, priority: "hi" });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, id: original.id, title: renamed });

  // Live wiring, no reload: the write publishes task_edited and the client
  // refetches, which turns the title and raises the chip here.
  await expect(card(page, stamp).locator(".ttitle")).toHaveText(renamed, { timeout: 15_000 });
  await expect(chip(page, stamp)).toBeVisible();

  await chip(page, stamp).click();
  const modal = page.locator(".modal");
  await expect(modal.locator(".m-title")).toHaveText("Changes by agent");
  await expect(modal.locator(".m-sub")).toHaveText(renamed);

  const edit = modal.locator(".ae-edit").first();
  await expect(edit.locator(".ae-who")).toContainText("Planner session");
  const titleRow = edit.locator(".ae-row").filter({ has: page.locator(".ae-field", { hasText: "Title" }) });
  await expect(titleRow.locator(".ae-before")).toHaveText(`Ship checkout redesign ${stamp}`);
  await expect(titleRow.locator(".ae-after")).toHaveText(renamed);
  const priRow = edit.locator(".ae-row").filter({ has: page.locator(".ae-field", { hasText: "Priority" }) });
  await expect(priRow.locator(".ae-before")).toHaveText("med");
  await expect(priRow.locator(".ae-after")).toHaveText("hi");

  await edit.getByRole("button", { name: "Revert" }).click();
  await expect(edit.locator(".ae-reverted-note")).toBeVisible();
  await expect(edit.getByRole("button", { name: "Revert" })).toHaveCount(0);

  await modal.getByRole("button", { name: "Close" }).click();
  await expect(chip(page, stamp)).toHaveCount(0);
  await expect(card(page, stamp).locator(".ttitle")).toHaveText(`Ship checkout redesign ${stamp}`, { timeout: 15_000 });

  // One update_task call recorded ONE edit spanning both fields, so the single
  // Revert folds both back.
  const settled = await getTask(request, original.id);
  expect(settled.title).toBe(`Ship checkout redesign ${stamp}`);
  expect(settled.priority).toBe("med");
  expect(settled.agent_edited_at).toBe(0);
});

test("Keep changes clears the chip without undoing the write", async ({ page, request }) => {
  const stamp = uid();
  const target = await createTask(request, { projectId, title: `Tighten API rate limits ${stamp}` });
  const renamed = `Tighten API rate limits ${stamp} (renamed)`;

  await openProject(page);
  await expect(chip(page, stamp)).toHaveCount(0);

  const res = await updateTaskAsAgent(request, { task: target.id, title: renamed });
  expect(res.ok()).toBeTruthy();

  await expect(card(page, stamp).locator(".ttitle")).toHaveText(renamed, { timeout: 15_000 });
  await expect(chip(page, stamp)).toBeVisible();

  await chip(page, stamp).click();
  const modal = page.locator(".modal");
  await expect(modal.locator(".ae-edit")).toHaveCount(1);
  await modal.getByRole("button", { name: "Keep changes" }).click();

  await expect(modal).toHaveCount(0);
  await expect(chip(page, stamp)).toHaveCount(0);
  // Kept, not undone: the new title is still there.
  await expect(card(page, stamp).locator(".ttitle")).toHaveText(renamed);
  const settled = await getTask(request, target.id);
  expect(settled.title).toBe(renamed);
  expect(settled.agent_edited_at).toBe(0);
});

test("a task with a live turn refuses the write, and nothing changes", async ({ request }) => {
  const target = await createTask(request, {
    projectId,
    title: `Streaming target ${uid()}`,
    description: "e2e:sleep=60000",
  });
  await sendMessage(request, target.id);
  await expect.poll(async () => (await getTask(request, target.id)).running, { timeout: 15_000 }).toBe(1);

  const before = await getTask(request, target.id);
  const res = await updateTaskAsAgent(request, { task: target.id, title: "Hijacked" });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("a turn is streaming in it right now");

  const after = await getTask(request, target.id);
  expect(after.title).toBe(before.title);
  expect(after.agent_edited_at).toBe(0);

  await request.post(`/api/tasks/${target.id}/abort`);
  await expect.poll(async () => (await getTask(request, target.id)).running, { timeout: 15_000 }).toBe(0);
});
