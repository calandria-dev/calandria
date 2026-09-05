// Stopping a turn that has been marked idle, from the card.
//
// tests/turnIdle.test.ts owns the mark: when it is set, when it is refused,
// when it clears. This spec owns the affordance hung off it, specifically the
// property that the first press must not stop anything. lib/turnActivity.ts
// refuses to auto-stop because it cannot tell a wedged wait from a slow one,
// and a one-click Stop on a card would hand that same undecidable call to a
// mis-aim, discarding real work on an accidental click. The assertion after
// the first press is `running` still 1, read from the server instead of the
// DOM.
//
// The idle window here is e2e/env.ts's CALANDRIA_TURN_IDLE_MS (8s), not the
// 20-minute production default, and `e2e:sleep` is what produces a live turn
// that says nothing at all.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, gotoApp, makeFixtureRepo, sendMessage, uid } from "./helpers";

const PROJECT = `Idle stop ${uid()}`;
let projectId = "";

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("idle-stop") });
  projectId = project.id;
});

/** A live turn that produces nothing, held open past the idle window. */
async function idleTurn(request: import("@playwright/test").APIRequestContext, title: string) {
  const task = await createTask(request, { projectId, title, description: "e2e:sleep=60000" });
  await sendMessage(request, task.id);
  await expect.poll(async () => (await getTask(request, task.id)).running, { timeout: 15_000 }).toBe(1);
  // The mark rides GET /api/projects/[id] rather than the task row: it is
  // in-memory, so nothing in `tasks` carries it (lib/turnActivity.ts).
  await expect
    .poll(async () => {
      const res = await request.get(`/api/projects/${projectId}`);
      const body = await res.json();
      return body.tasks.find((t: { id: string }) => t.id === task.id)?.idle_since ?? 0;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
  return task;
}

test("the list card's Stop asks first, then stops the turn", async ({ page, request }) => {
  const task = await idleTurn(request, `Quiet list ${uid()}`);

  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("List view").click();
  const card = page.locator(".task-row").filter({ hasText: task.title });
  await expect(card.locator(".activity.idle")).toContainText("no activity for");

  // First press arms the control. The turn must still be running afterwards.
  await card.locator(".idle-chip").click();
  await expect(card.locator(".idle-chip.armed")).toBeVisible();
  expect((await getTask(request, task.id)).running).toBe(1);
  // It must not have selected the task out from under the press either.
  await expect(card.locator(".idle-chip.armed")).toContainText("A long build looks the same");

  // Cancel puts it back, still without touching the turn.
  await card.locator(".idle-btn", { hasText: "Cancel" }).click();
  await expect(card.locator(".idle-chip.armed")).toHaveCount(0);
  expect((await getTask(request, task.id)).running).toBe(1);

  // Second press on a re-armed chip commits.
  await card.locator(".idle-chip").click();
  await card.locator(".idle-btn", { hasText: "Stop" }).click();
  await expect.poll(async () => (await getTask(request, task.id)).running, { timeout: 15_000 }).toBe(0);
  // Stopped, not failed: the turn unwound and left the task resumable.
  const settled = await getTask(request, task.id);
  expect(settled.awaiting_input).toBe(1);
  expect(settled.messages.filter((m: { content: string }) => m.content.startsWith("⚠"))).toHaveLength(0);
  // And the chip goes with the mark it was hung on.
  await expect(card.locator(".idle-chip")).toHaveCount(0);
});

test("the board card carries the same control", async ({ page, request }) => {
  const task = await idleTurn(request, `Quiet board ${uid()}`);

  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByTitle("Board view").click();
  const card = page.locator(".bcard").filter({ hasText: task.title });
  await expect(card.locator(".bc-chip.idle")).toBeVisible();

  await card.locator(".bc-chip.idle").click();
  await expect(card.locator(".bc-chip.idle.armed")).toBeVisible();
  expect((await getTask(request, task.id)).running).toBe(1);

  await card.locator(".idle-btn", { hasText: "Stop" }).click();
  await expect.poll(async () => (await getTask(request, task.id)).running, { timeout: 15_000 }).toBe(0);
});

test("the session offers no second Stop — the composer's is the one", async ({ page, request }) => {
  const task = await idleTurn(request, `Quiet session ${uid()}`);

  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(task.title).first().click();
  // The note is there, and the only Stop in the session column is the
  // composer's. The card in the list column beside it still has its chip: the
  // affordance is per surface, not per task.
  await expect(page.locator(".idle-note")).toContainText("no activity for");
  await expect(page.locator(".col-session .idle-chip")).toHaveCount(0);
  await expect(page.locator(".task-row .idle-chip")).toHaveCount(1);
  await page.getByTitle("Stop the current turn").click();
  await expect.poll(async () => (await getTask(request, task.id)).running, { timeout: 15_000 }).toBe(0);
});
