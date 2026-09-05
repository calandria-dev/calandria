// Snoozing a task parks it out of sight until a deadline, then hands it back
// to the category it came from.
//
// The feature rests on one stored fact, `tasks.snoozed_until` (a ms epoch);
// `status` is never touched, so there is no previous category to restore,
// only the one that never left. The wake needs no server-side sweep: a
// deadline in the past stops matching the predicate. These tests cover the
// two derivations that fall out of that single column:
//
//   snoozed  ⟺  snoozed_until >  now
//   woke     ⟺  0 < snoozed_until <= now
//
// The second is the "was snoozed" indicator: the same timestamp, read after
// it has passed, is the record that this card was parked and has just come
// back. Zero means never snoozed, or the indicator was dismissed.
import { describe, it, expect } from "vitest";
import {
  isSnoozed, wasSnoozed, snoozePresets, relativeUntil, wakeLabel, nextWake,
} from "@/app/shell/snooze";
import {
  createProject, createTask, updateTask,
  listProjects, listNeedsYou, countAwaiting,
} from "@/lib/store";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { subscribeGlobal, type BusEvent } from "@/lib/events";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const HOUR = 3_600_000;

// A local wall-clock instant relative to `base`, built with the same Date API
// the code under test uses, so these assertions hold in any timezone.
function at(base: number, addDays: number, hour: number, minute = 0): number {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

async function busEventsFor(taskId: string, fn: () => Promise<unknown>): Promise<BusEvent[]> {
  const seen: BusEvent[] = [];
  const unsub = subscribeGlobal((tid, ev) => { if (tid === taskId) seen.push(ev); });
  try { await fn(); } finally { unsub(); }
  return seen;
}

describe("the snooze derivation", () => {
  const now = Date.UTC(2026, 2, 3, 12, 0, 0);

  it("is snoozed only while the deadline is still ahead", () => {
    expect(isSnoozed({ snoozed_until: now + HOUR }, now)).toBe(true);
    expect(isSnoozed({ snoozed_until: now - HOUR }, now)).toBe(false);
    // It is awake as soon as the deadline is reached, so a deadline hit
    // exactly on a render tick never leaves the card in limbo.
    expect(isSnoozed({ snoozed_until: now }, now)).toBe(false);
    expect(isSnoozed({ snoozed_until: 0 }, now)).toBe(false);
  });

  it("reads a past deadline as the was-snoozed indicator, and zero as nothing", () => {
    expect(wasSnoozed({ snoozed_until: now - HOUR }, now)).toBe(true);
    // Due exactly now: it has woken, so the indicator is what it should show.
    expect(wasSnoozed({ snoozed_until: now }, now)).toBe(true);
    expect(wasSnoozed({ snoozed_until: now + HOUR }, now)).toBe(false);
    // Zero is the cleared state: a task that was never snoozed and one whose
    // indicator the user has already seen are the same row.
    expect(wasSnoozed({ snoozed_until: 0 }, now)).toBe(false);
  });

  it("never calls a task both snoozed and woken", () => {
    for (const until of [0, now - 1, now, now + 1, now + HOUR]) {
      const t = { snoozed_until: until };
      expect(isSnoozed(t, now) && wasSnoozed(t, now)).toBe(false);
    }
  });
});

describe("snooze durations", () => {
  it("turns a relative amount into a deadline", () => {
    const now = Date.UTC(2026, 2, 3, 12, 0, 0);
    expect(relativeUntil(now, 2, "hours")).toBe(now + 2 * HOUR);
    expect(relativeUntil(now, 30, "minutes")).toBe(now + 30 * 60_000);
    expect(relativeUntil(now, 3, "days")).toBe(now + 3 * 24 * HOUR);
    expect(relativeUntil(now, 2, "weeks")).toBe(now + 14 * 24 * HOUR);
  });

  it("lands the wall-clock presets on the hours a human means by them", () => {
    // A Tuesday morning: every preset is in play.
    const now = new Date(2026, 2, 3, 9, 15).getTime();
    const by = Object.fromEntries(snoozePresets(now).map((p) => [p.key, p.until]));
    expect(by["1h"]).toBe(now + HOUR);
    expect(by["3h"]).toBe(now + 3 * HOUR);
    expect(by.evening).toBe(at(now, 0, 18));
    expect(by.tomorrow).toBe(at(now, 1, 9));
    // "Next week" is the Monday after this one: Tue Mar 3 to Mon Mar 9.
    expect(by.week).toBe(at(now, 6, 9));
  });

  it("drops a preset that has already passed instead of offering a deadline in the past", () => {
    // 8pm: "this evening" is behind us, and so is 9am tomorrow-is-still-ahead.
    const evening = new Date(2026, 2, 3, 20, 0).getTime();
    const keys = snoozePresets(evening).map((p) => p.key);
    expect(keys).not.toContain("evening");
    expect(keys).toContain("tomorrow");
    expect(snoozePresets(evening).every((p) => p.until > evening)).toBe(true);
  });

  it("offers next Monday a full week out when today IS Monday", () => {
    const monday = new Date(2026, 2, 2, 9, 0).getTime();
    expect(new Date(monday).getDay()).toBe(1);
    const by = Object.fromEntries(snoozePresets(monday).map((p) => [p.key, p.until]));
    // Never "later today": a Monday 9am snooze that woke at Monday 9am would
    // be a no-op the user reads as broken.
    expect(by.week).toBe(at(monday, 7, 9));
  });
});

describe("the wake label", () => {
  it("counts minutes for a short snooze and names the day for a long one", () => {
    const now = new Date(2026, 2, 3, 9, 0).getTime();
    expect(wakeLabel(now + 42 * 60_000, now)).toBe("in 42m");
    expect(wakeLabel(now + 30_000, now)).toBe("in under a minute");
    // Later today reads as a clock time; "in 9h" makes you do the arithmetic.
    expect(wakeLabel(at(now, 0, 18), now)).toMatch(/^at /);
    expect(wakeLabel(at(now, 1, 9), now)).toMatch(/^tomorrow at /);
    // Inside the week, the weekday is the useful handle.
    expect(wakeLabel(at(now, 3, 9), now)).toMatch(/^Fri at /);
    // Beyond it, only a date is unambiguous.
    expect(wakeLabel(at(now, 20, 9), now)).toMatch(/^Mar 23 at /);
  });

  it("says now rather than a negative countdown for a deadline already reached", () => {
    const now = Date.UTC(2026, 2, 3, 12, 0, 0);
    expect(wakeLabel(now - HOUR, now)).toBe("now");
    expect(wakeLabel(now, now)).toBe("now");
  });
});

describe("nextWake", () => {
  const now = Date.UTC(2026, 2, 3, 12, 0, 0);

  it("finds the soonest deadline still ahead, so one timer can serve the whole list", () => {
    const rows = [
      { snoozed_until: now + 5 * HOUR },
      { snoozed_until: now + 2 * HOUR },
      { snoozed_until: now - HOUR },  // already woke
      { snoozed_until: 0 },           // never snoozed
    ];
    expect(nextWake(rows, now)).toBe(now + 2 * HOUR);
  });

  it("returns null when nothing is waiting, so no timer is armed at all", () => {
    expect(nextWake([{ snoozed_until: 0 }, { snoozed_until: now - HOUR }], now)).toBe(null);
    expect(nextWake([], now)).toBe(null);
  });
});

describe("a snoozed task and the attention surfaces", () => {
  // Snoozing something that is asking you a question stops it from asking.
  // All three surfaces share lib/store.ts's NEEDS_YOU predicate, so the
  // deadline is part of that predicate instead of filtered per caller: the
  // pill, its dropdown and the project badge must otherwise agree, which is
  // what tests/needsYou.test.ts checks.
  function awaitingTask(projectId: string, snoozedUntil: number) {
    const t = createTask({ project_id: projectId, title: "asked you something" });
    updateTask(t.id, { status: "in_progress", awaiting_input: 1, snoozed_until: snoozedUntil });
    return t;
  }

  it("drops out of the pill, the dropdown and the project badge while snoozed", () => {
    const project = createProject({ name: "SnoozeAttention" });
    const awake = awaitingTask(project.id, 0);
    const snoozed = awaitingTask(project.id, Date.now() + HOUR);

    expect(countAwaiting(project.id)).toBe(1);
    const dropdown = listNeedsYou().filter((r) => r.project_id === project.id);
    expect(dropdown.map((r) => r.id)).toEqual([awake.id]);
    expect(listProjects().find((p) => p.id === project.id)!.awaiting_count).toBe(1);
    // Still awaiting: snoozing hides it, it does not answer it.
    expect(snoozed.id).toBeTruthy();
  });

  it("counts again the moment the deadline passes, with nothing having written to the row", () => {
    const project = createProject({ name: "SnoozeWake" });
    // A deadline already behind us is exactly the state a snooze decays into.
    awaitingTask(project.id, Date.now() - HOUR);
    expect(countAwaiting(project.id)).toBe(1);
    expect(listNeedsYou().filter((r) => r.project_id === project.id)).toHaveLength(1);
    expect(listProjects().find((p) => p.id === project.id)!.awaiting_count).toBe(1);
  });
});

describe("PATCH /api/tasks/[id] snoozing", () => {
  const patch = (id: string, body: unknown) =>
    patchTask(new Request("http://x", { method: "PATCH", body: JSON.stringify(body) }), params(id));

  it("stores the deadline and leaves the status — the category it returns to — alone", async () => {
    const project = createProject({ name: "SnoozePatch" });
    const t = createTask({ project_id: project.id, title: "later" });
    updateTask(t.id, { status: "in_progress" });
    const until = Date.now() + 2 * HOUR;

    const res = await patch(t.id, { snoozed_until: until });
    expect(res.status).toBe(200);
    const row = await res.json();
    expect(row.snoozed_until).toBe(until);
    expect(row.status).toBe("in_progress");
  });

  it("announces the change so every other tab re-reads the row", async () => {
    const project = createProject({ name: "SnoozeEvents" });
    const t = createTask({ project_id: project.id, title: "later" });
    // task_edited, not task_updated: the /api/events payload carries only
    // running/awaiting_input/status, so a listener cannot learn a deadline
    // from it. This event flavor means "refetch the row".
    const events = await busEventsFor(t.id, () => patch(t.id, { snoozed_until: Date.now() + HOUR }));
    expect(events.map((e) => e.type)).toContain("task_edited");
  });

  // Waking a task by hand resolves against the server's clock. A client
  // sending its own Date.now() would, on a machine running minutes fast,
  // write a deadline still in the future, leaving a task the user just
  // un-snoozed hidden from the pill until the skew elapsed.
  it("unsnoozes to a deadline of now, so the card comes back wearing the indicator", async () => {
    const project = createProject({ name: "SnoozeUn" });
    const t = createTask({ project_id: project.id, title: "later" });
    await patch(t.id, { snoozed_until: Date.now() + 5 * HOUR });

    const before = Date.now();
    const row = await (await patch(t.id, { unsnooze: true })).json();
    expect(row.snoozed_until).toBeGreaterThanOrEqual(before);
    expect(row.snoozed_until).toBeLessThanOrEqual(Date.now());
    expect(wasSnoozed(row, Date.now())).toBe(true);
  });

  it("clears the indicator to zero when asked plainly", async () => {
    const project = createProject({ name: "SnoozeClear" });
    const t = createTask({ project_id: project.id, title: "later" });
    await patch(t.id, { snoozed_until: Date.now() - HOUR });
    const row = await (await patch(t.id, { snoozed_until: 0 })).json();
    expect(row.snoozed_until).toBe(0);
  });

  it("refuses a deadline that isn't a whole non-negative number of milliseconds", async () => {
    const project = createProject({ name: "SnoozeBad" });
    const t = createTask({ project_id: project.id, title: "later" });
    for (const bad of [-1, 1.5, NaN, Infinity, "tomorrow", null]) {
      const res = await patch(t.id, { snoozed_until: bad });
      expect(res.status, `snoozed_until: ${String(bad)}`).toBe(400);
    }
  });

  it("defaults a new task to not snoozed", () => {
    const project = createProject({ name: "SnoozeDefault" });
    expect(createTask({ project_id: project.id, title: "fresh" }).snoozed_until).toBe(0);
  });
});
