// Final acceptance journey (WC-19): one person, two projects. Running work shows
// in the Work Center across both, the question is answered, a code review is
// opened, changes are requested, the agent resubmits, the person accepts rev 2
// and lands it from the Diff tab, and the landed receipt then lets the task
// complete. A snoozed task with a required review still refuses done. The
// unit suite (tests/reviewRecovery.test.ts, reviewGates.test.ts,
// reviewGateSafety.test.ts) owns the restart, pending-effect delete and
// creation-off cases that a hermetic browser run cannot stage.

import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, git, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

let projA: string;
let projB: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  projA = (await createProject(request, { name: `Accept A ${uid()}`, repoPath: makeFixtureRepo("wc-accept-a") })).id;
  projB = (await createProject(request, { name: `Accept B ${uid()}`, repoPath: makeFixtureRepo("wc-accept-b") })).id;
});

const pill = (page: Page) => page.getByRole("button", { name: /^Work Center:/ });
const pane = (page: Page) => page.locator("[data-wc-review]");
const decision = (page: Page) => pane(page).getByRole("region", { name: "Decision" });

async function submitCode(request: APIRequestContext, taskId: string, extra: Record<string, unknown> = {}) {
  const res = await request.post("/api/internal/agent-tools/submit-review", {
    data: {
      taskId, requestId: null, expectedVersion: 0, expectedSubmissionId: null, required: true,
      summary: "Please review", requestedDecision: "Accept or request changes", evidence: [],
      validation: [{ command: "npm test", result: "passed" }], idempotencyKey: `k-${uid()}`,
      outputKey: "code", kind: "code", artifact: { kind: "code" }, ...extra,
    },
  });
  const j = await res.json();
  expect(j.ok, JSON.stringify(j)).toBe(true);
  return j;
}

function commit(worktree: string, rel: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(worktree, rel)), { recursive: true });
  fs.writeFileSync(path.join(worktree, rel), body);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", `change ${rel}`);
}

async function reviewsOf(request: APIRequestContext, taskId: string) {
  return (await (await request.get(`/api/tasks/${taskId}/reviews`)).json()).requests as any[];
}

test.use({ viewport: { width: 1280, height: 860 } });

test("review journey: question, request changes, resubmit, accept, land, complete", async ({ page, request }) => {
  // Running work in both projects reaches the one projection.
  const ask = await createTask(request, { projectId: projB, title: `Ask ${uid()}`, description: "e2e:ask=Mode|Which mode?|Fast,Safe" });
  await sendMessage(request, ask.id);
  await expect.poll(async () => (await getTask(request, ask.id)).awaiting_input).toBe(1);

  const t = await createTask(request, { projectId: projA, title: `Journey ${uid()}`, description: "e2e:write=src/seed.txt:seed" });
  await sendMessage(request, t.id);
  const settled = await waitForIdle(request, t.id);
  const wt = settled.worktree_path as string;
  commit(wt, "src/a.ts", "export const a = 1;\n");
  const r1 = await submitCode(request, t.id);

  await gotoApp(page);
  await pill(page).click();
  await expect(page.locator("[data-wc-row]").filter({ hasText: ask.title })).toBeVisible();
  const row = page.locator("[data-wc-row]").filter({ hasText: t.title });
  await row.getByRole("button", { name: /^Review:/ }).click();
  await expect(pane(page)).toBeVisible();

  // Request changes, then the agent resubmits a new revision.
  await decision(page).getByRole("button", { name: /^Request changes/ }).click();
  await decision(page).getByLabel("Feedback for the agent").fill("Add a second export.");
  await decision(page).getByRole("button", { name: "Send feedback" }).click();
  await expect(decision(page).getByText("Changes requested · delivered to the agent.")).toBeVisible({ timeout: 30_000 });
  await waitForIdle(request, t.id);
  const cur = (await reviewsOf(request, t.id))[0];
  commit(wt, "src/b.ts", "export const b = 2;\n");
  await submitCode(request, t.id, { requestId: cur.id ?? r1.requestId, expectedVersion: cur.version, expectedSubmissionId: cur.currentSubmission.id });

  // A required review blocks done, snoozed or not.
  const snz = await request.patch(`/api/tasks/${t.id}`, { data: { snoozed_until: Date.now() + 3_600_000 } });
  expect(snz.ok()).toBe(true);
  const early = await request.patch(`/api/tasks/${t.id}`, { data: { status: "done" } });
  expect(early.status()).toBe(409);
  expect((await early.json()).code).toBe("review_required");
  await request.patch(`/api/tasks/${t.id}`, { data: { snoozed_until: 0 } });

  // Accept rev 2 and land from the Diff tab; the landed receipt unblocks completion.
  await decision(page).getByRole("button", { name: /Go to rev 2/ }).click({ timeout: 30_000 });
  await decision(page).getByRole("button", { name: /^Accept rev 2/ }).click({ timeout: 30_000 });
  await expect(pane(page)).toHaveAttribute("data-wc-review-state", "accepted");
  await decision(page).getByRole("button", { name: /^Merge from landing controls/ }).click();
  await page.getByRole("button", { name: /Merge to main/ }).click();
  await expect.poll(async () => (await getTask(request, t.id)).merged_at, { timeout: 20_000 }).toBeTruthy();
  await expect.poll(async () => (await reviewsOf(request, t.id))[0].applicability.state).toBe("landed");

  const done = await request.patch(`/api/tasks/${t.id}`, { data: { status: "done" } });
  expect(done.ok(), await done.text()).toBe(true);

  // Reload keeps the outcome.
  await page.reload();
  expect((await reviewsOf(request, t.id))[0].state).toBe("accepted");
});
