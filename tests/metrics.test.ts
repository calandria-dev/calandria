// The Prometheus scrape endpoint (issue #16 item 3).
//
// Three things are pinned here, because each is a way a metrics endpoint can
// fail without an error: it keeps returning 200 while the graph is wrong.
//
//   1. The exposition is well-formed and zero-filled. Every outcome and every
//      schedule status is a series on every scrape, so an alert written against
//      `{outcome="failed"}` has data to be false about before the first failure.
//   2. The counters are driven by the real runner, through the same scripted
//      driver seam tests/turnLogging.test.ts uses. A counter asserted against a
//      hand-called incrementer would prove only that addition works.
//   3. The worktrees measurement is cached, so a tight scrape interval doesn't
//      `du` every task checkout on the box once per scrape.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { runTurnMock, diskUsageMock } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
  diskUsageMock: vi.fn(),
}));

vi.mock("@/lib/agents/claude/driver", () => ({
  claudeDriver: {
    id: "claude",
    label: "Scripted Fake",
    runTurn: (task: unknown, project: unknown, userText: string, ac?: unknown, hooks?: unknown) =>
      runTurnMock(task, project, userText, ac, hooks),
  },
}));

// Only the one function: the rest of lib/git.ts is real, because lib/store and
// the runner below both use it for actual worktree work.
vi.mock("@/lib/git", async () => ({
  ...(await vi.importActual<typeof import("@/lib/git")>("@/lib/git")),
  worktreeDiskUsage: (p: string) => diskUsageMock(p),
}));

import { createProject, createTask, getTask } from "@/lib/store";
import { startResumeTurn } from "@/lib/runner";
import { subscribe } from "@/lib/events";
import { claimRun, createSchedule, settleRun } from "@/lib/schedule/store";
import { renderMetrics, resetMetricsForTest, turnCounters } from "@/lib/metrics";
import { registerTurn, unregisterTurn } from "@/lib/abort";
import type { StreamEvent } from "@/lib/types";

function script(events: StreamEvent[]) {
  runTurnMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

/** Resolves when the runner publishes turn_end, the point at which the
 *  finished-turn counter has been incremented. */
function turnEnded(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = subscribe(taskId, (ev) => {
      if (ev.type === "turn_end") {
        unsub();
        resolve();
      }
    });
  });
}

/** One sample's value out of the exposition text, by its full series name
 *  (labels included). Returns undefined when the series isn't there at all,
 *  which several assertions below distinguish from 0. */
function sample(text: string, series: string): number | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

