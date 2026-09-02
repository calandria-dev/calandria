import { describe, expect, it } from "vitest";
import { describeSpec, formatWallClock, nextFireAt as rawNextFireAt, type ScheduleSpec } from "@/lib/schedule/time";

const LA = "America/Los_Angeles";
const WEEKDAYS = 62; // Mon–Fri
const DAILY = 127;
const at = (iso: string) => Date.parse(iso);
const weekdays830 = { daysMask: WEEKDAYS, timeOfDay: "08:30", timezone: LA };

// A recurring spec always resolves or throws — the nullable return exists only
// for a one-time date that is already behind us, which the `once` block below
// exercises against the raw export.
const nextFireAt = (spec: ScheduleSpec, afterMs: number) => rawNextFireAt(spec, afterMs)!;

describe("nextFireAt", () => {
  it("fires at local 08:30 when the host clock is UTC", () => {
    // Wed 2026-08-12 02:00 PDT. 08:30 PDT that morning is 15:30Z.
    expect(nextFireAt(weekdays830, at("2026-08-12T09:00:00Z")).ms).toBe(at("2026-08-12T15:30:00Z"));
  });

  it("is strictly after: a tick at exactly the fire instant rolls to the next day", () => {
    expect(nextFireAt(weekdays830, at("2026-08-12T15:30:00Z")).ms).toBe(at("2026-08-13T15:30:00Z"));
  });

  it("skips the weekend", () => {
    // Friday afternoon → Monday morning.
    expect(nextFireAt(weekdays830, at("2026-08-14T16:00:00Z")).ms).toBe(at("2026-08-17T15:30:00Z"));
  });

  it("keeps the WALL CLOCK fixed across a DST boundary, moving the UTC instant", () => {
    const daily830 = { daysMask: DAILY, timeOfDay: "08:30", timezone: LA };
    // Spring forward (2026-03-08): 08:30 PST was 16:30Z, 08:30 PDT is 15:30Z.
    expect(nextFireAt(daily830, at("2026-03-06T20:00:00Z")).ms).toBe(at("2026-03-07T16:30:00Z"));
    expect(nextFireAt(daily830, at("2026-03-07T20:00:00Z")).ms).toBe(at("2026-03-08T15:30:00Z"));
    // Fall back (2026-11-01): back to 16:30Z.
    expect(nextFireAt(daily830, at("2026-10-31T20:00:00Z")).ms).toBe(at("2026-11-01T16:30:00Z"));
  });

  it("spring-forward gap: a nonexistent wall time fires at the first valid instant", () => {
    // 02:30 does not exist on 2026-03-08 in LA (02:00 jumps to 03:00).
    const r = nextFireAt({ daysMask: DAILY, timeOfDay: "02:30", timezone: LA }, at("2026-03-08T00:00:00Z"));
    expect(r.ms).toBe(at("2026-03-08T10:00:00Z")); // 03:00 local
    expect(r.dstAdjusted).toBe("gap_forward");
  });

  it("fall-back overlap: an ambiguous wall time fires ONCE, at the earlier instant", () => {
    const spec = { daysMask: DAILY, timeOfDay: "01:30", timezone: LA };
    const first = nextFireAt(spec, at("2026-11-01T00:00:00Z"));
    expect(first.ms).toBe(at("2026-11-01T08:30:00Z")); // 01:30 PDT, the first pass
    expect(first.dstAdjusted).toBe("ambiguous_first");
    // A tick landing on that instant must NOT schedule the second 01:30 (09:30Z).
    expect(nextFireAt(spec, first.ms).ms).toBe(at("2026-11-02T09:30:00Z"));
  });

  it("handles a fractional-offset zone", () => {
    // Asia/Kathmandu is +05:45.
    const r = nextFireAt({ daysMask: DAILY, timeOfDay: "08:30", timezone: "Asia/Kathmandu" }, at("2026-08-12T00:00:00Z"));
    expect(r.ms).toBe(at("2026-08-12T02:45:00Z"));
  });

  it("handles 30-minute DST (Lord Howe)", () => {
    const LH = "Australia/Lord_Howe";
    // 2026-10-04: 02:00 jumps to 02:30, so 02:15 does not exist.
    const gap = nextFireAt({ daysMask: DAILY, timeOfDay: "02:15", timezone: LH }, at("2026-10-03T00:00:00Z"));
    expect(gap.dstAdjusted).toBe("gap_forward");
    expect(gap.ms).toBe(at("2026-10-03T15:30:00Z")); // 02:30 local
    // 2026-04-05: 02:00 falls back to 01:30, so 01:45 happens twice.
    const dup = nextFireAt({ daysMask: DAILY, timeOfDay: "01:45", timezone: LH }, at("2026-04-04T00:00:00Z"));
    expect(dup.dstAdjusted).toBe("ambiguous_first");
    expect(dup.ms).toBe(at("2026-04-04T14:45:00Z"));
  });

  it("crosses leap day and the year boundary", () => {
    const daily = { daysMask: DAILY, timeOfDay: "08:30", timezone: LA };
    expect(nextFireAt(daily, at("2028-02-29T00:00:00Z")).ms).toBe(at("2028-02-29T16:30:00Z"));
    expect(nextFireAt(daily, at("2026-12-31T20:00:00Z")).ms).toBe(at("2027-01-01T16:30:00Z"));
  });

  it("rejects an unusable spec rather than guessing", () => {
    expect(() => nextFireAt({ daysMask: 0, timeOfDay: "08:30", timezone: LA }, Date.now())).toThrow(/days_mask/);
    expect(() => nextFireAt({ daysMask: 62, timeOfDay: "8:30", timezone: LA }, Date.now())).toThrow(/time_of_day/);
    expect(() => nextFireAt({ daysMask: 62, timeOfDay: "24:00", timezone: LA }, Date.now())).toThrow(/time_of_day/);
    expect(() => nextFireAt({ daysMask: 62, timeOfDay: "08:30", timezone: "Mars/Olympus" }, Date.now())).toThrow(/timezone/);
  });
});

