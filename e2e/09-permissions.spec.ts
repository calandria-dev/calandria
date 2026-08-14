// The tool-permission gate, driven through the real UI: a turn parks on a
// permission card, the task shows as needing you while it waits, the user
// answers in the transcript, and "Always allow" both unblocks the turn and
// leaves a revocable rule in Settings. The mock agent runs the SAME
// lib/permissions.ts helpers the Claude driver's canUseTool does, so
// everything here except the SDK itself is the production path.

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

const PROJECT = `Permissions ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("permissions") });
  projectId = project.id;
});

// Open the app on a task and wait for its transcript to render.
async function openTask(page: import("@playwright/test").Page, title: string) {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(title, { exact: true }).first().click();
}

test("a turn parks on a permission card and continues once it's allowed once", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Ask before running",
    description: "e2e:permission=npm run lint",
  });
  await sendMessage(request, task.id);

  // Parked: the turn is live AND the task reads as needing you.
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 1 && t.awaiting_input === 1;
    }, { timeout: 20_000 })
    .toBe(true);

  await openTask(page, "Ask before running");
  const card = page.locator(".perm").first();
  await expect(card).toBeVisible();
  // The card shows the command being authorized, not just the tool name.
  await expect(card.locator(".perm-pre")).toContainText("npm run lint");

  await card.getByRole("button", { name: "Allow once" }).click();

  await expect(page.locator(".perm.settled")).toContainText("You allowed this once");
  const settled = await waitForIdle(request, task.id);
  expect(settled.awaiting_input).toBe(1); // turn ended — ordinary "your move"
  expect(settled.running).toBe(0);
});

test("declining tells the agent why and it stops instead of working around it", async ({ page, request }) => {
  const task = await createTask(request, {
    projectId,
    title: "Refuse the command",
    description: "e2e:permission=rm -rf build",
  });
  await sendMessage(request, task.id);
  await expect.poll(async () => (await getTask(request, task.id)).awaiting_input, { timeout: 20_000 }).toBe(1);

  await openTask(page, "Refuse the command");
  const card = page.locator(".perm").first();
  await expect(card).toBeVisible();
  await card.locator("input.ask-other").fill("not on this branch");
  await card.getByRole("button", { name: "Decline" }).click();

  await expect(page.locator(".perm.settled")).toContainText("You declined this");
  await expect(page.locator(".perm.settled")).toContainText("not on this branch");

  const done = await waitForIdle(request, task.id);
  const assistant = done.messages.filter((m: { role: string }) => m.role === "assistant");
  expect(assistant.at(-1).content).toContain("not on this branch");
});

test("'Always allow' remembers the command, skips the next prompt, and is revocable", async ({ page, request }) => {
  const first = await createTask(request, {
    projectId,
    title: "Remember this one",
    description: "e2e:permission=npm test --silent",
  });
  await sendMessage(request, first.id);
  await expect.poll(async () => (await getTask(request, first.id)).awaiting_input, { timeout: 20_000 }).toBe(1);

  await openTask(page, "Remember this one");
  const card = page.locator(".perm").first();
  // The button names the exact rule it will store — `npm test`, not the whole
  // line — so nobody grants more than they read.
  const always = card.getByRole("button", { name: /Always allow `npm test …`/ });
  await expect(always).toBeVisible();
  await always.click();
  await expect(page.locator(".perm.settled")).toContainText("npm test");
  await waitForIdle(request, first.id);

  // The rule is stored, project-scoped, and listed for revocation.
  const listed = await (await request.get("/api/settings/permissions")).json();
  const rule = listed.rules.find((r: { value: string }) => r.value === "npm test");
  expect(rule).toMatchObject({ tool: "Bash", match_kind: "bash_prefix", project_name: PROJECT });

  // A later command covered by that prefix never prompts.
  const second = await createTask(request, {
    projectId,
    title: "Covered by the rule",
    description: "e2e:permission=npm test --watch",
  });
  await sendMessage(request, second.id);
  const done = await waitForIdle(request, second.id);
  expect(done.messages.some((m: { content: string }) => m.content.includes('"permission"'))).toBe(false);

  // Revoking it puts the prompt back.
  const del = await request.delete("/api/settings/permissions", { data: { id: rule.id } });
  expect(del.ok()).toBe(true);
  const after = await (await request.get("/api/settings/permissions")).json();
  expect(after.rules.some((r: { id: string }) => r.id === rule.id)).toBe(false);
});
