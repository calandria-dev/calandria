import { describe, it, expect, beforeEach, vi } from "vitest";

// A red PR in the "needs you" inbox.
//
// .github/CLAUDE.md has always said "a push isn't done until its CI runs
// conclude", and left it entirely to the agent to remember; main once sat red
// for hours because every session verified locally and nobody watched Actions.
// What's pinned here is the product version of that policy: a failing check
// rollup RAISES the task into the same surface a parked question does, it says
// WHICH check broke, and it can seed a fix — all of it on the events bus and
// the inbox that already exist.
const { fetchPrStateMock } = vi.hoisted(() => ({ fetchPrStateMock: vi.fn() }));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPrState: fetchPrStateMock,
}));

import {
  createProject, createTask, getTask, updateTask,
  countAwaiting, listNeedsYou, taskAwaitingInput,
} from "@/lib/store";
import { subscribeGlobal, type BusEvent } from "@/lib/events";
import { failingChecks, type PrSnapshot } from "@/lib/github";
import { refreshPrState, parseFailingChecks } from "@/lib/prState";
import { buildCiFixPrompt } from "@/lib/agents/shared";

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

const RED = {
  name: "test (20.x)",
  url: "https://github.com/o/r/actions/runs/123/job/456",
  workflow: "Tests",
  verdict: "FAILURE",
};

function project() {
  return createProject({ name: `ci-${Math.random()}`, repo_path: process.cwd(), branch: "main" });
}

// A task with a PR, exactly as POST /api/tasks/[id]/pr leaves it.
function taskWithPr(projectId: string, number = 42) {
  const task = createTask({ project_id: projectId, title: "work with a PR" });
  updateTask(task.id, { pr_url: `https://github.com/o/r/pull/${number}`, pr_number: number });
  return task.id;
}

// Put a task in whatever PR state the case is about, through the real refresh
// path — the columns are written by lib/prState.ts, and a test that reached
// past it into the DB would stop proving that the refresh persists anything.
async function land(taskId: string, over: Partial<PrSnapshot>) {
  fetchPrStateMock.mockResolvedValue({ ok: true, snapshot: snapshot(over) });
  await refreshPrState(taskId, { force: true });
}

function watch(taskId: string) {
  const seen: BusEvent[] = [];
  const off = subscribeGlobal((id, ev) => { if (id === taskId) seen.push(ev); });
  return { seen, off };
}

beforeEach(() => {
  fetchPrStateMock.mockReset();
});

describe("failingChecks", () => {
  it("names only the red entries, and links each one's run", () => {
    const out = failingChecks([
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "lint", detailsUrl: "u1" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE", name: "test (20.x)", detailsUrl: "u2", workflowName: "Tests" },
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null as unknown as string, name: "e2e", detailsUrl: "u3" },
    ]);
    expect(out).toEqual([{ name: "test (20.x)", url: "u2", workflow: "Tests", verdict: "FAILURE" }]);
  });

  it("reads a legacy status context, which names and links itself differently", () => {
    // gh returns CheckRuns and StatusContexts in the SAME array. A context has
    // `context`/`targetUrl` where a run has `name`/`detailsUrl`, and reading
    // only the CheckRun spelling would report a red PR with nothing named.
    const out = failingChecks([{ __typename: "StatusContext", state: "FAILURE", context: "ci/circleci", targetUrl: "u9" }]);
    expect(out).toEqual([{ name: "ci/circleci", url: "u9", workflow: "", verdict: "FAILURE" }]);
  });

  it("counts the same verdicts red that the rollup does", () => {
    // Shares verdictOf() with rollupChecks precisely so a PR can never read
    // "checks failing" with an empty list, or vice versa.
    const entries = [
      { status: "COMPLETED", conclusion: "TIMED_OUT", name: "a" },
      { status: "COMPLETED", conclusion: "CANCELLED", name: "b" },
      { status: "COMPLETED", conclusion: "SKIPPED", name: "c" },
      { status: "COMPLETED", conclusion: "NEUTRAL", name: "d" },
    ];
    expect(failingChecks(entries).map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("caps a matrix that went red fifteen ways", () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      status: "COMPLETED", conclusion: "FAILURE", name: `test (${i})`,
    }));
    // One bug, fifteen red cells. The column this lands in is read on every
    // task list, so the list is bounded rather than growing with the matrix.
    expect(failingChecks(entries)).toHaveLength(8);
  });

  it("says nothing about a rollup that hasn't got one", () => {
    expect(failingChecks(null)).toEqual([]);
    expect(failingChecks([])).toEqual([]);
  });
});

