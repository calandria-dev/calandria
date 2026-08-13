// Turn-lifecycle behaviors around the runner: follow-up queueing while a turn
// is live, explicit Stop, failed-turn transcript notices, agent suggestions
// landing in the tray, and multi-turn resume. Mostly API-driven (the flows are
// server-side), with UI assertions where the behavior is user-visible.

import { expect, test } from "@playwright/test";
import {
  createProject,
  createTask,
  ensureOnboarded,
  getTask,
  gotoApp,
  makeFixtureRepo,
  sendMessage,
  uid,
  waitForIdle,
} from "./helpers";

const PROJECT = `Behaviors ${uid()}`;
// A second project, so a suggestion can be filed somewhere the running turn isn't.
const OTHER = `Behaviors Elsewhere ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("behaviors") });
  projectId = project.id;
});

test("a follow-up sent mid-turn queues, then runs as the next turn", async ({ request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Queueing",
    description: "e2e:sleep=3000",
  });
  await sendMessage(request, task.id); // initial turn: sleeps 3s
  await expect.poll(async () => (await getTask(request, task.id)).running).toBe(1);

  // Second message while the turn is live → parked, not run.
  const res = await request.post(`/api/tasks/${task.id}/messages`, { data: { text: "follow-up work" } });
  expect(res.status()).toBe(202);
  expect((await res.json()).queued).toBe(true);

  // Once the first turn ends the queue drains: both user messages and two
  // mock assistant replies end up in the transcript.
  await expect
    .poll(
      async () => {
        const t = await getTask(request, task.id);
        return t.running === 0 && t.messages.filter((m: { role: string }) => m.role === "assistant").length;
      },
      { timeout: 20_000 }
    )
    .toBe(2);
});

test("Stop ends a live turn cleanly and discards the queue", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Stopping",
    description: "e2e:sleep=60000",
  });
  await sendMessage(request, task.id);
  await expect.poll(async () => (await getTask(request, task.id)).running).toBe(1);
  await sendMessage(request, task.id, "queued behind the doomed turn");

  // Stop from the UI (the composer's stop button).
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Stopping").first().click();
  await page.getByTitle("Stop the current turn").click();

  const settled = await waitForIdle(request, task.id, 15_000);
  // Stopped, not failed: no error line, and the parked follow-up was discarded.
  const errors = settled.messages.filter((m: { content: string }) => m.content.startsWith("⚠"));
  expect(errors).toHaveLength(0);
  const assistants = settled.messages.filter((m: { role: string }) => m.role === "assistant");
  expect(assistants).toHaveLength(0); // aborted mid-sleep, before the reply
});

test("a failing turn surfaces the error in the transcript", async ({ request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Failing",
    description: "e2e:fail=Simulated agent failure",
  });
  await sendMessage(request, task.id);
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 0 && t.messages.some((m: { content: string }) => m.content.includes("Simulated agent failure"));
    }, { timeout: 20_000 })
    .toBeTruthy();
});

test("agent suggestions land in the Suggested tray", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Suggesting",
    description: "e2e:suggest=Refactor the widget factory",
  });
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);

  // Server-side: the suggested task row exists on this project.
  const detail = await (await request.get(`/api/projects/${projectId}`)).json();
  const suggestion = detail.tasks.find((t: { title: string }) => t.title === "Refactor the widget factory");
  expect(suggestion?.suggested).toBe(1);

  // UI: it shows under "Suggested by agents".
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await expect(page.getByText("Suggested by agents")).toBeVisible();
  // Scoped to the tray's name element — the originating task's description
  // contains the same words, so a bare text match is ambiguous.
  await expect(page.locator(".sg-name").filter({ hasText: "Refactor the widget factory" })).toBeVisible();
});

test("a suggestion filed into another project reaches that project's tray live", async ({ page, request }) => {
  // The cross-project fan-out: the turn runs in PROJECT, the task lands in
  // OTHER. The receiving tray is the one that has to refresh, and it belongs to
  // a project the running task knows nothing about — so this is the path that
  // only works if the `suggested` event carries the TARGET project id.
  const other = await createProject(request, { name: OTHER, repoPath: makeFixtureRepo("behaviors-other") });

  // Sit on the RECEIVING project with no transcript stream open for the turn
  // that's about to run — only the global /api/events stream can deliver this.
  await gotoApp(page);
  await page.getByText(OTHER).first().click();
  await expect(page.getByText("Suggested by agents")).toBeHidden();

  const task = await createTask(request, {
    projectId,
    title: "Filing elsewhere",
    description: `e2e:suggest-into=${OTHER}|Fix the other repo's build`,
  });
  await sendMessage(request, task.id);

  // No reload: the tray appears because the event named the target project.
  await expect(page.locator(".sg-name").filter({ hasText: "Fix the other repo's build" })).toBeVisible({ timeout: 20_000 });

  const detail = await (await request.get(`/api/projects/${other.id}`)).json();
  expect(detail.tasks.find((t: { title: string }) => t.title === "Fix the other repo's build")?.suggested).toBe(1);
});

test("an unrecognized project ref is refused instead of filed into the current project", async ({ request }) => {
  const before = await (await request.get(`/api/projects/${projectId}`)).json();
  const task = await createTask(request, {
    projectId,
    title: "Bad target",
    description: "e2e:suggest-into=no-such-project|Should never exist",
  });
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);

  const detail = await (await request.get(`/api/projects/${projectId}`)).json();
  // Nothing created anywhere — in particular NOT quietly in the calling project.
  expect(detail.tasks.some((t: { title: string }) => t.title === "Should never exist")).toBe(false);
  expect(detail.tasks.length).toBe(before.tasks.length + 1); // just the task we made
  // …and the agent was told why, so it can retry with a real name.
  const t = await getTask(request, task.id);
  expect(t.messages.some((m: { content: string }) => m.content.includes("no-such-project"))).toBe(true);
});

test("a second turn resumes the same session", async ({ request }) => {
  const task = await createTask(request, { projectId, title: "Resuming", description: "first pass" });
  await sendMessage(request, task.id);
  const afterFirst = await waitForIdle(request, task.id);
  expect(afterFirst.session_id).toBeTruthy();

  await sendMessage(request, task.id, "second pass, same session please");
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 0 && t.messages.filter((m: { role: string }) => m.role === "assistant").length;
    }, { timeout: 20_000 })
    .toBe(2);
  const afterSecond = await getTask(request, task.id);
  expect(afterSecond.session_id).toBe(afterFirst.session_id);
});