beforeEach(() => {
  runTurnMock.mockReset();
  diskUsageMock.mockReset();
  diskUsageMock.mockResolvedValue(4096);
  resetMetricsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exposition format", () => {
  it("emits a HELP and TYPE line for every metric it exports", async () => {
    const text = await renderMetrics();
    const names = [...text.matchAll(/^# TYPE (\S+) (\S+)$/gm)].map((m) => m[1]);
    expect(names).toContain("calandria_turns_started_total");
    expect(names).toContain("calandria_turns_finished_total");
    expect(names).toContain("calandria_turns_active");
    expect(names).toContain("calandria_db_size_bytes");
    expect(names).toContain("calandria_worktrees_size_bytes");
    expect(names).toContain("calandria_schedule_runs");
    for (const name of names) {
      expect(text).toContain(`# HELP ${name} `);
      // Every sample line belongs to a declared metric, and every declared
      // metric has at least one sample; an orphan TYPE block would be a
      // series a dashboard queries forever and never gets.
      expect(text.split("\n").some((l) => l.startsWith(name) && !l.startsWith("#"))).toBe(true);
    }
    for (const line of text.split("\n").filter((l) => l && !l.startsWith("#"))) {
      // name{labels} value: the value must parse as a number, or Prometheus
      // drops the whole scrape instead of just the one bad line.
      expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? -?[0-9.e+-]+$/);
    }
    expect(text.endsWith("\n")).toBe(true);
  });

  it("zero-fills every outcome and every schedule status, so an alert has data before the first failure", async () => {
    const text = await renderMetrics();
    for (const outcome of ["ok", "failed", "stopped", "interrupted"]) {
      expect(sample(text, `calandria_turns_finished_total{outcome="${outcome}"}`)).toBe(0);
    }
    for (const status of [
      "claimed", "running", "succeeded", "failed", "stopped", "interrupted", "missed", "skipped_overlap",
    ]) {
      expect(sample(text, `calandria_schedule_runs{status="${status}"}`)).toBe(0);
    }
  });

  it("reports the live turn count from the abort registry, not from task.running", async () => {
    // The registry is the source of truth for liveness. A row left running=1
    // by a crash must not be counted here.
    expect(sample(await renderMetrics(), "calandria_turns_active")).toBe(0);
    const controller = new AbortController();
    registerTurn("task-live", controller);
    expect(sample(await renderMetrics(), "calandria_turns_active")).toBe(1);
    unregisterTurn("task-live", controller);
    expect(sample(await renderMetrics(), "calandria_turns_active")).toBe(0);
  });

  it("carries build provenance as a labelled constant, like /api/version reports it", async () => {
    const text = await renderMetrics();
    expect(text).toMatch(/^calandria_build_info\{version="[^"]+",sha="[^"]*"\} 1$/m);
  });
});

describe("turn counters, driven through the real runner", () => {
  it("counts a start and an ok for a turn that ran", async () => {
    const project = createProject({ name: "Metrics" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([
      { type: "session", sessionId: "s-1" },
      { type: "assistant", content: "done" },
      { type: "done", sessionId: "s-1" },
    ]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    expect(turnCounters()).toMatchObject({ started: 1, finished: { ok: 1, failed: 0 } });
    const text = await renderMetrics();
    expect(sample(text, "calandria_turns_started_total")).toBe(1);
    expect(sample(text, 'calandria_turns_finished_total{outcome="ok"}')).toBe(1);
    // The turn is over: nothing is live, whatever the counters say.
    expect(sample(text, "calandria_turns_active")).toBe(0);
  });

  it("counts a failed turn under failed, matching the outcome the log line printed", async () => {
    const project = createProject({ name: "Metrics fail" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([
      { type: "session", sessionId: "s-2" },
      { type: "error", content: "boom" },
    ]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    expect(turnCounters()).toMatchObject({ started: 1, finished: { ok: 0, failed: 1 } });
  });

  it("counts a turn whose session never opened as interrupted, not as a success", async () => {
    // No `session` event: the agent never got as far as opening one, so the
    // turn produced nothing. Rolled into `ok` this would read as a healthy
    // instance doing work it never did.
    const project = createProject({ name: "Metrics interrupted" });
    const task = createTask({ project_id: project.id, title: "T", description: "" });
    script([]);
    const ended = turnEnded(task.id);
    await startResumeTurn(getTask(task.id)!, project, "go");
    await ended;

    expect(turnCounters()).toMatchObject({ started: 1, finished: { ok: 0, interrupted: 1 } });
  });
});

describe("schedule run outcomes", () => {
  it("counts the ledger by status", async () => {
    const project = createProject({ name: "Metrics schedules" });
    const schedule = createSchedule({
      project_id: project.id,
      name: "Nightly",
      prompt: "go",
      days_mask: 127,
      time_of_day: "03:00",
      timezone: "UTC",
    });
    settleRun(claimRun(schedule.id, 1, "scheduled")!.id, "succeeded");
    settleRun(claimRun(schedule.id, 2, "scheduled")!.id, "succeeded");
    settleRun(claimRun(schedule.id, 3, "scheduled")!.id, "failed");
    // Left claimed: a run in flight is a status too, and it's the one worth
    // alerting on when it stays that way.
    claimRun(schedule.id, 4, "scheduled");

    const text = await renderMetrics();
    expect(sample(text, 'calandria_schedule_runs{status="succeeded"}')).toBe(2);
    expect(sample(text, 'calandria_schedule_runs{status="failed"}')).toBe(1);
    expect(sample(text, 'calandria_schedule_runs{status="claimed"}')).toBe(1);
    expect(sample(text, 'calandria_schedule_runs{status="missed"}')).toBe(0);
  });
});

describe("size gauges", () => {
  it("measures the worktrees dir once and serves the cached number to later scrapes", async () => {
    const first = await renderMetrics();
    expect(sample(first, "calandria_worktrees_size_bytes")).toBe(4096);
    expect(diskUsageMock).toHaveBeenCalledTimes(1);

    diskUsageMock.mockResolvedValue(999999);
    const second = await renderMetrics();
    // Still the cached value, and no second `du`, which is why a 15s scrape
    // interval stays safe on an instance with big checkouts.
    expect(sample(second, "calandria_worktrees_size_bytes")).toBe(4096);
    expect(diskUsageMock).toHaveBeenCalledTimes(1);
  });

  it("omits the worktrees gauge rather than reporting 0 when it has never measured", async () => {
    // A gauge that reads 0 on the first scrape after every restart would
    // resolve a firing disk alert without a byte having been reclaimed.
    diskUsageMock.mockRejectedValue(new Error("du: cannot read"));
    resetMetricsForTest();
    const text = await renderMetrics();
    expect(sample(text, "calandria_worktrees_size_bytes")).toBeUndefined();
    expect(text).not.toContain("calandria_worktrees_size_bytes");
  });

  it("reports the database and its WAL sidecars separately", async () => {
    const text = await renderMetrics();
    // The suite's DB is real and has been written to by the tests above.
    expect(sample(text, 'calandria_db_size_bytes{file="db"}')).toBeGreaterThan(0);
    expect(sample(text, 'calandria_db_size_bytes{file="wal"}')).toBeGreaterThanOrEqual(0);
    expect(sample(text, 'calandria_db_size_bytes{file="shm"}')).toBeGreaterThanOrEqual(0);
  });
});
