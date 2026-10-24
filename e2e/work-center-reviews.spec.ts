// Review display (design release work-center-design-release/1, section 5): the
// REVIEW rail tab, the phone Review segment, the Work Center review chip and the
// artifact an agent captured. Reviews are opened through the internal
// submit-review route (the stdio bridge's endpoint) because no browser route
// creates one. Decision controls stay disabled in this release.
//
// WC_SHOTS=<dir> writes one screenshot per state and viewport for design review.

import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createProject, createTask, ensureOnboarded, getTask, git, gotoApp, makeFixtureRepo, sendMessage, uid, waitForIdle } from "./helpers";

const PROJECT = `WCReviews ${uid()}`;
let projectId: string;

test.beforeAll(async ({ request }) => {
  await ensureOnboarded(request);
  const project = await createProject(request, { name: PROJECT, repoPath: makeFixtureRepo("wc-reviews") });
  projectId = project.id;
});

const shot = async (page: Page, name: string) => {
  if (process.env.WC_SHOTS) await page.screenshot({ path: `${process.env.WC_SHOTS}/${name}.png` });
};

const DOC = "# Digest design\n\nBatch by user, not by channel.\n";

/** A task whose first turn wrote docs/plan.md into its worktree. */
async function taskWithPlan(request: APIRequestContext, title: string) {
  const task = await createTask(request, { projectId, title, description: `e2e:write=docs/plan.md:placeholder` });
  await sendMessage(request, task.id);
  const settled = await waitForIdle(request, task.id);
  const file = path.join(settled.worktree_path, "docs", "plan.md");
  // The mock writes the directive's literal text; normalise so the bytes are known.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DOC);
  return { id: task.id, title, worktree: settled.worktree_path as string };
}

async function submit(request: APIRequestContext, taskId: string, body: Record<string, unknown>) {
  const res = await request.post("/api/internal/agent-tools/submit-review", {
    data: {
      taskId,
      requestId: null, expectedVersion: 0, expectedSubmissionId: null,
      required: true, summary: "Please review", requestedDecision: "Accept or request changes",
      evidence: [], validation: [{ command: "npm test", result: "passed" }], idempotencyKey: `k-${uid()}`,
      ...body,
    },
  });
  const j = await res.json();
  expect(j.ok, JSON.stringify(j)).toBe(true);
  const m = /request (\S+), submission (\S+), revision (\d+), version (\d+)/.exec(j.text as string)!;
  return { requestId: m[1].replace(/,$/, ""), submissionId: m[2].replace(/,$/, ""), revision: Number(m[3]), version: Number(m[4]) };
}

const submitDoc = (request: APIRequestContext, taskId: string, extra: Record<string, unknown> = {}) =>
  submit(request, taskId, { outputKey: "plan", kind: "document", artifact: { kind: "document", path: "docs/plan.md" }, ...extra });
const submitCode = (request: APIRequestContext, taskId: string, extra: Record<string, unknown> = {}) =>
  submit(request, taskId, { outputKey: "code", kind: "code", artifact: { kind: "code" }, ...extra });