describe("persisting which check failed", () => {
  it("stores the red checks beside the verdict, so the UI can name them", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    await land(id, { checks: "failing", failing: [RED] });

    const task = getTask(id)!;
    expect(task.pr_checks).toBe("failing");
    expect(parseFailingChecks(task.pr_failing)).toEqual([RED]);
  });

  it("announces a SECOND job going red under an already-red rollup", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    await land(id, { checks: "failing", failing: [RED] });

    const w = watch(id);
    const second = { name: "typecheck", url: "u2", workflow: "Tests", verdict: "FAILURE" };
    await land(id, { checks: "failing", failing: [RED, second] });
    w.off();

    // pr_checks didn't move — it was "failing" before and after — so without
    // the failing list in changed() this would be silent, and the chip would
    // keep naming one job while two were broken.
    expect(w.seen.map((e) => e.type)).toContain("task_edited");
    expect(parseFailingChecks(getTask(id)!.pr_failing)).toHaveLength(2);
  });

  it("stays quiet when GitHub reports the same red checks again", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    await land(id, { checks: "failing", failing: [RED] });

    const w = watch(id);
    await land(id, { checks: "failing", failing: [RED] });
    w.off();

    // Every five minutes, forever, on every open red PR: an event here would
    // have every tab refetch its tray for nothing.
    expect(w.seen).toHaveLength(0);
  });

  it("clears the list when the checks go green", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    await land(id, { checks: "failing", failing: [RED] });
    await land(id, { checks: "passing", failing: [] });

    expect(getTask(id)!.pr_failing).toBe("");
  });

  it("keeps the last known red checks when GitHub can't be reached", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    await land(id, { checks: "failing", failing: [RED] });

    fetchPrStateMock.mockResolvedValue({ ok: false, error: "network is down" });
    await refreshPrState(id, { force: true });

    // "We couldn't ask" is not "the checks passed" — same rule the other pr_*
    // columns follow on a failed fetch.
    expect(parseFailingChecks(getTask(id)!.pr_failing)).toEqual([RED]);
  });

  it("survives a column an older build never wrote", () => {
    expect(parseFailingChecks("")).toEqual([]);
    expect(parseFailingChecks("{not json")).toEqual([]);
    expect(parseFailingChecks('{"name":"x"}')).toEqual([]); // an object, not a list
  });
});

