// Re-filing a task that has ALREADY RUN, through the Edit-task modal. The
// unstarted case is 06; here the task holds a git worktree cut from the wrong
// repo, and it can only move by discarding that checkout.
//
// The server rules (the two acknowledgements, the live-turn refusal, the child
// rows that follow the task) are pinned by tests/taskMoveWorktree.test.ts. This
// covers that the UI names the cost before it asks, that confirming moves the
// row and reclaims the worktree, and that the next turn runs in the
// DESTINATION repo, which is the reason to discard the checkout.

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import {
  createProject,
  getTask,
  gotoApp,
  makeFixtureRepo,
  runTaskToCompletion,
  sendMessage,
  uid,
  waitForIdle,
} from "./helpers";

const FROM = `Started from ${uid()}`;
const TO = `Started to ${uid()}`;
const TITLE = "Ran in the wrong repo";

let taskId = "";
let toRepo = "";

test.beforeAll(async ({ request }) => {
  // A real turn: the mock agent commits its work, so the task lands with a
  // worktree, a branch, and a commit main never took. This is the unsafe case,
  // since it can lose work.
  const ran = await runTaskToCompletion(request, { name: FROM, title: TITLE });
  taskId = ran.task.id;
  expect(ran.task.worktree_path).toBeTruthy();
  toRepo = makeFixtureRepo("started-to");
  await createProject(request, { name: TO, repoPath: toRepo });
});

test("a started task moves once its worktree is explicitly discarded", async ({ page, request }) => {
  const before = await getTask(request, taskId);
  const worktree = before.worktree_path;
  expect(fs.existsSync(worktree)).toBe(true);

  await gotoApp(page);
  await page.getByText(FROM).first().click();
  await page.locator(".ttitle").filter({ hasText: TITLE }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".dep-row").filter({ hasText: TO }).click();

  // States the cost before asking for confirmation: this worktree carries a
  // commit the base branch never took.
  const warning = page.locator(".hlp").filter({ hasText: /moving deletes them/ });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/not yet in main/);

  // Two-step, like Delete: the first click only arms it.
  await page.getByRole("button", { name: /Discard worktree and move/ }).click();
  await page.getByRole("button", { name: /Move and discard the worktree/ }).click();

  // The row leaves this project's tray…
  await expect(page.locator(".ttitle").filter({ hasText: TITLE })).toBeHidden();
  // …and is waiting in the destination.
  await page.getByText(TO).first().click();
  await expect(page.locator(".ttitle").filter({ hasText: TITLE })).toBeVisible();

  // The checkout is gone from disk and off the row, which is what lets the next
  // turn cut a fresh one.
  const moved = await getTask(request, taskId);
  expect(moved.worktree_path).toBe("");
  expect(moved.started).toBe(1);
  expect(fs.existsSync(worktree)).toBe(false);
  // The transcript is the reason to move instead of delete-and-recreate.
  expect(moved.messages.length).toBeGreaterThan(1);
});

test("its next turn runs in the destination repo", async ({ request }) => {
  await sendMessage(request, taskId, "e2e:write=landed-here.txt:from the new project");
  const settled = await waitForIdle(request, taskId);

  expect(settled.worktree_path).toBeTruthy();
  expect(fs.existsSync(`${settled.worktree_path}/landed-here.txt`)).toBe(true);
  // The fresh worktree is linked to the destination's repo. The old project's
  // README is nowhere in it; the new one's is.
  expect(fs.readFileSync(`${settled.worktree_path}/README.md`, "utf8")).toContain("started-to");
});