/** Commit a change in the task's worktree so a code review has a diff against main. */
function commitChange(worktree: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(worktree, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", "change for review");
}

const openTask = async (page: Page, taskId: string) => {
  await gotoApp(page, `?project=${projectId}&task=${taskId}`);
};
const tabs = (page: Page) => page.locator(".rail-tabs .rail-tab");
const pane = (page: Page) => page.locator("[data-wc-review]");

test("a task with no review request has no REVIEW tab", async ({ page, request }) => {
  const t = await createTask(request, { projectId, title: `No reviews ${uid()}` });
  await sendMessage(request, t.id);
  await waitForIdle(request, t.id);
  await openTask(page, t.id);
  await expect(tabs(page).first()).toBeVisible();
  await expect(tabs(page).filter({ hasText: "REVIEW" })).toHaveCount(0);
});

test("a stopped turn or an unread document never becomes a review request", async ({ request }) => {
  const t = await taskWithPlan(request, `Quiet ${uid()}`);
  const res = await request.get(`/api/tasks/${t.id}/reviews`);
  expect((await res.json()).requests).toHaveLength(0);
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("document review: exact bytes and digest, REVIEW after CONTEXT, deep link from Work Center", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Doc review ${uid()}`);
    const sub = await submitDoc(request, t.id);
    await gotoApp(page);
    await page.getByRole("button", { name: /^Work Center:/ }).click();
    const row = page.locator("[data-wc-row]").filter({ hasText: t.title });
    await row.getByRole("button", { name: /^Review:/ }).click();

    await expect(tabs(page)).toHaveText(["DIFF", "CONTEXT", /^REVIEW/]);
    await expect(tabs(page).nth(2)).toHaveClass(/\bon\b/);
    await expect(tabs(page).nth(2).locator(".wc-rv-tabdot")).toBeVisible();
    const p = pane(page);
    await expect(p.getByText("Revision 1 · Document")).toBeFocused();
    await expect(p.locator(".wc-rv-tag", { hasText: "Required" })).toBeVisible();
    await expect(p.locator(".wc-rv-tag", { hasText: "Awaiting decision" })).toBeVisible();
    const art = p.locator("[data-wc-artifact=document]");
    await expect(art.locator(".wc-rv-doc")).toHaveText(DOC);
    await expect(art).toContainText("docs/plan.md");
    await expect(art).toContainText(`${Buffer.byteLength(DOC)} bytes`);
    const digest = await art.locator(".wc-rv-digest").first().textContent();
    expect(digest).toMatch(/sha256 [0-9a-f]{64}/);
    await shot(page, "desktop-review-document");

    // Latest mutable content is never passed off as the captured artifact.
    fs.writeFileSync(path.join(t.worktree, "docs", "plan.md"), DOC + "Edited after submission.\n");
    await page.reload();
    await openTask(page, t.id);
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    await expect(p.locator(".wc-rv-doc")).toHaveText(DOC);
    await expect(p.locator(".wc-rv-tag", { hasText: "Changed since" })).toBeVisible();
    await expect(p.getByRole("button", { name: /Current file differs from this revision/ })).toBeDisabled();
    await shot(page, "desktop-review-document-changed");
    void sub;
  });

  test("decision controls are disabled and Accept anyway does not exist", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Disabled ${uid()}`);
    await submitDoc(request, t.id);
    await openTask(page, t.id);
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    const dec = pane(page).getByRole("region", { name: "Decision" });
    await expect(dec.getByRole("button", { name: /^Accept rev 1/ })).toBeDisabled();
    await expect(dec.getByRole("button", { name: /^Request changes/ })).toBeDisabled();
    await expect(dec.getByRole("button", { name: /^Waive/ })).toBeDisabled();
    await expect(pane(page).getByText(/anyway/i)).toHaveCount(0);
  });

  test("two requests, a resubmission, and a superseded revision", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Many ${uid()}`);
    const doc1 = await submitDoc(request, t.id);
    commitChange(t.worktree, { "src/a.ts": "export const a = 1;\n" });
    await submitCode(request, t.id);
    fs.writeFileSync(path.join(t.worktree, "docs", "plan.md"), DOC.replace("user", "recipient"));
    await submitDoc(request, t.id, { requestId: doc1.requestId, expectedVersion: doc1.version, expectedSubmissionId: doc1.submissionId });

    await openTask(page, t.id);
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    const p = pane(page);
    await expect(p.getByRole("group", { name: "Review requests on this task" }).getByRole("button")).toHaveCount(2);

    await p.getByRole("button", { name: /^plan/ }).click();
    await expect(p.getByText("Revision 2 · Document")).toBeVisible();
    await expect(p.locator(".wc-rv-doc")).toContainText("recipient");
    const hist = p.getByRole("region", { name: "Revisions" }).getByRole("button");
    await expect(hist).toHaveCount(2);
    await hist.nth(1).click();
    await expect(p.getByText("Revision 1 · Document")).toBeVisible();
    await expect(p.locator(".wc-rv-doc")).toHaveText(DOC);
    await expect(p.locator(".wc-rv-tag", { hasText: "Superseded" })).toBeVisible();
    await expect(p.getByRole("button", { name: /Go to rev 2/ })).toBeVisible();
    await shot(page, "desktop-review-superseded");
    await p.getByRole("button", { name: /Go to rev 2/ }).click();
    await expect(p.getByText("Revision 2 · Document")).toBeVisible();

    await p.getByRole("button", { name: /^code/ }).click();
    const code = p.locator("[data-wc-artifact=code]");
    await expect(code.locator(".wc-rv-pre")).toContainText("export const a = 1;");
    await expect(code.locator(".wc-rv-pre .a").first()).toBeVisible();
    await expect(code).toContainText("src/a.ts");
    await shot(page, "desktop-review-code");
    // The doc was edited after the code was captured, so the checkout is dirty: the Diff tab
    // would show something else, and the link is blocked with the reason.
    await expect(code.getByRole("button", { name: /Diff tab shows the live branch, which no longer matches this revision/ })).toBeDisabled();
  });

  test("a diff over the preview limit says PREVIEW TRUNCATED", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Huge ${uid()}`);
    const files: Record<string, string> = {};
    for (let i = 0; i < 1001; i++) files[`gen/f${i}.txt`] = `${i}\n`;
    commitChange(t.worktree, files);
    await submitCode(request, t.id);
    await openTask(page, t.id);
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    const code = pane(page).locator("[data-wc-artifact=code]");
    await expect(code.locator(".wc-rv-trunc")).toContainText("PREVIEW TRUNCATED");
    await expect(code).toContainText("pinned commits are complete");
    // The pinned range is identified, and the Diff tab opens while the branch still matches.
    await code.getByRole("button", { name: /Open the full diff in the Diff tab · pinned [0-9a-f]{7}…[0-9a-f]{7}/ }).click();
    await expect(tabs(page).first()).toHaveClass(/\bon\b/);
    await shot(page, "desktop-review-truncated");
  });

  test("the rail stacks the decision buttons under 380px", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Narrow ${uid()}`);
    await submitDoc(request, t.id);
    await openTask(page, t.id);
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    const btns = pane(page).locator(".wc-rv-btns").first();
    await expect(btns).toHaveCSS("flex-direction", "row");
    await page.evaluate(() => { (document.querySelector("[data-wc-review]") as HTMLElement).style.width = "340px"; });
    await expect(btns).toHaveCSS("flex-direction", "column");
  });

  test("withdrawn and unavailable artifacts render a state, not a blank", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Gone ${uid()}`);
    const r = await submitDoc(request, t.id);
    const res = await request.post("/api/internal/agent-tools/withdraw-review", {
      data: { taskId: t.id, requestId: r.requestId, expectedVersion: r.version, idempotencyKey: `w-${uid()}`, reason: "no longer needed" },
    });
    expect((await res.json()).ok).toBe(true);
    await openTask(page, t.id);
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    const p = pane(page);
    await expect(p.locator(".wc-rv-tag", { hasText: "Withdrawn" })).toBeVisible();
    await expect(p.getByText("No decision is offered on a withdrawn submission.")).toBeVisible();
    await expect(tabs(page).nth(2).locator(".wc-rv-tabdot")).toHaveCount(0);
    void getTask;
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test("Chat, Changes, Review segments appear only with a review request, and decisions are stacked", async ({ page, request }) => {
    const none = await createTask(request, { projectId, title: `Phone none ${uid()}` });
    await sendMessage(request, none.id);
    await waitForIdle(request, none.id);
    const t = await taskWithPlan(request, `Phone review ${uid()}`);
    await submitDoc(request, t.id);

    const open = (id: string) => openTask(page, id);
    await open(none.id);
    await expect(page.locator(".viewseg-btn")).toHaveText(["Chat", "Changes"]);

    await open(t.id);
    await expect(page.locator(".viewseg-btn")).toHaveText(["Chat", "Changes", /^Review/]);
    await page.locator(".viewseg-btn", { hasText: "Review" }).click();
    const p = pane(page);
    await expect(p.locator(".wc-rv-doc")).toHaveText(DOC);
    await expect(p.locator(".wc-rv-btns").first()).toHaveCSS("flex-direction", "column");
    await expect(p.getByRole("button", { name: /^Accept rev 1/ })).toBeDisabled();
    await shot(page, "phone-review");
  });
});
