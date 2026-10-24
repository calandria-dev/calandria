// Review display (design release work-center-design-release/1, section 5): the
// REVIEW rail tab, the phone Review segment, the Work Center review chip and the
// artifact an agent captured. Reviews are opened through the internal
// submit-review route (the stdio bridge's endpoint) because no browser route
// creates one. The decision controls post to the review action route.
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
const decision = (page: Page) => pane(page).getByRole("region", { name: "Decision" });
const outStrip = (page: Page) => pane(page).locator(".wc-rv-out");
const ACTIONS_URL = /\/api\/tasks\/[^/]+\/reviews\/[^/]+\/actions$/;

async function openReview(page: Page, taskId: string) {
  await openTask(page, taskId);
  await tabs(page).filter({ hasText: "REVIEW" }).click();
  await expect(pane(page)).toBeVisible();
}

async function reviewsOf(request: APIRequestContext, taskId: string) {
  const res = await request.get(`/api/tasks/${taskId}/reviews`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).requests as any[];
}

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

  test("decision controls are live and there is no Accept anyway", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Live ${uid()}`);
    await submitDoc(request, t.id);
    await openReview(page, t.id);
    const dec = decision(page);
    await expect(dec.getByRole("button", { name: /^Accept rev 1/ })).toBeEnabled();
    await expect(dec.getByRole("button", { name: /^Request changes/ })).toBeEnabled();
    await expect(dec.getByRole("button", { name: /^Waive/ })).toBeEnabled();
    await expect(pane(page).getByText(/anyway/i)).toHaveCount(0);
    await expect(pane(page).getByText(/still possible if you change your mind/i)).toHaveCount(0);
    await dec.getByRole("button", { name: /^Request changes/ }).click();
    await expect(pane(page).getByText(/anyway/i)).toHaveCount(0);
    await expect(pane(page).getByText(/still possible if you change your mind/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /anyway/i })).toHaveCount(0);
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
    await shot(page, "desktop-review-narrow-rail");
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

  test("accept from the Review tab records approval and does not merge", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Accept ${uid()}`);
    commitChange(t.worktree, { "src/acc.ts": "export const acc = 1;\n" });
    await submitCode(request, t.id);
    await openReview(page, t.id);
    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect(outStrip(page).filter({ hasText: "Revision accepted." })).toBeVisible();
    await shot(page, "desktop-review-accepted-ok");
    await expect(pane(page)).toHaveAttribute("data-wc-review-state", "accepted");
    await expect(pane(page).locator(".wc-rv-tag", { hasText: "Accepted" })).toBeVisible();
    const merge = decision(page).getByRole("button", { name: /^Merge from landing controls/ });
    await expect(merge).toBeVisible();

    const task = await getTask(request, t.id);
    expect(task.status).not.toBe("done");
    expect(task.merged_at ?? 0).toBeFalsy();
    expect(fs.existsSync(t.worktree)).toBe(true);
    expect((await reviewsOf(request, t.id))[0].state).toBe("accepted");

    await merge.click();
    await expect(tabs(page).first()).toHaveClass(/\bon\b/);
    await expect(tabs(page).first()).toHaveText(/DIFF/);
  });

  test("request changes: feedback needs text, is sent, and a resubmission supersedes the old controls", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Feedback ${uid()}`);
    const r1 = await submitDoc(request, t.id);
    await openReview(page, t.id);
    await decision(page).getByRole("button", { name: /^Request changes/ }).click();
    const send = decision(page).getByRole("button", { name: "Send feedback" });
    await expect(send).toBeDisabled();
    await decision(page).getByLabel("Feedback for the agent").fill("Please cover the retry path.");
    await shot(page, "desktop-review-compose");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(decision(page).getByText(/Changes requested · delivered to the agent\.|Feedback recorded · delivering to the agent…/)).toBeVisible({ timeout: 30_000 });
    await expect(decision(page).getByText("Changes requested · delivered to the agent.")).toBeVisible({ timeout: 30_000 });
    await waitForIdle(request, t.id);

    const cur = (await reviewsOf(request, t.id))[0];
    fs.writeFileSync(path.join(t.worktree, "docs", "plan.md"), DOC + "Retry path covered.\n");
    await submitDoc(request, t.id, { requestId: r1.requestId, expectedVersion: cur.version, expectedSubmissionId: cur.currentSubmission.id });
    await expect(decision(page).getByRole("button", { name: /^Accept rev 2/ })).toBeVisible({ timeout: 30_000 });
    await expect(decision(page).getByRole("button", { name: /^Accept rev 1/ })).toHaveCount(0);
  });

  test("waive needs a reason, Escape closes the form and returns focus, then a waiver is recorded", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Waive ${uid()}`);
    await submitDoc(request, t.id);
    await openReview(page, t.id);
    const opener = decision(page).getByRole("button", { name: /^Waive…/ });
    await opener.click();
    await expect(decision(page).getByText("Waive required review · rev 1")).toBeVisible();
    await shot(page, "desktop-review-waive-form");
    const waive = decision(page).getByRole("button", { name: "Waive", exact: true });
    await expect(waive).toBeDisabled();
    await decision(page).getByLabel("Reason for waiving").fill("   ");
    await expect(waive).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(decision(page).getByText("Waive required review · rev 1")).toHaveCount(0);

    await opener.click();
    await decision(page).getByLabel("Reason for waiving").fill("Covered by the design review.");
    await expect(waive).toBeEnabled();
    await waive.click();
    await expect(outStrip(page).filter({ hasText: /Requirement waived for this submission\.|Waived for this submission\./ })).toBeVisible();
    await expect(decision(page).getByText("Waived for this submission.")).toBeVisible({ timeout: 10_000 });
    expect((await reviewsOf(request, t.id))[0].state).toBe("waived");
  });

  test("a failed accept offers Retry and replays under the same idempotency key", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Retry ${uid()}`);
    await submitDoc(request, t.id);
    await openReview(page, t.id);
    const bodies: any[] = [];
    await page.route(ACTIONS_URL, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "snapshot_busy", message: "busy", retryable: true } }) });
    });
    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect(outStrip(page).filter({ hasText: "Acceptance not recorded (503)." })).toBeVisible();
    await shot(page, "desktop-review-accept-fail");
    await expect(decision(page).getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(decision(page).getByRole("button", { name: "Dismiss" })).toBeVisible();
    await page.unroute(ACTIONS_URL);
    const second: any[] = [];
    page.on("request", (r) => { if (ACTIONS_URL.test(r.url()) && r.method() === "POST") second.push(r.postDataJSON()); });
    await decision(page).getByRole("button", { name: "Retry" }).click();
    await expect(outStrip(page).filter({ hasText: "Revision accepted." })).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].idempotencyKey).toBeTruthy();
    expect(second[0].idempotencyKey).toBe(bodies[0].idempotencyKey);
    expect((await reviewsOf(request, t.id))[0].state).toBe("accepted");
  });

  test("an accept with no reply is an unknown result and Retry waits for May duplicate", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Unknown ${uid()}`);
    await submitDoc(request, t.id);
    await openReview(page, t.id);
    await page.route(ACTIONS_URL, (route) => route.abort());
    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect(outStrip(page).filter({ hasText: "Unknown result." })).toBeVisible();
    await shot(page, "desktop-review-accept-unknown");
    const retry = decision(page).getByRole("button", { name: "Retry" });
    await expect(retry).toBeDisabled();
    await expect(decision(page).getByRole("button", { name: "Leave as is" })).toBeVisible();
    await decision(page).getByLabel("May duplicate").check();
    await expect(retry).toBeEnabled();
  });

  test("feedback that was not recorded keeps its text and Dismiss makes it editable again", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Unrecorded ${uid()}`);
    await submitDoc(request, t.id);
    await openReview(page, t.id);
    await page.route(ACTIONS_URL, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "boom" } }) }));
    await decision(page).getByRole("button", { name: /^Request changes/ }).click();
    await decision(page).getByLabel("Feedback for the agent").fill("Tighten the intro.");
    await decision(page).getByRole("button", { name: "Send feedback" }).click();
    await expect(outStrip(page).filter({ hasText: "Feedback not recorded (500)." })).toBeVisible();
    await shot(page, "desktop-review-feedback-not-recorded");
    const ro = decision(page).getByLabel("Your feedback");
    await expect(ro).toHaveValue("Tighten the intro.");
    await expect(ro).not.toBeEditable();
    await decision(page).getByRole("button", { name: "Dismiss" }).click();
    const field = decision(page).getByLabel("Feedback for the agent");
    await expect(field).toBeEditable();
    await expect(field).toHaveValue("Tighten the intro.");
  });

  test("two tabs: the winning accept refuses the other tab's feedback", async ({ page, context, request }) => {
    const t = await taskWithPlan(request, `Race ${uid()}`);
    await submitDoc(request, t.id);
    const pageB = await context.newPage();
    await pageB.setViewportSize({ width: 1280, height: 860 });
    await openReview(page, t.id);
    await openReview(pageB, t.id);
    await decision(pageB).getByRole("button", { name: /^Request changes/ }).click();
    await decision(pageB).getByLabel("Feedback for the agent").fill("Late feedback from tab B.");

    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect(outStrip(page).filter({ hasText: "Revision accepted." })).toBeVisible();
    await expect.poll(async () => (await reviewsOf(request, t.id))[0].state).toBe("accepted");

    await decision(pageB).getByRole("button", { name: "Send feedback" }).click();
    const fail = pageB.locator(".wc-rv-out.fail");
    await expect(fail).toBeVisible();
    await expect(fail).toContainText(/changed|version|accepted|moved/i);
    await decision(pageB).getByRole("button", { name: "Dismiss" }).click();
    await expect(pane(pageB)).toHaveAttribute("data-wc-review-state", "accepted");

    // The request's history page carries every action on it: one acceptance, and the refused feedback left no row.
    const res = await request.get(`/api/tasks/${t.id}/reviews?request_id=${(await reviewsOf(request, t.id))[0].id}&limit=100`);
    const j = await res.json();
    expect(j.requests[0].state).toBe("accepted");
    const actions = j.history.actions as Array<{ action: string }>;
    expect(actions.filter((a) => a.action === "accept")).toHaveLength(1);
    expect(actions.filter((a) => a.action === "request_changes")).toHaveLength(0);
  });

  // Closing the waive form returns focus to its opener, which remounts when the form closes.
  test("Escape in the waive form returns focus to the Waive… button", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Waive focus ${uid()}`);
    await submitDoc(request, t.id);
    await openReview(page, t.id);
    await decision(page).getByRole("button", { name: /^Waive…/ }).click();
    await expect(decision(page).getByLabel("Reason for waiving")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(decision(page).getByRole("button", { name: /^Waive…/ })).toBeFocused();
  });

  // A refused feedback send, once dismissed, closes the form and shows the winning decision.
  test("after a refused send is dismissed the other tab shows Accepted, not the feedback form", async ({ page, context, request }) => {
    const t = await taskWithPlan(request, `Race form ${uid()}`);
    await submitDoc(request, t.id);
    const pageB = await context.newPage();
    await pageB.setViewportSize({ width: 1280, height: 860 });
    await openReview(page, t.id);
    await openReview(pageB, t.id);
    await decision(pageB).getByRole("button", { name: /^Request changes/ }).click();
    await decision(pageB).getByLabel("Feedback for the agent").fill("Late feedback from tab B.");
    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect.poll(async () => (await reviewsOf(request, t.id))[0].state).toBe("accepted");
    await decision(pageB).getByRole("button", { name: "Send feedback" }).click();
    await expect(pageB.locator(".wc-rv-out.fail")).toBeVisible();
    await shot(pageB, "desktop-review-conflict");
    await decision(pageB).getByRole("button", { name: "Dismiss" }).click();
    await expect(pageB.getByRole("button", { name: /^Merge from landing controls/ })).toBeVisible();
  });

  test("a failed feedback delivery offers Retry delivery after the duplicate acknowledgement", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Redeliver ${uid()}`);
    await submitDoc(request, t.id);
    // The pane refetches on focus and on every Work Center event, so a refetch can still be in
    // flight when the test ends; the patch gives up quietly once the page is gone.
    await page.route((u) => /\/api\/tasks\/[^/]+\/reviews$/.test(u.pathname), async (route) => {
      const res = await route.fetch().catch(() => null);
      const j = res ? await res.json().catch(() => null) : null;
      if (!res || !j) return route.abort().catch(() => {});
      const r = j.requests[0];
      r.state = "changes_requested";
      r.latestAction = { ...(r.latestAction ?? {}), id: "act-e2e-failed", action: "request_changes", state: "failed" };
      r.allowedActions = ["retry_feedback", "withdraw", "waive"];
      await route.fulfill({ response: res, json: j }).catch(() => {});
    });
    await openReview(page, t.id);
    await expect(outStrip(page).filter({ hasText: "Feedback not delivered." })).toBeVisible();
    const retry = decision(page).getByRole("button", { name: "Retry delivery" });
    await shot(page, "desktop-review-retry-delivery");
    await expect(retry).toBeDisabled();
    // One acknowledgement per attempt: a dismissed failed retry asks again.
    await page.route(ACTIONS_URL, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "snapshot_busy", message: "busy", retryable: true } }) }));
    await decision(page).getByLabel("The agent may receive this twice").check();
    await retry.click();
    await expect(outStrip(page).filter({ hasText: "Feedback not recorded (503)." })).toBeVisible();
    await decision(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(decision(page).getByLabel("The agent may receive this twice")).not.toBeChecked();
    await expect(retry).toBeDisabled();
    await page.unroute(ACTIONS_URL);
    const posts: any[] = [];
    await page.route(ACTIONS_URL, async (route) => {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ requestId: "r", action: { id: "act-e2e-retry", state: "pending" } }) });
    });
    await decision(page).getByLabel("The agent may receive this twice").check();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].action).toBe("retry_feedback");
    expect(posts[0].reason).toBe("Retry acknowledged: the agent may receive this feedback twice.");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("accepted, then changed: the pane asks for a resubmission and focuses an empty composer", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Changed ${uid()}`);
    commitChange(t.worktree, { "src/one.ts": "export const one = 1;\n" });
    await submitCode(request, t.id);
    await openReview(page, t.id);
    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect(pane(page)).toHaveAttribute("data-wc-review-state", "accepted");
    commitChange(t.worktree, { "src/two.ts": "export const two = 2;\n" });
    await page.reload();
    await tabs(page).filter({ hasText: "REVIEW" }).click();
    await expect(outStrip(page).filter({ hasText: "Rev 1 was accepted, then it changed." })).toBeVisible();
    const ask = decision(page).getByRole("button", { name: "Ask agent to resubmit" });
    await shot(page, "desktop-review-accepted-changed");
    await ask.click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("comp-input") ?? false)).toBe(true);
    await expect(page.locator(".comp-input")).toHaveText("");
  });

  test("Work Center row: Accept and Waive act on the leading review item", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Row ${uid()}`);
    await submitDoc(request, t.id);
    await gotoApp(page);
    await page.getByRole("button", { name: /^Work Center:/ }).click();
    const row = page.locator("[data-wc-row]").filter({ hasText: t.title });
    const accept = row.getByRole("button", { name: /^Accept rev 1/ });
    const waive = row.getByRole("button", { name: /^Waive…/ });
    await expect(accept).toBeVisible();
    await expect(waive).toBeVisible();

    await waive.click();
    const dlg = page.getByRole("dialog", { name: "Waive required review, rev 1" });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText("Waive required review · rev 1")).toBeVisible();
    await shot(page, "desktop-wc-waive-popover");
    const go = dlg.getByRole("button", { name: "Waive", exact: true });
    await expect(go).toBeDisabled();
    await dlg.getByLabel("Reason for waiving").fill("because");
    await expect(go).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(waive).toBeFocused();

    await accept.click();
    await expect(row.locator(".wc-out.ok")).toContainText("Revision accepted.");
    await shot(page, "desktop-wc-accept-ok");
    await expect(row.getByRole("button", { name: /^Review:/ })).toHaveCount(0);
  });

  test("Work Center row: a refused, failed or unanswered decision shows its own strip", async ({ page, request }) => {
    const t = await taskWithPlan(request, `RowFail ${uid()}`);
    await submitDoc(request, t.id);
    await gotoApp(page);
    await page.getByRole("button", { name: /^Work Center:/ }).click();
    const row = page.locator("[data-wc-row]").filter({ hasText: t.title });
    const accept = row.getByRole("button", { name: /^Accept rev 1/ });
    const reply = (status: number, body: unknown) => page.route(ACTIONS_URL, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));
    const out = row.locator(".wc-out");

    // The review moved: Dismiss only.
    await reply(409, { error: { code: "version_conflict", message: "the review changed since you read it", retryable: true }, current: { version: 9, state: "accepted", submissionId: null } });
    await accept.click();
    await expect(out).toContainText("The review changed since you read it.");
    await expect(out.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await out.getByRole("button", { name: "Dismiss" }).click();
    await page.unroute(ACTIONS_URL);

    // A 4xx that a resend cannot fix: Dismiss only.
    await reply(403, { error: { code: "human_required", message: "a person has to decide", retryable: false } });
    await accept.click();
    await expect(out).toContainText("Acceptance not recorded (403).");
    await expect(out.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await out.getByRole("button", { name: "Dismiss" }).click();
    await page.unroute(ACTIONS_URL);

    // A transient failure offers Retry.
    await reply(503, { error: { code: "snapshot_busy", message: "busy", retryable: true } });
    await accept.click();
    await expect(out).toContainText("Acceptance not recorded (503).");
    await expect(out.getByRole("button", { name: "Retry" })).toBeVisible();
    await out.getByRole("button", { name: "Dismiss" }).click();
    await page.unroute(ACTIONS_URL);

    // A 2xx whose action failed is a failure, never a success.
    await reply(200, { requestId: "r", submissionId: "s", version: 2, state: "accepted", action: { id: "a", state: "failed", decisionApplied: true, errorCode: "dirty_checkout", operation: null } });
    await accept.click();
    await expect(out).toContainText("Acceptance not recorded (dirty_checkout).");
    await out.getByRole("button", { name: "Dismiss" }).click();
    await page.unroute(ACTIONS_URL);

    // No answer: unknown result, and the row stays decidable.
    await page.route(ACTIONS_URL, (route) => route.abort());
    await accept.click();
    await expect(out).toContainText("Unknown result.");
    await expect(out.getByRole("button", { name: "Retry" })).toBeDisabled();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("a code review states the manifest digest and the full base and head", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Digest ${uid()}`);
    commitChange(t.worktree, { "src/d.ts": "export const d = 1;\n" });
    await submitCode(request, t.id);
    await openReview(page, t.id);
    const code = pane(page).locator("[data-wc-artifact=code]");
    await expect(code.getByText(/^manifest sha256 [0-9a-f]{64}$/)).toBeVisible();
    await expect(code.getByText(/^base [0-9a-f]{40}$/)).toBeVisible();
    await expect(code.getByText(/^head [0-9a-f]{40}$/)).toBeVisible();
  });

  test("a diff over the size limit names the reason", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Big ${uid()}`);
    commitChange(t.worktree, { "big/blob.txt": `${"x".repeat(79)}\n`.repeat(40_000) });
    await submitCode(request, t.id);
    await openReview(page, t.id);
    const code = pane(page).locator("[data-wc-artifact=code]");
    await expect(code.locator(".wc-rv-trunc")).toContainText("PREVIEW TRUNCATED · the diff is larger than the 2 MiB preview limit");
  });

  test("a review whose checkout is gone shows the unavailable state", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Gone checkout ${uid()}`);
    commitChange(t.worktree, { "src/g.ts": "export const g = 1;\n" });
    await submitCode(request, t.id);
    fs.rmSync(t.worktree, { recursive: true, force: true });
    await openReview(page, t.id);
    await expect(pane(page).locator(".wc-rv-tag", { hasText: "Unavailable" })).toBeVisible();
    await expect(pane(page).getByText("This revision cannot be checked against the task.")).toBeVisible();
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
    await expect(p.getByRole("button", { name: /^Accept rev 1/ })).toBeEnabled();
    await shot(page, "phone-review");
    await p.getByRole("button", { name: /^Request changes/ }).click();
    await expect(p.getByLabel("Feedback for the agent")).toBeFocused();
    await shot(page, "phone-review-compose");
  });

  test("the Work tab action sheet offers Accept and Snooze for a pending review", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Phone sheet ${uid()}`);
    await submitDoc(request, t.id);
    await gotoApp(page);
    await page.locator(".mtabbar-item").nth(3).click();
    const row = page.locator("[data-wc-row]").filter({ hasText: t.title });
    await row.getByRole("button", { name: `Actions for ${t.title}` }).click();
    const sheet = page.getByRole("dialog", { name: "Actions" });
    await expect(sheet.getByRole("button", { name: /^Accept rev 1/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Snooze/ })).toBeVisible();
    await shot(page, "phone-wc-sheet");
  });

  test("Ask agent to resubmit focuses the composer once; returning to Chat later does not refocus it", async ({ page, request }) => {
    const t = await taskWithPlan(request, `Phone resubmit ${uid()}`);
    commitChange(t.worktree, { "src/one.ts": "export const one = 1;\n" });
    await submitCode(request, t.id);
    await openTask(page, t.id);
    await page.locator(".viewseg-btn", { hasText: "Review" }).click();
    await decision(page).getByRole("button", { name: /^Accept rev 1/ }).click();
    await expect(pane(page)).toHaveAttribute("data-wc-review-state", "accepted");
    commitChange(t.worktree, { "src/two.ts": "export const two = 2;\n" });
    await page.reload();
    await page.locator(".viewseg-btn", { hasText: "Review" }).click();
    await expect(outStrip(page).filter({ hasText: "Rev 1 was accepted, then it changed." })).toBeVisible();
    const composerFocused = () => page.evaluate(() => document.activeElement?.classList.contains("comp-input") ?? false);

    await decision(page).getByRole("button", { name: "Ask agent to resubmit" }).click();
    await expect(page.locator(".viewseg-btn", { hasText: "Chat" })).toHaveClass(/\bon\b/);
    await expect.poll(composerFocused).toBe(true);

    await page.locator(".viewseg-btn", { hasText: "Changes" }).click();
    await page.locator(".viewseg-btn", { hasText: "Chat" }).click();
    await expect(page.locator(".viewseg-btn", { hasText: "Chat" })).toHaveClass(/\bon\b/);
    await expect.poll(composerFocused).toBe(false);
  });
});
