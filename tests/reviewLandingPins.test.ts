// The browser's local landing routes (WC-18) land the commit a person accepted:
// each passes the accepted head and base pins to mergeTask, which merges the
// pinned commit, commits nothing on the way, and refuses with nothing written
// when either pin moved. A task with no accepted review passes no pins.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mergeTaskCalls, completeCalls } = vi.hoisted(() => ({
  mergeTaskCalls: [] as Array<Record<string, unknown>>,
  completeCalls: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/git", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/git")>();
  return {
    ...mod,
    mergeTask: (input: Parameters<typeof mod.mergeTask>[0]) => {
      mergeTaskCalls.push(input);
      return mod.mergeTask(input);
    },
    // completeWorktreeMerge calls mergeTask inside the module, so its own input is recorded here.
    completeWorktreeMerge: (input: Parameters<typeof mod.completeWorktreeMerge>[0]) => {
      completeCalls.push(input);
      return mod.completeWorktreeMerge(input);
    },
  };
});
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  mergeTaskPr: vi.fn(),
  fetchPrState: vi.fn(),
  fetchCheckEvidence: vi.fn(async () => ({ ok: false, error: "none" })),
}));

import { POST as mergeRoute } from "../app/api/tasks/[id]/merge/route";
import { POST as prepareRoute } from "../app/api/tasks/[id]/merge/prepare/route";
import { mergeTask } from "../lib/git";
import { performReviewAction } from "../lib/reviews/actions";
import { submitReview } from "../lib/reviews/submit";
import { updateTask } from "../lib/store";
import { commitFile, git, uid } from "./helpers";
import { codeBody, reviewTask } from "./reviewFixture";

beforeEach(() => {
  process.env.CALANDRIA_REVIEW_REQUESTS = "1";
  mergeTaskCalls.length = 0;
  completeCalls.length = 0;
});
afterEach(() => {
  delete process.env.CALANDRIA_REVIEW_REQUESTS;
});

async function acceptedCode() {
  const f = await reviewTask();
  const branch = (await git(f.wt.path, "symbolic-ref", "--short", "HEAD")).trim();
  updateTask(f.taskId, { work_branch: branch });
  await commitFile(f.wt.path, "src/a.txt", "a\n", "feat: a");
  const sub = await submitReview(f.ctx, codeBody());
  const head = (await git(f.wt.path, "rev-parse", "HEAD")).trim();
  await performReviewAction(f.taskId, sub.body.requestId, { submissionId: sub.body.submissionId, expectedVersion: sub.body.version, action: "accept", idempotencyKey: `k-${uid()}` }, { id: "instance-owner" });
  return { ...f, submissionId: sub.body.submissionId, head, branch };
}

const post = (url: string, body?: unknown) => new Request(url, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const tip = async (repo: string, ref: string) => (await git(repo, "rev-parse", ref)).trim();

describe("pins on the browser's landing routes", () => {
  it("POST /merge passes the accepted head and base pins", async () => {
    const f = await acceptedCode();
    const baseTip = await tip(f.repo, "main");
    const res = await mergeRoute(post(`http://x/api/tasks/${f.taskId}/merge`), params(f.taskId));
    expect(res.status).toBe(200);
    const call = mergeTaskCalls[mergeTaskCalls.length - 1];
    expect(call.expectedHeadSha).toBe(f.head);
    expect(call.expectedBaseSha).toBe(baseTip);
    await git(f.repo, "merge-base", "--is-ancestor", f.head, "main");
  });

  it("a task without a review passes no pins", async () => {
    const f = await reviewTask();
    const branch = (await git(f.wt.path, "symbolic-ref", "--short", "HEAD")).trim();
    updateTask(f.taskId, { work_branch: branch });
    await commitFile(f.wt.path, "src/b.txt", "b\n", "feat: b");
    const res = await mergeRoute(post(`http://x/api/tasks/${f.taskId}/merge`), params(f.taskId));
    expect(res.status).toBe(200);
    const call = mergeTaskCalls[mergeTaskCalls.length - 1];
    expect(call.expectedHeadSha).toBeUndefined();
    expect(call.expectedBaseSha).toBeUndefined();
  });

  it("POST /merge/prepare passes the pins on its clean landing", async () => {
    const f = await acceptedCode();
    const baseTip = await tip(f.repo, "main");
    const res = await prepareRoute(post(`http://x/api/tasks/${f.taskId}/merge/prepare`), params(f.taskId));
    expect(res.status).toBe(200);
    const call = completeCalls[completeCalls.length - 1];
    expect(call.expectedHeadSha).toBe(f.head);
    expect(call.expectedBaseSha).toBe(baseTip);
    await git(f.repo, "merge-base", "--is-ancestor", f.head, "main");
  });
});

describe("a pinned mergeTask", () => {
  it("lands exactly the accepted commit and commits nothing", async () => {
    const f = await acceptedCode();
    const baseTip = await tip(f.repo, "main");
    fs.mkdirSync(path.join(f.wt.path, "src"), { recursive: true });
    fs.writeFileSync(path.join(f.wt.path, "src/dirt.txt"), "late bytes\n");
    const res = await mergeTask({
      repoPath: f.repo,
      worktreePath: f.wt.path,
      workBranch: f.branch,
      baseBranch: "main",
      message: "land",
      expectedHeadSha: f.head,
      expectedBaseSha: baseTip,
    });
    expect(res.ok).toBe(true);
    expect(res.mergedSha).toBe(f.head);
    expect(await tip(f.wt.path, f.branch)).toBe(f.head);
    await expect(git(f.repo, "cat-file", "-e", "main:src/dirt.txt")).rejects.toThrow();
    expect(fs.existsSync(path.join(f.wt.path, "src/dirt.txt"))).toBe(true);
    await git(f.repo, "merge-base", "--is-ancestor", f.head, "main");
  });

  it("refuses with nothing written when the branch no longer points at the pin", async () => {
    const f = await acceptedCode();
    const baseTip = await tip(f.repo, "main");
    await commitFile(f.wt.path, "src/late.txt", "late\n", "feat: late");
    const res = await mergeTask({
      repoPath: f.repo,
      worktreePath: f.wt.path,
      workBranch: f.branch,
      baseBranch: "main",
      message: "land",
      expectedHeadSha: f.head,
      expectedBaseSha: baseTip,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/moved/);
    expect(await tip(f.repo, "main")).toBe(baseTip);
  });
});
