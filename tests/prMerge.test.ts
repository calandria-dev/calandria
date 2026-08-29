import { describe, it, expect, beforeEach, vi } from "vitest";

// One-click "Squash & merge PR" (lib/prMerge.ts + POST /api/tasks/[id]/pr/merge).
//
// The feature's promise is that landing a reviewed PR doesn't mean leaving the
// app, so what's pinned here is the part that makes that safe rather than the
// part that makes it work: the button is enabled off GitHub's real answer, the
// route re-screens against a fresh one before it shells out, it refuses a task
// mid-turn like every other merge route, and a successful merge hands off to
// the PR-state refresh instead of cleaning up itself.
//
// gh is mocked — the real one needs a network, a login and a PR — but the
// store, the bus and the route's own guards are real.
const { mergeTaskPrMock, fetchPrStateMock } = vi.hoisted(() => ({
  mergeTaskPrMock: vi.fn(),
  fetchPrStateMock: vi.fn(),
}));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  mergeTaskPr: mergeTaskPrMock,
  fetchPrState: fetchPrStateMock,
}));

import { createProject, createTask, getTask, updateTask } from "@/lib/store";
import { autoMergeRefused, repoSlug, type PrSnapshot } from "@/lib/github";
import { prMergeBlocker, type PrMergeFacts } from "@/lib/prMerge";
import { POST as mergePrRoute } from "@/app/api/tasks/[id]/pr/merge/route";

const facts = (over: Partial<PrMergeFacts> = {}): PrMergeFacts => ({
  pr_url: "https://github.com/o/r/pull/42",
  pr_number: 42,
  pr_state: "open",
  pr_checks: "passing",
  pr_draft: 0,
  pr_merge_state: "CLEAN",
  pr_synced_at: 1_700_000_000_000,
  ...over,
});

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 42,
  state: "open",
  checks: "passing",
  review: "APPROVED",
  mergedAt: 0,
  mergeState: "CLEAN",
  draft: false,
  ...over,
});

// A task with a PR, as POST /api/tasks/[id]/pr leaves it.
function taskWithPr() {
  const project = createProject({ name: `prmerge-${Math.random()}`, repo_path: process.cwd(), branch: "main" });
  const task = createTask({ project_id: project.id, title: "work with a PR" });
  updateTask(task.id, { pr_url: "https://github.com/o/r/pull/42", pr_number: 42 });
  return task.id;
}

const call = (id: string) => mergePrRoute(new Request("http://x/api"), { params: Promise.resolve({ id }) });

beforeEach(() => {
  mergeTaskPrMock.mockReset();
  fetchPrStateMock.mockReset();
});