describe("a red PR in the needs-you inbox", () => {
  it("counts toward the pill even though no turn is parked", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    updateTask(id, { status: "in_progress" });
    expect(countAwaiting(p.id)).toBe(0);

    await land(id, { checks: "failing", failing: [RED] });

    // Nothing asked the user anything — awaiting_input is still 0 — and the
    // task still needs them.
    expect(getTask(id)!.awaiting_input).toBe(0);
    expect(countAwaiting(p.id)).toBe(1);
  });

  it("counts a task already marked DONE, which is the case that went unnoticed", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    updateTask(id, { status: "done" });
    await land(id, { checks: "failing", failing: [RED] });

    expect(countAwaiting(p.id)).toBe(1);
  });

  it("says which arm put each row in the dropdown", async () => {
    const p = project();
    const red = taskWithPr(p.id, 1);
    updateTask(red, { status: "in_progress" });
    await land(red, { checks: "failing", failing: [RED] });

    const parked = createTask({ project_id: p.id, title: "asked a question" }).id;
    updateTask(parked, { status: "in_progress" });
    updateTask(parked, { awaiting_input: 1 });

    const rows = listNeedsYou().filter((r) => r.project_id === p.id);
    expect(rows.find((r) => r.id === red)?.reason).toBe("ci");
    expect(rows.find((r) => r.id === red)?.pr_number).toBe(1);
    // "waiting for 3 hours" is true of a parked turn and a lie about a red PR,
    // whose age we never stored — so the two rows get different sublines.
    expect(rows.find((r) => r.id === parked)?.reason).toBe("input");
  });

  it("drops out of the pill once the PR is merged or closed", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    updateTask(id, { status: "in_progress" });
    await land(id, { checks: "failing", failing: [RED] });
    expect(countAwaiting(p.id)).toBe(1);

    // A merged PR is never re-polled (stalePrTasks), so a last-seen "failing"
    // on one would sit in the pill forever with nothing able to clear it.
    await land(id, { state: "merged", checks: "failing", failing: [RED], mergedAt: Date.now() });
    expect(countAwaiting(p.id)).toBe(0);
  });

  it("stays out of the pill when the task is held or cancelled", async () => {
    const p = project();
    const held = taskWithPr(p.id, 2);
    updateTask(held, { status: "on_hold" });
    await land(held, { checks: "failing", failing: [RED] });

    const cancelled = taskWithPr(p.id, 3);
    updateTask(cancelled, { status: "cancelled" });
    await land(cancelled, { checks: "failing", failing: [RED] });

    // Somebody has already decided not to pursue these.
    expect(countAwaiting(p.id)).toBe(0);
  });

  it("is silenced by a snooze, like every other attention surface", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    updateTask(id, { status: "in_progress" });
    await land(id, { checks: "failing", failing: [RED] });
    expect(countAwaiting(p.id)).toBe(1);

    updateTask(id, { snoozed_until: Date.now() + 60 * 60_000 });
    expect(countAwaiting(p.id)).toBe(0);
  });

  it("does NOT make the notifier announce a question nobody asked", async () => {
    const p = project();
    const id = taskWithPr(p.id);
    updateTask(id, { status: "in_progress" });
    await land(id, { checks: "failing", failing: [RED] });

    // The dispatcher calls emitAwaitingInput on EVERY turn end and lets this
    // row-read decide. Under the full pill predicate, a clean turn ending on a
    // task with a red PR would deliver a toast reading "Waiting for input".
    expect(countAwaiting(p.id)).toBe(1);
    expect(taskAwaitingInput(id)).toBe(false);
  });
});

describe("buildCiFixPrompt", () => {
  it("names the job, links its run and quotes the log tail", () => {
    const out = buildCiFixPrompt(42, [{
      name: "test (20.x)", url: "https://github.com/o/r/actions/runs/123/job/456",
      workflow: "Tests", log: "FAIL tests/merge.test.ts\n  expected 2, got 3", logError: "",
    }]);
    expect(out).toContain("#42");
    expect(out).toContain("Tests / test (20.x)");
    expect(out).toContain("https://github.com/o/r/actions/runs/123/job/456");
    expect(out).toContain("expected 2, got 3");
  });

  it("says the log is missing rather than leaving a fenced hole", () => {
    const out = buildCiFixPrompt(7, [{
      name: "ci/circleci", url: "", workflow: "", log: "", logError: "not a GitHub Actions run",
    }]);
    // An agent told "here is the log" and shown nothing will invent one; told
    // there isn't one, it reproduces the job instead.
    expect(out).toContain("No log available");
    expect(out).toContain("not a GitHub Actions run");
    expect(out).not.toContain("```");
  });

  it("covers every red job, not just the first", () => {
    const out = buildCiFixPrompt(1, [
      { name: "typecheck", url: "u1", workflow: "Tests", log: "TS2345", logError: "" },
      { name: "e2e", url: "u2", workflow: "Tests", log: "timeout", logError: "" },
    ]);
    expect(out).toContain("Failing checks (2)");
    expect(out).toContain("TS2345");
    expect(out).toContain("timeout");
  });
});
