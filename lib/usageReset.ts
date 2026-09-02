// When does the subscription's usage window reset — the instant "start at the
// usage-window reset" (tasks.start_at, lib/deferredStart.ts) is pointed at.
//
// Read off the plan-usage snapshot the titlebar meter already polls (lib/types
// PlanUsageSnapshot), so the answer is the provider's own reset time, not a
// guess from "five hours after something". Dependency-free on purpose: the
// client derives the deadline it offers in a button, and a test pins the rule,
// same as lib/usageLimit.ts.

import type { PlanUsageSnapshot } from "@/lib/types";

/**
 * Head-room past the provider's reset before a queued start fires. The reset
 * is exact, but a turn launched at the very instant it lands can still be
 * refused by an edge that hasn't rolled its counters — and a failed launch
 * here would park the task again with nobody watching, which is the failure
 * this feature exists to remove. A minute is invisible next to the hours of
 * waiting it follows.
 */
export const USAGE_RESET_MARGIN_MS = 60_000;

/**
 * The instant the BINDING limit resets, or null when no reset is known. Which
 * window binds, in order:
 *   1. the window the passive signal says rejected the last turn — the
 *      freshest fact there is, straight from the turn that hit the wall;
 *   2. any window the usage API reports as spent (≥ 100%);
 *   3. otherwise the session (5-hour) window's reset — the boundary you pace
 *      work against, so "start at the next window" is a sensible ask even
 *      while the current one still has room.
 * A reset already behind `now` is stale data (the window rolled over) and is
 * never offered: the earliest reset still ahead wins within each rule.
 */
export function usageResetAt(snap: PlanUsageSnapshot | null | undefined, now: number = Date.now()): number | null {
  if (!snap) return null;
  const ahead = (t: number | null | undefined): t is number => t != null && Number.isFinite(t) && t > now;
  if (snap.status === "rejected" && ahead(snap.statusResetsAt)) return snap.statusResetsAt;
  const spent = snap.windows.filter((w) => w.utilization >= 100 && ahead(w.resetsAt)).map((w) => w.resetsAt as number);
  if (spent.length) return Math.min(...spent);
  // By kind, not by id: "the 5-hour one" is spelled differently per provider
  // (Claude "five_hour", Antigravity "gemini-5h"). The id stays as the fallback
  // for a snapshot written before drivers declared a kind.
  const session = snap.windows.find((w) => w.kind === "session") ?? snap.windows.find((w) => w.id === "five_hour");
  return session && ahead(session.resetsAt) ? session.resetsAt : null;
}

/** The `start_at` to store for a reset at `resetAt`: the reset plus the margin. */
export const deferredStartFor = (resetAt: number): number => resetAt + USAGE_RESET_MARGIN_MS;
