// Wall-clock scheduling math. Intl only: no deps, no DB, no SDK (pinned by
// tests/importGraph.test.ts).
//
// Given "08:30 on weekdays, America/Los_Angeles", finds the next UTC instant
// that renders as that wall time in that zone. The server may be a container
// on UTC while the user is on Pacific, and the correct instant moves by an
// hour twice a year while the wall time does not.

export interface ScheduleSpec {
  /** Bitmask of allowed weekdays: Sun=1, Mon=2, … Sat=64. Weekdays = 62. */
  daysMask: number;
  /** 'HH:MM', 24-hour, local to `timezone`. */
  timeOfDay: string;
  /** IANA zone name. Never an offset: offsets don't survive DST. */
  timezone: string;
  /**
   * 'YYYY-MM-DD' for a one-time schedule, e.g. "check in on the release at
   * 04:00 tomorrow", or '' / undefined for the ordinary weekly one. When set,
   * `daysMask` is ignored and there is exactly one occurrence, after which
   * `nextFireAt` returns null forever.
   *
   * Stored as a calendar date, not an instant, so the one-time job keeps the
   * same wall-clock promise as every other: 02:30 on a spring-forward night
   * lands where `resolveWall` puts it, not an hour out.
   */
  onceDate?: string;
}

/** Which DST oddity (if any) moved this firing off its nominal wall time. */
export type DstAdjustment = "" | "gap_forward" | "ambiguous_first";

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    // Throws RangeError on an unknown zone; that's the validation.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timezone, f);
  }
  return f;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** How `ms` renders on the wall clock in `timezone`. */
export function partsIn(ms: number, timezone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as unknown as LocalParts;
}

/**
 * The zone's UTC offset at `ms`, derived by formatting the instant and reading
 * the result back as if it were UTC. Second-granular, which is all any real
 * zone needs.
 */
function offsetAt(ms: number, timezone: string): number {
  const p = partsIn(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The first minute at or after `lo` carrying a different offset than `lo`,
 * i.e. the instant a DST transition completes. `lo` and `hi` must straddle it.
 * Only ever called on a spring-forward gap, so the binary search is free.
 */
function transitionBetween(lo: number, hi: number, timezone: string): number {
  const loOffset = offsetAt(lo, timezone);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
    if (mid <= lo || mid >= hi) break;
    if (offsetAt(mid, timezone) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The instant for a nominal local wall time, and whether DST moved it.
 *
 * Candidates are built from the offsets a day either side, which brackets any
 * transition, then filtered to those that actually render back as the requested
 * wall time:
 *   - exactly one survives → the ordinary case;
 *   - two survive → the wall time happens twice (fall back); take the EARLIER
 *     so the schedule runs once, on the first pass;
 *   - none survive → the wall time doesn't exist (spring forward); run at the
 *     instant the gap closes, which is as soon as the clock permits.
 */
export function resolveWall(
  year: number, month: number, day: number, hour: number, minute: number, timezone: string
): { ms: number; dstAdjusted: DstAdjustment } {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = [...new Set([naive - offsetAt(naive - DAY_MS, timezone), naive - offsetAt(naive + DAY_MS, timezone)])]
    .sort((a, b) => a - b);
  const valid = candidates.filter((c) => offsetAt(c, timezone) + Math.floor(c / 1000) * 1000 === naive);
  if (valid.length === 0) {
    return { ms: transitionBetween(candidates[0], candidates[candidates.length - 1], timezone), dstAdjusted: "gap_forward" };
  }
  if (valid.length > 1) return { ms: valid[0], dstAdjusted: "ambiguous_first" };
  return { ms: valid[0], dstAdjusted: "" };
}

/** A one-time schedule's date, parsed and range-checked. Throws on anything else. */
function parseOnceDate(onceDate: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onceDate);
  if (!m) throw new Error(`invalid once_date (want 'YYYY-MM-DD'): ${onceDate}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Round-trip through UTC to reject 2026-02-30 and friends, which Date would
  // otherwise roll forward into March with no error.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) {
    throw new Error(`invalid once_date (no such calendar date): ${onceDate}`);
  }
  return { year, month, day };
}

/**
 * The next firing strictly after `afterMs`, so re-adjudicating a slot that
 * just fired can never fire it again.
 *
 * Returns **null** when the spec has no further occurrence, which only a
 * one-time schedule (`onceDate`) can ever be: its single slot is behind
 * `afterMs`. A recurring spec always resolves or throws. Callers must land
 * that null somewhere visible: `advanceNextFire` spends the schedule instead
 * of leaving it enabled and pointed at nothing.
 */
export function nextFireAt(spec: ScheduleSpec, afterMs: number): { ms: number; dstAdjusted: DstAdjustment } | null {
  const { daysMask, timeOfDay, timezone, onceDate } = spec;
  const parsed = /^(\d{2}):(\d{2})$/.exec(timeOfDay);
  if (!parsed) throw new Error(`invalid time_of_day (want 'HH:MM'): ${timeOfDay}`);
  const hour = Number(parsed[1]);
  const minute = Number(parsed[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid time_of_day (out of range): ${timeOfDay}`);
  // The mask is dead weight on a one-time schedule, so it isn't validated
  // here: the editor keeps whatever weekly selection was on screen when the
  // user switched to Once, and a switch back must not have to survive a
  // throw.
  if (!onceDate && (!Number.isInteger(daysMask) || daysMask <= 0 || daysMask > 127)) {
    throw new Error(`invalid days_mask (want 1–127): ${daysMask}`);
  }
  try {
    formatter(timezone);
  } catch {
    throw new Error(`invalid timezone (want an IANA zone): ${timezone}`);
  }

  if (onceDate) {
    const { year, month, day } = parseOnceDate(onceDate);
    const resolved = resolveWall(year, month, day, hour, minute, timezone);
    return resolved.ms > afterMs ? resolved : null;
  }

  // Walk local calendar dates, never epoch + 24h: the latter is wrong on a
  // DST day by exactly the amount that matters here.
  const start = partsIn(afterMs, timezone);
  for (let i = 0; i < 400; i++) {
    const nominal = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    if (!(daysMask & (1 << nominal.getUTCDay()))) continue;
    const resolved = resolveWall(
      nominal.getUTCFullYear(), nominal.getUTCMonth() + 1, nominal.getUTCDate(), hour, minute, timezone
    );
    if (resolved.ms > afterMs) return resolved;
  }
  // 400 > 366, so any non-empty mask resolves long before here.
  throw new Error("no occurrence found within 400 days");
}

/**
 * An instant as it reads on the schedule's own wall clock: "2026-08-14 08:30".
 *
 * Used for the minted task's title, which must show the zone's local time: a
 * job set for 08:30 Pacific needs a title that says "08:30". Falls back to
 * UTC only if the stored zone has become unusable (a tzdata removal),
 * because a title is never worth throwing over.
 */
export function formatWallClock(ms: number, timezone: string): string {
  try {
    const p = partsIn(ms, timezone);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Human summary for the UI and run notes, e.g. "Mon–Fri at 08:30 (America/Los_Angeles)". */
export function describeSpec(spec: ScheduleSpec): string {
  if (spec.onceDate) return `Once on ${spec.onceDate} at ${spec.timeOfDay} (${spec.timezone})`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = names.filter((_, i) => spec.daysMask & (1 << i));
  let label: string;
  if (days.length === 7) label = "Every day";
  else if (spec.daysMask === 62) label = "Mon–Fri";
  else if (spec.daysMask === 65) label = "Sat–Sun";
  else label = days.join(", ");
  return `${label} at ${spec.timeOfDay} (${spec.timezone})`;
}
