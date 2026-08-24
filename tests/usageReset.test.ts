// Which usage-window reset a queued start aims at (lib/usageReset.ts): the
// plan-usage snapshot names several windows, and the rule for which one binds
// is what the "Start at reset" button shows, so it's pinned here.
import { describe, expect, it } from "vitest";
import { usageResetAt, deferredStartFor, USAGE_RESET_MARGIN_MS } from "@/lib/usageReset";
import type { PlanUsageSnapshot } from "@/lib/types";

const now = Date.UTC(2026, 7, 24, 12, 0, 0);
const H = 3_600_000;

function snap(over: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  return {
    available: true, reason: null, plan: "max",
    windows: [
      { id: "five_hour", label: "Current session", utilization: 35, resetsAt: now + 2 * H },
      { id: "seven_day", label: "Current week (all models)", utilization: 72, resetsAt: now + 48 * H },
    ],
    status: "allowed", statusWindow: null, statusResetsAt: null, fetchedAt: now, stale: false,
    ...over,
  };
}

describe("usageResetAt", () => {
  it("with room left, offers the session window's reset — the boundary you pace work against", () => {
    expect(usageResetAt(snap(), now)).toBe(now + 2 * H);
  });

  it("a rejected turn's own reset beats everything: it's the freshest fact", () => {
    const s = snap({ status: "rejected", statusWindow: "seven_day", statusResetsAt: now + 30 * H });
    expect(usageResetAt(s, now)).toBe(now + 30 * H);
  });

  it("a spent window (100%) binds even when the passive status is quiet, earliest first", () => {
    const s = snap({
      windows: [
        { id: "five_hour", label: "Current session", utilization: 40, resetsAt: now + H },
        { id: "seven_day_opus", label: "Current week (Opus)", utilization: 100, resetsAt: now + 20 * H },
        { id: "seven_day", label: "Current week (all models)", utilization: 100, resetsAt: now + 10 * H },
      ],
    });
    expect(usageResetAt(s, now)).toBe(now + 10 * H);
  });

  it("never offers a reset that has already passed — stale data, the window rolled over", () => {
    const rolled = snap({
      status: "rejected", statusWindow: "five_hour", statusResetsAt: now - 60_000,
      windows: [{ id: "five_hour", label: "Current session", utilization: 100, resetsAt: now - 60_000 }],
    });
    expect(usageResetAt(rolled, now)).toBeNull();
    expect(usageResetAt(null, now)).toBeNull();
    expect(usageResetAt(snap({ windows: [] }), now)).toBeNull();
  });

  it("the stored deadline sits a minute past the reset", () => {
    expect(deferredStartFor(now)).toBe(now + USAGE_RESET_MARGIN_MS);
    expect(USAGE_RESET_MARGIN_MS).toBe(60_000);
  });
});
