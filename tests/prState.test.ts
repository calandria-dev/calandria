import { describe, it, expect, beforeEach, vi } from "vitest";

// Keeping a task's GitHub PR state fresh (lib/prState.ts).
//
// The whole point of the feature is that the app can ANSWER "is this PR open,
// red, approved or landed?" without a human going to github.com, so what's
// pinned here is: the answer is persisted, it reaches clients as an event, and
// asking costs a bounded number of `gh pr view` calls. gh itself is mocked —
// the real one needs a network, a login and a PR — but everything around it,
// including the store writes and the bus, is real.
const { fetchPrStateMock } = vi.hoisted(() => ({ fetchPrStateMock: vi.fn() }));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPrState: fetchPrStateMock,
}));

import { getDb } from "@/lib/db";
import { createProject, createTask, getTask, updateTask, stalePrTasks, openPrTaskCount } from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { parsePrNumber, rollupChecks, type PrSnapshot } from "@/lib/github";
import { refreshPrState, sweepPrs, prView } from "@/lib/prState";

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 42,
  state: "open",
  checks: "passing",
  review: "",
  mergedAt: 0,
  mergeState: "CLEAN",
  draft: false,
  failing: [],
  ...over,
});

// A task that already has a PR, exactly as POST /api/tasks/[id]/pr leaves it:
// url + number stored, and nothing yet heard back from GitHub.
function taskWithPr(over: { number?: number; url?: string } = {}) {
  const project = createProject({ name: `pr-${Math.random()}`, repo_path: process.cwd(), branch: "main" });
  const task = createTask({ project_id: project.id, title: "work with a PR" });
  const number = over.number ?? 42;
  updateTask(task.id, { pr_url: over.url ?? `https://github.com/o/r/pull/${number}`, pr_number: number });
  return { projectId: project.id, taskId: task.id };
}

// Collect bus events for a task. Deliberately NOT internal: the sweep skips a
// pass when watcherCount() is zero, and a listener here is the "somebody is
// looking at this" the real sweep waits for.
function watch(taskId: string) {
  const seen: BusEvent[] = [];
  const off = subscribeGlobal((id, ev) => { if (id === taskId) seen.push(ev); });
  return { seen, off };
}

beforeEach(() => {
  fetchPrStateMock.mockReset();
});

describe("parsePrNumber", () => {
  it("reads the number out of a PR url, once, instead of per render", () => {
    expect(parsePrNumber("https://github.com/o/r/pull/42")).toBe(42);
    expect(parsePrNumber("https://github.example.com/o/r/pull/7#issuecomment-1")).toBe(7);
    expect(parsePrNumber("https://github.com/o/r/issues/42")).toBe(0);
    expect(parsePrNumber("")).toBe(0);
  });
});

