// Notifications end to end: the server composes one, the SSE stream carries it,
// and the browser channel decides whether to show it. window.Notification is
// stubbed via addInitScript — Playwright cannot observe a real system toast, and
// the interesting logic is which payloads reach the constructor anyway.
//
// Everything below the stub is the production path: the real emitter, the real
// dispatcher on the real bus, the real relay.

import { expect, test } from "@playwright/test";
import {
  createProject, createTask, ensureOnboarded, getTask, gotoApp,
  makeFixtureRepo, sendMessage, uid,
} from "./helpers";

const PROJECT = `Notifications ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("notifications") });
  projectId = project.id;
});

// Replace window.Notification with a recorder, granted by default, before any
// app code runs. Collected on window.__notes for the assertions below.
async function stubNotifications(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __notes: { title: string; body: string; tag: string }[] }).__notes = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: NotificationOptions) {
        (window as unknown as { __notes: unknown[] }).__notes.push({ title, body: opts?.body ?? "", tag: opts?.tag ?? "" });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
  });
}

function notes(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as { __notes: { title: string; body: string; tag: string }[] }).__notes);
}

test("a task parking on a permission card notifies a tab looking elsewhere", async ({ page, request }) => {
  const watching = await createTask(request, { projectId, title: "Something else entirely" });
  const parking = await createTask(request, {
    projectId,
    title: "Needs a permission",
    description: "e2e:permission=npm run lint",
  });

  await stubNotifications(page);
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Something else entirely", { exact: true }).first().click();

  // Park the OTHER task while this tab is looking at `watching`.
  await sendMessage(request, parking.id);
  await expect
    .poll(async () => (await getTask(request, parking.id)).awaiting_input, { timeout: 20_000 })
    .toBe(1);

  await expect.poll(async () => (await notes(page)).length, { timeout: 15_000 }).toBe(1);
  const [note] = await notes(page);
  expect(note.title).toBe("Waiting for input");
  expect(note.body).toContain("Needs a permission");
  expect(note.body).toContain(PROJECT);
  expect(note.tag).toBe(`awaiting_input:${parking.id}`);
});

test("no notification when you are already looking at the task that parked", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Watched while it parks",
    description: "e2e:permission=npm run build",
  });

  await stubNotifications(page);
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Watched while it parks", { exact: true }).first().click();

  await sendMessage(request, task.id);
  await expect
    .poll(async () => (await getTask(request, task.id)).awaiting_input, { timeout: 20_000 })
    .toBe(1);
  // The card is on screen — a system toast about it would be noise.
  await expect(page.getByText("npm run build").first()).toBeVisible({ timeout: 15_000 });
  expect(await notes(page)).toEqual([]);
});

test("a failed turn notifies", async ({ page, request }) => {
  await createTask(request, { projectId, title: "Elsewhere again" });
  const failing = await createTask(request, {
    projectId,
    title: "Falls over",
    description: "e2e:fail=the session ended unexpectedly",
  });

  await stubNotifications(page);
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText("Elsewhere again", { exact: true }).first().click();

  await sendMessage(request, failing.id);

  await expect.poll(async () => (await notes(page)).map((n) => n.title), { timeout: 20_000 })
    .toContain("Turn failed");
  const note = (await notes(page)).find((n) => n.title === "Turn failed")!;
  expect(note.body).toContain("Falls over");
  expect(note.body).toContain("the session ended unexpectedly");
});
