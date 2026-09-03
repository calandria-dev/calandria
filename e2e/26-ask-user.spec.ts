// AskUserQuestion driven through the real UI: a turn parks on a question card,
// the user picks in the transcript, and the turn resumes with what they chose.
//
// This is the OTHER half of lib/asks.ts. 09-permissions.spec.ts covers the
// canUseTool card; this covers the ask card, which is a different render path
// (AskView in app/shell/Transcript.tsx — option pickers, multi-select, a free
// text "Other") and a different answer shape (AskAnswers, one entry per
// question, rather than one decision).
//
// The mock's `e2e:ask=` directive calls lib/agentTools.startAskUser and then
// polls takeAskOutcome(), which is exactly what the stdio bridge's `ask_user`
// tool does for a non-Claude agent — the path with no browser coverage at all
// before this file. Everything here except the HTTP hop between the bridge and
// the server is the production path.

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

const PROJECT = `Asks ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("asks") });
  projectId = project.id;
});

// Open the app on a task and wait for its transcript to render.
async function openTask(page: import("@playwright/test").Page, title: string) {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(title, { exact: true }).first().click();
}

// Park a fresh task on an ask card and return it, once the task reads as both
// live and needing you — the two facts that make the card answerable.
async function parkOnAsk(
  request: import("@playwright/test").APIRequestContext,
  title: string,
  description: string
) {
  const task = await createTask(request, { projectId, title, description });
  await sendMessage(request, task.id);
  await expect
    .poll(async () => {
      const t = await getTask(request, task.id);
      return t.running === 1 && t.awaiting_input === 1;
    }, { timeout: 20_000, message: `task ${task.id} never parked on its question` })
    .toBe(true);
  return task;
}

test("a turn parks on a question, docks it, and resumes with the answer", async ({ page, request }) => {
  const task = await parkOnAsk(
    request,
    "Ask before deploying",
    "e2e:ask=Target|Where should this go?|Staging,Production"
  );

  await openTask(page, "Ask before deploying");
  const card = page.locator(".ask").first();
  await expect(card).toBeVisible();
  await expect(card.locator(".ask-chip")).toHaveText("Target");
  await expect(card.locator(".ask-qh")).toContainText("Where should this go?");
  await expect(card.locator(".ask-opt")).toHaveCount(2);

  // DOCKED below the transcript, not sitting in it. Inline, the one row the
  // turn is parked on is at the mercy of whatever streams in after it — one
  // subagent returning a screenful scrolls the question away and nothing then
  // says an answer is owed. Lifted out of the flow, so it appears exactly once.
  await expect(page.locator(".prompt-dock .ask")).toBeVisible();
  await expect(page.locator(".ask")).toHaveCount(1);

  // Nothing to send until something is picked.
  const send = card.getByRole("button", { name: "Send answer" });
  await expect(send).toBeDisabled();
  await card.getByRole("button", { name: "Staging" }).click();
  await expect(send).toBeEnabled();
  await send.click();

  // Answered, so it settles back into the transcript where it was asked, as a
  // read-only summary of what was chosen.
  const answered = page.locator(".ask.answered");
  await expect(answered).toContainText("You answered");
  await expect(answered.locator(".ask-picked")).toHaveText("Staging");
  await expect(page.locator(".prompt-dock")).toHaveCount(0);

  // And the turn resumed: the choice reached the MODEL, not just the database.
  const done = await waitForIdle(request, task.id);
  const assistant = done.messages.filter((m: { role: string }) => m.role === "assistant");
  expect(assistant.some((m: { content: string }) => m.content.includes("- Target: Staging"))).toBe(true);
  expect(done.awaiting_input).toBe(1); // turn ended — ordinary "your move"
});

test("a multi-select question takes several options and a typed 'Other'", async ({ page, request }) => {
  const task = await parkOnAsk(
    request,
    "Ask what to include",
    "e2e:ask=Scope|Which parts should I touch?|Server,Client|multi"
  );

  await openTask(page, "Ask what to include");
  const card = page.locator(".prompt-dock .ask");
  await expect(card).toBeVisible();
  await expect(card.locator(".ask-multi")).toHaveText("pick any");

  // Multi-select accumulates rather than replacing, and the free-text field is
  // an extra answer alongside the picks instead of clearing them.
  await card.getByRole("button", { name: "Server" }).click();
  await card.getByRole("button", { name: "Client" }).click();
  await card.locator("input.ask-other").fill("Docs too");
  await card.getByRole("button", { name: "Send answer" }).click();

  await expect(page.locator(".ask.answered .ask-picked")).toHaveText("Server, Client, Docs too");

  const done = await waitForIdle(request, task.id);
  const assistant = done.messages.filter((m: { role: string }) => m.role === "assistant");
  expect(assistant.some((m: { content: string }) => m.content.includes("- Scope: Server, Client, Docs too"))).toBe(true);
});

test("one card carrying two questions is answered as a whole", async ({ page, request }) => {
  // A parallel batch really can park on several questions at once, so the dock
  // is a list. Answering has to be all-or-nothing: a half-filled card would
  // send an AskAnswers with a hole in it.
  const task = await parkOnAsk(
    request,
    "Ask two things",
    "e2e:ask=Runtime|Which runtime?|Node,Deno\ne2e:ask=Style|Which formatter?|Prettier,Biome"
  );

  await openTask(page, "Ask two things");
  const card = page.locator(".prompt-dock .ask");
  await expect(card.locator(".ask-q")).toHaveCount(2);

  const send = card.getByRole("button", { name: "Send answer" });
  await card.getByRole("button", { name: "Node" }).click();
  await expect(send).toBeDisabled(); // one of two — not an answer yet
  await card.getByRole("button", { name: "Biome" }).click();
  await send.click();

  const picked = page.locator(".ask.answered .ask-picked");
  await expect(picked).toHaveCount(2);
  await expect(picked.nth(0)).toHaveText("Node");
  await expect(picked.nth(1)).toHaveText("Biome");

  const done = await waitForIdle(request, task.id);
  const assistant = done.messages.filter((m: { role: string }) => m.role === "assistant");
  // Plural, and both answers, in the text the model reads back.
  expect(assistant.some((m: { content: string }) =>
    m.content.includes("answered your questions") &&
    m.content.includes("- Runtime: Node") &&
    m.content.includes("- Style: Biome"))).toBe(true);
});
