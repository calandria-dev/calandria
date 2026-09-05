import { describe, it, expect } from "vitest";
import {
  parseCron,
  nextCronFire,
  planSessionCrons,
  cronThatWoke,
  lingerNote,
  cancelledCronsNotice,
  describeCron,
  wakeTimeLabel,
} from "@/lib/agents/claude/sessionCrons";

// The Stop hook's session_crons payload as measured on claude CLI 2.1.240: a
// one-shot ScheduleWakeup encodes ONLY its wall-clock minute ("58 11 * * *"
// for 11:58, local time, day/month wildcards); a recurring CronCreate carries
// the expression it was given. These pin the local-time math the driver uses
// to decide whether a wakeup fits a bounded linger window and to label it.

// A fixed local "now": Mon 2026-08-24 11:56:40 (local time — the CLI's cron
// clock IS the server's local clock, since the CLI is our child process).
const NOW = new Date(2026, 7, 24, 11, 56, 40).getTime();
const local = (h: number, m: number, dayOffset = 0) => new Date(2026, 7, 24 + dayOffset, h, m).getTime();

describe("nextCronFire (local-time, minute granularity)", () => {
  it("resolves a one-shot wakeup's MM HH * * * to the next occurrence today", () => {
    expect(nextCronFire("58 11 * * *", NOW)).toBe(local(11, 58));
  });
  it("rolls a passed wall-clock minute over to tomorrow", () => {
    expect(nextCronFire("30 11 * * *", NOW)).toBe(local(11, 30, 1));
  });
  it("counts the current minute only when now is exactly on it", () => {
    expect(nextCronFire("56 11 * * *", NOW)).toBe(local(11, 56, 1)); // 11:56:40 has passed 11:56:00
    expect(nextCronFire("56 11 * * *", local(11, 56))).toBe(local(11, 56));
  });
  it("handles every-minute, steps, ranges and lists", () => {
    expect(nextCronFire("* * * * *", NOW)).toBe(local(11, 57));
    expect(nextCronFire("*/15 * * * *", NOW)).toBe(local(12, 0));
    expect(nextCronFire("0 9-17 * * *", NOW)).toBe(local(12, 0));
    expect(nextCronFire("0,30 12 * * *", NOW)).toBe(local(12, 0));
  });
  it("applies the Vixie day rule: dom OR dow when both are restricted", () => {
    // 2026-08-24 is a Monday. dow=2 (Tue) alone → tomorrow.
    expect(nextCronFire("0 9 * * 2", NOW)).toBe(local(9, 0, 1));
    // dom=26 alone → Wed the 26th.
    expect(nextCronFire("0 9 26 * *", NOW)).toBe(local(9, 0, 2));
    // both restricted: the earlier of the two wins (Tue the 25th via dow).
    expect(nextCronFire("0 9 26 * 2", NOW)).toBe(local(9, 0, 1));
    // 7 is Sunday too.
    expect(nextCronFire("0 9 * * 7", NOW)).toBe(local(9, 0, 6));
  });
  it("returns null for garbage and for dates that never come", () => {
    expect(parseCron("not a cron")).toBeNull();
    expect(nextCronFire("61 11 * * *", NOW)).toBeNull();
    expect(nextCronFire("0 0 31 2 *", NOW)).toBeNull();
    expect(nextCronFire("0 0 * *", NOW)).toBeNull();
  });
});

const oneShot = { id: "a", schedule: "58 11 * * *", recurring: false, prompt: "WAKE: check the build" };
const later = { id: "b", schedule: "0 14 * * *", recurring: false, prompt: "WAKE: later" };
const loop = { id: "c", schedule: "* * * * *", recurring: true, prompt: "TICK" };

