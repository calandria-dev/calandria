// Per-task base branches, end to end: a task pointed at a second branch through
// the edit dialog, merged, and the file landing on THAT branch — while the
// user's own checkout stays exactly where it was, on `main`, untouched.
//
// This is the case unit tests can't prove. `mergeIntoTargetWorktree` lands a
// merge whose target isn't the repo's current branch at the object level, with
// no working tree materialized; only the built server, a real worktree and a
// real repo on disk show that the user's checkout really is left alone.
// Design: docs/superpowers/specs/2026-08-27-per-task-base-branch-design.md.

import { expect, test } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, git, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

test.describe.configure({ mode: "serial" });

const PROJECT = `Base Branch ${uid()}`;
const TASK_TITLE = "Land on the feature branch";
let repoPath: string;
let taskId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  repoPath = makeFixtureRepo("base-branch");
  // A second branch for the task to be retargeted onto. Created from main's tip
  // and left alone: the user's checkout never leaves main for the whole spec.
  git(repoPath, "branch", "feature/auth");

  const project = await createProject(request, { name: PROJECT, repoPath });
  const task = await createTask(request, {
    projectId: project.id,
    title: TASK_TITLE,
    description: "Write the greeting. e2e:write=greeting.txt:hello from the feature branch",
  });
  taskId = task.id;
  // Cut the worktree and do the work FIRST, from main — so the retarget below
  // is the interesting case (a worktree that already exists) rather than a row
  // edit before anything has happened.
  await sendMessage(request, taskId);
  await waitForIdle(request, taskId);
});

test("retargets a started task to another branch from the edit dialog", async ({ page, request }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(TASK_TITLE).first().click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.locator(".modal");
  const field = dialog.locator(".field", { hasText: "Base branch" });
  // The placeholder states what an empty field inherits, so the current answer
  // is readable without the field being filled in.
  await expect(field.locator("input")).toHaveAttribute("placeholder", "main (from the project)");

  await field.locator("input").fill("feature/auth");
  await field.getByRole("button", { name: "Retarget" }).click();

  // Reported, not silent — the tool and the field both say what happened.
  await expect(field.getByText(/Now based on feature\/auth/)).toBeVisible({ timeout: 15_000 });
  const task = await (await request.get(`/api/tasks/${taskId}`)).json();
  expect(task.base_branch).toBe("feature/auth");
});

test("merges into that branch, leaving the user's checkout on main", async ({ page, request }) => {
  await gotoApp(page);
  await page.getByText(PROJECT).first().click();
  await page.getByText(TASK_TITLE).first().click();

  // The merge button names the task's OWN base, not the project's default.
  await page.getByRole("button", { name: /Merge to feature\/auth/ }).click();
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${taskId}`)).json()).merged_at, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // The work is on feature/auth…
  expect(git(repoPath, "show", "feature/auth:greeting.txt")).toBe("hello from the feature branch");
  // …and nowhere near main, which is the whole point of a per-task base.
  expect(() => git(repoPath, "show", "main:greeting.txt")).toThrow();

  // The user's checkout never moved: same branch, same commit, clean tree. A
  // merge that landed by moving the ref of a branch this checkout had open
  // would show the whole thing here as uncommitted deletions.
  expect(git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(repoPath, "status", "--porcelain")).toBe("");
});