describe("formatWallClock", () => {
  it("renders an instant on the SCHEDULE's clock, not the server's", () => {
    // The minted task's title. This is the case that was wrong: the run fired
    // at 08:30 Pacific and the task was called "…— 2026-08-14 15:30", which is
    // the one thing this whole feature is supposed to get right. Tests run on a
    // UTC host (tests/setup.ts) precisely like the container does, so the bug
    // reproduces here.
    expect(formatWallClock(at("2026-08-14T15:30:00Z"), LA)).toBe("2026-08-14 08:30");
    expect(formatWallClock(at("2026-08-14T15:30:00Z"), "UTC")).toBe("2026-08-14 15:30");
    expect(formatWallClock(at("2026-08-14T15:30:00Z"), "Asia/Kathmandu")).toBe("2026-08-14 21:15");
  });

  it("keeps the wall time across a DST boundary, and pads midnight", () => {
    // Same nominal 08:30 either side of the spring-forward, eight hours apart
    // in UTC on one side and seven on the other — the title must read 08:30 in
    // both, or it contradicts the schedule it came from.
    expect(formatWallClock(at("2026-01-14T16:30:00Z"), LA)).toBe("2026-01-14 08:30");
    expect(formatWallClock(at("2026-07-14T15:30:00Z"), LA)).toBe("2026-07-14 08:30");
    expect(formatWallClock(at("2026-08-14T07:00:00Z"), LA)).toBe("2026-08-14 00:00");
  });

  it("falls back to UTC rather than throwing on a zone that no longer resolves", () => {
    // A title is never worth losing the whole firing over.
    expect(formatWallClock(at("2026-08-14T15:30:00Z"), "Mars/Olympus")).toBe("2026-08-14 15:30");
  });
});

describe("nextFireAt, one-time", () => {
  const once = (onceDate: string, timeOfDay = "04:00"): ScheduleSpec =>
    ({ daysMask: WEEKDAYS, timeOfDay, timezone: LA, onceDate });

  it("fires on its date at its wall time, once", () => {
    // Thu 2026-09-03 04:00 PDT is 11:00Z.
    const spec = once("2026-09-03");
    expect(nextFireAt(spec, at("2026-09-01T00:00:00Z")).ms).toBe(at("2026-09-03T11:00:00Z"));
  });

  it("has nothing after that occurrence — the whole point of a one-off", () => {
    const spec = once("2026-09-03");
    const fired = nextFireAt(spec, at("2026-09-01T00:00:00Z"));
    // Strictly after, same as the recurring path: the slot we just fired is gone.
    expect(rawNextFireAt(spec, fired.ms)).toBeNull();
    expect(rawNextFireAt(spec, at("2026-09-04T00:00:00Z"))).toBeNull();
  });

  it("is null from the start when its date has already passed", () => {
    expect(rawNextFireAt(once("2020-01-01"), at("2026-09-01T00:00:00Z"))).toBeNull();
  });

  it("ignores days_mask — the date is the whole schedule", () => {
    // 2026-09-06 is a SUNDAY and the mask is Mon–Fri. It fires anyway.
    expect(nextFireAt(once("2026-09-06"), at("2026-09-01T00:00:00Z")).ms).toBe(at("2026-09-06T11:00:00Z"));
    // And an unusable mask can't stop it, so switching a weekly schedule to
    // Once never has to launder the mask it leaves behind.
    expect(nextFireAt({ ...once("2026-09-06"), daysMask: 0 }, at("2026-09-01T00:00:00Z")).ms)
      .toBe(at("2026-09-06T11:00:00Z"));
  });

  it("keeps the wall-clock promise across a DST gap", () => {
    // 02:30 doesn't exist on 2026-03-08 in LA; it runs when the gap closes.
    const r = nextFireAt(once("2026-03-08", "02:30"), at("2026-03-01T00:00:00Z"));
    expect(r.dstAdjusted).toBe("gap_forward");
    expect(r.ms).toBe(at("2026-03-08T10:00:00Z"));
  });

  it("rejects a malformed or non-existent date rather than rolling it forward", () => {
    expect(() => rawNextFireAt(once("2026-9-3"), Date.now())).toThrow(/once_date/);
    expect(() => rawNextFireAt(once("2026-02-30"), Date.now())).toThrow(/no such calendar date/);
  });

  it("describes itself as a one-off", () => {
    expect(describeSpec(once("2026-09-03"))).toBe("Once on 2026-09-03 at 04:00 (America/Los_Angeles)");
  });
});