describe("prMergeBlocker", () => {
  it("lets a green, open, non-draft, conflict-free PR through", () => {
    expect(prMergeBlocker(facts())).toBeNull();
  });

  it("refuses before GitHub has answered at all, rather than guessing from empty fields", () => {
    // Every field below pr_synced_at is "" until the first refresh lands, so a
    // brand-new PR would otherwise read as "not open" and say the wrong thing.
    expect(prMergeBlocker(facts({ pr_synced_at: 0, pr_state: "", pr_checks: "" }))).toMatch(/hasn't answered/i);
  });

  it("names the specific reason for each terminal or unmergeable state", () => {
    expect(prMergeBlocker(facts({ pr_state: "merged" }))).toMatch(/already merged/i);
    expect(prMergeBlocker(facts({ pr_state: "closed" }))).toMatch(/closed without merging/i);
    expect(prMergeBlocker(facts({ pr_draft: 1 }))).toMatch(/draft/i);
    expect(prMergeBlocker(facts({ pr_checks: "failing" }))).toMatch(/checks are failing/i);
    expect(prMergeBlocker(facts({ pr_merge_state: "DIRTY" }))).toMatch(/conflicts/i);
  });

  it("does NOT refuse the states --auto exists to wait out", () => {
    // Waiting on a required review, behind the base, non-required checks still
    // running, mergeability not computed yet: queueing is exactly the answer.
    for (const pr_merge_state of ["BLOCKED", "BEHIND", "UNSTABLE", "UNKNOWN", ""])
      expect(prMergeBlocker(facts({ pr_merge_state }))).toBeNull();
    // A pending check is the ordinary case for the auto path, not a refusal.
    expect(prMergeBlocker(facts({ pr_checks: "pending", pr_merge_state: "BLOCKED" }))).toBeNull();
  });

  it("refuses a task with no PR", () => {
    expect(prMergeBlocker(facts({ pr_url: "", pr_number: 0 }))).toMatch(/no pull request/i);
  });
});

describe("repoSlug", () => {
  it("reads owner/repo out of every spelling git hands out", () => {
    expect(repoSlug("git@github.com:penmoid/calandria.git")).toBe("penmoid/calandria");
    expect(repoSlug("https://github.com/penmoid/calandria.git")).toBe("penmoid/calandria");
    expect(repoSlug("https://github.com/penmoid/calandria")).toBe("penmoid/calandria");
    expect(repoSlug("ssh://git@github.com/penmoid/calandria.git")).toBe("penmoid/calandria");
  });

  it("gives up on anything that isn't github.com, so gh is left to infer the repo", () => {
    expect(repoSlug("git@gitlab.com:o/r.git")).toBe("");
    expect(repoSlug("")).toBe("");
  });
});

describe("autoMergeRefused", () => {
  it("recognises the two ways gh says 'I could not arm auto-merge'", () => {
    expect(autoMergeRefused("failed to enable auto-merge: GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)")).toBe(true);
    // Nothing left to wait for — GitHub refuses to queue a PR that is already
    // clean, which means "just merge it", not "give up".
    expect(autoMergeRefused("GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)")).toBe(true);
  });

  it("leaves a genuinely unmergeable PR alone, so it isn't merged by the back door", () => {
    expect(autoMergeRefused("Pull request #42 is not mergeable: the merge commit cannot be cleanly created.")).toBe(false);
    expect(autoMergeRefused("")).toBe(false);
  });
});

describe("POST /api/tasks/[id]/pr/merge", () => {
  it("refuses while a turn is running, in the same words the other merge routes use", async () => {
    const id = taskWithPr();
    updateTask(id, { running: 1 });
    const res = await call(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/task is running/i);
    expect(mergeTaskPrMock).not.toHaveBeenCalled();
  });

  it("re-screens against a FRESH answer and never shells out on a red PR", async () => {
    const id = taskWithPr();
    // The row says nothing yet; GitHub says the build went red while the rail
    // was on screen. The refusal has to come from the fresh answer.
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ checks: "failing" }) });
    const res = await call(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/checks are failing/i);
    expect(mergeTaskPrMock).not.toHaveBeenCalled();
    expect(getTask(id)!.pr_checks).toBe("failing");
  });

  it("refuses a draft even though its state is 'open'", async () => {
    const id = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ draft: true }) });
    const res = await call(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/draft/i);
    expect(mergeTaskPrMock).not.toHaveBeenCalled();
  });

  it("reports a QUEUED auto-merge as queued rather than as merged", async () => {
    const id = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ mergeState: "BLOCKED", checks: "pending" }) });
    mergeTaskPrMock.mockResolvedValue({ ok: true, queued: true });
    const res = await call(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.merged).toBeUndefined();
    // It hasn't landed, so the row must still say open — the sweep carries it.
    expect(getTask(id)!.pr_state).toBe("open");
  });

  it("says so when --auto was refused and a plain squash landed it instead", async () => {
    const id = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });
    mergeTaskPrMock.mockResolvedValue({ ok: true, merged: true, fellBack: "Auto merge is not allowed for this repository" });
    const body = await (await call(id)).json();
    expect(body.merged).toBe(true);
    expect(body.fellBack).toMatch(/not allowed/i);
  });

  it("hands off to the PR-state refresh after an immediate merge instead of cleaning up itself", async () => {
    const id = taskWithPr();
    // Pre-screen answer, then the post-merge one. The route's whole cleanup
    // contribution is writing pr_state=merged; the reclaim path keys off it.
    fetchPrStateMock
      .mockResolvedValueOnce({ ok: true, snapshot: snapshot() })
      .mockResolvedValueOnce({ ok: true, snapshot: snapshot({ state: "merged", mergedAt: 1_700_000_100_000 }) });
    mergeTaskPrMock.mockResolvedValue({ ok: true, merged: true });
    const body = await (await call(id)).json();
    expect(body.merged).toBe(true);
    expect(fetchPrStateMock).toHaveBeenCalledTimes(2);
    const row = getTask(id)!;
    expect(row.pr_state).toBe("merged");
    expect(row.pr_merged_at).toBe(1_700_000_100_000);
    // Not this route's job. merged_at is OUR local merge into the base branch;
    // a PR merged on github.com never touched this box, and duplicating the
    // local merge's bookkeeping here is exactly the drift the handoff avoids.
    expect(row.merged_at).toBe(0);
    expect(body.pr.state).toBe("merged");
  });

  it("passes a gh failure back as a 409 rather than claiming success", async () => {
    const id = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });
    mergeTaskPrMock.mockResolvedValue({ ok: false, error: "gh is not logged in to GitHub" });
    const res = await call(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not logged in/i);
  });

  it("refuses a task that never opened a PR before it asks GitHub anything", async () => {
    const project = createProject({ name: `noPr-${Math.random()}`, repo_path: process.cwd(), branch: "main" });
    const task = createTask({ project_id: project.id, title: "no PR here" });
    const res = await call(task.id);
    expect(res.status).toBe(400);
    expect(fetchPrStateMock).not.toHaveBeenCalled();
  });
});
