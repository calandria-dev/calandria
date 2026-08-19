import { describe, expect, it, beforeEach } from "vitest";
import { createProject } from "@/lib/store";
import { getDb } from "@/lib/db";
import { createSchedule, getSchedule, listRuns, updateSchedule } from "@/lib/schedule/store";
import { adjudicate } from "@/lib/schedule/due";
import { nextFireAt } from "@/lib/schedule/time";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const never = () => false;

function makeSchedule() {
  const pid = createProject({ name: `due-${Math.random().toString(36).slice(2)}` }).id;
  return createSchedule({
    project_id: pid, name: "Jira triage", prompt: "/jira-tasks",
    days_mask: 62, time_of_day: "08:30", timezone: LA,
  });
}

/** Force the row's next_fire_at to a specific slot, as a real elapsed slot would be. */
function pinNextFire(id: string, ms: number) {
  getDb().prepare("UPDATE schedules SET next_fire_at = ? WHERE id = ?").run(ms, id);
  return getSchedule(id)!;
}

describe("adjudicate", () => {
  let s: ReturnType<typeof makeSchedule>;
  beforeEach(() => { s = makeSchedule(); });

  it("does nothing before the schedule is due", () => {
    expect(adjudicate(s, Date.now(), never).kind).toBe("none");
  });

  it("fires when the slot arrives", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 1_000, never);
    expect(verdict.kind).toBe("fire");
    if (verdict.kind === "fire") expect(verdict.run.trigger).toBe("scheduled");
    // and the schedule has moved on, so the same slot can't be re-adjudicated
    expect(getSchedule(s.id)!.next_fire_at).toBeGreaterThan(slot);
  });

  it("catches a recent miss up ONCE, marking it as such", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 2 * 60 * 60 * 1000, never); // 2h late, inside the 4h window
    expect(verdict.kind).toBe("fire");
    if (verdict.kind === "fire") expect(verdict.run.trigger).toBe("catch_up");
  });

  it("records a stale slot as missed instead of running it at teatime", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 9 * 60 * 60 * 1000, never); // 9h late
    expect(verdict.kind).toBe("missed");
    expect(listRuns(s.id, 10)[0].status).toBe("missed");
  });

  it("clears a whole weekend of backlog in ONE sweep, firing at most once", () => {
    // Down from Friday 08:30 until Monday 10:00 local.
    const friday = at("2026-08-14T15:30:00Z");
    const pinned = pinNextFire(s.id, friday);
    const mondayLate = at("2026-08-17T17:00:00Z"); // Mon 10:00 PDT, 1.5h after the slot
    const verdict = adjudicate(pinned, mondayLate, never);
    expect(verdict.kind).toBe("fire");
    if (verdict.kind === "fire") {
      expect(verdict.run.trigger).toBe("catch_up");
      expect(verdict.run.scheduled_for).toBe(at("2026-08-17T15:30:00Z")); // Monday's slot, not Friday's
    }
    // Friday is on the record as missed, not quietly dropped.
    const statuses = listRuns(s.id, 10).map((r) => r.status);
    expect(statuses).toContain("missed");
    // Next up is Tuesday — the backlog is fully consumed.
    expect(getSchedule(s.id)!.next_fire_at).toBe(at("2026-08-18T15:30:00Z"));
  });

  it("skips while the previous run is still going, and says why", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const verdict = adjudicate(pinned, slot + 1_000, () => true);
    expect(verdict.kind).toBe("skipped");
    expect(listRuns(s.id, 10)[0].status).toBe("skipped_overlap");
    // It still moves on, or one wedged turn would freeze the schedule forever.
    expect(getSchedule(s.id)!.next_fire_at).toBeGreaterThan(slot);
  });

  it("honours a per-schedule catch-up window of zero", () => {
    const slot = at("2026-08-12T15:30:00Z");
    updateSchedule(s.id, { catch_up_ms: 0 });
    const pinned = pinNextFire(s.id, slot);
    expect(adjudicate(pinned, slot + 60_000, never).kind).toBe("missed");
  });

  it("never double-claims a slot two ticks race for", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const pinned = pinNextFire(s.id, slot);
    const a = adjudicate(pinned, slot + 1_000, never);
    const b = adjudicate(pinned, slot + 1_000, never); // same stale snapshot
    const fired = [a, b].filter((v) => v.kind === "fire");
    expect(fired).toHaveLength(1);
  });

  it("a pause landing between the tick and the claim wins", () => {
    // The ticker adjudicates from a snapshot taken up to a tick ago; adjudicate()
    // re-reads, so a pause in that window must stop the firing.
    const slot = at("2026-08-12T15:30:00Z");
    const stale = pinNextFire(s.id, slot);
    updateSchedule(s.id, { enabled: 0 });
    expect(adjudicate(stale, slot + 1_000, never).kind).toBe("none");
    // And a paused schedule accrues NO missed rows — unpausing must not greet
    // the user with a wall of red for slots they deliberately skipped.
    expect(listRuns(s.id, 10)).toHaveLength(0);
  });

  it("a schedule deleted mid-tick is a no-op, not a crash", () => {
    const slot = at("2026-08-12T15:30:00Z");
    const stale = pinNextFire(s.id, slot);
    getDb().prepare("DELETE FROM schedules WHERE id = ?").run(s.id);
    expect(adjudicate(stale, slot + 1_000, never).kind).toBe("none");
  });

  it("carries the DST adjustment onto the run", () => {
    const pid = createProject({ name: `dst-${Math.random().toString(36).slice(2)}` }).id;
    const gap = createSchedule({
      project_id: pid, name: "gap", prompt: "x",
      days_mask: 127, time_of_day: "02:30", timezone: LA,
    });
    const slot = nextFireAt({ daysMask: 127, timeOfDay: "02:30", timezone: LA }, at("2026-03-08T00:00:00Z"));
    const pinned = pinNextFire(gap.id, slot.ms);
    const verdict = adjudicate(pinned, slot.ms + 1_000, never);
    if (verdict.kind === "fire") expect(verdict.run.dst_adjusted).toBe("gap_forward");
    else throw new Error(`expected a fire, got ${verdict.kind}`);
  });
});