describe("rollupChecks", () => {
  it("calls no CI at all 'none', never 'passing'", () => {
    expect(rollupChecks([])).toBe("none");
    expect(rollupChecks(null)).toBe("none");
  });

  it("lets one red check outweigh any number of green ones", () => {
    expect(
      rollupChecks([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      ])
    ).toBe("failing");
  });

  it("counts a check that hasn't finished as pending, not green", () => {
    expect(
      rollupChecks([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "IN_PROGRESS" },
      ])
    ).toBe("pending");
    // A legacy commit status reports its verdict as `state` instead.
    expect(rollupChecks([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending");
  });

  it("treats skipped and neutral as green, the way GitHub does", () => {
    expect(
      rollupChecks([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" },
        { __typename: "StatusContext", state: "SUCCESS" },
      ])
    ).toBe("passing");
  });

  it("refuses to call a verdict it doesn't recognize a pass", () => {
    expect(rollupChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SOMETHING_NEW" }])).toBe("pending");
  });
});

describe("refreshPrState", () => {
  it("persists what GitHub said and announces it as task_edited", async () => {
    const { taskId } = taskWithPr();
    const w = watch(taskId);
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ checks: "failing", review: "CHANGES_REQUESTED" }) });

    const res = await refreshPrState(taskId);
    w.off();

    expect(res).toMatchObject({ ok: true, changed: true });
    const task = getTask(taskId)!;
    expect(task.pr_state).toBe("open");
    expect(task.pr_checks).toBe("failing");
    expect(task.pr_review).toBe("CHANGES_REQUESTED");
    expect(task.pr_synced_at).toBeGreaterThan(0);
    // The board and the session rail update off this, the same way every other
    // lifecycle fact reaches them.
    expect(w.seen.map((e) => e.type)).toContain("task_edited");
  });

  it("persists draft and mergeability, and announces a change in either", async () => {
    // The two facts the Squash & merge button is enabled off (lib/prMerge.ts).
    // Both used to be dropped on the floor: mergeStateStatus was fetched and
    // never stored, isDraft was never asked for.
    const { taskId } = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ draft: true, mergeState: "DRAFT" }) });
    await refreshPrState(taskId);
    expect(getTask(taskId)!.pr_draft).toBe(1);
    expect(getTask(taskId)!.pr_merge_state).toBe("DRAFT");

    // Marking it ready for review changes nothing else — state is still open,
    // checks still passing — so unless changed() counts these two, the rail
    // would keep the button disabled until something unrelated moved.
    const w = watch(taskId);
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ draft: false, mergeState: "CLEAN" }) });
    const res = await refreshPrState(taskId, { force: true });
    w.off();

    expect(res).toMatchObject({ ok: true, changed: true });
    expect(getTask(taskId)!.pr_draft).toBe(0);
    expect(w.seen.map((e) => e.type)).toContain("task_edited");
  });

  it("records a merge on github.com without claiming a local merge", async () => {
    const { taskId } = taskWithPr();
    const mergedAt = Date.parse("2026-08-01T10:00:00Z");
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ state: "merged", mergedAt }) });

    await refreshPrState(taskId);

    const task = getTask(taskId)!;
    expect(task.pr_state).toBe("merged");
    expect(task.pr_merged_at).toBe(mergedAt);
    // merged_at is OUR merge into the base branch. A PR merged on github.com
    // never touched this box, and saying otherwise would tell the diff rail the
    // work is already in the user's local branch.
    expect(task.merged_at).toBe(0);
  });

  it("does not float the task to the top of the board", async () => {
    const { taskId } = taskWithPr();
    const before = getTask(taskId)!.updated_at;
    getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(before - 60_000, taskId);
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });

    await refreshPrState(taskId);

    // updated_at is the list's sort key and retention's clock. A five-minute
    // poll that stamped it would reorder the board on its own.
    expect(getTask(taskId)!.updated_at).toBe(before - 60_000);
  });

  it("stays quiet when GitHub says the same thing again", async () => {
    const { taskId } = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });
    await refreshPrState(taskId);

    const w = watch(taskId);
    const res = await refreshPrState(taskId, { force: true });
    w.off();

    expect(res).toMatchObject({ ok: true, changed: false });
    // pr_synced_at moves on every refresh, so publishing on "the row changed"
    // would have every tab refetch its tray every five minutes forever.
    expect(w.seen).toHaveLength(0);
  });

  it("reuses a fresh answer instead of spawning gh again", async () => {
    const { taskId } = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });

    await refreshPrState(taskId);
    await refreshPrState(taskId); // opening the task again, immediately
    expect(fetchPrStateMock).toHaveBeenCalledTimes(1);

    // The explicit Refresh click beats the window — that is what it is for.
    await refreshPrState(taskId, { force: true });
    expect(fetchPrStateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good snapshot when GitHub can't be reached, and backs off", async () => {
    const { taskId } = taskWithPr();
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ checks: "passing" }) });
    await refreshPrState(taskId);

    fetchPrStateMock.mockResolvedValue({ ok: false, error: "network is unreachable" });
    const res = await refreshPrState(taskId, { force: true });

    expect(res).toMatchObject({ ok: false, reason: "failed" });
    const task = getTask(taskId)!;
    // "We couldn't ask" is not "the PR changed".
    expect(task.pr_checks).toBe("passing");
    expect(task.pr_state).toBe("open");
    // …but the clock still moved, so a repo GitHub can't answer for backs off
    // to the sweep's interval instead of being retried by every trigger.
    expect(task.pr_synced_at).toBeGreaterThan(0);
  });

  it("does nothing for a task with no PR", async () => {
    const project = createProject({ name: `nopr-${Math.random()}`, repo_path: process.cwd(), branch: "main" });
    const task = createTask({ project_id: project.id, title: "no PR here" });

    expect(await refreshPrState(task.id)).toMatchObject({ ok: false, reason: "no_pr" });
    expect(fetchPrStateMock).not.toHaveBeenCalled();
    expect(prView(getTask(task.id)!)).toBeNull();
  });
});

describe("the sweep's candidate set", () => {
  it("never asks about a PR that already landed or was closed", async () => {
    // The count is database-wide and earlier cases leave open PRs behind, so
    // this case measures its own delta rather than an absolute.
    const before = openPrTaskCount();
    const open = taskWithPr({ number: 1 });
    const merged = taskWithPr({ number: 2 });
    const closed = taskWithPr({ number: 3 });

    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ state: "merged", mergedAt: Date.now() }) });
    await refreshPrState(merged.taskId);
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot({ state: "closed" }) });
    await refreshPrState(closed.taskId);

    const ids = stalePrTasks(Date.now() + 1, 50).map((t) => t.id);
    expect(ids).toContain(open.taskId);
    expect(ids).not.toContain(merged.taskId);
    expect(ids).not.toContain(closed.taskId);
    // A terminal PR can't change back, so the recurring cost is bounded by open
    // work rather than by how many PRs this instance has ever opened.
    expect(openPrTaskCount()).toBe(before + 1);
  });

  it("caps how many gh calls one pass can make", async () => {
    for (let i = 0; i < 8; i++) taskWithPr({ number: 100 + i });
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });

    // A watcher, because the sweep skips a pass nobody could see.
    const w = watch("none-of-them");
    const n = await sweepPrs();
    w.off();

    // CALANDRIA_PR_POLL_BATCH, default 5. The rest are picked up by later
    // passes, oldest sync first, rather than forking eight gh processes at once.
    expect(n).toBe(5);
    expect(fetchPrStateMock).toHaveBeenCalledTimes(5);
  });

  it("skips the pass entirely when no tab is watching", async () => {
    taskWithPr({ number: 900 });
    fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot() });

    expect(await sweepPrs()).toBe(0);
    expect(fetchPrStateMock).not.toHaveBeenCalled();
  });
});