describe("planSessionCrons policy", () => {
  it("honors everything under the unbounded default, recurring included", () => {
    const plan = planSessionCrons([oneShot, later, loop], { now: NOW, enabled: true, deadline: null });
    expect(plan.linger.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(plan.cancelled).toEqual([]);
    expect(plan.linger[0].fireAt).toBe(local(11, 58));
  });
  it("honors only what fits the window on a bounded instance", () => {
    const plan = planSessionCrons([oneShot, later, loop], { now: NOW, enabled: true, deadline: NOW + 10 * 60_000 });
    expect(plan.linger.map((c) => c.id)).toEqual(["a", "c"]);
    expect(plan.cancelled.map((c) => c.id)).toEqual(["b"]);
  });
  it("cancels everything when lingering is off", () => {
    const plan = planSessionCrons([oneShot, loop], { now: NOW, enabled: false, deadline: null });
    expect(plan.linger).toEqual([]);
    expect(plan.cancelled.map((c) => c.id)).toEqual(["a", "c"]);
  });
  it("lingers on an unparsable expression unbounded (the CLI accepted it), cancels it bounded (can't prove it fits)", () => {
    const odd = { id: "z", schedule: "?? ??", recurring: false, prompt: "x" };
    expect(planSessionCrons([odd], { now: NOW, enabled: true, deadline: null }).linger).toHaveLength(1);
    expect(planSessionCrons([odd], { now: NOW, enabled: true, deadline: NOW + 60_000 }).cancelled).toHaveLength(1);
  });
});

describe("labels", () => {
  const planned = planSessionCrons([oneShot, later, loop], { now: NOW, enabled: true, deadline: null }).linger;
  it("names the earliest wake on the activity line, and background work first", () => {
    expect(lingerNote(0, [planned[0]], NOW)).toBe("waiting to wake at 11:58");
    expect(lingerNote(0, [planned[1], planned[0]], NOW)).toBe("waiting to wake at 11:58 (+1 more)");
    expect(lingerNote(2, [], NOW)).toBe("working in background");
    expect(lingerNote(1, [planned[0]], NOW)).toBe("working in background · waiting to wake at 11:58");
  });
  it("shows a recurring cron's expression and its next fire", () => {
    expect(lingerNote(0, [planned[2]], NOW)).toBe("wakes on `* * * * *`, next 11:57");
  });
  it("labels a wake by how far off it is: bare time today, weekday within a week, date beyond", () => {
    // The untested branch that sank the v0.9.0 tag build. A wake five minutes
    // out is still on ANOTHER calendar day when the turn runs near midnight,
    // so the label grows a weekday, and every suite that hardcoded HH:MM in a
    // notice failed for the ~5 minutes a day that was true. Pinned here, on a
    // frozen clock, so the driver suites can stay tolerant of the prefix.
    expect(wakeTimeLabel(local(11, 58), NOW)).toBe("11:58");
    expect(wakeTimeLabel(new Date(2026, 7, 25, 0, 3).getTime(), NOW)).toBe("Tue 00:03");
    expect(wakeTimeLabel(new Date(2026, 8, 3, 9, 0).getTime(), NOW)).toBe("Sep 3 09:00");
    expect(wakeTimeLabel(null, NOW)).toBe("an unparsed schedule");
  });
  it("picks the cron a wake init came from: the latest one already due, else the earliest", () => {
    expect(cronThatWoke(planned, local(11, 58))?.id).toBe("a"); // 11:57 (loop) and 11:58 (a) both due → the latest due
    expect(cronThatWoke(planned, NOW)?.id).toBe("c"); // nothing due yet → next up is the every-minute loop at 11:57
    expect(cronThatWoke([], NOW)).toBeNull();
  });
  it("writes the honesty notice with each cancelled wake's time and prompt", () => {
    const n = cancelledCronsNotice([planned[0]], "the session closed before it fired", NOW);
    expect(n).toBe('⏰ Scheduled wakeup cancelled (the session closed before it fired): at 11:58, "WAKE: check the build". It will not fire; nothing re-invokes this session on its own.');
    const two = cancelledCronsNotice([planned[0], planned[2]], "lingering is off", NOW);
    expect(two).toMatch(/^⏰ Scheduled wakeups cancelled \(lingering is off\): at 11:58, "WAKE: check the build"; on `\* \* \* \* \*` \(next 11:57\), "TICK"\. They will not fire/);
    expect(describeCron({ ...planned[0], prompt: "x".repeat(200) }, NOW)).toMatch(/x{160}…"$/);
  });
});
