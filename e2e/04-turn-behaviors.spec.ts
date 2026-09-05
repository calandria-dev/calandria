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

  // Second message while the turn is live is parked, not run.
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
  // The turn ends without an error line, and the parked follow-up is discarded.
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
  // Scoped to the tray's name element: the originating task's description
  // contains the same words, so a bare text match is ambiguous.
  await expect(page.locator(".sg-name").filter({ hasText: "Refactor the widget factory" })).toBeVisible();
});

test("a suggestion is reviewable in the transcript that made it, and starts from there", async ({ page, request }) => {
  // The card lets the user act on the proposal where it was made, without
  // leaving for the tray.
  const suggested = `Cache the widget lookups ${uid()}`;
  const task = await createTask(request, {
    projectId,
    title: "Suggesting in-window",
    description: `e2e:suggest=${suggested}`,
  });
  await sendMessage(request, task.id);
  await waitForIdle(request, task.id);

  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Suggesting in-window").first().click();

  // The card settles onto the suggest_task call's own row and names the
  // project the task was filed into, since suggest_task can point anywhere.
  const card = page.locator(".sugcard");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText(suggested);
  await expect(card.locator(".sugcard-proj")).toContainText(PROJECT);

  // Start mints the session from here, exactly as the tray's Start does.
  await card.getByRole("button", { name: "Start" }).click();

  await expect
    .poll(async () => {
      const detail = await (await request.get(`/api/projects/${projectId}`)).json();
      const row = detail.tasks.find((t: { title: string }) => t.title === suggested);
      return !!row && row.suggested === 0 && row.started === 1;
    }, { timeout: 30_000, message: "the suggestion never launched a session" })
    .toBe(true);

  // Re-read the transcript that offered it: the state is derived from the task
  // row, so the card must not still be offering to start it a second time.
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Suggesting in-window").first().click();
  const settled = page.locator(".sugcard");
  await expect(settled).toContainText("Session started", { timeout: 20_000 });
  await expect(settled.getByRole("button", { name: "Start" })).toHaveCount(0);
});

test("a suggestion filed into another project reaches that project's tray live", async ({ page, request }) => {
  // The turn runs in PROJECT, but the task lands in OTHER. This exercises the
  // path where the receiving tray, belonging to a different project than the
  // one running the turn, only refreshes because the `suggested` event
  // carries the TARGET project id.
  const other = await createProject(request, { name: OTHER, repoPath: makeFixtureRepo("behaviors-other") });

  // Sits on the receiving project with no transcript stream open for the turn
  // about to run, so only the global /api/events stream can deliver this.
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
  // Nothing is created anywhere, including the calling project.
  expect(detail.tasks.some((t: { title: string }) => t.title === "Should never exist")).toBe(false);
  expect(detail.tasks.length).toBe(before.tasks.length + 1); // just the task we made
  // The agent is told why, so it can retry with a real name.
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

// Auto-start must run against the built server: tests/autoStart.ts mocks
// lib/runner, so it can pin WHEN a launch happens but not whether the launch
// itself succeeds in a production Turbopack bundle. This is the only check
// for that failure mode; tests/importGraph.test.ts pins the import-graph
// shape (acyclicity and the dynamic runner import) that keeps it working.
test("a blocker marked done auto-starts its dependent's first turn", async ({ request }) => {
  const blocker = await createTask(request, { projectId, title: `Blocker ${uid()}` });
  const dependent = await createTask(request, { projectId, title: "Waits for the blocker" });

  const wired = await request.patch(`/api/tasks/${dependent.id}`, {
    data: { depends_on: [blocker.id], auto_start: 1 },
  });
  expect(wired.ok()).toBeTruthy();
  expect((await wired.json()).depends_on).toEqual([blocker.id]);

  // The only trigger: no message is ever POSTed to the dependent.
  const done = await request.patch(`/api/tasks/${blocker.id}`, { data: { status: "done" } });
  expect(done.ok()).toBeTruthy();

  const settled = await waitForIdle(request, dependent.id);
  expect(settled.started).toBe(1);
  // The turn really ran (a claimed-but-crashed launch also leaves a user
  // message behind), and the transcript says why it began.
  const roles = settled.messages.map((m: { role: string }) => m.role);
  expect(roles).toContain("assistant");
  const note = settled.messages.find(
    (m: { role: string; content: string }) => m.role === "system" && m.content.includes("Auto-started")
  );
  expect(note?.content).toContain(blocker.title);
  expect(note?.content).toContain("is done");
});

test("a task an agent renames updates the list live, with no reload", async ({ page, request }) => {
  // Exercises the update_task path. Unlike a status change, a retitle carries
  // no field the coarse /api/events payload includes, so this only works if
  // the write publishes "task_edited" and the client refetches the tray on
  // it. Not selecting the task keeps the transcript stream closed, so the
  // global stream is the only way to deliver the update.
  const task = await createTask(request, {
    projectId,
    title: "Working title",
    description: "e2e:retitle=Renamed by the agent",
  });
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await expect(page.locator(".ttitle").filter({ hasText: "Working title" })).toBeVisible();

  await sendMessage(request, task.id);

  await expect(page.locator(".ttitle").filter({ hasText: "Renamed by the agent" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".ttitle").filter({ hasText: "Working title" })).toBeHidden();
  expect((await getTask(request, task.id)).title).toBe("Renamed by the agent");
});
