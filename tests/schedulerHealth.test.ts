import { describe, expect, it } from "vitest";
import { schedulerAlert } from "@/app/shell/format";

// The Schedules card's warning banner. A schedule promises work at 08:30 with
// nobody logged in, so the card must never show a confident "next run
// tomorrow 08:30" when nothing is watching for it. Covers three failure
// shapes, keyed off the API's `lastTickAt`.
const OK = { started: true, startedAt: 1_000, lastTickAt: 1_000_000, lastError: "", tickMs: 30_000 };

describe("schedulerAlert", () => {
  it("says nothing when the ticker is sweeping cleanly", () => {
    expect(schedulerAlert(OK, OK.lastTickAt + 10_000)).toBeNull();
    // A sweep can legitimately outlast one interval: it fires schedules
    // serially, and a firing sets up a worktree. No banner on the second tick.
    expect(schedulerAlert(OK, OK.lastTickAt + 60_000)).toBeNull();
  });

  it("leads with a ticker that was never started", () => {
    expect(schedulerAlert({ ...OK, started: false })).toMatch(/not running on this instance/i);
  });

  it("reports a ticker whose sweeps have stopped coming back", () => {
    // tickSchedules() is single-flight. One call that never returns (a stalled
    // agent CLI in the fire-time probe, a hung git op) leaves `ticking` true
    // forever, so EVERY schedule on the instance stops with nothing thrown:
    // `lastError` stays empty and `started` stays true. A stale lastTickAt
    // is the only symptom of this failure.
    const alert = schedulerAlert(OK, OK.lastTickAt + 10 * 60_000);
    expect(alert).toMatch(/hasn't completed a check/i);
    expect(alert).toMatch(/nothing is firing/i);
  });

  it("ages a very first sweep that never returned, from when the ticker started", () => {
    // lastTickAt is 0 until a sweep FINISHES, so a boot-time wedge has no tick
    // to age at all. startedAt is the fallback, covering the case where
    // nothing has ever fired.
    const booting = { ...OK, lastTickAt: 0, startedAt: 5_000_000 };
    expect(schedulerAlert(booting, 5_030_000)).toBeNull();
    expect(schedulerAlert(booting, 5_000_000 + 10 * 60_000)).toMatch(/hasn't completed a check/i);
  });

  it("keeps a floor under the staleness window so a fast dev tick can't flicker", () => {
    const fast = { ...OK, tickMs: 1_000 };
    expect(schedulerAlert(fast, OK.lastTickAt + 60_000)).toBeNull();
    expect(schedulerAlert(fast, OK.lastTickAt + 5 * 60_000)).toMatch(/hasn't completed a check/i);
  });

  it("names the schedule that failed, and doesn't blame the tick", () => {
    // The banner must name the failing schedule and not blame the ticker: a
    // schedule-level fault should not read as "the last scheduler tick
    // failed," which would send the user to the ticker instead of the
    // schedule, and should clear once that schedule fires cleanly.
    const alert = schedulerAlert({ ...OK, lastError: '"Morning triage": invalid timezone' }, OK.lastTickAt + 10_000);
    expect(alert).toContain("Morning triage");
    expect(alert).toMatch(/The others still ran/i);
    expect(alert).not.toMatch(/tick failed/i);
  });

  it("ranks a dead ticker above a schedule-level failure", () => {
    // Both true at once: the schedule error is moot if nothing is sweeping.
    expect(schedulerAlert({ ...OK, started: false, lastError: "boom" })).toMatch(/not running/i);
    expect(schedulerAlert({ ...OK, lastError: "boom" }, OK.lastTickAt + 10 * 60_000)).toMatch(/hasn't completed/i);
  });
});
